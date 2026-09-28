import json
import sys
from argparse import Namespace
from pathlib import Path

import pytest

from catence_console import accounts, cli
from catence_console.release import CATENCE_RELEASE_VERSION


class FakeResponse:
    status = 200

    def __init__(self, payload: dict[str, object]) -> None:
        self.payload = payload

    def read(self) -> bytes:
        return json.dumps(self.payload).encode("utf-8")

    def __enter__(self) -> "FakeResponse":
        return self

    def __exit__(self, *_: object) -> None:
        return None


def test_health_requires_the_console_protocol(monkeypatch):
    monkeypatch.setattr(
        cli.urllib.request,
        "urlopen",
        lambda *_args, **_kwargs: FakeResponse(
            {
                "status": "ok",
                "service": "catence",
                "runtimeVersion": "0.1.0",
                "protocolVersion": 1,
                "capabilities": {"mcp": True, "dashboardApi": 1, "demoStore": True},
            }
        ),
    )

    healthy, details = cli._health("http://127.0.0.1:8787")

    assert healthy is True
    assert details["runtimeVersion"] == "0.1.0"
    assert details["protocolVersion"] == 1


def test_health_rejects_an_incompatible_protocol(monkeypatch):
    monkeypatch.setattr(
        cli.urllib.request,
        "urlopen",
        lambda *_args, **_kwargs: FakeResponse({"status": "ok", "service": "catence", "runtimeVersion": "0.2.0", "protocolVersion": 2}),
    )

    healthy, details = cli._health("http://127.0.0.1:8787")

    assert healthy is False
    assert "requires Catence protocol 1" in str(details["detail"])


def test_runtime_command_uses_the_lockstep_npm_release(monkeypatch, tmp_path):
    monkeypatch.setattr(cli, "_require_command", lambda command, _explanation: command)
    monkeypatch.setattr(cli.shutil, "which", lambda _command: None)

    command = cli._runtime_command(tmp_path, "127.0.0.1", 8787, 8000)

    assert command[:4] == ["npx", "--yes", f"catence@{CATENCE_RELEASE_VERSION}", "serve"]
    assert command[command.index("--home") + 1] == str(tmp_path)


def test_serve_runs_chainlit_from_the_installed_console_package(monkeypatch, tmp_path):
    class FakeProcess:
        returncode = 0

        def poll(self):
            return self.returncode

        def terminate(self):
            return None

        def wait(self, timeout: float):
            return self.returncode

    calls: list[dict[str, object]] = []

    def fake_popen(command, **kwargs):
        calls.append({"command": command, **kwargs})
        return FakeProcess()

    monkeypatch.setattr(cli, "_wait_for_health", lambda *_args: None)
    monkeypatch.setattr(cli, "validate_auth_configuration", lambda: None)
    monkeypatch.setattr(cli.subprocess, "Popen", fake_popen)

    result = cli.serve(
        Namespace(
            home=tmp_path,
            mcp_url="http://127.0.0.1:8787/mcp",
            ui_host="127.0.0.1",
            mcp_host="127.0.0.1",
            mcp_port=8787,
            ui_port=8000,
            external_mcp=False,
        )
    )

    assert result == 0
    # serve() first runs a best-effort `catence-data migrate --all` via
    # subprocess.run, which internally constructs a Popen; the patched Popen
    # therefore captures that migrate call too. Find the chainlit process by
    # command instead of assuming it is the very first call.
    chainlit_call = next(call for call in calls if "chainlit" in call["command"])
    assert chainlit_call["cwd"] == Path(cli.__file__).resolve().parent
    assert chainlit_call["command"][4] == str(Path(cli.__file__).resolve().with_name("app.py"))


def run_cli(monkeypatch, tmp_path, arguments, environment=None):
    """Run ``catence-console`` against a hermetic $CATENCE_HOME and return its exit code."""

    monkeypatch.setenv("CATENCE_HOME", str(tmp_path))
    monkeypatch.delenv("CATENCE_CONSOLE_USERNAME", raising=False)
    monkeypatch.delenv("CATENCE_CONSOLE_PASSWORD_HASH", raising=False)
    for name, value in (environment or {}).items():
        monkeypatch.setenv(name, value)
    monkeypatch.setattr(sys, "argv", ["catence-console", *arguments])
    with pytest.raises(SystemExit) as exit_info:
        cli.main()
    return int(exit_info.value.code or 0)


def write_catalog(tmp_path, *athlete_ids):
    payload = {
        "formatVersion": 1,
        "defaultAthleteId": athlete_ids[0],
        "athletes": [
            {"id": athlete_id, "label": athlete_id.title(), "createdAt": "2026-08-21T21:57:29.368Z"}
            for athlete_id in athlete_ids
        ],
    }
    (tmp_path / "catalog.json").write_text(json.dumps(payload), encoding="utf-8")


def test_users_add_reads_the_password_from_the_environment(monkeypatch, tmp_path, capsys):
    monkeypatch.setenv("TEST_CONSOLE_PASSWORD", "correct horse")
    write_catalog(tmp_path, "martina")

    result = run_cli(
        monkeypatch,
        tmp_path,
        ["users", "add", "martina", "--athlete", "martina", "--password-env", "TEST_CONSOLE_PASSWORD"],
    )

    assert result == 0
    stored = accounts.load_accounts(accounts.default_accounts_path(tmp_path))
    assert [(account.username, account.role, account.athletes) for account in stored] == [("martina", "member", ["martina"])]
    assert accounts.verify_password(stored[0], "correct horse") is True
    assert "Added Console account 'martina'" in capsys.readouterr().out


def test_users_add_defaults_to_member_and_supports_admins(monkeypatch, tmp_path):
    monkeypatch.setenv("TEST_CONSOLE_PASSWORD", "pw")

    assert run_cli(monkeypatch, tmp_path, ["users", "add", "martina", "--password-env", "TEST_CONSOLE_PASSWORD"]) == 0
    assert run_cli(monkeypatch, tmp_path, ["users", "add", "coach", "--admin", "--password-env", "TEST_CONSOLE_PASSWORD"]) == 0

    stored = {account.username: account for account in accounts.load_accounts(accounts.default_accounts_path(tmp_path))}
    assert (stored["martina"].role, stored["martina"].athletes) == ("member", [])
    assert (stored["coach"].role, stored["coach"].athletes) == ("admin", "all")


def test_users_add_warns_when_no_catalog_can_validate_athlete_ids(monkeypatch, tmp_path, capsys):
    monkeypatch.setenv("TEST_CONSOLE_PASSWORD", "pw")

    result = run_cli(
        monkeypatch,
        tmp_path,
        ["users", "add", "martina", "--athlete", "martina", "--password-env", "TEST_CONSOLE_PASSWORD"],
    )

    assert result == 0
    assert "warning: no catalog" in capsys.readouterr().err


def test_users_add_requires_a_password_source(monkeypatch, tmp_path, capsys):
    result = run_cli(monkeypatch, tmp_path, ["users", "add", "martina", "--password-env", "UNSET_PASSWORD"])

    assert result == 1
    assert "UNSET_PASSWORD is not set" in capsys.readouterr().err


def test_users_add_rejects_duplicates_and_admin_athlete_mixes(monkeypatch, tmp_path, capsys):
    monkeypatch.setenv("TEST_CONSOLE_PASSWORD", "pw")
    assert run_cli(monkeypatch, tmp_path, ["users", "add", "martina", "--password-env", "TEST_CONSOLE_PASSWORD"]) == 0
    capsys.readouterr()

    duplicate = run_cli(monkeypatch, tmp_path, ["users", "add", "martina", "--password-env", "TEST_CONSOLE_PASSWORD"])
    assert duplicate == 1
    assert "already exists" in capsys.readouterr().err

    mixed = run_cli(
        monkeypatch,
        tmp_path,
        ["users", "add", "coach", "--admin", "--athlete", "martina", "--password-env", "TEST_CONSOLE_PASSWORD"],
    )
    assert mixed == 1
    assert "cannot be combined" in capsys.readouterr().err


def test_users_add_prompts_interactively_and_requires_matching_passwords(monkeypatch, tmp_path, capsys):
    prompts = iter(["first", "second"])
    monkeypatch.setattr(cli.getpass, "getpass", lambda _prompt: next(prompts))

    result = run_cli(monkeypatch, tmp_path, ["users", "add", "martina"])

    assert result == 1
    assert "did not match" in capsys.readouterr().err
    assert accounts.load_accounts(accounts.default_accounts_path(tmp_path)) == []


def test_users_add_accepts_interactive_passwords(monkeypatch, tmp_path):
    prompts = iter(["pw", "pw"])
    monkeypatch.setattr(cli.getpass, "getpass", lambda _prompt: next(prompts))

    result = run_cli(monkeypatch, tmp_path, ["users", "add", "martina"])

    assert result == 0
    stored = accounts.load_accounts(accounts.default_accounts_path(tmp_path))
    assert accounts.verify_password(stored[0], "pw") is True


def test_users_list_shows_roles_grants_and_break_glass(monkeypatch, tmp_path, capsys):
    write_catalog(tmp_path, "martina", "luca")
    accounts.add_account(accounts.default_accounts_path(tmp_path), username="martina", password="pw", role="member", athletes=["martina"])
    accounts.add_account(accounts.default_accounts_path(tmp_path), username="coach", password="pw", role="admin", athletes="all")

    result = run_cli(
        monkeypatch,
        tmp_path,
        ["users", "list"],
        environment={
            "CATENCE_CONSOLE_USERNAME": "root",
            "CATENCE_CONSOLE_PASSWORD_HASH": "$2b$12$fakefakefakefakefakefakefakefakefakefakefakefakefakefa",
        },
    )

    assert result == 0
    output = capsys.readouterr().out
    assert "martina" in output
    assert "member" in output
    assert "all" in output
    assert "root" in output
    assert "(environment break-glass)" in output
    assert "$2" not in output


def test_users_list_reports_an_empty_store(monkeypatch, tmp_path, capsys):
    result = run_cli(monkeypatch, tmp_path, ["users", "list"])

    assert result == 0
    assert "No Console accounts are configured" in capsys.readouterr().out


def test_users_remove_and_unknown_users(monkeypatch, tmp_path, capsys):
    monkeypatch.setenv("TEST_CONSOLE_PASSWORD", "pw")
    path = accounts.default_accounts_path(tmp_path)
    assert run_cli(monkeypatch, tmp_path, ["users", "add", "martina", "--password-env", "TEST_CONSOLE_PASSWORD"]) == 0
    capsys.readouterr()

    assert run_cli(monkeypatch, tmp_path, ["users", "remove", "martina"]) == 0
    assert accounts.load_accounts(path) == []
    assert "Removed Console account 'martina'" in capsys.readouterr().out

    missing = run_cli(monkeypatch, tmp_path, ["users", "remove", "martina"])
    assert missing == 1
    assert "not found" in capsys.readouterr().err


def test_users_passwd_replaces_the_password(monkeypatch, tmp_path):
    monkeypatch.setenv("TEST_CONSOLE_PASSWORD", "first")
    monkeypatch.setenv("TEST_NEW_PASSWORD", "second")
    path = accounts.default_accounts_path(tmp_path)
    assert run_cli(monkeypatch, tmp_path, ["users", "add", "martina", "--password-env", "TEST_CONSOLE_PASSWORD"]) == 0

    result = run_cli(monkeypatch, tmp_path, ["users", "passwd", "martina", "--password-env", "TEST_NEW_PASSWORD"])

    assert result == 0
    stored = accounts.load_accounts(path)[0]
    assert accounts.verify_password(stored, "second") is True
    assert accounts.verify_password(stored, "first") is False

    unknown = run_cli(monkeypatch, tmp_path, ["users", "passwd", "nobody", "--password-env", "TEST_NEW_PASSWORD"])
    assert unknown == 1


def test_users_set_role_coerces_admins_and_keeps_grants_when_demoting(monkeypatch, tmp_path, capsys):
    write_catalog(tmp_path, "martina")
    accounts.add_account(accounts.default_accounts_path(tmp_path), username="martina", password="pw", role="member", athletes=["martina"])

    assert run_cli(monkeypatch, tmp_path, ["users", "set-role", "martina", "admin"]) == 0
    promoted = accounts.load_accounts(accounts.default_accounts_path(tmp_path))[0]
    assert (promoted.role, promoted.athletes) == ("admin", "all")
    assert "now 'all'" in capsys.readouterr().out

    assert run_cli(monkeypatch, tmp_path, ["users", "set-role", "martina", "member"]) == 0
    demoted = accounts.load_accounts(accounts.default_accounts_path(tmp_path))[0]
    assert (demoted.role, demoted.athletes) == ("member", "all")


def test_users_grant_and_revoke_manage_member_grants(monkeypatch, tmp_path, capsys):
    write_catalog(tmp_path, "martina", "luca")
    accounts.add_account(accounts.default_accounts_path(tmp_path), username="martina", password="pw", role="member", athletes=[])

    assert run_cli(monkeypatch, tmp_path, ["users", "grant", "martina", "martina"]) == 0
    assert accounts.load_accounts(accounts.default_accounts_path(tmp_path))[0].athletes == ["martina"]

    assert run_cli(monkeypatch, tmp_path, ["users", "grant", "martina", "martina", "luca"]) == 0
    assert accounts.load_accounts(accounts.default_accounts_path(tmp_path))[0].athletes == ["martina", "luca"]

    assert run_cli(monkeypatch, tmp_path, ["users", "revoke", "martina", "martina", "luca"]) == 0
    assert accounts.load_accounts(accounts.default_accounts_path(tmp_path))[0].athletes == []

    assert run_cli(monkeypatch, tmp_path, ["users", "revoke", "martina", "luca"]) == 0
    assert "had none of" in capsys.readouterr().out


def test_users_grant_and_revoke_reject_admins_and_unknown_users(monkeypatch, tmp_path, capsys):
    accounts.add_account(accounts.default_accounts_path(tmp_path), username="coach", password="pw", role="admin", athletes="all")

    assert run_cli(monkeypatch, tmp_path, ["users", "grant", "coach", "martina"]) == 1
    assert "admin" in capsys.readouterr().err

    assert run_cli(monkeypatch, tmp_path, ["users", "revoke", "coach", "martina"]) == 1

    unknown = run_cli(monkeypatch, tmp_path, ["users", "grant", "nobody", "martina"])
    assert unknown == 1
    assert "not found" in capsys.readouterr().err


def test_users_commands_reject_unknown_athletes_when_a_catalog_exists(monkeypatch, tmp_path, capsys):
    write_catalog(tmp_path, "martina", "luca")

    result = run_cli(monkeypatch, tmp_path, ["users", "add", "martina", "--athlete", "ghost", "--password-env", "UNSET"])

    assert result == 1
    error = capsys.readouterr().err
    assert "Unknown athlete id(s) ghost" in error
    assert "martina, luca" in error
    assert accounts.load_accounts(accounts.default_accounts_path(tmp_path)) == []


def test_users_commands_accept_an_explicit_home(monkeypatch, tmp_path):
    elsewhere = tmp_path / "elsewhere"
    monkeypatch.setenv("TEST_CONSOLE_PASSWORD", "pw")

    result = run_cli(
        monkeypatch,
        tmp_path,
        ["users", "add", "martina", "--password-env", "TEST_CONSOLE_PASSWORD", "--home", str(elsewhere)],
    )

    assert result == 0
    assert accounts.load_accounts(accounts.default_accounts_path(elsewhere))[0].username == "martina"
    assert accounts.load_accounts(accounts.default_accounts_path(tmp_path)) == []
