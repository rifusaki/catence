"""Password authentication for a Console exposed through a reverse proxy."""

from __future__ import annotations

import os
from dataclasses import dataclass

import bcrypt
import chainlit as cl
from chainlit.user import User


@dataclass(frozen=True)
class ConsoleAuthConfiguration:
    username: str
    password_hash: str
    jwt_secret: str


def missing_auth_environment() -> tuple[str, ...]:
    return tuple(
        name
        for name in (
            "CATENCE_CONSOLE_USERNAME",
            "CATENCE_CONSOLE_PASSWORD_HASH",
            "CHAINLIT_AUTH_SECRET",
        )
        if not os.environ.get(name)
    )


def auth_configuration() -> ConsoleAuthConfiguration | None:
    if missing_auth_environment():
        return None
    return ConsoleAuthConfiguration(
        username=os.environ["CATENCE_CONSOLE_USERNAME"],
        password_hash=os.environ["CATENCE_CONSOLE_PASSWORD_HASH"],
        jwt_secret=os.environ["CHAINLIT_AUTH_SECRET"],
    )


def validate_auth_configuration() -> None:
    missing = missing_auth_environment()
    if missing:
        raise RuntimeError(
            "Console authentication is required. Set " + ", ".join(missing) + ". "
            "Generate a bcrypt hash with `catence-console auth hash-password`."
        )
    configuration = auth_configuration()
    assert configuration is not None
    try:
        bcrypt.checkpw(b"test", configuration.password_hash.encode("utf-8"))
    except (TypeError, ValueError) as error:
        raise RuntimeError("CATENCE_CONSOLE_PASSWORD_HASH must be a valid bcrypt hash.") from error


@cl.password_auth_callback
async def authenticate(username: str, password: str) -> User | None:
    """Authenticate the one shared Console account without logging credentials."""

    configuration = auth_configuration()
    if configuration is None or username != configuration.username:
        return None
    try:
        valid = bcrypt.checkpw(password.encode("utf-8"), configuration.password_hash.encode("utf-8"))
    except (TypeError, ValueError):
        return None
    if not valid:
        return None
    return User(identifier=configuration.username, metadata={"role": "console-owner"})
