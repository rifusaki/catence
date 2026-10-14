"""Bearer-token authentication for calls from the Console to the Catence runtime.

The runtime's HTTP gate is switched on by the presence of a token file
(CATENCE_MCP_TOKEN_FILE). Every endpoint except the health probes then needs
an exact `Authorization: Bearer <token>` header. The Console is one of those
callers: its dashboard/athlete proxies and the agent's MCP client both attach
the same header through this module.

The file may not exist yet when the Console starts (the runtime arms the gate;
`catence-data mcp enable`, the Console Settings, or the exposure API create
it), so the token is read lazily and re-read whenever the file's mtime
changes. An existing but unreadable or empty file fails loudly instead of
silently sending unauthenticated calls.
"""

from __future__ import annotations

import os
from pathlib import Path

from .config import ConsoleConfigurationError

TOKEN_FILE_ENV = "CATENCE_MCP_TOKEN_FILE"

_token_cache: tuple[float, str | None] | None = None


def _token_file() -> str:
    return os.environ.get(TOKEN_FILE_ENV, "").strip()


def runtime_token() -> str:
    """The bearer token for the Catence runtime, or "" when the gate is off."""

    global _token_cache
    token_file = _token_file()
    if not token_file:
        return ""
    try:
        mtime = Path(token_file).stat().st_mtime
    except OSError:
        return ""  # Gate not enabled yet; the runtime creates the file on demand.
    if _token_cache is not None and _token_cache[0] == mtime:
        cached = _token_cache[1]
        if cached is not None:
            return cached
        raise ConsoleConfigurationError(f"The Catence auth token file {token_file} is empty.")
    try:
        token = Path(token_file).read_text(encoding="utf-8").strip()
    except OSError as error:
        raise ConsoleConfigurationError(f"Cannot read the Catence auth token file {token_file}: {error}") from error
    _token_cache = (mtime, token or None)
    if not token:
        raise ConsoleConfigurationError(f"The Catence auth token file {token_file} is empty.")
    return token


def runtime_authorization_headers() -> dict[str, str]:
    """Headers to attach to every Console call into the Catence runtime."""

    token = runtime_token()
    return {"authorization": f"Bearer {token}"} if token else {}
