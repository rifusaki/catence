import json
from argparse import Namespace
from pathlib import Path

from catence_console import cli


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

    assert command[:4] == ["npx", "--yes", "catence@0.2.0", "serve"]
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
    assert calls[0]["cwd"] == Path(cli.__file__).resolve().parent
    assert calls[0]["command"][4] == str(Path(cli.__file__).resolve().with_name("app.py"))
