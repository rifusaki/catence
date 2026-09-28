"""Runtime-managed credentials for extra Console tool servers.

Admins can set or clear the environment variables referenced by
``console.mcpServers`` from the Console UI after the runtime has started. The
values live in ``<data directory>/console/tool_server_secrets.json`` where the
data directory defaults to ``$CATENCE_HOME`` or ``~/.catence``. The file is
written atomically with mode 0o600 and looks like::

    {
      "formatVersion": 1,
      "secrets": {
        "EXA_API_KEY": "…"
      }
    }

Values here take precedence over the process environment when a tool server
connects, so a saved credential applies to the next chat turn without a
restart. A malformed or unreadable file raises
:class:`ToolServerSecretsStoreError`; chat turns fall back to the process
environment, while the Console UI and ``doctor`` surface the problem.
"""

from __future__ import annotations

import json
import os
import re
import uuid
from pathlib import Path

TOOL_SERVER_SECRETS_FORMAT_VERSION = 1
SECRET_NAME_PATTERN = re.compile(r"^[A-Za-z_][A-Za-z0-9_]{0,127}$")
MAX_SECRET_CHARACTERS = 8_192

_STORE_FIELDS = ("formatVersion", "secrets")


class ToolServerSecretsError(Exception):
    """Base class for Console tool-server credential failures."""


class ToolServerSecretsStoreError(ToolServerSecretsError):
    """Raised when the credential store is malformed, unreadable, or unwritable."""


class ToolServerSecretValidationError(ToolServerSecretsError, ValueError):
    """Raised when a credential name or value cannot be stored."""


def default_tool_server_secrets_path(data_directory: Path) -> Path:
    """The credential store location for a Catence data directory."""

    return data_directory / "console" / "tool_server_secrets.json"


def _validated_secret(name: object, value: object) -> tuple[str, str]:
    if not isinstance(name, str) or not SECRET_NAME_PATTERN.match(name):
        raise ToolServerSecretValidationError(
            "Credential names must look like environment variables (letters, digits, and underscores)."
        )
    if not isinstance(value, str) or not value:
        raise ToolServerSecretValidationError(f"Credential {name} must be a non-empty string.")
    if len(value) > MAX_SECRET_CHARACTERS:
        raise ToolServerSecretValidationError(
            f"Credential {name} is longer than {MAX_SECRET_CHARACTERS} characters."
        )
    return name, value


def load_tool_server_secrets(path: Path) -> dict[str, str]:
    """Load and strictly validate the credential store at ``path``.

    A missing file is an empty store; every other problem raises
    :class:`ToolServerSecretsStoreError` so callers can decide between failing
    and falling back to the process environment.
    """

    try:
        text = path.read_text(encoding="utf-8")
    except FileNotFoundError:
        return {}
    except (OSError, UnicodeDecodeError) as error:
        raise ToolServerSecretsStoreError(f"Could not read Console tool-server credentials at {path}: {error}") from error
    try:
        payload = json.loads(text)
    except json.JSONDecodeError as error:
        raise ToolServerSecretsStoreError(
            f"Console tool-server credentials at {path} are not valid JSON: {error}"
        ) from error
    if not isinstance(payload, dict):
        raise ToolServerSecretsStoreError(f"Console tool-server credentials at {path} must be a JSON object.")
    unknown_fields = sorted(set(payload) - set(_STORE_FIELDS))
    if unknown_fields:
        raise ToolServerSecretsStoreError(
            f"Console tool-server credentials at {path} contain unknown fields: {', '.join(unknown_fields)}."
        )
    version = payload.get("formatVersion")
    if version != TOOL_SERVER_SECRETS_FORMAT_VERSION or isinstance(version, bool):
        raise ToolServerSecretsStoreError(
            f"Console tool-server credentials at {path} must declare formatVersion {TOOL_SERVER_SECRETS_FORMAT_VERSION}."
        )
    raw_secrets = payload.get("secrets")
    if not isinstance(raw_secrets, dict):
        raise ToolServerSecretsStoreError(f"Console tool-server credentials at {path} must contain a secrets object.")
    secrets: dict[str, str] = {}
    for name, value in raw_secrets.items():
        try:
            validated_name, validated_value = _validated_secret(name, value)
        except ToolServerSecretValidationError as error:
            raise ToolServerSecretsStoreError(
                f"Console tool-server credentials at {path} are invalid: {error}"
            ) from error
        secrets[validated_name] = validated_value
    return secrets


def save_tool_server_secrets(path: Path, secrets: dict[str, str]) -> None:
    """Validate ``secrets`` and atomically replace the store at ``path``.

    The containing directory is created private (0o700), the temporary file is
    written with mode 0o600, and ``os.replace`` makes the swap atomic.
    """

    validated = dict(_validated_secret(name, value) for name, value in secrets.items())
    payload = {
        "formatVersion": TOOL_SERVER_SECRETS_FORMAT_VERSION,
        "secrets": validated,
    }
    try:
        path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    except OSError as error:
        raise ToolServerSecretsStoreError(
            f"Could not create Console tool-server credentials directory {path.parent}: {error}"
        ) from error
    temporary = path.with_name(f"{path.name}.{uuid.uuid4().hex}.tmp")
    try:
        descriptor = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
        with os.fdopen(descriptor, "w", encoding="utf-8") as handle:
            handle.write(json.dumps(payload, indent=2) + "\n")
        os.replace(temporary, path)
    except OSError as error:
        temporary.unlink(missing_ok=True)
        raise ToolServerSecretsStoreError(
            f"Could not write Console tool-server credentials to {path}: {error}"
        ) from error


def set_tool_server_secret(path: Path, name: str, value: str) -> dict[str, str]:
    """Store one credential value and return the updated mapping."""

    _, validated_value = _validated_secret(name, value)
    secrets = load_tool_server_secrets(path)
    secrets[name] = validated_value
    save_tool_server_secrets(path, secrets)
    return secrets


def clear_tool_server_secret(path: Path, name: str) -> dict[str, str]:
    """Remove one credential value and return the updated mapping."""

    secrets = load_tool_server_secrets(path)
    secrets.pop(name, None)
    save_tool_server_secrets(path, secrets)
    return secrets
