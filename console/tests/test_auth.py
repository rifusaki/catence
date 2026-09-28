import asyncio

import bcrypt
import pytest

from catence_console import auth
from catence_console.accounts import add_account, default_accounts_path


@pytest.fixture(autouse=True)
def isolated_console_home(monkeypatch, tmp_path):
    """Keep every test hermetic: no real $CATENCE_HOME, no ambient account."""

    monkeypatch.setenv("CATENCE_HOME", str(tmp_path))
    monkeypatch.delenv("CATENCE_CONSOLE_USERNAME", raising=False)
    monkeypatch.delenv("CATENCE_CONSOLE_PASSWORD_HASH", raising=False)
    monkeypatch.delenv("CHAINLIT_AUTH_SECRET", raising=False)
    return tmp_path


def set_environment_account(monkeypatch, username="coach", password="correct horse"):
    monkeypatch.setenv("CATENCE_CONSOLE_USERNAME", username)
    monkeypatch.setenv("CATENCE_CONSOLE_PASSWORD_HASH", bcrypt.hashpw(password.encode("utf-8"), bcrypt.gensalt()).decode("utf-8"))
    monkeypatch.setenv("CHAINLIT_AUTH_SECRET", "test-secret")


def test_password_callback_accepts_only_the_configured_shared_account(monkeypatch):
    set_environment_account(monkeypatch)

    user = asyncio.run(auth.authenticate("coach", "correct horse"))

    assert user is not None
    assert user.identifier == "coach"
    assert user.metadata == {"role": "admin", "breakGlass": True}
    assert asyncio.run(auth.authenticate("coach", "wrong")) is None
    assert asyncio.run(auth.authenticate("other", "correct horse")) is None


def test_auth_configuration_fails_closed_when_required_environment_is_missing(monkeypatch):
    monkeypatch.delenv("CATENCE_CONSOLE_USERNAME", raising=False)
    monkeypatch.delenv("CATENCE_CONSOLE_PASSWORD_HASH", raising=False)
    monkeypatch.delenv("CHAINLIT_AUTH_SECRET", raising=False)

    assert set(auth.missing_auth_environment()) == {
        "CATENCE_CONSOLE_USERNAME",
        "CATENCE_CONSOLE_PASSWORD_HASH",
        "CHAINLIT_AUTH_SECRET",
    }


def test_accounts_path_follows_catence_home(isolated_console_home):
    assert auth.accounts_path() == default_accounts_path(isolated_console_home)


def test_authenticate_accepts_a_stored_member(isolated_console_home):
    add_account(
        default_accounts_path(isolated_console_home),
        username="martina",
        password="correct horse",
        role="member",
        athletes=["martina"],
    )

    user = asyncio.run(auth.authenticate("martina", "correct horse"))

    assert user is not None
    assert user.identifier == "martina"
    assert user.display_name == "martina"
    assert user.metadata == {"role": "member"}
    assert asyncio.run(auth.authenticate("martina", "wrong")) is None
    assert asyncio.run(auth.authenticate("unknown", "correct horse")) is None


def test_authenticate_accepts_a_stored_admin(isolated_console_home):
    add_account(
        default_accounts_path(isolated_console_home),
        username="coach",
        password="correct horse",
        role="admin",
        athletes="all",
    )

    user = asyncio.run(auth.authenticate("coach", "correct horse"))

    assert user is not None
    assert user.metadata == {"role": "admin"}


def test_authenticate_prefers_the_stored_account_but_keeps_the_break_glass_admin(monkeypatch, isolated_console_home):
    set_environment_account(monkeypatch, username="coach", password="env-password")
    add_account(
        default_accounts_path(isolated_console_home),
        username="coach",
        password="store-password",
        role="member",
        athletes=[],
    )

    stored = asyncio.run(auth.authenticate("coach", "store-password"))
    break_glass = asyncio.run(auth.authenticate("coach", "env-password"))

    assert stored is not None
    assert stored.metadata == {"role": "member"}
    assert break_glass is not None
    assert break_glass.metadata == {"role": "admin", "breakGlass": True}
    assert asyncio.run(auth.authenticate("coach", "wrong")) is None


def test_validate_auth_configuration_accepts_a_store_only_setup(monkeypatch, isolated_console_home):
    monkeypatch.setenv("CHAINLIT_AUTH_SECRET", "test-secret")
    add_account(
        default_accounts_path(isolated_console_home),
        username="martina",
        password="pw",
        role="member",
        athletes=[],
    )

    auth.validate_auth_configuration()


def test_validate_auth_configuration_accepts_an_environment_only_setup(monkeypatch):
    set_environment_account(monkeypatch)

    auth.validate_auth_configuration()


def test_validate_auth_configuration_requires_the_chainlit_secret(monkeypatch, isolated_console_home):
    add_account(
        default_accounts_path(isolated_console_home),
        username="martina",
        password="pw",
        role="member",
        athletes=[],
    )

    with pytest.raises(RuntimeError, match="CHAINLIT_AUTH_SECRET"):
        auth.validate_auth_configuration()


def test_validate_auth_configuration_rejects_a_partial_environment_pair(monkeypatch):
    monkeypatch.setenv("CHAINLIT_AUTH_SECRET", "test-secret")
    monkeypatch.setenv("CATENCE_CONSOLE_USERNAME", "coach")

    with pytest.raises(RuntimeError, match="must be set together"):
        auth.validate_auth_configuration()


def test_validate_auth_configuration_explains_both_options(monkeypatch):
    monkeypatch.setenv("CHAINLIT_AUTH_SECRET", "test-secret")

    with pytest.raises(RuntimeError) as error:
        auth.validate_auth_configuration()

    assert "catence-console users add" in str(error.value)
    assert "CATENCE_CONSOLE_USERNAME" in str(error.value)


def test_validate_auth_configuration_rejects_a_malformed_store(monkeypatch, isolated_console_home):
    set_environment_account(monkeypatch)
    (isolated_console_home / "console").mkdir(parents=True, exist_ok=True)
    default_accounts_path(isolated_console_home).write_text("{not json", encoding="utf-8")

    with pytest.raises(RuntimeError, match="unusable"):
        auth.validate_auth_configuration()


def test_malformed_store_keeps_the_environment_account_working(monkeypatch, isolated_console_home, caplog):
    set_environment_account(monkeypatch)
    (isolated_console_home / "console").mkdir(parents=True, exist_ok=True)
    default_accounts_path(isolated_console_home).write_text("{not json", encoding="utf-8")

    user = asyncio.run(auth.authenticate("coach", "correct horse"))

    assert user is not None
    assert user.metadata == {"role": "admin", "breakGlass": True}
    assert asyncio.run(auth.authenticate("martina", "correct horse")) is None
    assert "Ignoring unusable Console accounts store" in caplog.text
