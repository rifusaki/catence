import json
import socket
from types import SimpleNamespace

import bcrypt
import pytest
from chainlit.auth.jwt import create_jwt
from chainlit.user import User
from fastapi.testclient import TestClient

from catence_console import app, mcp_auth
from catence_console.accounts import ACCOUNTS_FORMAT_VERSION, default_accounts_path

CREATED_AT = "2026-09-28T12:00:00+00:00"
PASSWORD_HASH = bcrypt.hashpw(b"correct horse", bcrypt.gensalt()).decode("utf-8")
RUNTIME_TOKEN = "test-runtime-token"

OAUTH_SETTINGS = {
    "enabled": True,
    "publicUrl": "https://catence-mcp.example.com",
    "source": "console",
    "settingsFile": "/data/oauth/settings.json",
    "settingsState": "ok",
}


def _closed_port() -> int:
    """A port nothing listens on, so proxied requests fail upstream fast."""

    with socket.socket() as probe:
        probe.bind(("127.0.0.1", 0))
        return probe.getsockname()[1]


def _stored_account(username: str, role: str, athletes: str | list[str]) -> dict:
    return {
        "username": username,
        "passwordHash": PASSWORD_HASH,
        "role": role,
        "athletes": athletes,
        "createdAt": CREATED_AT,
    }


@pytest.fixture
def console_home(tmp_path, monkeypatch):
    """A hermetic CATENCE_HOME with stored accounts and no reachable runtime."""

    monkeypatch.setenv("CATENCE_HOME", str(tmp_path))
    monkeypatch.setenv("CHAINLIT_AUTH_SECRET", "test-secret-that-is-long-enough-for-hs256")
    monkeypatch.delenv("CATENCE_CONSOLE_USERNAME", raising=False)
    monkeypatch.delenv("CATENCE_CONSOLE_PASSWORD_HASH", raising=False)
    monkeypatch.delenv("CHAINLIT_LOCAL_USER", raising=False)
    monkeypatch.setattr(app, "MCP_URL", f"http://127.0.0.1:{_closed_port()}/mcp")
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
    return tmp_path


@pytest.fixture
def runtime_token(console_home, monkeypatch):
    """A legacy runtime token file, so proxied requests carry the bearer header."""

    token_file = console_home / "mcp-token"
    token_file.write_text(RUNTIME_TOKEN, encoding="utf-8")
    monkeypatch.setenv("CATENCE_MCP_TOKEN_FILE", str(token_file))
    monkeypatch.setattr(mcp_auth, "_token_cache", None)
    return RUNTIME_TOKEN


def client_for(username: str) -> TestClient:
    """A TestClient carrying a valid session cookie for ``username``."""

    client = TestClient(app.chainlit_server)
    client.cookies.set(
        "access_token",
        create_jwt(User(identifier=username, display_name=username, metadata={})),
    )
    return client


class _Upstream:
    """A minimal urlopen response double for proxy tests."""

    def __init__(self, payload: bytes, status: int = 200):
        self.status = status
        self.payload = payload
        self.headers = SimpleNamespace(get_content_type=lambda: "application/json")

    def read(self) -> bytes:
        return self.payload

    def __enter__(self):
        return self

    def __exit__(self, *_):
        return False


def _forbid_upstream(monkeypatch):
    monkeypatch.setattr(
        app.urllib.request,
        "urlopen",
        lambda *args, **kwargs: pytest.fail("the runtime must not be called"),
    )


def test_mcp_oauth_settings_routes_require_login(console_home):
    anonymous = TestClient(app.chainlit_server)

    assert anonymous.get("/api/v1/mcp-oauth-settings").status_code == 401
    assert anonymous.post("/api/v1/mcp-oauth-settings", json={"enabled": False}).status_code == 401

    for response in (
        anonymous.get("/api/v1/mcp-oauth-settings"),
        anonymous.post("/api/v1/mcp-oauth-settings", json={"enabled": False}),
    ):
        assert response.json()["error"]["code"] == "unauthorized"


def test_mcp_oauth_settings_routes_are_admin_only(console_home, monkeypatch):
    _forbid_upstream(monkeypatch)

    member = client_for("rifusaki")
    overview = member.get("/api/v1/mcp-oauth-settings")
    update = member.post("/api/v1/mcp-oauth-settings", json={"enabled": True, "publicUrl": "https://catence-mcp.example.com"})

    for response in (overview, update):
        assert response.status_code == 403
        assert response.json()["error"]["code"] == "admin_required"


def test_mcp_oauth_settings_routes_reject_wrong_methods(console_home, monkeypatch):
    _forbid_upstream(monkeypatch)
    admin = client_for("coach")

    put = admin.put("/api/v1/mcp-oauth-settings", json={"enabled": False})
    assert put.status_code == 405
    assert put.json()["error"]["code"] == "method_not_allowed"
    assert put.json()["error"]["message"] == "Use GET or POST for /api/v1/mcp-oauth-settings."

    assert admin.delete("/api/v1/mcp-oauth-settings").status_code == 405


def test_mcp_oauth_settings_overview_proxies_the_runtime(console_home, runtime_token, monkeypatch):
    captured = {}

    def fake_urlopen(request, timeout=0):
        captured["request"] = request
        return _Upstream(json.dumps(OAUTH_SETTINGS).encode("utf-8"))

    monkeypatch.setattr(app.urllib.request, "urlopen", fake_urlopen)

    response = client_for("coach").get("/api/v1/mcp-oauth-settings")

    assert response.status_code == 200
    assert response.json() == OAUTH_SETTINGS
    forwarded = captured["request"]
    assert forwarded.get_method() == "GET"
    assert forwarded.full_url.endswith("/api/v1/mcp-oauth-settings")
    assert forwarded.get_header("Authorization") == f"Bearer {runtime_token}"


def test_mcp_oauth_settings_update_forwards_the_body(console_home, runtime_token, monkeypatch):
    captured = {}

    def fake_urlopen(request, timeout=0):
        captured["request"] = request
        return _Upstream(json.dumps(OAUTH_SETTINGS).encode("utf-8"))

    monkeypatch.setattr(app.urllib.request, "urlopen", fake_urlopen)

    body = {"enabled": True, "publicUrl": "https://catence-mcp.example.com"}
    response = client_for("coach").post("/api/v1/mcp-oauth-settings", json=body)

    assert response.status_code == 200
    assert response.json() == OAUTH_SETTINGS
    forwarded = captured["request"]
    assert forwarded.get_method() == "POST"
    assert forwarded.full_url.endswith("/api/v1/mcp-oauth-settings")
    assert json.loads(forwarded.data) == body
    assert forwarded.get_header("Authorization") == f"Bearer {runtime_token}"


def test_mcp_oauth_settings_update_validates_the_body_shape(console_home, monkeypatch):
    _forbid_upstream(monkeypatch)
    admin = client_for("coach")

    not_an_object = admin.post(
        "/api/v1/mcp-oauth-settings",
        content=b"[1, 2]",
        headers={"content-type": "application/json"},
    )
    assert not_an_object.status_code == 400
    assert not_an_object.json()["error"]["code"] == "invalid_request"

    missing_enabled = admin.post("/api/v1/mcp-oauth-settings", json={"publicUrl": "https://catence-mcp.example.com"})
    assert missing_enabled.status_code == 400
    assert missing_enabled.json()["error"]["message"] == "enabled is required and must be a boolean."

    wrong_type = admin.post("/api/v1/mcp-oauth-settings", json={"enabled": "yes"})
    assert wrong_type.status_code == 400
    assert wrong_type.json()["error"]["code"] == "invalid_request"

    bad_url_type = admin.post("/api/v1/mcp-oauth-settings", json={"enabled": False, "publicUrl": 5})
    assert bad_url_type.status_code == 400
    assert bad_url_type.json()["error"]["message"] == "publicUrl must be a string."

    # A boolean enabled with no publicUrl is forwarded: the runtime answers
    # whether the pairing is valid (required when enabling).
    forwarded = {}

    def fake_urlopen(request, timeout=0):
        forwarded["request"] = request
        return _Upstream(json.dumps(OAUTH_SETTINGS).encode("utf-8"))

    monkeypatch.setattr(app.urllib.request, "urlopen", fake_urlopen)
    ok = admin.post("/api/v1/mcp-oauth-settings", json={"enabled": False})
    assert ok.status_code == 200
    assert json.loads(forwarded["request"].data) == {"enabled": False}


def test_mcp_oauth_settings_passes_runtime_errors_through(console_home, runtime_token, monkeypatch):
    runtime_error = json.dumps(
        {"error": {"code": "mcp_oauth_settings_update_failed", "message": "publicUrl must use https: the OAuth issuer is advertised publicly."}}
    ).encode("utf-8")
    monkeypatch.setattr(app.urllib.request, "urlopen", lambda *args, **kwargs: _Upstream(runtime_error, status=400))

    response = client_for("coach").post("/api/v1/mcp-oauth-settings", json={"enabled": True, "publicUrl": "http://catence-mcp.example.com"})

    assert response.status_code == 400
    assert response.json()["error"]["code"] == "mcp_oauth_settings_update_failed"
