"""Per-account Console logins and athlete access, stored next to the catalog.

Accounts live in ``<data directory>/console/accounts.json`` where the data
directory defaults to ``$CATENCE_HOME`` or ``~/.catence``. They are
Console-only: the MCP server itself stays open, and model settings or global
features are not gated by them. The file is written atomically with mode 0o600
and looks like::

    {
      "formatVersion": 1,
      "accounts": [
        {
          "username": "martina",
          "passwordHash": "$2b$12$...",
          "role": "member",
          "athletes": ["martina"],
          "createdAt": "2026-09-28T12:00:00+00:00"
        }
      ]
    }

``role`` is ``"admin"`` (sees every athlete) or ``"member"``; ``athletes`` is
``"all"`` or a list of catalog athlete ids. Admins must use ``"all"``, and
members may hold zero grants (an empty list). A malformed or unreadable file
fails closed: loading raises :class:`AccountsStoreError` and callers must not
fall back to anonymous access. The environment break-glass account
(``CATENCE_CONSOLE_USERNAME`` / ``CATENCE_CONSOLE_PASSWORD_HASH``) is never
persisted here.
"""

from __future__ import annotations

import json
import os
import re
import uuid
from dataclasses import dataclass, replace
from datetime import UTC, datetime
from pathlib import Path

import bcrypt

ACCOUNTS_FORMAT_VERSION = 1
ACCOUNT_ROLES = ("admin", "member")
ALL_ATHLETES = "all"

USERNAME_PATTERN = re.compile(r"^[A-Za-z0-9._-]{1,64}$")
ATHLETE_ID_PATTERN = re.compile(r"^[a-z][a-z0-9-]{0,62}$")

_ACCOUNT_FIELDS = ("username", "passwordHash", "role", "athletes", "createdAt")
_STORE_FIELDS = ("formatVersion", "accounts")


class AccountsError(Exception):
    """Base class for Console accounts store failures."""


class AccountsStoreError(AccountsError):
    """Raised when accounts.json is malformed, unreadable, or unwritable."""


class AccountExistsError(AccountsError):
    """Raised when adding a username that already exists."""


class AccountNotFoundError(AccountsError):
    """Raised when a mutation names a username that is not stored."""


class AccountValidationError(AccountsError, ValueError):
    """Raised when a value would store an unusable Console account."""


@dataclass(frozen=True)
class ConsoleAccount:
    """One Console login and the athletes it may access."""

    username: str
    password_hash: str
    role: str
    athletes: str | list[str]
    created_at: str


def default_accounts_path(data_directory: Path) -> Path:
    """The accounts store location for a Catence data directory."""

    return data_directory / "console" / "accounts.json"


def hash_password(password: str) -> str:
    """Hash a non-empty Console password with bcrypt."""

    if not password:
        raise AccountValidationError("Console password cannot be empty.")
    return bcrypt.hashpw(password.encode("utf-8"), bcrypt.gensalt()).decode("utf-8")


def verify_password(password_hash_or_account: str | ConsoleAccount, password: str) -> bool:
    """Check a password against a hash or account; malformed hashes never raise."""

    password_hash = (
        password_hash_or_account.password_hash
        if isinstance(password_hash_or_account, ConsoleAccount)
        else password_hash_or_account
    )
    try:
        return bcrypt.checkpw(password.encode("utf-8"), password_hash.encode("utf-8"))
    except (TypeError, ValueError):
        return False


def env_account() -> ConsoleAccount | None:
    """The environment break-glass admin, or ``None`` unless both variables are set.

    The account is validated like any other at login but never persisted:
    unsetting the environment variables always revokes it.
    """

    username = os.environ.get("CATENCE_CONSOLE_USERNAME")
    password_hash = os.environ.get("CATENCE_CONSOLE_PASSWORD_HASH")
    if not username or not password_hash:
        return None
    return ConsoleAccount(
        username=username,
        password_hash=password_hash,
        role="admin",
        athletes=ALL_ATHLETES,
        created_at=datetime.now(UTC).isoformat(),
    )


def account_can_access(account: ConsoleAccount, athlete_id: str) -> bool:
    """True when the account may act for the athlete."""

    if account.role == "admin":
        return True
    if account.athletes == ALL_ATHLETES:
        return True
    return athlete_id in account.athletes


def load_accounts(path: Path) -> list[ConsoleAccount]:
    """Load and strictly validate the accounts store at ``path``.

    A missing file is an empty store; every other problem raises
    :class:`AccountsStoreError` so callers fail closed instead of silently
    dropping accounts.
    """

    try:
        text = path.read_text(encoding="utf-8")
    except FileNotFoundError:
        return []
    except (OSError, UnicodeDecodeError) as error:
        raise AccountsStoreError(f"Could not read Console accounts at {path}: {error}") from error
    try:
        payload = json.loads(text)
    except json.JSONDecodeError as error:
        raise AccountsStoreError(f"Console accounts at {path} are not valid JSON: {error}") from error
    if not isinstance(payload, dict):
        raise AccountsStoreError(f"Console accounts at {path} must be a JSON object.")
    unknown_fields = sorted(set(payload) - set(_STORE_FIELDS))
    if unknown_fields:
        raise AccountsStoreError(f"Console accounts at {path} contain unknown fields: {', '.join(unknown_fields)}.")
    version = payload.get("formatVersion")
    if version != ACCOUNTS_FORMAT_VERSION or isinstance(version, bool):
        raise AccountsStoreError(f"Console accounts at {path} must declare formatVersion {ACCOUNTS_FORMAT_VERSION}.")
    raw_accounts = payload.get("accounts")
    if not isinstance(raw_accounts, list):
        raise AccountsStoreError(f"Console accounts at {path} must contain an accounts list.")
    accounts = [
        _account_from_json(entry, path=path, index=index)
        for index, entry in enumerate(raw_accounts)
    ]
    usernames = [account.username for account in accounts]
    duplicates = sorted({username for username in usernames if usernames.count(username) > 1})
    if duplicates:
        raise AccountsStoreError(f"Console accounts at {path} contain duplicate usernames: {', '.join(duplicates)}.")
    return accounts


def save_accounts(path: Path, accounts: list[ConsoleAccount]) -> None:
    """Validate ``accounts`` and atomically replace the store at ``path``.

    The containing directory is created private (0o700), the temporary file is
    written with mode 0o600, and ``os.replace`` makes the swap atomic.
    """

    validated = [_validated_account(account) for account in accounts]
    usernames = [account.username for account in validated]
    duplicates = sorted({username for username in usernames if usernames.count(username) > 1})
    if duplicates:
        raise AccountValidationError(f"Console accounts must have unique usernames; duplicates: {', '.join(duplicates)}.")
    payload = {
        "formatVersion": ACCOUNTS_FORMAT_VERSION,
        "accounts": [_account_to_json(account) for account in validated],
    }
    try:
        path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    except OSError as error:
        raise AccountsStoreError(f"Could not create Console accounts directory {path.parent}: {error}") from error
    temporary = path.with_name(f"{path.name}.{uuid.uuid4().hex}.tmp")
    try:
        descriptor = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
        with os.fdopen(descriptor, "w", encoding="utf-8") as handle:
            handle.write(json.dumps(payload, indent=2) + "\n")
        os.replace(temporary, path)
    except OSError as error:
        temporary.unlink(missing_ok=True)
        raise AccountsStoreError(f"Could not write Console accounts to {path}: {error}") from error


def find_account(path: Path, username: str) -> ConsoleAccount | None:
    """Return the stored account named ``username``, if any."""

    return next((account for account in load_accounts(path) if account.username == username), None)


def add_account(
    path: Path,
    *,
    username: str,
    password: str,
    role: str,
    athletes: str | list[str],
) -> ConsoleAccount:
    """Add one account, failing if the username is already stored."""

    account = _validated_account(
        ConsoleAccount(
            username=username,
            password_hash=hash_password(password),
            role=role,
            athletes=athletes,
            created_at=datetime.now(UTC).isoformat(),
        )
    )
    existing = load_accounts(path)
    if any(stored.username == account.username for stored in existing):
        raise AccountExistsError(f"Console account {account.username!r} already exists in {path}.")
    save_accounts(path, [*existing, account])
    return account


def remove_account(path: Path, username: str) -> ConsoleAccount:
    """Remove and return one stored account."""

    accounts = load_accounts(path)
    removed = next((account for account in accounts if account.username == username), None)
    if removed is None:
        raise AccountNotFoundError(f"Console account {username!r} was not found in {path}.")
    save_accounts(path, [account for account in accounts if account.username != username])
    return removed


def update_account(
    path: Path,
    username: str,
    *,
    password: str | None = None,
    role: str | None = None,
    athletes: str | list[str] | None = None,
) -> ConsoleAccount:
    """Update one account; omitted fields keep their current values.

    Promoting to admin coerces ``athletes`` to ``"all"``. Demoting to member
    keeps the current grants, which may therefore remain ``"all"``.
    """

    if password is None and role is None and athletes is None:
        raise AccountValidationError(f"No changes were requested for Console account {username!r}.")
    accounts = load_accounts(path)
    current = next((account for account in accounts if account.username == username), None)
    if current is None:
        raise AccountNotFoundError(f"Console account {username!r} was not found in {path}.")
    next_athletes: object = current.athletes if athletes is None else athletes
    if role == "admin" and athletes is None:
        next_athletes = ALL_ATHLETES
    updated = _validated_account(
        replace(
            current,
            password_hash=current.password_hash if password is None else hash_password(password),
            role=current.role if role is None else role,
            athletes=next_athletes,
        )
    )
    save_accounts(path, [updated if account.username == username else account for account in accounts])
    return updated


def _validated_account(account: ConsoleAccount) -> ConsoleAccount:
    """Return ``account`` canonicalized, raising on any unusable field."""

    username = _validated_username(account.username)
    role = _validated_role(account.role)
    return ConsoleAccount(
        username=username,
        password_hash=_validated_password_hash(account.password_hash),
        role=role,
        athletes=_parsed_athletes(account.athletes, role=role, username=username),
        created_at=_validated_created_at(account.created_at),
    )


def _validated_username(username: str) -> str:
    if not isinstance(username, str) or not USERNAME_PATTERN.fullmatch(username):
        raise AccountValidationError(
            f"Console username {username!r} must be 1-64 characters of letters, digits, dots, underscores, or hyphens."
        )
    return username


def _validated_password_hash(password_hash: str) -> str:
    if not isinstance(password_hash, str) or not password_hash.startswith("$2"):
        raise AccountValidationError("Console password hashes must be bcrypt hashes starting with '$2'.")
    return password_hash


def _validated_role(role: str) -> str:
    if role not in ACCOUNT_ROLES:
        raise AccountValidationError(f"Console role {role!r} must be one of: {', '.join(ACCOUNT_ROLES)}.")
    return role


def _parsed_athletes(athletes: object, *, role: str, username: str) -> str | list[str]:
    if athletes == ALL_ATHLETES:
        return ALL_ATHLETES
    if not isinstance(athletes, list):
        raise AccountValidationError(
            f"Console account {username!r} athletes must be '{ALL_ATHLETES}' or a list of athlete ids."
        )
    if role == "admin":
        raise AccountValidationError(f"Console admin {username!r} must use athletes '{ALL_ATHLETES}', not an athlete list.")
    parsed: list[str] = []
    for athlete_id in athletes:
        if not isinstance(athlete_id, str) or not ATHLETE_ID_PATTERN.fullmatch(athlete_id):
            raise AccountValidationError(f"Console account {username!r} has an invalid athlete id: {athlete_id!r}.")
        if athlete_id not in parsed:
            parsed.append(athlete_id)
    return parsed


def _validated_created_at(created_at: str) -> str:
    if not isinstance(created_at, str) or not created_at:
        raise AccountValidationError("Console accounts must carry a non-empty ISO createdAt timestamp.")
    try:
        datetime.fromisoformat(created_at)
    except ValueError as error:
        raise AccountValidationError(f"Console account createdAt {created_at!r} is not an ISO timestamp.") from error
    return created_at


def _account_to_json(account: ConsoleAccount) -> dict[str, object]:
    return {
        "username": account.username,
        "passwordHash": account.password_hash,
        "role": account.role,
        "athletes": account.athletes,
        "createdAt": account.created_at,
    }


def _account_from_json(payload: object, *, path: Path, index: int) -> ConsoleAccount:
    if not isinstance(payload, dict):
        raise AccountsStoreError(f"Console accounts at {path} contain a non-object account at index {index}.")
    unknown_fields = sorted(set(payload) - set(_ACCOUNT_FIELDS))
    if unknown_fields:
        raise AccountsStoreError(
            f"Console accounts at {path} contain unknown fields at index {index}: {', '.join(unknown_fields)}."
        )
    missing_fields = [field for field in _ACCOUNT_FIELDS if field not in payload]
    if missing_fields:
        raise AccountsStoreError(
            f"Console accounts at {path} are missing fields at index {index}: {', '.join(missing_fields)}."
        )
    try:
        return _validated_account(
            ConsoleAccount(
                username=payload["username"],
                password_hash=payload["passwordHash"],
                role=payload["role"],
                athletes=payload["athletes"],
                created_at=payload["createdAt"],
            )
        )
    except AccountValidationError as error:
        raise AccountsStoreError(f"Console accounts at {path} are invalid at index {index}: {error}") from error
