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

from .accounts import (
    AccountNotFoundError,
    AccountsError,
    AccountsStoreError,
    ConsoleAccount,
    add_account,
    default_accounts_path,
    env_account,
    find_account,
    hash_password as hash_console_password,
    load_accounts,
    remove_account,
    update_account,
)
from .auth import missing_auth_environment, validate_auth_configuration
from .config import ConsoleConfigurationError, load_console_configuration, missing_environment, referenced_environment
from .release import CATENCE_PROTOCOL_VERSION, CATENCE_RELEASE_VERSION
from .tool_server_secrets import (
    ToolServerSecretsStoreError,
    default_tool_server_secrets_path,
    load_tool_server_secrets,
)


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
    accounts_file = default_accounts_path(catalog_home)
    stored_accounts: list[ConsoleAccount] = []
    accounts_error: str | None = None
    try:
        stored_accounts = load_accounts(accounts_file)
    except AccountsStoreError as error:
        accounts_error = str(error)
    break_glass = env_account()
    missing_auth = list(missing_auth_environment())
    authentication: dict[str, object] = {
        "ready": bool(
            "CHAINLIT_AUTH_SECRET" not in missing_auth
            and accounts_error is None
            and (break_glass is not None or stored_accounts)
        ),
        "missingEnvironment": missing_auth,
        "accountsFile": str(accounts_file),
        "storedAccounts": len(stored_accounts),
        "storedAdmins": sum(1 for account in stored_accounts if account.role == "admin"),
        "storedMembers": sum(1 for account in stored_accounts if account.role == "member"),
        "environmentAccount": break_glass.username if break_glass is not None else None,
    }
    if accounts_error is not None:
        authentication["accountsError"] = accounts_error
    report["authentication"] = authentication
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
        try:
            tool_server_secrets = load_tool_server_secrets(default_tool_server_secrets_path(catalog_home))
        except ToolServerSecretsStoreError as error:
            report["toolServerSecretsError"] = str(error)
            tool_server_secrets = {}
        tool_servers = []
        for server in configuration.tool_servers.values():
            missing = [
                name
                for name in referenced_environment(server)
                if not tool_server_secrets.get(name) and not os.environ.get(name)
            ]
            tool_servers.append(
                {
                    "id": server.name,
                    "label": server.label,
                    "url": server.url,
                    "missingEnvironment": missing,
                    "ready": not missing,
                }
            )
        report["toolServers"] = tool_servers
    except ConsoleConfigurationError as error:
        report["configurationError"] = str(error)
        _json_output(report)
        return 1

    healthy, health = _health(mcp_url.rsplit("/mcp", 1)[0])
    report["catenceServer"] = {"reachable": healthy, **health}
    profile_ready = all(profile["ready"] for profile in report["profiles"] if isinstance(profile, dict))
    report["ok"] = bool(healthy and profile_ready and authentication["ready"])
    _json_output(report)
    return 0 if report["ok"] else 1


def _known_athlete_ids(catalog_home: Path) -> list[str] | None:
    """Catalog athlete ids, or None when the catalog cannot validate ids."""

    catalog_path = catalog_home / "catalog.json"
    try:
        payload = json.loads(catalog_path.read_text(encoding="utf-8"))
    except FileNotFoundError:
        print(f"catence-console: warning: no catalog at {catalog_path}; athlete ids are not validated.", file=sys.stderr)
        return None
    except (OSError, UnicodeDecodeError, json.JSONDecodeError) as error:
        print(f"catence-console: warning: cannot read {catalog_path} ({error}); athlete ids are not validated.", file=sys.stderr)
        return None
    athletes = payload.get("athletes") if isinstance(payload, dict) else None
    if not isinstance(athletes, list):
        print(f"catence-console: warning: no athlete list in {catalog_path}; athlete ids are not validated.", file=sys.stderr)
        return None
    return [entry["id"] for entry in athletes if isinstance(entry, dict) and isinstance(entry.get("id"), str)]


def _require_known_athletes(catalog_home: Path, athlete_ids: list[str]) -> None:
    known = _known_athlete_ids(catalog_home)
    if known is None:
        return
    unknown = [athlete_id for athlete_id in athlete_ids if athlete_id not in known]
    if unknown:
        known_label = ", ".join(known) if known else "(none)"
        raise RuntimeError(f"Unknown athlete id(s) {', '.join(unknown)}; this catalog has: {known_label}.")


def _password_from_environment_or_prompt(environment_variable: str | None) -> str:
    if environment_variable:
        password = os.environ.get(environment_variable)
        if not password:
            raise RuntimeError(
                f"{environment_variable} is not set or empty; cannot read the Console password from the environment."
            )
        return password
    password = getpass.getpass("Console password: ")
    confirmation = getpass.getpass("Confirm Console password: ")
    if not password:
        raise RuntimeError("Console password cannot be empty.")
    if password != confirmation:
        raise RuntimeError("Console passwords did not match.")
    return password


def _grants_label(account: ConsoleAccount) -> str:
    if account.athletes == "all":
        return "all"
    return ", ".join(account.athletes) if account.athletes else "(none)"


def _stored_account_or_error(path: Path, username: str) -> ConsoleAccount:
    account = find_account(path, username)
    if account is None:
        raise AccountNotFoundError(f"Console account {username!r} was not found in {path}.")
    return account


def users_add(args: argparse.Namespace) -> int:
    """Add a Console user: member by default, or an admin that sees all athletes."""

    catalog_home = args.home.resolve()
    if args.admin and args.athlete:
        raise RuntimeError("--admin grants access to every athlete and cannot be combined with --athlete.")
    if args.admin:
        role, athletes = "admin", "all"
    else:
        role, athletes = "member", list(args.athlete or [])
        if athletes:
            _require_known_athletes(catalog_home, athletes)
    password = _password_from_environment_or_prompt(args.password_env)
    account = add_account(
        default_accounts_path(catalog_home),
        username=args.username,
        password=password,
        role=role,
        athletes=athletes,
    )
    print(f"Added Console account {account.username!r} ({account.role}, athletes: {_grants_label(account)}).")
    return 0


def users_list(args: argparse.Namespace) -> int:
    """List stored Console users plus the environment break-glass account."""

    accounts_file = default_accounts_path(args.home.resolve())
    stored = sorted(load_accounts(accounts_file), key=lambda account: account.username)
    rows = [(account.username, account.role, _grants_label(account), "") for account in stored]
    break_glass = env_account()
    if break_glass is not None and all(row[0] != break_glass.username for row in rows):
        rows.append((break_glass.username, break_glass.role, _grants_label(break_glass), "(environment break-glass)"))
    if not rows:
        print(f"No Console accounts are configured in {accounts_file}.")
        return 0
    headers = ("USERNAME", "ROLE", "GRANTS", "SOURCE")
    widths = [max(len(row[column]) for row in [headers, *rows]) for column in range(len(headers))]
    for row in [headers, *rows]:
        print("  ".join(value.ljust(widths[column]) for column, value in enumerate(row)).rstrip())
    return 0


def users_remove(args: argparse.Namespace) -> int:
    """Remove one stored Console user."""

    removed = remove_account(default_accounts_path(args.home.resolve()), args.username)
    print(f"Removed Console account {removed.username!r}.")
    return 0


def users_passwd(args: argparse.Namespace) -> int:
    """Replace one Console user's password."""

    path = default_accounts_path(args.home.resolve())
    _stored_account_or_error(path, args.username)
    password = _password_from_environment_or_prompt(args.password_env)
    account = update_account(path, args.username, password=password)
    print(f"Updated the password for Console account {account.username!r}.")
    return 0


def users_set_role(args: argparse.Namespace) -> int:
    """Change one Console user's role; promoting to admin coerces grants to "all"."""

    account = update_account(default_accounts_path(args.home.resolve()), args.username, role=args.role)
    if args.role == "admin":
        print(f"Set Console account {account.username!r} role to admin; athlete grants are now 'all'.")
    else:
        print(
            f"Set Console account {account.username!r} role to member; "
            f"existing athlete grants were kept ({_grants_label(account)})."
        )
    return 0


def users_grant(args: argparse.Namespace) -> int:
    """Grant athletes to a member; admins already see every athlete."""

    catalog_home = args.home.resolve()
    path = default_accounts_path(catalog_home)
    account = _stored_account_or_error(path, args.username)
    if account.role == "admin":
        raise RuntimeError(f"Console account {account.username!r} is an admin and already has access to all athletes.")
    requested = list(dict.fromkeys(args.athlete_ids))
    _require_known_athletes(catalog_home, requested)
    if account.athletes == "all":
        print(f"Console account {account.username!r} already has access to all athletes.")
        return 0
    granted = [athlete_id for athlete_id in requested if athlete_id not in account.athletes]
    if not granted:
        print(f"Console account {account.username!r} already has access to: {', '.join(requested)}.")
        return 0
    updated = update_account(path, args.username, athletes=[*account.athletes, *granted])
    print(f"Granted {', '.join(granted)} to Console account {updated.username!r}; grants: {_grants_label(updated)}.")
    return 0


def users_revoke(args: argparse.Namespace) -> int:
    """Revoke athletes from a member; revoking the last grant leaves no grants."""

    catalog_home = args.home.resolve()
    path = default_accounts_path(catalog_home)
    account = _stored_account_or_error(path, args.username)
    if account.role == "admin":
        raise RuntimeError(f"Console account {account.username!r} is an admin and always has access to all athletes.")
    requested = list(dict.fromkeys(args.athlete_ids))
    _require_known_athletes(catalog_home, requested)
    if account.athletes == "all":
        raise RuntimeError(
            f"Console account {account.username!r} currently has access to all athletes; single revocations are not "
            "representable. Give the account an explicit grant list in console/accounts.json first."
        )
    revoked = [athlete_id for athlete_id in requested if athlete_id in account.athletes]
    if not revoked:
        print(f"Console account {account.username!r} had none of: {', '.join(requested)}.")
        return 0
    updated = update_account(
        path,
        args.username,
        athletes=[athlete_id for athlete_id in account.athletes if athlete_id not in revoked],
    )
    print(f"Revoked {', '.join(revoked)} from Console account {updated.username!r}; grants: {_grants_label(updated)}.")
    return 0


def _dispatch_users(args: argparse.Namespace) -> int:
    handlers = {
        "add": users_add,
        "list": users_list,
        "remove": users_remove,
        "passwd": users_passwd,
        "set-role": users_set_role,
        "grant": users_grant,
        "revoke": users_revoke,
    }
    return handlers[args.users_command](args)


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

    # Best-effort data migration for Docker updates. The Node runtime bumps
    # the DuckDB schema (canonical_training_derived_avg_power_w etc.); a
    # stale file would make the read-only MCP health probe reject requests
    # until the next manual sync. Running `catence-data migrate --all`
    # here (when Node is available) heals an existing beta install on plain
    # `docker compose up` without wiping the volume. Failures are ignored
    # so a missing Node binary or a locked store does not block the console.
    try:
        catence_bin = shutil.which("catence-data") or shutil.which("catence")
        if catence_bin:
            subprocess.run(
                [catence_bin, "--home", str(catalog_home), "migrate", "--all"],
                timeout=30,
                stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL,
                check=False,
            )
        else:
            # Fallback for source checkouts where the binary is only via npx.
            subprocess.run(
                ["npx", "--yes", f"catence@{CATENCE_RELEASE_VERSION}", "--home", str(catalog_home), "migrate", "--all"],
                timeout=30,
                stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL,
                check=False,
            )
    except Exception:
        pass

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

    def home_option(subcommand: argparse.ArgumentParser) -> None:
        subcommand.add_argument(
            "--home",
            type=Path,
            default=Path(os.environ.get("CATENCE_HOME", str(Path.home() / ".catence"))),
            help="Catence data directory holding console/accounts.json.",
        )

    def password_option(subcommand: argparse.ArgumentParser) -> None:
        subcommand.add_argument(
            "--password-env",
            metavar="VAR",
            default=None,
            help="Read the password from environment variable VAR instead of prompting (for automation).",
        )

    users_command = subcommands.add_parser("users", help="Manage per-account Console logins and athlete access.")
    users_subcommands = users_command.add_subparsers(dest="users_command", required=True)

    add_command = users_subcommands.add_parser("add", help="Add a Console user; members get explicit athlete grants.")
    add_command.add_argument("username")
    add_command.add_argument("--admin", action="store_true", help="Grant the admin role, which sees all athletes.")
    add_command.add_argument("--athlete", action="append", metavar="ATHLETE_ID", help="Grant one athlete id (repeatable).")
    password_option(add_command)
    home_option(add_command)

    list_command = users_subcommands.add_parser("list", help="List Console users, their roles, and their athlete grants.")
    home_option(list_command)

    remove_command = users_subcommands.add_parser("remove", help="Remove a Console user.")
    remove_command.add_argument("username")
    home_option(remove_command)

    passwd_command = users_subcommands.add_parser("passwd", help="Change a Console user's password.")
    passwd_command.add_argument("username")
    password_option(passwd_command)
    home_option(passwd_command)

    set_role_command = users_subcommands.add_parser("set-role", help="Change a Console user's role.")
    set_role_command.add_argument("username")
    set_role_command.add_argument("role", choices=("admin", "member"))
    home_option(set_role_command)

    grant_command = users_subcommands.add_parser("grant", help="Grant athletes to a member.")
    grant_command.add_argument("username")
    grant_command.add_argument("athlete_ids", nargs="+", metavar="ATHLETE_ID")
    home_option(grant_command)

    revoke_command = users_subcommands.add_parser("revoke", help="Revoke athletes from a member.")
    revoke_command.add_argument("username")
    revoke_command.add_argument("athlete_ids", nargs="+", metavar="ATHLETE_ID")
    home_option(revoke_command)
    return command


def hash_password() -> int:
    password = getpass.getpass("Console password: ")
    confirmation = getpass.getpass("Confirm Console password: ")
    if not password:
        raise RuntimeError("Console password cannot be empty.")
    if password != confirmation:
        raise RuntimeError("Console passwords did not match.")
    print(hash_console_password(password))
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
    if args.command == "users":
        try:
            raise SystemExit(_dispatch_users(args))
        except (AccountsError, RuntimeError) as error:
            print(f"catence-console: {error}", file=sys.stderr)
            raise SystemExit(1) from error
    try:
        raise SystemExit(serve(args))
    except RuntimeError as error:
        print(f"catence-console: {error}", file=sys.stderr)
        raise SystemExit(2) from error
