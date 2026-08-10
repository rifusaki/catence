import asyncio
from types import SimpleNamespace

from catence_console import agent
from catence_console.config import ProviderProfile


class FakeTransport:
    async def __aenter__(self):
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
        return SimpleNamespace(
            tools=[
                {
                    "name": "daily_recovery_review",
                    "description": "Review recovery",
                    "inputSchema": {"type": "object", "properties": {}},
                }
            ]
        )


def test_respond_normalizes_mcp_tools_for_litellm(monkeypatch):
    monkeypatch.setattr(agent, "streamablehttp_client", lambda _: FakeTransport())
    monkeypatch.setattr(agent, "ClientSession", FakeSession)
    captured = {}

    async def complete(**kwargs):
        captured.update(kwargs)
        return SimpleNamespace(choices=[SimpleNamespace(message=SimpleNamespace(content="Evidence summary", tool_calls=[]))])

    answer = asyncio.run(
        agent.respond(
            profile=ProviderProfile(id="local", label="Local", model="openai/example"),
            model_id="default",
            reasoning_effort="medium",
            history=[{"role": "user", "content": "How am I recovering?"}],
            mcp_url="http://example.test/mcp",
            complete=complete,
        )
    )

    assert answer == "Evidence summary"
    assert captured["model"] == "openai/example"
    assert captured["reasoning_effort"] == "medium"
    assert "temperature" not in captured
    assert captured["tools"] == [
        {
            "type": "function",
            "function": {
                "name": "daily_recovery_review",
                "description": "Review recovery",
                "parameters": {"type": "object", "properties": {}},
            },
        }
    ]


def test_tool_result_limit_marks_truncated_evidence():
    payload = agent._tool_result_payload({"content": "x" * 100}, maximum_characters=20)
    assert payload["truncated"] is True
    assert "20" in payload["message"]
