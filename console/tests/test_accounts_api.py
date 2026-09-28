import asyncio
import json

import bcrypt
import pytest
from chainlit.auth.jwt import create_jwt
from chainlit.user import User
from fastapi.testclient import TestClient

from catence_console import app, auth
from catence_console.accounts import (
    ACCOUNTS_FORMAT_VERSION,
    default_accounts_path,
    find_account,
    verify_password,
)

CREATED_AT = "2026-09-28T12:00:00+00:00"
PASSWORD_HASH = bcrypt.hashpw(b"correct horse", bcrypt.gensalt()).decode("utf-8")

BREAK_GLASS_USERNAME = "coach-env"


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
    """A hermetic CATENCE_HOME with stored accounts and no break-glass admin."""

    monkeypatch.setenv("CATENCE_HOME", str(tmp_path))
    monkeypatch.setenv("CHAINLIT_AUTH_SECRET", "test-secret-that-is-long-enough-for-hs256")
    monkeypatch.delenv("CATENCE_CONSOLE_USERNAME", raising=False)
    monkeypatch.delenv("CATENCE_CONSOLE_PASSWORD_HASH", raising=False)
    monkeypatch.delenv("CHAINLIT_LOCAL_USER", raising=False)
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
def break_glass_home(tmp_path, monkeypatch):
    """A hermetic CATENCE_HOME where only the environment break-glass admin exists."""

    monkeypatch.setenv("CATENCE_HOME", str(tmp_path))
    monkeypatch.setenv("CHAINLIT_AUTH_SECRET", "test-secret-that-is-long-enough-for-hs256")
    monkeypatch.setenv("CATENCE_CONSOLE_USERNAME", BREAK_GLASS_USERNAME)
    monkeypatch.setenv("CATENCE_CONSOLE_PASSWORD_HASH", PASSWORD_HASH)
    monkeypatch.delenv("CHAINLIT_LOCAL_USER", raising=False)
    return tmp_path


def client_for(username: str) -> TestClient:
    """A TestClient carrying a valid session cookie for ``username``."""

    client = TestClient(app.chainlit_server)
    client.cookies.set(
        "access_token",
        create_jwt(User(identifier=username, display_name=username, metadata={})),
    )
    return client


def assert_no_store_secrets(response) -> None:
    """Account responses must never leak password hashes or the store file path."""

    assert "passwordHash" not in response.text
    assert PASSWORD_HASH not in response.text
    assert "accounts.json" not in response.text


# ------------------------------------------------------------------ whoami


def test_whoami_requires_login():
    response = TestClient(app.chainlit_server).get("/api/v1/whoami")

    assert response.status_code == 401
    assert response.json()["error"]["code"] == "unauthorized"


def test_whoami_returns_the_member_identity_and_grants(console_home):
    response = client_for("rifusaki").get("/api/v1/whoami")

    assert response.status_code == 200
    assert response.json() == {"username": "rifusaki", "role": "member", "athletes": ["martina"]}


def test_whoami_returns_admin_with_all_athletes(console_home):
    response = client_for("coach").get("/api/v1/whoami")

    assert response.status_code == 200
    assert response.json() == {"username": "coach", "role": "admin", "athletes": "all"}


def test_whoami_keeps_a_zero_grant_member_signed_in(console_home):
    response = client_for("newcomer").get("/api/v1/whoami")

    assert response.status_code == 200
    assert response.json() == {"username": "newcomer", "role": "member", "athletes": []}


def test_whoami_reports_the_environment_break_glass_account_as_admin(break_glass_home):
    response = client_for(BREAK_GLASS_USERNAME).get("/api/v1/whoami")

    assert response.status_code == 200
    assert response.json() == {"username": BREAK_GLASS_USERNAME, "role": "admin", "athletes": "all"}


# --------------------------------------------------------- accounts overview


def test_accounts_overview_requires_login():
    response = TestClient(app.chainlit_server).get("/api/v1/accounts")

    assert response.status_code == 401
    assert response.json()["error"]["code"] == "unauthorized"


def test_accounts_overview_is_admin_only(console_home):
    response = client_for("rifusaki").get("/api/v1/accounts")

    assert response.status_code == 403
    assert response.json()["error"]["code"] == "admin_required"


def test_accounts_overview_lists_public_fields_without_hashes_or_paths(console_home):
    response = client_for("coach").get("/api/v1/accounts")

    assert response.status_code == 200
    assert response.json() == {
        "accounts": [
            {"username": "coach", "role": "admin", "athletes": "all", "createdAt": CREATED_AT},
            {"username": "newcomer", "role": "member", "athletes": [], "createdAt": CREATED_AT},
            {"username": "rifusaki", "role": "member", "athletes": ["martina"], "createdAt": CREATED_AT},
        ],
        "breakGlass": None,
    }
    assert_no_store_secrets(response)


def test_accounts_overview_reports_the_break_glass_username_when_configured(console_home, monkeypatch):
    monkeypatch.setenv("CATENCE_CONSOLE_USERNAME", BREAK_GLASS_USERNAME)
    monkeypatch.setenv("CATENCE_CONSOLE_PASSWORD_HASH", PASSWORD_HASH)

    response = client_for("coach").get("/api/v1/accounts")

    assert response.status_code == 200
    assert response.json()["breakGlass"] == {"username": BREAK_GLASS_USERNAME}


def test_accounts_collection_rejects_non_get_methods(console_home):
    response = client_for("coach").post("/api/v1/accounts", json={})

    assert response.status_code == 405
    assert response.json()["error"]["code"] == "method_not_allowed"


# ------------------------------------------------------------ authorization


@pytest.mark.parametrize("action", ["add", "update", "remove", "passwd"])
def test_account_mutations_require_login(action):
    response = TestClient(app.chainlit_server).post(f"/api/v1/accounts/{action}", json={})

    assert response.status_code == 401
    assert response.json()["error"]["code"] == "unauthorized"


@pytest.mark.parametrize("action", ["add", "update", "remove", "passwd"])
def test_account_mutations_are_admin_only_before_the_body_is_parsed(console_home, action):
    response = client_for("rifusaki").post(f"/api/v1/accounts/{action}", json={"not": "a valid body"})

    assert response.status_code == 403
    assert response.json()["error"]["code"] == "admin_required"


def test_account_mutations_reject_malformed_bodies_with_invalid_request(console_home):
    response = client_for("coach").post(
        "/api/v1/accounts/add",
        content=b"{not json",
        headers={"content-type": "application/json"},
    )

    assert response.status_code == 400
    assert response.json()["error"]["code"] == "invalid_request"


def test_account_mutations_require_a_username(console_home):
    client = client_for("coach")

    for action in ("update", "remove", "passwd"):
        response = client.post(f"/api/v1/accounts/{action}", json={"password": "pw"})
        assert response.status_code == 400
        assert response.json()["error"]["code"] == "invalid_request"


# --------------------------------------------------------------------- add


def test_admin_adds_a_member_who_can_then_authenticate(console_home):
    response = client_for("coach").post(
        "/api/v1/accounts/add",
        json={"username": "nina", "password": "fresh password", "role": "member", "athletes": ["martina"]},
    )

    assert response.status_code == 200
    payload = response.json()
    assert set(payload) == {"username", "role", "athletes", "createdAt"}
    assert (payload["username"], payload["role"], payload["athletes"]) == ("nina", "member", ["martina"])
    assert isinstance(payload["createdAt"], str) and payload["createdAt"]
    assert_no_store_secrets(response)

    user = asyncio.run(auth.authenticate("nina", "fresh password"))
    assert user is not None
    assert user.identifier == "nina"
    assert user.metadata == {"role": "member"}
    assert asyncio.run(auth.authenticate("nina", "wrong")) is None


def test_add_rejects_a_duplicate_username_with_conflict(console_home):
    response = client_for("coach").post(
        "/api/v1/accounts/add",
        json={"username": "rifusaki", "password": "fresh password", "role": "member", "athletes": []},
    )

    assert response.status_code == 409
    assert response.json()["error"]["code"] == "account_exists"
    assert_no_store_secrets(response)


def test_add_rejects_invalid_roles_and_athlete_ids(console_home):
    client = client_for("coach")

    bad_role = client.post(
        "/api/v1/accounts/add",
        json={"username": "nina", "password": "fresh password", "role": "owner", "athletes": []},
    )
    assert bad_role.status_code == 400
    assert bad_role.json()["error"]["code"] == "invalid_request"
    assert "role" in bad_role.json()["error"]["message"]

    bad_athlete = client.post(
        "/api/v1/accounts/add",
        json={"username": "nina", "password": "fresh password", "role": "member", "athletes": ["Martina"]},
    )
    assert bad_athlete.status_code == 400
    assert bad_athlete.json()["error"]["code"] == "invalid_request"
    assert "athlete" in bad_athlete.json()["error"]["message"]

    # Neither rejected request may have stored an account.
    assert find_account(default_accounts_path(console_home), "nina") is None


def test_add_rejects_an_admin_with_an_athlete_list(console_home):
    response = client_for("coach").post(
        "/api/v1/accounts/add",
        json={"username": "nina", "password": "fresh password", "role": "admin", "athletes": ["martina"]},
    )

    assert response.status_code == 400
    assert response.json()["error"]["code"] == "invalid_request"
    assert "admin" in response.json()["error"]["message"]


# ------------------------------------------------------------------ update


def test_update_changes_grants_then_promotes_and_demotes(console_home):
    client = client_for("coach")
    path = default_accounts_path(console_home)

    granted = client.post(
        "/api/v1/accounts/update", json={"username": "rifusaki", "athletes": ["martina", "coach-athlete"]}
    )
    assert granted.status_code == 200
    assert granted.json()["athletes"] == ["martina", "coach-athlete"]
    stored = find_account(path, "rifusaki")
    assert stored is not None and stored.athletes == ["martina", "coach-athlete"]
    assert_no_store_secrets(granted)

    promoted = client.post("/api/v1/accounts/update", json={"username": "rifusaki", "role": "admin"})
    assert promoted.status_code == 200
    assert (promoted.json()["role"], promoted.json()["athletes"]) == ("admin", "all")
    stored = find_account(path, "rifusaki")
    assert stored is not None and (stored.role, stored.athletes) == ("admin", "all")

    demoted = client.post("/api/v1/accounts/update", json={"username": "rifusaki", "role": "member"})
    assert demoted.status_code == 200
    assert (demoted.json()["role"], demoted.json()["athletes"]) == ("member", "all")
    stored = find_account(path, "rifusaki")
    assert stored is not None and (stored.role, stored.athletes) == ("member", "all")


def test_update_unknown_user_is_not_found(console_home):
    response = client_for("coach").post("/api/v1/accounts/update", json={"username": "ghost", "role": "member"})

    assert response.status_code == 404
    assert response.json()["error"]["code"] == "account_not_found"
    assert_no_store_secrets(response)


def test_update_without_requested_changes_is_rejected(console_home):
    response = client_for("coach").post("/api/v1/accounts/update", json={"username": "rifusaki"})

    assert response.status_code == 400
    assert response.json()["error"]["code"] == "invalid_request"


# ------------------------------------------------------------------ remove


def test_remove_deletes_an_account(console_home):
    response = client_for("coach").post("/api/v1/accounts/remove", json={"username": "newcomer"})

    assert response.status_code == 200
    assert response.json() == {"ok": True}
    assert find_account(default_accounts_path(console_home), "newcomer") is None


def test_remove_unknown_user_is_not_found(console_home):
    response = client_for("coach").post("/api/v1/accounts/remove", json={"username": "ghost"})

    assert response.status_code == 404
    assert response.json()["error"]["code"] == "account_not_found"
    assert_no_store_secrets(response)


def test_remove_refuses_the_last_stored_admin_without_break_glass(console_home):
    response = client_for("coach").post("/api/v1/accounts/remove", json={"username": "coach"})

    assert response.status_code == 400
    assert response.json()["error"]["code"] == "last_admin"
    assert find_account(default_accounts_path(console_home), "coach") is not None


def test_remove_allows_the_last_stored_admin_when_break_glass_is_configured(console_home, monkeypatch):
    monkeypatch.setenv("CATENCE_CONSOLE_USERNAME", BREAK_GLASS_USERNAME)
    monkeypatch.setenv("CATENCE_CONSOLE_PASSWORD_HASH", PASSWORD_HASH)

    response = client_for("coach").post("/api/v1/accounts/remove", json={"username": "coach"})

    assert response.status_code == 200
    assert response.json() == {"ok": True}
    assert find_account(default_accounts_path(console_home), "coach") is None


def test_remove_allows_an_admin_when_another_admin_remains(console_home):
    client = client_for("coach")
    promoted = client.post("/api/v1/accounts/update", json={"username": "rifusaki", "role": "admin"})
    assert promoted.status_code == 200

    response = client.post("/api/v1/accounts/remove", json={"username": "coach"})

    assert response.status_code == 200
    assert find_account(default_accounts_path(console_home), "coach") is None


# ------------------------------------------------------------------ passwd


def test_passwd_replaces_the_password(console_home):
    response = client_for("coach").post(
        "/api/v1/accounts/passwd", json={"username": "newcomer", "password": "new password"}
    )

    assert response.status_code == 200
    assert response.json() == {"ok": True}
    stored = find_account(default_accounts_path(console_home), "newcomer")
    assert stored is not None
    assert verify_password(stored, "new password") is True
    assert verify_password(stored, "correct horse") is False


def test_passwd_unknown_user_is_not_found(console_home):
    response = client_for("coach").post(
        "/api/v1/accounts/passwd", json={"username": "ghost", "password": "new password"}
    )

    assert response.status_code == 404
    assert response.json()["error"]["code"] == "account_not_found"
    assert_no_store_secrets(response)


def test_passwd_rejects_an_empty_password(console_home):
    response = client_for("coach").post("/api/v1/accounts/passwd", json={"username": "newcomer", "password": ""})

    assert response.status_code == 400
    assert response.json()["error"]["code"] == "invalid_request"


# ------------------------------------------------------------- env-only


def test_environment_only_install_supports_whoami_and_account_management(break_glass_home):
    client = client_for(BREAK_GLASS_USERNAME)

    identity = client.get("/api/v1/whoami")
    assert identity.status_code == 200
    assert identity.json() == {"username": BREAK_GLASS_USERNAME, "role": "admin", "athletes": "all"}

    listed = client.get("/api/v1/accounts")
    assert listed.status_code == 200
    assert listed.json() == {"accounts": [], "breakGlass": {"username": BREAK_GLASS_USERNAME}}

    added = client.post(
        "/api/v1/accounts/add",
        json={"username": "nina", "password": "fresh password", "role": "member", "athletes": ["martina"]},
    )
    assert added.status_code == 200

    refreshed = client.get("/api/v1/accounts")
    assert [account["username"] for account in refreshed.json()["accounts"]] == ["nina"]
    assert refreshed.json()["breakGlass"] == {"username": BREAK_GLASS_USERNAME}
