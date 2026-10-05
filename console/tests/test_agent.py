import asyncio
import json
from types import SimpleNamespace

import pytest
from litellm.exceptions import AuthenticationError, InternalServerError, ServiceUnavailableError

from catence_console import agent
from catence_console.config import ModelOption, ProviderProfile, ToolServer
from catence_console.mcp_servers import ToolServerConnection, ToolServerFailure
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
                },
                {
                    "name": "list_athletes",
                    "description": "List athletes",
                    "inputSchema": {"type": "object", "properties": {}},
                },
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
    assert [tool["function"]["name"] for tool in captured["tools"]] == [
        "daily_recovery_review",
        "recall_saved_tool_result",
    ]


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


@pytest.mark.parametrize("base_env", ["OPENCODE_GO_API_BASE", "OPENCODE_GO_MESSAGES_API_BASE"])
def test_respond_sends_opencode_go_headers_for_go_profiles(monkeypatch, base_env):
    monkeypatch.setattr(agent, "streamablehttp_client", lambda _: FakeTransport())
    monkeypatch.setattr(agent, "ClientSession", FakeSession)
    captured = {}

    async def complete(**kwargs):
        captured.update(kwargs)
        return SimpleNamespace(choices=[SimpleNamespace(message=SimpleNamespace(content="ok", tool_calls=[]))])

    asyncio.run(
        agent.respond(
            profile=ProviderProfile(
                id="opencode-go",
                label="OpenCode Go",
                model="openai/deepseek-v4-flash",
                api_key_env="OPENCODE_GO_API_KEY",
                api_base_env=base_env,
            ),
            model_id="default",
            reasoning_effort=None,
            history=[{"role": "user", "content": "How am I recovering?"}],
            mcp_url="http://example.test/mcp",
            thread_id="thread-abc",
            complete=complete,
        )
    )

    assert captured["extra_headers"]["x-opencode-session"] == "thread-abc"
    assert captured["extra_headers"]["x-opencode-client"] == "catence-console"


def test_respond_omits_opencode_go_headers_for_other_profiles(monkeypatch):
    monkeypatch.setattr(agent, "streamablehttp_client", lambda _: FakeTransport())
    monkeypatch.setattr(agent, "ClientSession", FakeSession)
    captured = {}

    async def complete(**kwargs):
        captured.update(kwargs)
        return SimpleNamespace(choices=[SimpleNamespace(message=SimpleNamespace(content="ok", tool_calls=[]))])

    asyncio.run(
        agent.respond(
            profile=ProviderProfile(id="openai", label="OpenAI", model="openai/o4-mini"),
            model_id="default",
            reasoning_effort=None,
            history=[{"role": "user", "content": "How am I recovering?"}],
            mcp_url="http://example.test/mcp",
            thread_id="thread-abc",
            complete=complete,
        )
    )

    assert "extra_headers" not in captured


def test_tool_result_limit_marks_truncated_evidence():
    payload = agent._tool_result_payload({"content": "x" * 100}, maximum_characters=20)
    assert payload["truncated"] is True
    assert "20" in payload["message"]


def test_tool_result_limit_keeps_classified_errors():
    result = {
        "content": [
            {
                "type": "text",
                "text": json.dumps(
                    {
                        "data": None,
                        "error": {
                            "code": "invalid_request",
                            "message": "Read-only query failed: Binder Error: Ambiguous reference to column name \"activity_source_id\"",
                        },
                    }
                ),
            }
        ],
        "isError": True,
    }

    payload = agent._tool_result_payload(result, maximum_characters=10)

    assert payload["isError"] is True
    assert payload["truncated"] is True
    assert payload["originalCharacters"] > 10
    assert payload["error"]["code"] == "invalid_request"
    assert "Ambiguous reference" in payload["error"]["message"]
    assert payload["message"] == payload["error"]["message"]


def test_tool_result_limit_caps_retained_error_message():
    result = {
        "content": [
            {"type": "text", "text": json.dumps({"error": {"message": "y" * (agent._TRUNCATED_ERROR_MESSAGE_CHARACTERS + 50)}})},
        ],
        "isError": True,
    }

    payload = agent._tool_result_payload(result, maximum_characters=10)

    assert payload["error"]["message"].endswith("…")
    assert len(payload["error"]["message"]) == agent._TRUNCATED_ERROR_MESSAGE_CHARACTERS + 1


def test_tool_definitions_hide_the_console_roster_listing():
    definitions = agent._tool_definitions(
        [
            {"name": "list_athletes", "description": "List athletes", "inputSchema": {"type": "object", "properties": {}}},
            {"name": "read_series", "description": "Read a series", "inputSchema": {"type": "object", "properties": {}}},
        ]
    )

    assert [definition["function"]["name"] for definition in definitions] == ["read_series", "recall_saved_tool_result"]


def test_selected_athlete_overrides_model_supplied_scope_for_data_tools():
    assert agent._scoped_tool_arguments("read_series", {"athleteId": "other", "dataset": "daily"}, "alex") == {
        "athleteId": "alex",
        "dataset": "daily",
    }
    # The roster listing is hidden from the model, but would still be scoped.
    assert agent._scoped_tool_arguments("list_athletes", {}, "alex") == {"athleteId": "alex"}
    assert agent._scoped_tool_arguments("recall_saved_tool_result", {"callId": "call-1"}, "alex") == {"callId": "call-1"}


def test_respond_system_scope_message_names_the_selected_athlete(monkeypatch):
    monkeypatch.setattr(agent, "streamablehttp_client", lambda _: FakeTransport())
    monkeypatch.setattr(agent, "ClientSession", FakeSession)

    def scope_messages(**overrides):
        captured = {}

        async def complete(**kwargs):
            captured.update(kwargs)
            return SimpleNamespace(choices=[SimpleNamespace(message=SimpleNamespace(content="Done.", tool_calls=[]))])

        asyncio.run(
            agent.respond(
                profile=ProviderProfile(id="local", label="Local", model="openai/example"),
                model_id="default",
                reasoning_effort=None,
                history=[],
                mcp_url="http://example.test/mcp",
                complete=complete,
                **overrides,
            )
        )
        return [
            message["content"]
            for message in captured["messages"]
            if message["role"] == "system" and "scoped to athleteId" in message["content"]
        ]

    assert scope_messages(athlete_id="martina", athlete_label="Martina") == [
        "This Console chat is scoped to athleteId 'martina' (Martina). "
        "Every Catence data tool call is forced to that athlete; do not try to select or compare another athlete."
    ]
    assert scope_messages(athlete_id="martina") == [
        "This Console chat is scoped to athleteId 'martina'. "
        "Every Catence data tool call is forced to that athlete; do not try to select or compare another athlete."
    ]


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


def test_athlete_file_context_returns_a_fenced_athlete_authored_block():
    class Session:
        async def call_tool(self, name, arguments):
            assert name == "get_athlete_file"
            assert arguments == {"athleteId": "alex"}
            return {
                "content": [
                    {
                        "type": "text",
                        "text": json.dumps(
                            {
                                "data": {
                                    "exists": True,
                                    "content": "# Athlete file\n\n## Goals\n\n- Sub-40 10K",
                                    "hash": "abc",
                                    "updatedAt": "2026-01-01T00:00:00Z",
                                }
                            }
                        ),
                    }
                ]
            }

    context = asyncio.run(agent._athlete_file_context(Session(), "alex"))

    assert context is not None
    assert "```markdown" in context
    assert "Sub-40 10K" in context
    assert "athlete-authored data" in context


def test_athlete_file_context_caps_long_content():
    long_content = "x" * (agent._ATHLETE_FILE_CONTEXT_CHARACTERS + 100)

    class Session:
        async def call_tool(self, name, arguments):
            return {
                "content": [
                    {
                        "type": "text",
                        "text": json.dumps({"data": {"exists": True, "content": long_content, "hash": "abc", "updatedAt": None}}),
                    }
                ]
            }

    context = asyncio.run(agent._athlete_file_context(Session(), None))

    assert context is not None
    assert f"{'x' * agent._ATHLETE_FILE_CONTEXT_CHARACTERS}…" in context
    assert "x" * (agent._ATHLETE_FILE_CONTEXT_CHARACTERS + 1) not in context


def test_athlete_file_context_missing_file_returns_create_hint():
    class Session:
        async def call_tool(self, name, arguments):
            return {
                "content": [
                    {
                        "type": "text",
                        "text": json.dumps({"data": {"exists": False, "content": "# Athlete file", "hash": None, "updatedAt": None}}),
                    }
                ]
            }

    context = asyncio.run(agent._athlete_file_context(Session(), "alex"))

    assert context is not None
    assert "does not exist yet" in context
    assert "update_athlete_file" in context


def test_athlete_file_context_failures_stay_silent():
    class Session:
        async def call_tool(self, name, arguments):
            raise RuntimeError("mcp unavailable")

    assert asyncio.run(agent._athlete_file_context(Session(), "alex")) is None


def test_respond_injects_the_athlete_file_as_data(monkeypatch):
    athlete_file_result = {
        "content": [
            {
                "type": "text",
                "text": json.dumps(
                    {"data": {"exists": True, "content": "# Athlete file\n\n## Goals\n\n- Sub-40 10K", "hash": "abc", "updatedAt": None}}
                ),
            }
        ]
    }

    class InjectionSession(FakeSession):
        async def call_tool(self, name, arguments):
            return athlete_file_result

    monkeypatch.setattr(agent, "streamablehttp_client", lambda _: FakeTransport())
    monkeypatch.setattr(agent, "ClientSession", InjectionSession)

    captured: dict[str, object] = {}

    async def complete(**kwargs):
        captured.update(kwargs)
        return SimpleNamespace(choices=[SimpleNamespace(message=SimpleNamespace(content="Done.", tool_calls=[]))])

    answer = asyncio.run(
        agent.respond(
            profile=_profile(),
            model_id="default",
            reasoning_effort=None,
            history=[{"role": "user", "content": "What should I focus on next?"}],
            mcp_url="http://example.test/mcp",
            athlete_id="alex",
            complete=complete,
        )
    )

    assert answer == "Done."
    messages = captured["messages"]
    assert any(
        message["role"] == "system" and "Athlete file (athlete-authored data" in message["content"]
        for message in messages
    )


class _FakeExtraSession:
    """Session double for one extra tool server; records the calls it receives."""

    def __init__(self, tools):
        self.tools = list(tools)
        self.calls: list[tuple[str, dict]] = []

    async def call_tool(self, name, arguments):
        self.calls.append((name, arguments))
        return {"content": [{"type": "text", "text": f"result for {name}"}]}


def _exa_connection(tools):
    session = _FakeExtraSession(tools)
    connection = ToolServerConnection(name="exa", label="Exa Web Search", session=session, tools=session.tools)
    return connection, session


def _exa_server():
    return ToolServer(name="exa", label="Exa Web Search", url="https://mcp.exa.ai/mcp")


def _extra_open(monkeypatch, connections, failures=None):
    async def fake_open(stack, servers, secrets):
        return connections, list(failures or [])

    monkeypatch.setattr(agent, "open_tool_servers", fake_open)


def _search_tool():
    return {"name": "web_search_exa", "description": "Search the web", "inputSchema": {"type": "object", "properties": {}}}


def _tool_call_completion(name, arguments):
    return SimpleNamespace(
        choices=[
            SimpleNamespace(
                message=SimpleNamespace(
                    content=None,
                    tool_calls=[{"id": "call-1", "function": {"name": name, "arguments": json.dumps(arguments)}}],
                )
            )
        ]
    )


def _final_completion():
    return SimpleNamespace(choices=[SimpleNamespace(message=SimpleNamespace(content="Done.", tool_calls=[]))])


def test_respond_offers_extra_tool_servers_and_routes_their_calls(monkeypatch):
    monkeypatch.setattr(agent, "streamablehttp_client", lambda _: FakeTransport())
    monkeypatch.setattr(agent, "ClientSession", FakeSession)
    connection, session = _exa_connection([_search_tool()])
    _extra_open(monkeypatch, [connection])
    monkeypatch.setattr(agent.cl, "Step", _RecordingStep)
    _RecordingStep.instances.clear()
    captured = {}
    completions = iter([_tool_call_completion("web_search_exa", {"query": "sub-40 10k"}), _final_completion()])

    async def complete(**kwargs):
        captured.update(kwargs)
        return next(completions)

    answer = asyncio.run(
        agent.respond(
            profile=ProviderProfile(id="local", label="Local", model="openai/example"),
            model_id="default",
            reasoning_effort=None,
            history=[{"role": "user", "content": "Find a plan."}],
            mcp_url="http://example.test/mcp",
            tool_servers={"exa": _exa_server()},
            tool_server_secrets={"EXA_API_KEY": "stored-secret"},
            athlete_id="martina",
            complete=complete,
        )
    )

    assert answer == "Done."
    names = [definition["function"]["name"] for definition in captured["tools"]]
    assert names == ["daily_recovery_review", "web_search_exa", "recall_saved_tool_result"]
    # The extra server never receives the Catence athlete scope.
    assert session.calls == [("web_search_exa", {"query": "sub-40 10k"})]
    assert [step.name for step in _RecordingStep.instances] == ["Exa Web Search · web_search_exa"]


def test_extra_tool_names_are_namespaced_when_they_collide(monkeypatch):
    monkeypatch.setattr(agent, "streamablehttp_client", lambda _: FakeTransport())
    monkeypatch.setattr(agent, "ClientSession", FakeSession)
    connection, session = _exa_connection(
        [{"name": "daily_recovery_review", "description": "Collides", "inputSchema": {"type": "object", "properties": {}}}]
    )
    _extra_open(monkeypatch, [connection])
    monkeypatch.setattr(agent.cl, "Step", _RecordingStep)
    _RecordingStep.instances.clear()
    captured = {}
    completions = iter([_tool_call_completion("exa_daily_recovery_review", {}), _final_completion()])

    async def complete(**kwargs):
        captured.update(kwargs)
        return next(completions)

    answer = asyncio.run(
        agent.respond(
            profile=ProviderProfile(id="local", label="Local", model="openai/example"),
            model_id="default",
            reasoning_effort=None,
            history=[],
            mcp_url="http://example.test/mcp",
            tool_servers={"exa": _exa_server()},
            complete=complete,
        )
    )

    assert answer == "Done."
    names = [definition["function"]["name"] for definition in captured["tools"]]
    assert names == ["daily_recovery_review", "exa_daily_recovery_review", "recall_saved_tool_result"]
    # The model-facing prefix is stripped before the owning server is called.
    assert session.calls == [("daily_recovery_review", {})]


def test_tool_server_failures_are_reported_without_failing_the_turn(monkeypatch):
    monkeypatch.setattr(agent, "streamablehttp_client", lambda _: FakeTransport())
    monkeypatch.setattr(agent, "ClientSession", FakeSession)
    failure = ToolServerFailure(
        name="exa",
        label="Exa Web Search",
        message="Missing credentials: EXA_API_KEY.",
        missing_environment=("EXA_API_KEY",),
    )
    _extra_open(monkeypatch, [], [failure])
    monkeypatch.setattr(agent.cl, "Step", _RecordingStep)
    _RecordingStep.instances.clear()
    captured = {}

    async def complete(**kwargs):
        captured.update(kwargs)
        return _final_completion()

    answer = asyncio.run(
        agent.respond(
            profile=ProviderProfile(id="local", label="Local", model="openai/example"),
            model_id="default",
            reasoning_effort=None,
            history=[],
            mcp_url="http://example.test/mcp",
            tool_servers={"exa": _exa_server()},
            step_parent_id="user-message-1",
            complete=complete,
        )
    )

    assert answer == "Done."
    steps = [step for step in _RecordingStep.instances if step.name == "Tool servers"]
    assert len(steps) == 1
    assert steps[0].parent_id == "user-message-1"
    assert steps[0].output["unavailable"] == [
        {
            "name": "exa",
            "label": "Exa Web Search",
            "message": "Missing credentials: EXA_API_KEY.",
            "missingEnvironment": ["EXA_API_KEY"],
        }
    ]
    names = [definition["function"]["name"] for definition in captured["tools"]]
    assert names == ["daily_recovery_review", "recall_saved_tool_result"]


def test_scoped_arguments_only_touch_catence_tools_when_restricted():
    catence_tools = {"read_series"}

    assert agent._scoped_tool_arguments(
        "web_search_exa", {"query": "x"}, "alex", catence_tools=catence_tools
    ) == {"query": "x"}
    assert agent._scoped_tool_arguments("read_series", {}, "alex", catence_tools=catence_tools) == {
        "athleteId": "alex"
    }


def test_respond_heartbeats_while_a_model_call_is_in_flight(monkeypatch):
    monkeypatch.setattr(agent, "streamablehttp_client", lambda _: FakeTransport())
    monkeypatch.setattr(agent, "ClientSession", FakeSession)
    monkeypatch.setattr(agent, "_MODEL_CALL_HEARTBEAT_SECONDS", 0.01)
    heartbeats = []

    monkeypatch.setattr(agent, "start_generation_sidecar", lambda _thread_id: None)
    monkeypatch.setattr(
        agent,
        "finish_generation_sidecar",
        lambda _thread_id, *, stage, tool_call_count=0, last_tool=None: None,
    )
    monkeypatch.setattr(
        agent,
        "update_generation_sidecar",
        lambda thread_id, *, tool_call_count, last_tool: heartbeats.append((thread_id, tool_call_count, last_tool)),
    )

    async def complete(**_kwargs):
        await asyncio.sleep(0.05)
        return SimpleNamespace(choices=[SimpleNamespace(message=SimpleNamespace(content="Done", tool_calls=[]))])

    answer = asyncio.run(
        agent.respond(
            profile=ProviderProfile(id="local", label="Local", model="openai/example"),
            model_id="default",
            reasoning_effort=None,
            history=[],
            mcp_url="http://example.test/mcp",
            thread_id="thread-1",
            complete=complete,
        )
    )

    assert answer == "Done"
    assert heartbeats
    assert all(heartbeat[0] == "thread-1" for heartbeat in heartbeats)


def test_respond_times_out_a_hung_model_call(monkeypatch, tmp_path):
    monkeypatch.setenv("CATENCE_HOME", str(tmp_path))
    monkeypatch.setattr(agent, "streamablehttp_client", lambda _: FakeTransport())
    monkeypatch.setattr(agent, "ClientSession", FakeSession)
    monkeypatch.setattr(agent, "_MODEL_CALL_TIMEOUT_SECONDS", 0.05)

    async def complete(**_kwargs):
        await asyncio.sleep(5)
        return SimpleNamespace(choices=[SimpleNamespace(message=SimpleNamespace(content="Done", tool_calls=[]))])

    with pytest.raises(TimeoutError, match="did not answer"):
        asyncio.run(
            agent.respond(
                profile=ProviderProfile(id="local", label="Local", model="openai/example"),
                model_id="default",
                reasoning_effort=None,
                history=[],
                mcp_url="http://example.test/mcp",
                thread_id="thread-1",
                complete=complete,
            )
        )
