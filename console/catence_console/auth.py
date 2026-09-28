"""Password authentication for a Console exposed through a reverse proxy."""

from __future__ import annotations

import logging
import os
from dataclasses import dataclass
from pathlib import Path

import bcrypt
import chainlit as cl
from chainlit.user import User

from .accounts import (
    AccountsStoreError,
    ConsoleAccount,
    default_accounts_path,
    env_account,
    load_accounts,
    verify_password,
)

logger = logging.getLogger(__name__)


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


def data_directory() -> Path:
    """The Catence data directory; resolved per call like ``app.DATA_DIRECTORY``."""

    return Path(os.environ.get("CATENCE_HOME", str(Path.home() / ".catence"))).expanduser().resolve()


def accounts_path() -> Path:
    """The Console accounts store this process reads and writes."""

    return default_accounts_path(data_directory())


def validate_auth_configuration() -> None:
    """Fail fast when the Console cannot authenticate anyone safely.

    ``CHAINLIT_AUTH_SECRET`` is always required. After that, the environment
    break-glass admin and the accounts store are independent login sources:
    at least one must be configured, and a malformed store is fatal even when
    the environment pair is present.
    """

    if not os.environ.get("CHAINLIT_AUTH_SECRET"):
        raise RuntimeError(
            "CHAINLIT_AUTH_SECRET is required so Chainlit can sign Console sessions. "
            "Set it to a random secret (for example `openssl rand -hex 32`) and configure a Console user with "
            "`catence-console users add <username>` or the CATENCE_CONSOLE_USERNAME/CATENCE_CONSOLE_PASSWORD_HASH "
            "environment pair."
        )
    username = os.environ.get("CATENCE_CONSOLE_USERNAME")
    password_hash = os.environ.get("CATENCE_CONSOLE_PASSWORD_HASH")
    if bool(username) != bool(password_hash):
        missing = "CATENCE_CONSOLE_PASSWORD_HASH" if username else "CATENCE_CONSOLE_USERNAME"
        raise RuntimeError(
            f"CATENCE_CONSOLE_USERNAME and CATENCE_CONSOLE_PASSWORD_HASH must be set together; {missing} is missing. "
            "Set both for the environment break-glass admin, or unset both and manage Console users with "
            "`catence-console users add <username>`."
        )
    if username:
        assert password_hash is not None
        try:
            bcrypt.checkpw(b"test", password_hash.encode("utf-8"))
        except (TypeError, ValueError) as error:
            raise RuntimeError("CATENCE_CONSOLE_PASSWORD_HASH must be a valid bcrypt hash.") from error
    try:
        stored_accounts = load_accounts(accounts_path())
    except AccountsStoreError as error:
        raise RuntimeError(f"Console accounts store is unusable: {error}") from error
    if not username and not stored_accounts:
        raise RuntimeError(
            "No Console login is configured. Add one with `catence-console users add <username>`, or set the "
            "CATENCE_CONSOLE_USERNAME and CATENCE_CONSOLE_PASSWORD_HASH environment pair as an environment "
            "break-glass admin (CHAINLIT_AUTH_SECRET is always required)."
        )


def _stored_account(username: str) -> ConsoleAccount | None:
    try:
        accounts = load_accounts(accounts_path())
    except AccountsStoreError as error:
        logger.warning("Ignoring unusable Console accounts store: %s", error)
        return None
    return next((account for account in accounts if account.username == username), None)


@cl.password_auth_callback
async def authenticate(username: str, password: str) -> User | None:
    """Authenticate a stored Console account, then the environment break-glass admin.

    The accounts store is re-read per login so user management takes effect
    without a restart. A malformed store only disables store logins; the
    environment break-glass admin keeps working.
    """

    account = _stored_account(username)
    if account is not None and verify_password(account, password):
        return User(
            identifier=account.username,
            display_name=account.username,
            metadata={"role": account.role},
        )
    break_glass = env_account()
    if break_glass is not None and username == break_glass.username and verify_password(break_glass, password):
        return User(
            identifier=break_glass.username,
            metadata={"role": break_glass.role, "breakGlass": True},
        )
    return None
