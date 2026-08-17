import asyncio
from types import SimpleNamespace

import pytest

from catence_console import agent
from catence_console.config import ProviderProfile
from catence_console.persistence import tool_call_store


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


class WrappingSession(FakeSession):
    async def __aexit__(self, exc_type, exc, tb):
        if exc is not None:
            raise ExceptionGroup("unhandled errors in a TaskGroup (1 sub-exception)", [exc]) from None
        return False


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
    assert captured["tools"][0] == {
        "type": "function",
        "function": {
            "name": "daily_recovery_review",
            "description": "Review recovery",
            "parameters": {"type": "object", "properties": {}},
        },
    }
    assert captured["tools"][1]["function"]["name"] == "recall_saved_tool_result"


def test_tool_result_limit_marks_truncated_evidence():
    payload = agent._tool_result_payload({"content": "x" * 100}, maximum_characters=20)
    assert payload["truncated"] is True
    assert "20" in payload["message"]


def test_selected_athlete_overrides_model_supplied_scope_for_data_tools():
    assert agent._scoped_tool_arguments("read_series", {"athleteId": "other", "dataset": "daily"}, "alex") == {
        "athleteId": "alex",
        "dataset": "daily",
    }
    assert agent._scoped_tool_arguments("list_athletes", {}, "alex") == {}


def test_respond_passes_mcp_instructions_and_saved_call_context_to_the_model(monkeypatch, tmp_path):
    monkeypatch.setattr(agent, "streamablehttp_client", lambda _: FakeTransport())
    monkeypatch.setattr(agent, "ClientSession", FakeSession)
    store = tool_call_store(tmp_path)
    store.record(
        thread_id="thread-1",
        call_id="prior-call",
        name="get_activity_segments",
        arguments={"activityId": "strava:19656841525"},
        result={"content": [{"type": "text", "text": "prior evidence"}]},
    )
    captured = {}

    async def initialize(self):
        return {
            "instructions": "For segment questions, call get_activity_segments first.",
        }

    monkeypatch.setattr(FakeSession, "initialize", initialize)

    async def complete(**kwargs):
        captured.update(kwargs)
        return SimpleNamespace(choices=[SimpleNamespace(message=SimpleNamespace(content="I will reuse that context.", tool_calls=[]))])

    answer = asyncio.run(
        agent.respond(
            profile=ProviderProfile(id="local", label="Local", model="openai/example"),
            model_id="default",
            reasoning_effort=None,
            history=[{"role": "user", "content": "What did we learn about that climb?"}],
            mcp_url="http://example.test/mcp",
            tool_call_store=store,
            thread_id="thread-1",
            complete=complete,
        )
    )

    assert answer == "I will reuse that context."
    system_messages = [message["content"] for message in captured["messages"] if message["role"] == "system"]
    assert any("get_activity_segments" in message for message in system_messages)
    assert any("prior-call" in message and "strava:19656841525" in message for message in system_messages)
    assert any(
        tool["function"]["name"] == "recall_saved_tool_result"
        for tool in captured["tools"]
    )
    assert agent._saved_result_payload(store, "thread-1", {"callId": "prior-call"}) == {
        "content": [{"type": "text", "text": "prior evidence"}]
    }


def test_respond_records_completed_mcp_calls(monkeypatch, tmp_path):
    monkeypatch.setattr(agent, "streamablehttp_client", lambda _: FakeTransport())
    monkeypatch.setattr(agent, "ClientSession", FakeSession)
    store = tool_call_store(tmp_path)

    async def invoke(*_args, **_kwargs):
        return {"content": [{"type": "text", "text": "fresh evidence"}]}

    monkeypatch.setattr(agent, "_invoke_tool", invoke)
    completions = iter(
        [
            SimpleNamespace(
                choices=[
                    SimpleNamespace(
                        message=SimpleNamespace(
                            content=None,
                            tool_calls=[
                                {
                                    "id": "new-call",
                                    "function": {
                                        "name": "daily_recovery_review",
                                        "arguments": '{"date":"2026-08-10"}',
                                    },
                                }
                            ],
                        )
                    )
                ]
            ),
            SimpleNamespace(choices=[SimpleNamespace(message=SimpleNamespace(content="Done.", tool_calls=[]))]),
        ]
    )

    async def complete(**_kwargs):
        return next(completions)

    answer = asyncio.run(
        agent.respond(
            profile=ProviderProfile(id="local", label="Local", model="openai/example"),
            model_id="default",
            reasoning_effort=None,
            history=[{"role": "user", "content": "Review today."}],
            mcp_url="http://example.test/mcp",
            tool_call_store=store,
            thread_id="thread-1",
            complete=complete,
        )
    )

    assert answer == "Done."
    calls = store.list("thread-1")
    assert [(call.call_id, call.name, call.arguments) for call in calls] == [
        ("new-call", "daily_recovery_review", {"date": "2026-08-10"})
    ]
    assert store.result("thread-1", "new-call") == {"content": [{"type": "text", "text": "fresh evidence"}]}


def test_respond_unwraps_client_session_task_group_exception(monkeypatch):
    monkeypatch.setattr(agent, "streamablehttp_client", lambda _: FakeTransport())
    monkeypatch.setattr(agent, "ClientSession", WrappingSession)

    async def complete(**kwargs):
        raise RuntimeError("ProviderError: upstream refused the request")

    with pytest.raises(RuntimeError, match="ProviderError: upstream refused the request"):
        asyncio.run(
            agent.respond(
                profile=ProviderProfile(id="local", label="Local", model="openai/example"),
                model_id="default",
                reasoning_effort=None,
                history=[],
                mcp_url="http://example.test/mcp",
                complete=complete,
            )
        )


def test_respond_keeps_multi_error_groups_grouped(monkeypatch):
    monkeypatch.setattr(agent, "streamablehttp_client", lambda _: FakeTransport())
    monkeypatch.setattr(agent, "ClientSession", WrappingSession)

    async def complete(**kwargs):
        raise ExceptionGroup(
            "provider fan-out",
            [RuntimeError("first provider failed"), ValueError("second provider failed")],
        )

    with pytest.raises(ExceptionGroup) as captured:
        asyncio.run(
            agent.respond(
                profile=ProviderProfile(id="local", label="Local", model="openai/example"),
                model_id="default",
                reasoning_effort=None,
                history=[],
                mcp_url="http://example.test/mcp",
                complete=complete,
            )
        )

    assert {type(exception) for exception in captured.value.exceptions} == {RuntimeError, ValueError}
