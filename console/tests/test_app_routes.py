import asyncio
import json
import socket
from types import SimpleNamespace

import bcrypt
import pytest
from chainlit.auth.jwt import create_jwt
from chainlit.user import User
from fastapi.testclient import TestClient

from catence_console import app
from catence_console.accounts import ACCOUNTS_FORMAT_VERSION, ConsoleAccount, default_accounts_path

CREATED_AT = "2026-09-28T12:00:00+00:00"
PASSWORD_HASH = bcrypt.hashpw(b"correct horse", bcrypt.gensalt()).decode("utf-8")

ADMIN = ConsoleAccount("coach", PASSWORD_HASH, "admin", "all", CREATED_AT)
MEMBER = ConsoleAccount("rifusaki", PASSWORD_HASH, "member", ["martina"], CREATED_AT)
NEWCOMER = ConsoleAccount("newcomer", PASSWORD_HASH, "member", [], CREATED_AT)

ROSTER = {
    "defaultAthleteId": "coach-athlete",
    "athletes": [
        {"id": "coach-athlete", "label": "Coach athlete"},
        {"id": "martina", "label": "Martina"},
    ],
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
                    _stored_account("newcomer", "member", []),
                ],
            }
        ),
        encoding="utf-8",
    )
    return tmp_path


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


def test_dashboard_proxy_route_is_reachable_before_the_console_spa_and_requires_login():
    response = TestClient(app.chainlit_server).get("/api/v1/dashboard?athleteId=alex")

    assert response.status_code == 401
    assert response.json()["error"]["code"] == "unauthorized"


def test_health_proxy_route_is_reachable_before_the_console_spa_and_requires_login():
    # Regression: without this proxy, /api/v1/health fell through to the
    # SPA catch-all (200 HTML) and the Status page fell back to Chainlit's
    # /health {"status":"ok"}, rendering empty Runtime / bare "v".
    response = TestClient(app.chainlit_server).get("/api/v1/health")

    assert response.status_code == 401
    assert response.json()["error"]["code"] == "unauthorized"


def test_athlete_file_proxy_route_requires_login_for_reads_and_writes():
    client = TestClient(app.chainlit_server)

    read_response = client.get("/api/v1/athlete-file?athleteId=alex")
    write_response = client.put("/api/v1/athlete-file?athleteId=alex", json={"content": "hello", "expectedHash": None})

    assert read_response.status_code == 401
    assert read_response.json()["error"]["code"] == "unauthorized"
    assert write_response.status_code == 401
    assert write_response.json()["error"]["code"] == "unauthorized"


def test_member_reaches_granted_athletes_and_is_forbidden_for_others(console_home):
    client = client_for("rifusaki")

    allowed = client.get("/api/v1/dashboard?athleteId=martina")
    forbidden = client.get("/api/v1/dashboard?athleteId=someone-else")

    # The gate opens: the request fails upstream (no runtime in tests), not at the gate.
    assert allowed.status_code == 502
    assert allowed.json()["error"]["code"] == "mcp_unavailable"
    assert forbidden.status_code == 403
    assert forbidden.json()["error"]["code"] == "athlete_forbidden"


def test_member_without_athlete_parameter_falls_back_to_the_first_grant(console_home, monkeypatch):
    captured = {}

    def fake_urlopen(target, timeout=0):
        captured["target"] = target
        return _Upstream(b"{}")

    monkeypatch.setattr(app.urllib.request, "urlopen", fake_urlopen)

    response = client_for("rifusaki").get("/api/v1/dashboard?days=7")

    assert response.status_code == 200
    assert captured["target"].endswith("/api/v1/dashboard?days=7&athleteId=martina")


def test_zero_grant_member_is_forbidden_on_athlete_scoped_routes(console_home):
    client = client_for("newcomer")

    assert client.get("/api/v1/dashboard?athleteId=martina").status_code == 403
    assert client.get("/api/v1/dashboard").status_code == 403
    assert client.get("/api/v1/sync/status?athleteId=martina").status_code == 403


def test_admin_passes_any_athlete_through(console_home):
    client = client_for("coach")

    assert client.get("/api/v1/dashboard?athleteId=anyone").status_code == 502
    assert client.get("/api/v1/dashboard").status_code == 502


def test_unknown_identifier_token_is_rejected(console_home):
    response = client_for("ghost").get("/api/v1/dashboard?athleteId=martina")

    assert response.status_code == 401
    assert response.json()["error"]["code"] == "unauthorized"


def test_environment_break_glass_account_keeps_full_access(tmp_path, monkeypatch):
    # No accounts.json at all: behavior matches the pre-accounts Console.
    monkeypatch.setenv("CATENCE_HOME", str(tmp_path))
    monkeypatch.setenv("CHAINLIT_AUTH_SECRET", "test-secret-that-is-long-enough-for-hs256")
    monkeypatch.setenv("CATENCE_CONSOLE_USERNAME", "coach")
    monkeypatch.setenv("CATENCE_CONSOLE_PASSWORD_HASH", PASSWORD_HASH)
    monkeypatch.delenv("CHAINLIT_LOCAL_USER", raising=False)
    monkeypatch.setattr(app, "MCP_URL", f"http://127.0.0.1:{_closed_port()}/mcp")
    client = client_for("coach")

    assert client.get("/api/v1/dashboard?athleteId=alex").status_code == 502
    assert client.get("/api/v1/dashboard").status_code == 502


def test_local_development_identifier_is_an_implicit_admin(tmp_path, monkeypatch):
    monkeypatch.setenv("CATENCE_HOME", str(tmp_path))
    monkeypatch.setenv("CHAINLIT_AUTH_SECRET", "test-secret-that-is-long-enough-for-hs256")
    monkeypatch.setenv("CHAINLIT_LOCAL_USER", "catence-local")
    monkeypatch.delenv("CATENCE_CONSOLE_USERNAME", raising=False)
    monkeypatch.delenv("CATENCE_CONSOLE_PASSWORD_HASH", raising=False)
    monkeypatch.setattr(app, "MCP_URL", f"http://127.0.0.1:{_closed_port()}/mcp")

    response = client_for("catence-local").get("/api/v1/dashboard?athleteId=alex")

    assert response.status_code == 502


def test_athlete_roster_is_narrowed_to_the_session_account(console_home, monkeypatch):
    monkeypatch.setattr(app, "_roster_payload", lambda: ROSTER)

    monkeypatch.setattr(app.cl.user_session, "get", lambda key: SimpleNamespace(identifier="rifusaki"))
    assert app._athlete_roster() == ("martina", {"Martina": "martina"})

    monkeypatch.setattr(app.cl.user_session, "get", lambda key: SimpleNamespace(identifier="coach"))
    assert app._athlete_roster() == (
        "coach-athlete",
        {"Coach athlete": "coach-athlete", "Martina": "martina"},
    )

    # A member with no grants must browse empty instead of raising.
    monkeypatch.setattr(app.cl.user_session, "get", lambda key: SimpleNamespace(identifier="newcomer"))
    assert app._athlete_roster() == (None, {})


def test_athlete_file_put_enforces_grants(console_home):
    client = client_for("rifusaki")
    body = {"content": "hello", "expectedHash": None}

    forbidden = client.put("/api/v1/athlete-file?athleteId=someone-else", json=body)
    allowed = client.put("/api/v1/athlete-file?athleteId=martina", json=body)
    fallback = client.put("/api/v1/athlete-file", json=body)

    assert forbidden.status_code == 403
    assert forbidden.json()["error"]["code"] == "athlete_forbidden"
    assert allowed.status_code == 502
    assert fallback.status_code == 502
    assert client_for("newcomer").put("/api/v1/athlete-file", json=body).status_code == 403


def test_sync_post_body_variants_enforce_grants(console_home):
    client = client_for("rifusaki")

    assert client.post("/api/v1/sync", json={"athleteId": "martina"}).status_code == 502
    assert client.post("/api/v1/sync", json={}).status_code == 502
    forbidden = client.post("/api/v1/sync", json={"athleteId": "someone-else"})
    assert forbidden.status_code == 403
    assert forbidden.json()["error"]["code"] == "athlete_forbidden"
    assert client_for("newcomer").post("/api/v1/sync", json={}).status_code == 403
    assert client_for("coach").post("/api/v1/sync", json={"athleteId": "anyone"}).status_code == 502


def test_sync_proxy_injects_the_first_grant_when_no_athlete_is_named(console_home, monkeypatch):
    captured = {}

    def fake_urlopen(request, timeout=0):
        captured["request"] = request
        return _Upstream(b"{}", status=202)

    monkeypatch.setattr(app.urllib.request, "urlopen", fake_urlopen)

    response = client_for("rifusaki").post("/api/v1/sync", json={"refresh": True})

    assert response.status_code == 202
    forwarded = captured["request"]
    assert forwarded.get_method() == "POST"
    assert json.loads(forwarded.data) == {"refresh": True, "athleteId": "martina"}


def test_athletes_proxy_filters_the_roster_for_members(console_home, monkeypatch):
    monkeypatch.setattr(app.urllib.request, "urlopen", lambda *args, **kwargs: _Upstream(json.dumps(ROSTER).encode("utf-8")))

    member_response = client_for("rifusaki").get("/api/v1/athletes")
    admin_response = client_for("coach").get("/api/v1/athletes")

    assert member_response.status_code == 200
    assert member_response.json() == {"defaultAthleteId": "martina", "athletes": [{"id": "martina", "label": "Martina"}]}
    assert admin_response.json() == ROSTER


def test_filter_roster_keeps_unrestricted_accounts_unchanged():
    all_grant_member = ConsoleAccount("allie", PASSWORD_HASH, "member", "all", CREATED_AT)

    assert app.filter_roster(ROSTER, None) == ROSTER
    assert app.filter_roster(ROSTER, ADMIN) == ROSTER
    assert app.filter_roster(ROSTER, all_grant_member) == ROSTER


def test_filter_roster_narrows_members_and_moves_the_default():
    filtered = app.filter_roster(ROSTER, MEMBER)

    assert filtered == {"defaultAthleteId": "martina", "athletes": [{"id": "martina", "label": "Martina"}]}
    # The pure helper never mutates the runtime payload it was handed.
    assert ROSTER["defaultAthleteId"] == "coach-athlete"


def test_filter_roster_keeps_a_granted_default_in_place():
    payload = {
        "defaultAthleteId": "martina",
        "athletes": [{"id": "martina", "label": "Martina"}, {"id": "other", "label": "Other"}],
    }

    assert app.filter_roster(payload, MEMBER) == {"defaultAthleteId": "martina", "athletes": [{"id": "martina", "label": "Martina"}]}


def test_filter_roster_clears_the_roster_when_the_member_has_no_grants():
    assert app.filter_roster(ROSTER, NEWCOMER) == {"defaultAthleteId": "", "athletes": []}


def test_athlete_scope_resolves_grants_and_admin_passthrough():
    assert app.athlete_scope(ADMIN, "anyone") == (True, "anyone")
    assert app.athlete_scope(ADMIN, None) == (True, None)
    assert app.athlete_scope(MEMBER, "martina") == (True, "martina")
    assert app.athlete_scope(MEMBER, "someone-else") == (False, None)
    assert app.athlete_scope(MEMBER, None) == (True, "martina")
    assert app.athlete_scope(NEWCOMER, "martina") == (False, None)
    assert app.athlete_scope(NEWCOMER, None) == (False, None)


def test_can_run_agent_turn_requires_a_scoped_athlete():
    assert app.can_run_agent_turn("martina") is True
    assert app.can_run_agent_turn("") is False
    assert app.can_run_agent_turn(None) is False


def test_zero_grant_members_get_a_notice_instead_of_an_agent_turn(monkeypatch):
    sent = []

    class FakeMessage:
        def __init__(self, *, content, metadata=None):
            self.content = content

        async def send(self):
            sent.append(self.content)

    monkeypatch.setattr(app, "_configuration", lambda: SimpleNamespace(profile=lambda profile_id: SimpleNamespace()))
    monkeypatch.setattr(app, "_selected_settings", lambda: ("openai", "default", None, 8, 24_000, None, None))
    monkeypatch.setattr(app.cl, "Message", FakeMessage)
    monkeypatch.setattr(
        app.asyncio,
        "create_task",
        lambda *args, **kwargs: pytest.fail("a zero-grant member must not start an agent turn"),
    )

    asyncio.run(app.on_message(FakeMessage(content="hello")))

    assert sent == [app.NO_ATHLETE_ACCESS_NOTICE]


def test_add_athlete_route_requires_login():
    response = TestClient(app.chainlit_server).post("/api/v1/athletes", json={"id": "sam", "label": "Sam"})

    assert response.status_code == 401
    assert response.json()["error"]["code"] == "unauthorized"


def test_add_athlete_proxy_is_admin_only_and_forwards_the_body(console_home, monkeypatch):
    captured = {}

    def fake_urlopen(request, timeout=0):
        captured["request"] = request
        return _Upstream(json.dumps(ROSTER).encode("utf-8"), status=201)

    monkeypatch.setattr(app.urllib.request, "urlopen", fake_urlopen)

    member = client_for("rifusaki").post("/api/v1/athletes", json={"id": "sam", "label": "Sam"})
    assert member.status_code == 403
    assert member.json()["error"]["code"] == "admin_required"

    response = client_for("coach").post("/api/v1/athletes", json={"id": "sam", "label": "Sam", "setDefault": True})

    assert response.status_code == 201
    forwarded = captured["request"]
    assert forwarded.get_method() == "POST"
    assert forwarded.full_url.endswith("/api/v1/athletes")
    assert json.loads(forwarded.data) == {"id": "sam", "label": "Sam", "setDefault": True}


def test_generation_status_proxy_requires_login_and_forwards_the_path(console_home, monkeypatch):
    captured = {}

    def fake_urlopen(target, timeout=0):
        captured["target"] = target
        return _Upstream(b'{"threadId": "abc", "running": true, "stale": false}')

    monkeypatch.setattr(app.urllib.request, "urlopen", fake_urlopen)

    anonymous = TestClient(app.chainlit_server).get("/api/v1/threads/abc/generation")
    assert anonymous.status_code == 401

    response = client_for("rifusaki").get("/api/v1/threads/abc/generation")

    assert response.status_code == 200
    assert response.json() == {"threadId": "abc", "running": True, "stale": False}
    assert captured["target"].endswith("/api/v1/threads/abc/generation")


def test_on_stop_clears_a_sidecar_left_by_a_dead_process(monkeypatch, tmp_path):
    monkeypatch.setenv("CATENCE_HOME", str(tmp_path))
    monkeypatch.setattr(app.cl, "context", SimpleNamespace(session=SimpleNamespace(thread_id="dead-thread")))
    directory = tmp_path / "generation"
    directory.mkdir()
    sidecar = directory / "dead-thread.generation.json"
    sidecar.write_text(json.dumps({"stage": "running", "heartbeatAt": "2026-01-01T00:00:00+00:00"}))
    app._ACTIVE_GENERATIONS.clear()

    asyncio.run(app.on_stop())

    assert not sidecar.exists()
    assert app._ACTIVE_GENERATIONS == {}


def test_on_stop_cancels_a_live_generation(monkeypatch, tmp_path):
    monkeypatch.setenv("CATENCE_HOME", str(tmp_path))
    monkeypatch.setattr(app.cl, "context", SimpleNamespace(session=SimpleNamespace(thread_id="live-thread")))
    app._ACTIVE_GENERATIONS.clear()
    app._STOP_REQUESTED.clear()

    async def scenario():
        cancelled = asyncio.Event()

        async def sleeper():
            try:
                await asyncio.sleep(60)
            except asyncio.CancelledError:
                cancelled.set()
                raise

        task = asyncio.create_task(sleeper())
        app._ACTIVE_GENERATIONS["live-thread"] = task
        await asyncio.sleep(0)

        await app.on_stop()

        assert cancelled.is_set()
        assert task.cancelled()
        assert "live-thread" not in app._ACTIVE_GENERATIONS
        assert "live-thread" not in app._STOP_REQUESTED

    asyncio.run(scenario())


def test_stopped_generation_does_not_deliver_a_stale_answer(monkeypatch, tmp_path):
    monkeypatch.setenv("CATENCE_HOME", str(tmp_path))
    monkeypatch.setattr(app.cl, "context", SimpleNamespace(session=SimpleNamespace(thread_id="stopped-thread")))
    sent = []

    class FakeMessage:
        def __init__(self, *, content, metadata=None):
            self.content = content
            self.id = "message-1"

        async def send(self):
            sent.append(self.content)

    async def fake_respond(**_kwargs):
        return "a late answer"

    monkeypatch.setattr(app, "respond", fake_respond)
    monkeypatch.setattr(app.cl, "Message", FakeMessage)
    app._ACTIVE_GENERATIONS.clear()
    app._STOP_REQUESTED.clear()

    async def scenario():
        app._STOP_REQUESTED.add("stopped-thread")
        task = asyncio.create_task(
            app._run_generation(
                FakeMessage(content="question"),
                SimpleNamespace(id="local", label="Local"),
                "default",
                None,
                [],
                8,
                24_000,
                {},
                {},
                "martina",
                "Martina",
            )
        )
        app._ACTIVE_GENERATIONS["stopped-thread"] = task
        await task

    asyncio.run(scenario())

    assert sent == []
    assert "stopped-thread" not in app._STOP_REQUESTED
    assert app._ACTIVE_GENERATIONS == {}
