"""Local launcher and preflight checks for Catence Console."""

from __future__ import annotations

import argparse
import getpass
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

from .auth import missing_auth_environment, validate_auth_configuration
from .config import ConsoleConfigurationError, load_console_configuration, missing_environment
from .release import CATENCE_PROTOCOL_VERSION, CATENCE_RELEASE_VERSION


def _json_output(value: object) -> None:
    print(json.dumps(value, indent=2, sort_keys=True))


def _health(url: str) -> tuple[bool, dict[str, object]]:
    try:
        with urllib.request.urlopen(url.rstrip("/") + "/health", timeout=3) as response:
            payload = json.loads(response.read().decode("utf-8"))
        if not isinstance(payload, dict) or response.status != 200 or payload.get("status") != "ok" or payload.get("service") != "catence":
            return False, {"detail": "Catence health response was not recognized."}
        protocol_version = payload.get("protocolVersion")
        if protocol_version != CATENCE_PROTOCOL_VERSION:
            return False, {
                "detail": f"Console requires Catence protocol {CATENCE_PROTOCOL_VERSION}; server reports {protocol_version!r}.",
                "runtimeVersion": payload.get("runtimeVersion"),
                "protocolVersion": protocol_version,
            }
        return True, {
            "detail": "reachable",
            "runtimeVersion": payload.get("runtimeVersion"),
            "protocolVersion": protocol_version,
            "capabilities": payload.get("capabilities"),
        }
    except (urllib.error.URLError, TimeoutError, json.JSONDecodeError) as error:
        return False, {"detail": str(error)}


def doctor(catalog_home: Path, mcp_url: str) -> int:
    report: dict[str, object] = {
        "home": str(catalog_home),
        "mcpUrl": mcp_url,
        "profiles": [],
        "ok": False,
    }
    missing_auth = list(missing_auth_environment())
    report["authentication"] = {"ready": not missing_auth, "missingEnvironment": missing_auth}
    try:
        configuration = load_console_configuration(catalog_home)
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

    healthy, health = _health(mcp_url.rsplit("/mcp", 1)[0])
    report["catenceServer"] = {"reachable": healthy, **health}
    profile_ready = all(profile["ready"] for profile in report["profiles"] if isinstance(profile, dict))
    report["ok"] = bool(healthy and profile_ready and not missing_auth)
    _json_output(report)
    return 0 if report["ok"] else 1


def _require_command(command: str, explanation: str) -> str:
    resolved = shutil.which(command)
    if not resolved:
        raise RuntimeError(f"{command} is required to {explanation}.")
    return resolved


def _wait_for_health(mcp_url: str, process: subprocess.Popen[object] | None) -> None:
    deadline = time.monotonic() + 20
    health_url = mcp_url.rsplit("/mcp", 1)[0]
    while time.monotonic() < deadline:
        if process and process.poll() is not None:
            raise RuntimeError(f"Catence server exited with status {process.returncode} before it became ready.")
        healthy, _ = _health(health_url)
        if healthy:
            return
        time.sleep(0.25)
    raise RuntimeError("Catence server did not pass /health within 20 seconds.")


def _runtime_command(catalog_home: Path, host: str, mcp_port: int, ui_port: int) -> list[str]:
    runtime = shutil.which("catence")
    command = [runtime, "serve"] if runtime else [
        _require_command("npx", "start the matching Catence runtime"),
        "--yes",
        f"catence@{CATENCE_RELEASE_VERSION}",
        "serve",
    ]
    return [
        *command,
        "--home",
        str(catalog_home),
        "--host",
        host,
        "--port",
        str(mcp_port),
        "--allow-origin",
        f"http://127.0.0.1:{ui_port}",
        "--allow-origin",
        f"http://localhost:{ui_port}",
    ]


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
    catalog_home = args.home.resolve()
    mcp_url = args.mcp_url or f"http://{args.mcp_host}:{args.mcp_port}/mcp"
    console_root = Path(__file__).resolve().parent
    validate_auth_configuration()

    environment = dict(os.environ)
    environment.update(
        {
            "CATENCE_HOME": str(catalog_home),
            "CATENCE_MCP_URL": mcp_url,
            "CHAINLIT_APP_ROOT": str(console_root),
        }
    )

    catence_process: subprocess.Popen[object] | None = None
    if args.mcp_url or args.external_mcp:
        _wait_for_health(mcp_url, None)
    else:
        catence_process = subprocess.Popen(_runtime_command(catalog_home, args.mcp_host, args.mcp_port, args.ui_port), env=environment)
        _wait_for_health(mcp_url, catence_process)

    chainlit_command = [
        sys.executable,
        "-m",
        "chainlit",
        "run",
        str(console_root / "app.py"),
        "--headless",
        "--host",
        args.ui_host,
        "--port",
        str(args.ui_port),
    ]
    console_process = subprocess.Popen(chainlit_command, cwd=console_root, env=environment)
    print(f"Catence Console is starting at http://{args.ui_host}:{args.ui_port}", flush=True)
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
    command.add_argument("--version", action="version", version=f"catence-console {CATENCE_RELEASE_VERSION}")
    subcommands = command.add_subparsers(dest="command", required=True)

    def connection_options(subcommand: argparse.ArgumentParser) -> None:
        subcommand.add_argument("--home", type=Path, default=Path(os.environ.get("CATENCE_HOME", str(Path.home() / ".catence"))))
        subcommand.add_argument("--mcp-url", default=os.environ.get("CATENCE_MCP_URL", "http://127.0.0.1:8787/mcp"))

    doctor_command = subcommands.add_parser("doctor", help="Validate named profiles, required environment variables, and Catence health.")
    connection_options(doctor_command)

    serve_command = subcommands.add_parser("serve", help="Run the packaged Console and a matching Catence runtime on loopback.")
    serve_command.add_argument("--home", type=Path, default=Path(os.environ.get("CATENCE_HOME", str(Path.home() / ".catence"))))
    serve_command.add_argument("--mcp-url", default=os.environ.get("CATENCE_MCP_URL"), help="Use an already-running compatible Catence HTTP MCP server.")
    serve_command.add_argument("--ui-host", default=os.environ.get("CATENCE_CONSOLE_HOST", "127.0.0.1"))
    serve_command.add_argument("--mcp-host", default="127.0.0.1")
    serve_command.add_argument("--mcp-port", type=int, default=8787)
    serve_command.add_argument("--ui-port", type=int, default=8000)
    serve_command.add_argument("--no-build-ui", action="store_true", help="Deprecated no-op; catence-chainlit includes prebuilt frontend assets.")
    serve_command.add_argument("--external-mcp", action="store_true", help="Deprecated alias for using the loopback server already running at --host/--mcp-port.")
    auth_command = subcommands.add_parser("auth", help="Generate or validate Console login configuration.")
    auth_command.add_subparsers(dest="auth_command", required=True).add_parser(
        "hash-password", help="Prompt for a password and print a bcrypt hash for CATENCE_CONSOLE_PASSWORD_HASH."
    )
    return command


def hash_password() -> int:
    password = getpass.getpass("Console password: ")
    confirmation = getpass.getpass("Confirm Console password: ")
    if not password:
        raise RuntimeError("Console password cannot be empty.")
    if password != confirmation:
        raise RuntimeError("Console passwords did not match.")
    import bcrypt

    print(bcrypt.hashpw(password.encode("utf-8"), bcrypt.gensalt()).decode("utf-8"))
    return 0


def main() -> NoReturn:
    args = parser().parse_args()
    if args.command == "doctor":
        raise SystemExit(doctor(args.home.resolve(), args.mcp_url))
    if args.command == "auth" and args.auth_command == "hash-password":
        try:
            raise SystemExit(hash_password())
        except RuntimeError as error:
            print(f"catence-console: {error}", file=sys.stderr)
            raise SystemExit(2) from error
    try:
        raise SystemExit(serve(args))
    except RuntimeError as error:
        print(f"catence-console: {error}", file=sys.stderr)
        raise SystemExit(2) from error
