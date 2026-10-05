import json

import bcrypt
import pytest
from chainlit.auth.jwt import create_jwt
from chainlit.user import User
from fastapi.testclient import TestClient

from catence_console import app
from catence_console.accounts import ACCOUNTS_FORMAT_VERSION, default_accounts_path
from catence_console.tool_server_secrets import (
    default_tool_server_secrets_path,
    load_tool_server_secrets,
)

CREATED_AT = "2026-09-28T12:00:00+00:00"
PASSWORD_HASH = bcrypt.hashpw(b"correct horse", bcrypt.gensalt()).decode("utf-8")

BREAK_GLASS_USERNAME = "coach-env"

STORED_SECRET = "exa-secret-value"


def _stored_account(username: str, role: str, athletes: str | list[str]) -> dict:
    return {
        "username": username,
        "passwordHash": PASSWORD_HASH,
        "role": role,
        "athletes": athletes,
        "createdAt": CREATED_AT,
    }


def _config_payload() -> dict:
    return {
        "console": {
            "profiles": {"local": {"model": "openai/example"}},
            "mcpServers": {
                "exa": {
                    "url": "https://mcp.exa.ai/mcp",
                    "headers": {"x-api-key": "$EXA_API_KEY"},
                },
                "weather": {
                    "label": "Weather",
                    "url": "https://weather.example.test/mcp?token=${WEATHER_TOKEN}",
                },
            },
        }
    }


def _prepare_home(tmp_path, monkeypatch, *, accounts: bool) -> None:
    monkeypatch.setenv("CATENCE_HOME", str(tmp_path))
    monkeypatch.setenv("CHAINLIT_AUTH_SECRET", "test-secret-that-is-long-enough-for-hs256")
    monkeypatch.delenv("CATENCE_CONSOLE_USERNAME", raising=False)
    monkeypatch.delenv("CATENCE_CONSOLE_PASSWORD_HASH", raising=False)
    monkeypatch.delenv("CHAINLIT_LOCAL_USER", raising=False)
    monkeypatch.delenv("EXA_API_KEY", raising=False)
    monkeypatch.delenv("WEATHER_TOKEN", raising=False)
    if accounts:
        path = default_accounts_path(tmp_path)
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(
            json.dumps(
                {
                    "formatVersion": ACCOUNTS_FORMAT_VERSION,
                    "accounts": [
                        _stored_account("coach", "admin", "all"),
                        _stored_account("rifusaki", "member", ["martina"]),
                    ],
                }
            ),
            encoding="utf-8",
        )
    (tmp_path / "config.json").write_text(json.dumps(_config_payload()), encoding="utf-8")
    # app.DATA_DIRECTORY is resolved once at import time, so handlers need the
    # hermetic home injected directly.
    monkeypatch.setattr(app, "DATA_DIRECTORY", tmp_path)


@pytest.fixture
def tool_servers_home(tmp_path, monkeypatch):
    """A hermetic CATENCE_HOME with stored accounts and configured tool servers."""

    _prepare_home(tmp_path, monkeypatch, accounts=True)
    return tmp_path


@pytest.fixture
def break_glass_tool_servers_home(tmp_path, monkeypatch):
    """A hermetic CATENCE_HOME where only the environment break-glass admin exists."""

    _prepare_home(tmp_path, monkeypatch, accounts=False)
    monkeypatch.setenv("CATENCE_CONSOLE_USERNAME", BREAK_GLASS_USERNAME)
    monkeypatch.setenv("CATENCE_CONSOLE_PASSWORD_HASH", PASSWORD_HASH)
    return tmp_path


def client_for(username: str) -> TestClient:
    """A TestClient carrying a valid session cookie for ``username``."""

    client = TestClient(app.chainlit_server)
    client.cookies.set(
        "access_token",
        create_jwt(User(identifier=username, display_name=username, metadata={})),
    )
    return client


def _stored_secrets(home) -> dict[str, str]:
    return load_tool_server_secrets(default_tool_server_secrets_path(home))


def _exa_credentials(payload: dict) -> dict:
    server = next(server for server in payload["servers"] if server["name"] == "exa")
    return server["secrets"][0]


# ------------------------------------------------------------------ overview


def test_tool_servers_overview_requires_login():
    response = TestClient(app.chainlit_server).get("/api/v1/tool-servers")

    assert response.status_code == 401
    assert response.json()["error"]["code"] == "unauthorized"


def test_tool_servers_overview_is_admin_only(tool_servers_home):
    response = client_for("rifusaki").get("/api/v1/tool-servers")

    assert response.status_code == 403
    assert response.json()["error"]["code"] == "admin_required"


def test_tool_servers_overview_lists_servers_and_credential_readiness(tool_servers_home):
    response = client_for("coach").get("/api/v1/tool-servers")

    assert response.status_code == 200
    assert response.json() == {
        "servers": [
            {
                "name": "exa",
                "label": "exa",
                "url": "https://mcp.exa.ai/mcp",
                "secrets": [{"name": "EXA_API_KEY", "configured": False, "source": None}],
            },
            {
                "name": "weather",
                "label": "Weather",
                "url": "https://weather.example.test/mcp?token=${WEATHER_TOKEN}",
                "secrets": [{"name": "WEATHER_TOKEN", "configured": False, "source": None}],
            },
        ]
    }


def test_tool_servers_overview_includes_the_default_exa_server(tmp_path, monkeypatch):
    _prepare_home(tmp_path, monkeypatch, accounts=True)
    (tmp_path / "config.json").write_text(
        json.dumps({"console": {"profiles": {"local": {"model": "openai/example"}}}}),
        encoding="utf-8",
    )

    response = client_for("coach").get("/api/v1/tool-servers")

    assert response.status_code == 200
    assert response.json() == {
        "servers": [
            {
                "name": "exa",
                "label": "Exa Web Search",
                "url": "https://mcp.exa.ai/mcp?tools=web_search_exa,web_fetch_exa",
                "secrets": [],
            }
        ]
    }


def test_tool_servers_overview_reports_console_and_environment_sources(tool_servers_home, monkeypatch):
    secrets_path = default_tool_server_secrets_path(tool_servers_home)
    secrets_path.parent.mkdir(parents=True, exist_ok=True)
    secrets_path.write_text(
        json.dumps({"formatVersion": 1, "secrets": {"EXA_API_KEY": STORED_SECRET}}),
        encoding="utf-8",
    )
    monkeypatch.setenv("WEATHER_TOKEN", "env-weather-token")

    payload = client_for("coach").get("/api/v1/tool-servers").json()

    assert _exa_credentials(payload) == {"name": "EXA_API_KEY", "configured": True, "source": "console"}
    weather = next(server for server in payload["servers"] if server["name"] == "weather")
    assert weather["secrets"] == [{"name": "WEATHER_TOKEN", "configured": True, "source": "environment"}]


def test_tool_servers_overview_rejects_non_get(tool_servers_home):
    response = client_for("coach").put("/api/v1/tool-servers")

    assert response.status_code == 405
    assert response.json()["error"]["code"] == "method_not_allowed"


def test_missing_console_configuration_is_reported(tmp_path, monkeypatch):
    monkeypatch.setenv("CATENCE_HOME", str(tmp_path))
    monkeypatch.setenv("CHAINLIT_AUTH_SECRET", "test-secret-that-is-long-enough-for-hs256")
    monkeypatch.setenv("CATENCE_CONSOLE_USERNAME", BREAK_GLASS_USERNAME)
    monkeypatch.setenv("CATENCE_CONSOLE_PASSWORD_HASH", PASSWORD_HASH)
    monkeypatch.delenv("CHAINLIT_LOCAL_USER", raising=False)
    monkeypatch.setattr(app, "DATA_DIRECTORY", tmp_path)

    response = client_for(BREAK_GLASS_USERNAME).get("/api/v1/tool-servers")

    assert response.status_code == 400
    assert response.json()["error"]["code"] == "invalid_request"


# ------------------------------------------------------------------ mutations


def test_setting_a_credential_stores_it_without_returning_the_value(tool_servers_home):
    response = client_for("coach").post(
        "/api/v1/tool-servers/exa/secrets",
        json={"name": "EXA_API_KEY", "value": STORED_SECRET},
    )

    assert response.status_code == 200
    assert STORED_SECRET not in response.text
    assert _exa_credentials(response.json()) == {"name": "EXA_API_KEY", "configured": True, "source": "console"}
    assert _stored_secrets(tool_servers_home) == {"EXA_API_KEY": STORED_SECRET}


def test_clearing_a_credential_falls_back_to_the_environment(tool_servers_home, monkeypatch):
    client_for("coach").post(
        "/api/v1/tool-servers/exa/secrets",
        json={"name": "EXA_API_KEY", "value": STORED_SECRET},
    )
    monkeypatch.setenv("EXA_API_KEY", "from-the-environment")

    response = client_for("coach").post(
        "/api/v1/tool-servers/exa/secrets",
        json={"name": "EXA_API_KEY", "value": None},
    )

    assert response.status_code == 200
    assert _exa_credentials(response.json()) == {"name": "EXA_API_KEY", "configured": True, "source": "environment"}
    assert _stored_secrets(tool_servers_home) == {}


def test_clearing_an_unset_credential_reports_not_configured(tool_servers_home):
    response = client_for("coach").post(
        "/api/v1/tool-servers/exa/secrets",
        json={"name": "EXA_API_KEY", "value": None},
    )

    assert response.status_code == 200
    assert _exa_credentials(response.json()) == {"name": "EXA_API_KEY", "configured": False, "source": None}


def test_unknown_tool_server_is_not_found(tool_servers_home):
    response = client_for("coach").post(
        "/api/v1/tool-servers/nope/secrets",
        json={"name": "EXA_API_KEY", "value": STORED_SECRET},
    )

    assert response.status_code == 404
    assert response.json()["error"]["code"] == "tool_server_not_found"


def test_unreferenced_credential_is_rejected(tool_servers_home):
    response = client_for("coach").post(
        "/api/v1/tool-servers/exa/secrets",
        json={"name": "OTHER_KEY", "value": STORED_SECRET},
    )

    assert response.status_code == 400
    assert response.json()["error"]["code"] == "invalid_request"


def test_missing_credential_name_is_rejected(tool_servers_home):
    response = client_for("coach").post(
        "/api/v1/tool-servers/exa/secrets",
        json={"value": STORED_SECRET},
    )

    assert response.status_code == 400
    assert response.json()["error"]["code"] == "invalid_request"


def test_missing_value_key_is_rejected(tool_servers_home):
    response = client_for("coach").post(
        "/api/v1/tool-servers/exa/secrets",
        json={"name": "EXA_API_KEY"},
    )

    assert response.status_code == 400
    assert response.json()["error"]["code"] == "invalid_request"
    assert "value is required" in response.json()["error"]["message"]


@pytest.mark.parametrize("value", ["", 7, [], {}])
def test_empty_or_non_string_values_are_rejected(tool_servers_home, value):
    response = client_for("coach").post(
        "/api/v1/tool-servers/exa/secrets",
        json={"name": "EXA_API_KEY", "value": value},
    )

    assert response.status_code == 400
    assert response.json()["error"]["code"] == "invalid_request"


def test_admin_check_runs_before_the_body_is_parsed(tool_servers_home):
    response = client_for("rifusaki").post(
        "/api/v1/tool-servers/exa/secrets",
        content=b"not json",
        headers={"content-type": "application/json"},
    )

    assert response.status_code == 403
    assert response.json()["error"]["code"] == "admin_required"


def test_mutating_credentials_requires_login(tool_servers_home):
    response = TestClient(app.chainlit_server).post(
        "/api/v1/tool-servers/exa/secrets",
        json={"name": "EXA_API_KEY", "value": STORED_SECRET},
    )

    assert response.status_code == 401
    assert response.json()["error"]["code"] == "unauthorized"


def test_break_glass_admin_can_manage_credentials(break_glass_tool_servers_home):
    response = client_for(BREAK_GLASS_USERNAME).post(
        "/api/v1/tool-servers/exa/secrets",
        json={"name": "EXA_API_KEY", "value": STORED_SECRET},
    )

    assert response.status_code == 200
    assert _exa_credentials(response.json())["source"] == "console"


def test_malformed_credential_store_is_reported(tool_servers_home):
    secrets_path = default_tool_server_secrets_path(tool_servers_home)
    secrets_path.parent.mkdir(parents=True, exist_ok=True)
    secrets_path.write_text("{not json", encoding="utf-8")

    response = client_for("coach").get("/api/v1/tool-servers")

    assert response.status_code == 500
    assert response.json()["error"]["code"] == "tool_server_secrets_error"
