"""Bearer-token authentication for calls from the Console to the Catence runtime.

When the runtime is started with an auth token file (CATENCE_MCP_TOKEN_FILE),
every request except the health endpoints must present the exact
`Authorization: Bearer <token>` header. The Console is one of those callers:
its dashboard/athlete proxies and the agent's MCP client both attach the same
header through this module.

The token lives in a file (never in an environment variable value, `.env`, or
`config.json`); the path is passed through the environment. The file is read
once per process; rotating the token means rewriting the file and restarting
the stack.
"""

from __future__ import annotations

import os
from pathlib import Path

from .config import ConsoleConfigurationError

TOKEN_FILE_ENV = "CATENCE_MCP_TOKEN_FILE"

_cached_token: str | None = None


def _token_file() -> str:
    return os.environ.get(TOKEN_FILE_ENV, "").strip()


def runtime_token() -> str:
    """The bearer token for the Catence runtime, or "" when no file is configured.

    Fails loudly on an unreadable or empty token file: a silent empty return
    would turn every runtime call into a confusing stream of 401s.
    """

    global _cached_token
    if _cached_token is None:
        token_file = _token_file()
        if not token_file:
            _cached_token = ""
        else:
            try:
                _cached_token = Path(token_file).read_text(encoding="utf-8").strip()
            except OSError as error:
                raise ConsoleConfigurationError(
                    f"Cannot read the Catence auth token file {token_file}: {error}"
                ) from error
            if not _cached_token:
                raise ConsoleConfigurationError(f"The Catence auth token file {token_file} is empty.")
    return _cached_token


def runtime_authorization_headers() -> dict[str, str]:
    """Headers to attach to every Console call into the Catence runtime."""

    token = runtime_token()
    return {"authorization": f"Bearer {token}"} if token else {}
