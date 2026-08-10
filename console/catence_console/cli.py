"""Local launcher and preflight checks for Catence Console."""

from __future__ import annotations

import argparse
import json
import os
import shutil
import signal
import subprocess
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path
from typing import NoReturn

from .config import ConsoleConfigurationError, load_console_configuration, missing_environment


def repository_root() -> Path:
    return Path(__file__).resolve().parents[2]


def ui_root() -> Path:
    return repository_root().parent / "catence-ui"


def _json_output(value: object) -> None:
    print(json.dumps(value, indent=2, sort_keys=True))


def _health(url: str) -> tuple[bool, str]:
    try:
        with urllib.request.urlopen(url.rstrip("/") + "/health", timeout=3) as response:
            payload = json.loads(response.read().decode("utf-8"))
        return response.status == 200 and payload.get("status") == "ok", "reachable"
    except (urllib.error.URLError, TimeoutError, json.JSONDecodeError) as error:
        return False, str(error)


def doctor(data_directory: Path, mcp_url: str) -> int:
    report: dict[str, object] = {
        "dataDirectory": str(data_directory),
        "mcpUrl": mcp_url,
        "profiles": [],
        "ok": False,
    }
    try:
        configuration = load_console_configuration(data_directory)
        profiles = []
        for profile in configuration.profiles.values():
            profiles.append(
                {
                    "id": profile.id,
                    "model": profile.model,
                    "missingEnvironment": list(missing_environment(profile)),
                    "ready": not missing_environment(profile),
                }
            )
        report["defaultProfile"] = configuration.default_profile
        report["profiles"] = profiles
    except ConsoleConfigurationError as error:
        report["configurationError"] = str(error)
        _json_output(report)
        return 1

    healthy, health_message = _health(mcp_url.rsplit("/mcp", 1)[0])
    report["catenceServer"] = {"reachable": healthy, "detail": health_message}
    profile_ready = all(profile["ready"] for profile in report["profiles"] if isinstance(profile, dict))
    report["ok"] = bool(healthy and profile_ready)
    _json_output(report)
    return 0 if report["ok"] else 1


def _require_command(command: str, explanation: str) -> str:
    resolved = shutil.which(command)
    if not resolved:
        raise RuntimeError(f"{command} is required to {explanation}.")
    return resolved


def _build_frontend(root: Path, api_origin: str) -> None:
    pnpm = _require_command("pnpm", "build the Catence frontend")
    environment = dict(os.environ)
    environment["VITE_CATENCE_API_ORIGIN"] = api_origin
    result = subprocess.run([pnpm, "--filter", "@chainlit/app", "build"], cwd=root, env=environment, check=False)
    if result.returncode:
        raise RuntimeError("Catence frontend build failed.")


def _wait_for_health(mcp_url: str, process: subprocess.Popen[object]) -> None:
    deadline = time.monotonic() + 20
    health_url = mcp_url.rsplit("/mcp", 1)[0]
    while time.monotonic() < deadline:
        if process.poll() is not None:
            raise RuntimeError(f"Catence server exited with status {process.returncode} before it became ready.")
        healthy, _ = _health(health_url)
        if healthy:
            return
        time.sleep(0.25)
    raise RuntimeError("Catence server did not pass /health within 20 seconds.")


def _stop(process: subprocess.Popen[object]) -> None:
    if process.poll() is not None:
        return
    process.terminate()
    try:
        process.wait(timeout=8)
    except subprocess.TimeoutExpired:
        process.kill()
        process.wait(timeout=3)


def serve(args: argparse.Namespace) -> int:
    root = repository_root()
    ui = ui_root()
    data_directory = args.data_dir.resolve()
    mcp_url = f"http://{args.host}:{args.mcp_port}/mcp"

    if not ui.joinpath("frontend").is_dir() or not ui.joinpath("backend").is_dir():
        raise RuntimeError(f"Catence UI fork was not found at {ui}. It must be a sibling of the Catence checkout.")
    if not args.no_build_ui:
        _build_frontend(ui, f"http://{args.host}:{args.mcp_port}")

    frontend_build = ui / "frontend" / "dist" / "index.html"
    if not frontend_build.exists():
        raise RuntimeError("No built Catence frontend exists. Remove --no-build-ui or run the frontend build first.")

    environment = dict(os.environ)
    environment.update(
        {
            "CATENCE_DATA_DIR": str(data_directory),
            "CATENCE_MCP_URL": mcp_url,
            "CHAINLIT_APP_ROOT": str(root),
            "CHAINLIT_LOCAL_USER": "catence-local",
        }
    )

    catence_process: subprocess.Popen[object] | None = None
    if not args.external_mcp:
        tsx = root / "node_modules" / ".bin" / "tsx"
        if not tsx.exists():
            raise RuntimeError("Catence Node dependencies are missing. Run `npm install` in the Catence checkout first.")
        catence_command = [
            str(tsx),
            "src/interfaces/mcp/main.ts",
            "serve",
            "--data-dir",
            str(data_directory),
            "--host",
            args.host,
            "--port",
            str(args.mcp_port),
            "--allow-origin",
            f"http://127.0.0.1:{args.ui_port}",
            "--allow-origin",
            f"http://localhost:{args.ui_port}",
        ]
        catence_process = subprocess.Popen(catence_command, cwd=root, env=environment)
        _wait_for_health(mcp_url, catence_process)

    chainlit_command = [
        sys.executable,
        "-m",
        "chainlit",
        "run",
        str(root / "console" / "catence_console" / "app.py"),
        "--headless",
        "--host",
        args.host,
        "--port",
        str(args.ui_port),
    ]
    console_process = subprocess.Popen(chainlit_command, cwd=root, env=environment)
    print(f"Catence Console is starting at http://{args.host}:{args.ui_port}", flush=True)
    previous_sigterm_handler = signal.getsignal(signal.SIGTERM)

    def stop_on_sigterm(_signal_number: int, _frame: object) -> None:
        raise KeyboardInterrupt

    signal.signal(signal.SIGTERM, stop_on_sigterm)
    try:
        while True:
            if console_process.poll() is not None:
                return int(console_process.returncode or 0)
            if catence_process and catence_process.poll() is not None:
                raise RuntimeError(f"Catence server exited with status {catence_process.returncode}.")
            time.sleep(0.25)
    except KeyboardInterrupt:
        return 0
    finally:
        signal.signal(signal.SIGTERM, previous_sigterm_handler)
        _stop(console_process)
        if catence_process:
            _stop(catence_process)


def parser() -> argparse.ArgumentParser:
    command = argparse.ArgumentParser(prog="catence-console", description="Local Chainlit Console for Catence.")
    subcommands = command.add_subparsers(dest="command", required=True)

    def connection_options(subcommand: argparse.ArgumentParser) -> None:
        subcommand.add_argument("--data-dir", type=Path, default=Path(os.environ.get("CATENCE_DATA_DIR", ".catence")))
        subcommand.add_argument("--mcp-url", default=os.environ.get("CATENCE_MCP_URL", "http://127.0.0.1:8787/mcp"))

    doctor_command = subcommands.add_parser("doctor", help="Validate named profiles, required environment variables, and Catence health.")
    connection_options(doctor_command)

    serve_command = subcommands.add_parser("serve", help="Build the UI and run Catence plus Chainlit on loopback.")
    serve_command.add_argument("--data-dir", type=Path, default=Path(os.environ.get("CATENCE_DATA_DIR", ".catence")))
    serve_command.add_argument("--host", choices=("127.0.0.1", "localhost"), default="127.0.0.1")
    serve_command.add_argument("--mcp-port", type=int, default=8787)
    serve_command.add_argument("--ui-port", type=int, default=8000)
    serve_command.add_argument("--no-build-ui", action="store_true", help="Use an existing frontend build.")
    serve_command.add_argument("--external-mcp", action="store_true", help="Use an already-running Catence server at --host/--mcp-port.")
    return command


def main() -> NoReturn:
    args = parser().parse_args()
    if args.command == "doctor":
        raise SystemExit(doctor(args.data_dir.resolve(), args.mcp_url))
    try:
        raise SystemExit(serve(args))
    except RuntimeError as error:
        print(f"catence-console: {error}", file=sys.stderr)
        raise SystemExit(2) from error
