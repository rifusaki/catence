"""Tests for opening and resolving the extra Console tool servers."""

import asyncio
from contextlib import AsyncExitStack
from types import SimpleNamespace

import pytest

from catence_console import mcp_servers
from catence_console.config import ToolServer

EXA_TOOLS = [
    {
        "name": "web_search_exa",
        "description": "Search the web",
        "inputSchema": {"type": "object", "properties": {}},
    }
]


class FakeTransport:
    def __init__(self, calls, url, headers):
        self.calls = calls
        self.url = url
        self.headers = headers

    async def __aenter__(self):
        self.calls.append((self.url, self.headers))
        return ("read", "write")

    async def __aexit__(self, *_):
        return False


class FakeSession:
    def __init__(self, *_):
        pass

    async def __aenter__(self):
        return self

    async def __aexit__(self, *_):
        return False

    async def initialize(self):
        return None

    async def list_tools(self):
        return SimpleNamespace(tools=list(EXA_TOOLS))


def run_open(monkeypatch, servers, secrets, factory=None):
    """Open ``servers`` with fake transports, returning (connections, failures, transport calls)."""

    calls = []

    def transport(url, headers=None):
        if factory is not None:
            return factory(url, headers)
        return FakeTransport(calls, url, headers)

    monkeypatch.setattr(mcp_servers, "streamablehttp_client", transport)
    monkeypatch.setattr(mcp_servers, "ClientSession", FakeSession)

    async def scenario():
        async with AsyncExitStack() as stack:
            return await mcp_servers.open_tool_servers(stack, servers, secrets)

    connections, failures = asyncio.run(scenario())
    return connections, failures, calls


def exa_server(url="https://mcp.exa.ai/mcp", headers=None):
    return ToolServer(
        name="exa",
        label="Exa Web Search",
        url=url,
        headers={"x-api-key": "$EXA_API_KEY"} if headers is None else headers,
    )


def test_resolves_stored_credentials_before_the_environment(monkeypatch):
    monkeypatch.setenv("EXA_API_KEY", "environment-secret")

    connections, failures, calls = run_open(
        monkeypatch, {"exa": exa_server()}, {"EXA_API_KEY": "stored-secret"}
    )

    assert failures == []
    assert len(connections) == 1
    connection = connections[0]
    assert connection.name == "exa"
    assert connection.label == "Exa Web Search"
    assert connection.tools == EXA_TOOLS
    assert calls == [("https://mcp.exa.ai/mcp", {"x-api-key": "stored-secret"})]


def test_falls_back_to_the_process_environment(monkeypatch):
    monkeypatch.setenv("EXA_API_KEY", "environment-secret")

    connections, failures, calls = run_open(monkeypatch, {"exa": exa_server()}, {})

    assert failures == []
    assert len(connections) == 1
    assert calls == [("https://mcp.exa.ai/mcp", {"x-api-key": "environment-secret"})]


def test_expands_environment_references_in_urls(monkeypatch):
    monkeypatch.setenv("EXA_API_KEY", "url-secret")
    server = exa_server(url="https://mcp.exa.ai/mcp?exaApiKey=${EXA_API_KEY}", headers={})

    connections, failures, calls = run_open(monkeypatch, {"exa": server}, {})

    assert failures == []
    assert len(connections) == 1
    assert calls == [("https://mcp.exa.ai/mcp?exaApiKey=url-secret", None)]


def test_missing_credentials_are_reported_not_raised(monkeypatch):
    monkeypatch.delenv("EXA_API_KEY", raising=False)

    connections, failures, calls = run_open(monkeypatch, {"exa": exa_server()}, {})

    assert connections == []
    assert calls == []
    assert len(failures) == 1
    failure = failures[0]
    assert failure.name == "exa"
    assert failure.label == "Exa Web Search"
    assert failure.missing_environment == ("EXA_API_KEY",)
    assert "EXA_API_KEY" in failure.message


def test_connect_failures_are_collected_not_raised(monkeypatch):
    def exploding(url, headers=None):
        raise RuntimeError("connection refused")

    connections, failures, calls = run_open(
        monkeypatch, {"exa": exa_server()}, {"EXA_API_KEY": "stored-secret"}, factory=exploding
    )

    assert connections == []
    assert calls == []
    assert [failure.message for failure in failures] == ["connection refused"]


def test_one_broken_server_does_not_stop_the_others(monkeypatch):
    def transport(url, headers=None):
        if "broken" in url:
            raise RuntimeError("connection refused")
        return FakeTransport(calls, url, headers)

    calls = []
    servers = {
        "broken": ToolServer(name="broken", label="Broken", url="https://broken.example/mcp"),
        "exa": exa_server(headers={}),
    }

    connections, failures, calls = run_open(monkeypatch, servers, {}, factory=transport)

    assert [connection.name for connection in connections] == ["exa"]
    assert [failure.name for failure in failures] == ["broken"]
