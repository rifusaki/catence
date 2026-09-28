"""Turn-scoped connections to the extra Console tool servers.

The Console agent always talks to the Catence runtime; this module opens
additional Streamable HTTP sessions for any servers declared under
``console.mcpServers`` and collects their tools for the model.

A server that cannot be reached never breaks a turn: it is reported as a
:class:`ToolServerFailure` and skipped. Environment references in the server
URL and headers (``$NAME`` or ``${NAME}``) resolve from the Console credential
store first, then the process environment, so credentials saved in the
Console UI apply to the next turn without a restart.
"""

from __future__ import annotations

import asyncio
import logging
import os
from contextlib import AsyncExitStack
from dataclasses import dataclass, field
from typing import Any, Mapping, Sequence

from mcp import ClientSession
from mcp.client.streamable_http import streamablehttp_client

from .config import ENVIRONMENT_REFERENCE, ToolServer, referenced_environment

logger = logging.getLogger(__name__)

CONNECT_TIMEOUT_SECONDS = 20.0


@dataclass(frozen=True)
class ToolServerConnection:
    """A live session to one extra tool server and the tools it offers."""

    name: str
    label: str
    session: ClientSession
    tools: list[Any] = field(default_factory=list)


@dataclass(frozen=True)
class ToolServerFailure:
    """One configured tool server that could not be offered this turn."""

    name: str
    label: str
    message: str
    missing_environment: tuple[str, ...] = ()


class _MissingEnvironment(Exception):
    """Raised when a referenced credential is neither stored nor in the environment."""

    def __init__(self, names: Sequence[str]) -> None:
        self.names = tuple(names)
        super().__init__(", ".join(self.names))


def _expand(text: str, values: Mapping[str, str]) -> str:
    """Replace every ``$NAME``/``${NAME}`` reference in ``text``."""

    def replace(match: Any) -> str:
        return values[match.group(1) or match.group(2)]

    return ENVIRONMENT_REFERENCE.sub(replace, text)


def _resolve(server: ToolServer, secrets: Mapping[str, str]) -> tuple[str, dict[str, str]]:
    """Resolve the server URL and headers, preferring stored credentials."""

    values: dict[str, str] = {}
    missing: list[str] = []
    for name in referenced_environment(server):
        value = secrets.get(name) or os.environ.get(name)
        if value:
            values[name] = value
        else:
            missing.append(name)
    if missing:
        raise _MissingEnvironment(missing)
    return (
        _expand(server.url, values),
        {key: _expand(value, values) for key, value in server.headers.items()},
    )


def _error_message(error: BaseException) -> str:
    """Flatten nested exception groups to the innermost message."""

    while isinstance(error, BaseExceptionGroup) and error.exceptions:
        error = error.exceptions[0]
    return str(error) or type(error).__name__


async def open_tool_servers(
    stack: AsyncExitStack,
    servers: Mapping[str, ToolServer],
    secrets: Mapping[str, str],
    *,
    timeout_seconds: float = CONNECT_TIMEOUT_SECONDS,
) -> tuple[list[ToolServerConnection], list[ToolServerFailure]]:
    """Open every configured server, returning connections and per-server failures.

    Sessions are registered on ``stack`` so the caller closes them with the
    turn. Failures are collected instead of raised; the agent reports them and
    continues with whatever is available.
    """

    connections: list[ToolServerConnection] = []
    failures: list[ToolServerFailure] = []
    for server in servers.values():
        try:
            url, headers = _resolve(server, secrets)
        except _MissingEnvironment as error:
            failures.append(
                ToolServerFailure(
                    name=server.name,
                    label=server.label,
                    message=f"Missing credentials: {', '.join(error.names)}.",
                    missing_environment=error.names,
                )
            )
            continue
        try:
            async with asyncio.timeout(timeout_seconds):
                transport = await stack.enter_async_context(streamablehttp_client(url, headers=headers or None))
                read_stream, write_stream = transport[:2]
                session = await stack.enter_async_context(ClientSession(read_stream, write_stream))
                await session.initialize()
                listed = await session.list_tools()
            connections.append(
                ToolServerConnection(
                    name=server.name,
                    label=server.label,
                    session=session,
                    tools=list(listed.tools),
                )
            )
        except Exception as error:  # noqa: BLE001 - any failure means "skip this server"
            logger.warning("Console tool server %r is unavailable: %s", server.name, error)
            failures.append(
                ToolServerFailure(name=server.name, label=server.label, message=_error_message(error))
            )
    return connections, failures
