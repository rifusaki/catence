import json
import socket
import urllib.parse
from types import SimpleNamespace

import bcrypt
import pytest
from chainlit.auth.jwt import create_jwt
from chainlit.user import User
from fastapi.testclient import TestClient

from catence_console import accounts, app, mcp_auth
from catence_console.accounts import ACCOUNTS_FORMAT_VERSION, AccountsStoreError, default_accounts_path

CREATED_AT = "2026-09-28T12:00:00+00:00"
PASSWORD_HASH = bcrypt.hashpw(b"correct horse", bcrypt.gensalt()).decode("utf-8")
RUNTIME_TOKEN = "test-runtime-token"

KEY_ID = "a1b2c3d4e5f60718293a4b5c6d7e8f90"

KEYS_LISTING = {
    "keys": [
        {"id": KEY_ID, "label": "rifusaki key", "account": "rifusaki", "createdAt": CREATED_AT},
        {
            "id": "b2c3d4e5f60718293a4b5c6d7e8f90a1",
            "label": "coach key",
            "account": "coach",
            "createdAt": CREATED_AT,
            "revokedAt": CREATED_AT,
        },
    ]
}
CREATED_KEY = {
    "id": KEY_ID,
    "label": "Claude",
    "account": "rifusaki",
    "createdAt": CREATED_AT,
    "token": "raw-token-shown-once",
}
ROLLED_KEY = {**CREATED_KEY, "token": "new-raw-token-shown-once"}


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
                    _stored_account("newcomer", "member", []),
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


def test_mcp_keys_routes_require_login(console_home):
    anonymous = TestClient(app.chainlit_server)

    assert anonymous.get("/api/v1/mcp-keys").status_code == 401
    assert anonymous.post("/api/v1/mcp-keys", json={"account": "rifusaki"}).status_code == 401
    assert anonymous.delete(f"/api/v1/mcp-keys?id={KEY_ID}").status_code == 401
    assert anonymous.post("/api/v1/mcp-keys/roll", json={"id": KEY_ID, "account": "rifusaki"}).status_code == 401

    for response in (
        anonymous.get("/api/v1/mcp-keys"),
        anonymous.post("/api/v1/mcp-keys", json={"account": "rifusaki"}),
    ):
        assert response.json()["error"]["code"] == "unauthorized"


def test_mcp_keys_member_cross_account_operations_are_refused(console_home, monkeypatch):
    """A member may manage only its own account's keys; keying, rolling, or
    otherwise touching another account is an admin operation and never
    reaches the runtime."""
    _forbid_upstream(monkeypatch)

    member = client_for("rifusaki")
    create = member.post("/api/v1/mcp-keys", json={"account": "coach", "label": "nope"})
    roll = member.post("/api/v1/mcp-keys/roll", json={"id": KEY_ID, "account": "coach"})

    for response in (create, roll):
        assert response.status_code == 403
        assert response.json()["error"]["code"] == "admin_required"


def test_mcp_keys_overview_filters_to_the_members_own_account(console_home, runtime_token, monkeypatch):
    def fake_urlopen(request, timeout=0):
        assert request.get_method() == "GET"
        return _Upstream(json.dumps(KEYS_LISTING).encode("utf-8"))

    monkeypatch.setattr(app.urllib.request, "urlopen", fake_urlopen)

    member = client_for("rifusaki").get("/api/v1/mcp-keys")
    assert member.status_code == 200
    assert member.json() == {"keys": [KEYS_LISTING["keys"][0]]}

    admin = client_for("coach").get("/api/v1/mcp-keys")
    assert admin.status_code == 200
    assert admin.json() == KEYS_LISTING


def test_mcp_keys_member_self_service_lifecycle(console_home, runtime_token, monkeypatch):
    """A member creates, rolls, and revokes its own account's keys through the
    runtime. Other accounts' keys answer 404 — the same code as an unknown id,
    so the registry's other accounts stay unenumerable — and are never
    forwarded."""
    calls = []

    def fake_urlopen(request, timeout=0):
        calls.append(request)
        method = request.get_method()
        if method == "GET":
            return _Upstream(json.dumps(KEYS_LISTING).encode("utf-8"))
        if method == "DELETE":
            key_id = urllib.parse.parse_qs(urllib.parse.urlparse(request.full_url).query)["id"][0]
            return _Upstream(json.dumps({"revoked": key_id}).encode("utf-8"))
        if request.full_url.endswith("/api/v1/mcp-keys"):
            return _Upstream(json.dumps(CREATED_KEY).encode("utf-8"), status=201)
        return _Upstream(json.dumps(ROLLED_KEY).encode("utf-8"))

    monkeypatch.setattr(app.urllib.request, "urlopen", fake_urlopen)
    member = client_for("rifusaki")

    # Create for its own account: the body is forwarded verbatim and the raw
    # token comes back exactly once.
    create = member.post("/api/v1/mcp-keys", json={"account": "rifusaki", "label": "Claude"})
    assert create.status_code == 201
    assert create.json() == CREATED_KEY

    # Revoke its own key: the visibility lookup runs first, then the DELETE.
    calls.clear()
    revoke = member.delete(f"/api/v1/mcp-keys?id={KEY_ID}")
    assert revoke.status_code == 200
    assert revoke.json() == {"revoked": KEY_ID}
    assert [call.get_method() for call in calls] == ["GET", "DELETE"]

    # Roll its own key: only the id is forwarded to the runtime.
    calls.clear()
    roll = member.post("/api/v1/mcp-keys/roll", json={"id": KEY_ID, "account": "rifusaki"})
    assert roll.status_code == 200
    assert roll.json() == ROLLED_KEY
    assert [call.get_method() for call in calls] == ["GET", "POST"]
    assert json.loads(calls[-1].data) == {"id": KEY_ID}

    # Another account's key and an unknown id both 404 after the visibility
    # lookup; neither is forwarded as a DELETE.
    coach_key_id = KEYS_LISTING["keys"][1]["id"]
    for key_id in (coach_key_id, "f" * 32):
        calls.clear()
        response = member.delete(f"/api/v1/mcp-keys?id={key_id}")
        assert response.status_code == 404
        assert response.json()["error"]["code"] == "mcp_key_not_found"
        assert [call.get_method() for call in calls] == ["GET"]

    # Rolling another account's key is the same 404.
    calls.clear()
    roll_foreign = member.post("/api/v1/mcp-keys/roll", json={"id": coach_key_id, "account": "rifusaki"})
    assert roll_foreign.status_code == 404
    assert roll_foreign.json()["error"]["code"] == "mcp_key_not_found"
    assert [call.get_method() for call in calls] == ["GET"]


def test_mcp_keys_routes_reject_wrong_methods(console_home, monkeypatch):
    _forbid_upstream(monkeypatch)
    admin = client_for("coach")

    put = admin.put("/api/v1/mcp-keys", json={"account": "rifusaki"})
    assert put.status_code == 405
    assert put.json()["error"]["code"] == "method_not_allowed"
    assert put.json()["error"]["message"] == "Use GET, POST, or DELETE for /api/v1/mcp-keys."

    roll_get = admin.get("/api/v1/mcp-keys/roll")
    assert roll_get.status_code == 405
    assert roll_get.json()["error"]["code"] == "method_not_allowed"
    assert roll_get.json()["error"]["message"] == "Use POST for /api/v1/mcp-keys/roll."

    assert admin.delete("/api/v1/mcp-keys/roll").status_code == 405


def test_mcp_keys_overview_proxies_the_listing(console_home, runtime_token, monkeypatch):
    captured = {}

    def fake_urlopen(request, timeout=0):
        captured["request"] = request
        return _Upstream(json.dumps(KEYS_LISTING).encode("utf-8"))

    monkeypatch.setattr(app.urllib.request, "urlopen", fake_urlopen)

    response = client_for("coach").get("/api/v1/mcp-keys")

    assert response.status_code == 200
    assert response.json() == KEYS_LISTING
    forwarded = captured["request"]
    assert forwarded.get_method() == "GET"
    assert forwarded.full_url.endswith("/api/v1/mcp-keys")
    assert forwarded.get_header("Authorization") == f"Bearer {runtime_token}"


def test_mcp_keys_create_forwards_the_body_and_returns_the_token_once(console_home, runtime_token, monkeypatch):
    captured = {}

    def fake_urlopen(request, timeout=0):
        captured["request"] = request
        return _Upstream(json.dumps(CREATED_KEY).encode("utf-8"), status=201)

    monkeypatch.setattr(app.urllib.request, "urlopen", fake_urlopen)

    body = {"account": "rifusaki", "label": "Claude"}
    response = client_for("coach").post("/api/v1/mcp-keys", json=body)

    assert response.status_code == 201
    assert response.json() == CREATED_KEY
    forwarded = captured["request"]
    assert forwarded.get_method() == "POST"
    assert forwarded.full_url.endswith("/api/v1/mcp-keys")
    assert json.loads(forwarded.data) == body
    assert forwarded.get_header("Authorization") == f"Bearer {runtime_token}"


def test_mcp_keys_create_rejects_an_unknown_account_before_the_runtime(console_home, monkeypatch):
    _forbid_upstream(monkeypatch)
    admin = client_for("coach")

    unknown = admin.post("/api/v1/mcp-keys", json={"account": "ghost"})
    assert unknown.status_code == 400
    assert unknown.json()["error"]["code"] == "account_not_found"

    missing = admin.post("/api/v1/mcp-keys", json={"label": "no account"})
    assert missing.status_code == 400
    assert missing.json()["error"]["code"] == "invalid_request"

    not_an_object = admin.post(
        "/api/v1/mcp-keys",
        content=b"[1, 2]",
        headers={"content-type": "application/json"},
    )
    assert not_an_object.status_code == 400
    assert not_an_object.json()["error"]["code"] == "invalid_request"


def test_mcp_keys_create_fails_closed_when_the_accounts_store_is_unusable(console_home, monkeypatch):
    _forbid_upstream(monkeypatch)

    def broken_load(_path):
        raise AccountsStoreError("malformed store")

    monkeypatch.setattr(accounts, "load_accounts", broken_load)

    response = client_for("coach").post("/api/v1/mcp-keys", json={"account": "rifusaki"})

    assert response.status_code == 500
    assert response.json()["error"]["code"] == "accounts_store_error"


def test_mcp_keys_revoke_forwards_the_id_query_parameter(console_home, runtime_token, monkeypatch):
    captured = {}

    def fake_urlopen(request, timeout=0):
        captured["request"] = request
        return _Upstream(json.dumps({"revoked": KEY_ID}).encode("utf-8"))

    monkeypatch.setattr(app.urllib.request, "urlopen", fake_urlopen)

    response = client_for("coach").delete(f"/api/v1/mcp-keys?id={KEY_ID}")

    assert response.status_code == 200
    assert response.json() == {"revoked": KEY_ID}
    forwarded = captured["request"]
    assert forwarded.get_method() == "DELETE"
    assert forwarded.full_url.endswith(f"/api/v1/mcp-keys?id={KEY_ID}")
    assert forwarded.get_header("Authorization") == f"Bearer {runtime_token}"


def test_mcp_keys_roll_forwards_only_the_id(console_home, runtime_token, monkeypatch):
    captured = {}

    def fake_urlopen(request, timeout=0):
        captured["request"] = request
        return _Upstream(json.dumps(ROLLED_KEY).encode("utf-8"))

    monkeypatch.setattr(app.urllib.request, "urlopen", fake_urlopen)

    response = client_for("coach").post("/api/v1/mcp-keys/roll", json={"id": KEY_ID, "account": "rifusaki"})

    assert response.status_code == 200
    assert response.json() == ROLLED_KEY
    forwarded = captured["request"]
    assert forwarded.get_method() == "POST"
    assert forwarded.full_url.endswith("/api/v1/mcp-keys/roll")
    # The runtime's strict roll body accepts only id; the account stays Console-side.
    assert json.loads(forwarded.data) == {"id": KEY_ID}
    assert forwarded.get_header("Authorization") == f"Bearer {runtime_token}"


def test_mcp_keys_roll_rejects_an_unknown_account_before_the_runtime(console_home, monkeypatch):
    _forbid_upstream(monkeypatch)
    admin = client_for("coach")

    unknown = admin.post("/api/v1/mcp-keys/roll", json={"id": KEY_ID, "account": "ghost"})
    assert unknown.status_code == 400
    assert unknown.json()["error"]["code"] == "account_not_found"

    without_account = admin.post("/api/v1/mcp-keys/roll", json={"id": KEY_ID})
    assert without_account.status_code == 400
    assert without_account.json()["error"]["code"] == "invalid_request"

    without_id = admin.post("/api/v1/mcp-keys/roll", json={"account": "rifusaki"})
    assert without_id.status_code == 400
    assert without_id.json()["error"]["code"] == "invalid_request"


def test_mcp_keys_proxy_passes_through_runtime_errors(console_home, monkeypatch):
    not_found = json.dumps({"error": {"code": "mcp_key_not_found", "message": f"Unknown MCP key {KEY_ID}."}}).encode("utf-8")
    monkeypatch.setattr(app.urllib.request, "urlopen", lambda *args, **kwargs: _Upstream(not_found, status=404))

    revoke = client_for("coach").delete(f"/api/v1/mcp-keys?id={KEY_ID}")
    assert revoke.status_code == 404
    assert revoke.json()["error"]["code"] == "mcp_key_not_found"

    create_failed = json.dumps({"error": {"code": "mcp_key_create_failed", "message": "disk full"}}).encode("utf-8")
    monkeypatch.setattr(app.urllib.request, "urlopen", lambda *args, **kwargs: _Upstream(create_failed, status=400))

    create = client_for("coach").post("/api/v1/mcp-keys", json={"account": "rifusaki"})
    assert create.status_code == 400
    assert create.json()["error"]["code"] == "mcp_key_create_failed"
