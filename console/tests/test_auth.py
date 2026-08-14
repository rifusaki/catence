import asyncio

import bcrypt

from catence_console import auth


def test_password_callback_accepts_only_the_configured_shared_account(monkeypatch):
    monkeypatch.setenv("CATENCE_CONSOLE_USERNAME", "coach")
    monkeypatch.setenv("CATENCE_CONSOLE_PASSWORD_HASH", bcrypt.hashpw(b"correct horse", bcrypt.gensalt()).decode("utf-8"))
    monkeypatch.setenv("CHAINLIT_AUTH_SECRET", "test-secret")

    user = asyncio.run(auth.authenticate("coach", "correct horse"))

    assert user is not None
    assert user.identifier == "coach"
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
