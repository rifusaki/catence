import asyncio
from types import SimpleNamespace

import pytest
from litellm.exceptions import AuthenticationError, InternalServerError, ServiceUnavailableError

from catence_console import agent
from catence_console.config import ModelOption, ProviderProfile
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


def test_provider_safe_schema_rewrites_tuple_items_for_upstream_gateways():
    schema = {
        "$schema": "http://json-schema.org/draft-07/schema#",
        "type": "object",
        "properties": {
            "distanceKm": {
                "type": "array",
                "items": [{"type": "number", "minimum": 0}, {"type": "number", "minimum": 0}],
            },
            "tags": {"type": "array", "items": {"type": "string"}},
            "nested": {"anyOf": [{"type": "array", "items": []}, {"type": "null"}]},
        },
    }

    rewritten = agent._provider_safe_schema(schema)

    assert rewritten["properties"]["distanceKm"]["items"] == {
        "anyOf": [{"type": "number", "minimum": 0}, {"type": "number", "minimum": 0}]
    }
    # Object-form items and untouched branches pass through unchanged.
    assert rewritten["properties"]["tags"]["items"] == {"type": "string"}
    assert rewritten["properties"]["nested"]["anyOf"][0] == {"type": "array", "items": {}}
    assert rewritten["$schema"] == schema["$schema"]


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


def test_respond_never_sends_reasoning_effort_for_disabled_models(monkeypatch):
    monkeypatch.setattr(agent, "streamablehttp_client", lambda _: FakeTransport())
    monkeypatch.setattr(agent, "ClientSession", FakeSession)
    captured = {}

    async def complete(**kwargs):
        captured.update(kwargs)
        return SimpleNamespace(choices=[SimpleNamespace(message=SimpleNamespace(content="Evidence summary", tool_calls=[]))])

    profile = ProviderProfile(
        id="opencode-go",
        label="OpenCode Go",
        model="openai/mimo-v2.5",
        models={
            "mimo-v2.5": ModelOption(id="mimo-v2.5", label="MiMo V2.5", model="openai/mimo-v2.5", variants={}),
        },
        default_model="mimo-v2.5",
    )
    answer = asyncio.run(
        agent.respond(
            profile=profile,
            model_id="mimo-v2.5",
            reasoning_effort="high",
            history=[{"role": "user", "content": "How am I recovering?"}],
            mcp_url="http://example.test/mcp",
            complete=complete,
        )
    )

    assert answer == "Evidence summary"
    assert captured["model"] == "openai/mimo-v2.5"
    assert "reasoning_effort" not in captured
    assert "allowed_openai_params" not in captured


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
    assert any("course_geometry" in message and "resolve_event_course" in message for message in system_messages)
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


class _RecordingStep:
    """Minimal cl.Step double that records constructor arguments."""

    instances: list["_RecordingStep"] = []

    def __init__(self, *, name, type, default_open, parent_id=None):
        self.name = name
        self.type = type
        self.default_open = default_open
        self.parent_id = parent_id
        self.input = None
        self.output = None
        self.is_error = False
        _RecordingStep.instances.append(self)

    async def send(self):
        return self

    async def update(self):
        return self


def test_tool_steps_nest_under_the_triggering_user_message(monkeypatch):
    """Tool steps must carry the edited/regenerated message as their parent."""
    monkeypatch.setattr(agent, "streamablehttp_client", lambda _: FakeTransport())
    monkeypatch.setattr(agent, "ClientSession", FakeSession)
    monkeypatch.setattr(agent.cl, "Step", _RecordingStep)
    _RecordingStep.instances.clear()

    async def call_tool(name, arguments):
        return {"content": [{"type": "text", "text": "evidence"}]}

    FakeSession.call_tool = call_tool
    completions = iter(
        [
            SimpleNamespace(
                choices=[
                    SimpleNamespace(
                        message=SimpleNamespace(
                            content=None,
                            tool_calls=[
                                {
                                    "id": "call-1",
                                    "function": {"name": "daily_recovery_review", "arguments": "{}"},
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
            step_parent_id="user-message-1",
            complete=complete,
        )
    )

    assert answer == "Done."
    assert [step.parent_id for step in _RecordingStep.instances] == ["user-message-1"]


def _profile(**overrides):
    fields = {
        "id": "opencode-go",
        "label": "Console Go",
        "model": "openai/ox-alpha-free",
        "api_key_env": "OPENCODE_GO_API_KEY",
        "api_base_env": None,
    }
    fields.update(overrides)
    return ProviderProfile(**fields)


def test_describe_failure_points_upstream_errors_at_the_provider(monkeypatch):
    monkeypatch.setenv("OPENCODE_GO_API_BASE", "https://opencode.ai/zen/go/v1")
    error = ServiceUnavailableError(
        "OpenAIException - Error from provider (Console Go): Upstream request failed: Endpoint is unavailable.",
        llm_provider="openai",
        model="ox-alpha-free",
    )

    message = agent.describe_model_failure(_profile(api_base_env="OPENCODE_GO_API_BASE"), "ox-alpha-free", error)

    assert "**Console Go** (https://opencode.ai/zen/go/v1)" in message
    assert "not a Catence configuration problem" in message
    assert "Endpoint is unavailable." in message
    assert "doctor" not in message


def test_describe_failure_internal_server_error_names_the_provider():
    error = InternalServerError("Internal server error", llm_provider="openai", model="muse-spark-1.2")

    message = agent.describe_model_failure(_profile(), "muse-spark-1.2", error)

    assert "failed upstream" in message
    assert "Internal server error" in message
    # No api_base configured: no misleading target suffix, still no doctor hint.
    assert "(https" not in message
    assert "doctor" not in message


def test_describe_failure_authentication_error_suggests_the_env_var(monkeypatch):
    monkeypatch.delenv("OPENCODE_GO_API_BASE", raising=False)
    error = AuthenticationError("bad key", llm_provider="openai", model="ox-alpha-free")

    message = agent.describe_model_failure(_profile(), "ox-alpha-free", error)

    assert "rejected the credentials" in message
    assert "OPENCODE_GO_API_KEY" in message
    # The targeted env-var guidance replaces the generic doctor hint.
    assert "doctor" not in message


def test_describe_failure_unknown_error_keeps_the_doctor_hint():
    message = agent.describe_model_failure(_profile(), "ox-alpha-free", RuntimeError("boom"))

    assert "boom" in message
    assert "doctor" in message
