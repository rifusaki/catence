"""LiteLLM tool-calling loop backed by Catence's Streamable HTTP MCP endpoint."""

from __future__ import annotations

import json
from collections.abc import Awaitable, Callable
from typing import Any

import chainlit as cl
from litellm import acompletion
from mcp import ClientSession
from mcp.client.streamable_http import streamablehttp_client

from .config import DEFAULT_TOOL_RESULT_CHARACTER_LIMIT, DEFAULT_TOOL_ROUND_LIMIT, ProviderProfile
from .persistence import SavedToolCall, ToolCallStore

SYSTEM_PROMPT = """You are Catence, a careful endurance-training data assistant.
Use Catence MCP tools for athlete-specific facts. Start with a named review tool
when it fits (recovery, training load, or weekly review), then ask a narrow
follow-up tool only when it would change the recommendation. Never invent data
or clinical conclusions. Distinguish a missing measurement from a poor value.
In every conclusion, name the dates and metrics returned by the tools so the
athlete can trace the evidence. Catence's data is personal and local: do not
ask for credentials or expose configuration values.

Follow the catalog contract before using the advanced SQL fallback: never
query information_schema or other DuckDB system tables. If a dataset, field,
or identifier is uncertain, call describe_data or describe_dataset first.
read_series accepts numeric metrics only; use string identifiers as filters.
For a selected activity's Strava segments, climbs, grades, KOMs, or PRs, call
get_activity_segments before querying tables or claiming data is unavailable.
For Garmin running VO₂max, call get_vo2max_history with sport set to running;
Garmin labels its source rows generic, and the tool resolves that safely."""

_RECALL_SAVED_TOOL_RESULT = "recall_saved_tool_result"
_TOOL_HISTORY_LIMIT = 24
_TOOL_ARGUMENT_PREVIEW_CHARACTERS = 1_600

def _as_json(value: Any) -> Any:
    if hasattr(value, "model_dump"):
        return value.model_dump(mode="json", exclude_none=True)
    if isinstance(value, dict):
        return {key: _as_json(item) for key, item in value.items()}
    if isinstance(value, (list, tuple)):
        return [_as_json(item) for item in value]
    return value


def _flatten_exception_groups(exc: BaseException) -> list[BaseException]:
    if isinstance(exc, BaseExceptionGroup):
        leaves: list[BaseException] = []
        for sub in exc.exceptions:
            leaves.extend(_flatten_exception_groups(sub))
        return leaves
    return [exc]


def _unwrap_exception_group(exc: BaseException) -> BaseException:
    leaves = _flatten_exception_groups(exc)
    if len(leaves) == 1:
        return leaves[0]
    return ExceptionGroup("Catence agent failed with multiple errors", leaves)


def _tool_definitions(tools: list[Any]) -> list[dict[str, Any]]:
    definitions: list[dict[str, Any]] = []
    for tool in tools:
        raw = _as_json(tool)
        definitions.append(
            {
                "type": "function",
                "function": {
                    "name": raw["name"],
                    "description": raw.get("description", ""),
                    "parameters": raw.get("inputSchema", raw.get("input_schema", {"type": "object", "properties": {}})),
                },
            }
        )
    definitions.append(
        {
            "type": "function",
            "function": {
                "name": _RECALL_SAVED_TOOL_RESULT,
                "description": "Load the stored result for one earlier tool call in this chat. Use only when the compact prior-tool-call record is insufficient; otherwise call the authoritative Catence tool again if fresh data is needed.",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "callId": {
                            "type": "string",
                            "description": "The callId listed in prior tool-call context.",
                        }
                    },
                    "required": ["callId"],
                    "additionalProperties": False,
                },
            },
        }
    )
    return definitions


def _tool_call_parts(tool_call: Any) -> tuple[str, str, dict[str, Any]]:
    raw = _as_json(tool_call)
    function = raw.get("function", {})
    name = function.get("name")
    raw_arguments = function.get("arguments", "{}")
    if not isinstance(name, str) or not name:
        raise ValueError("The model requested a tool without a valid name.")
    try:
        arguments = json.loads(raw_arguments) if isinstance(raw_arguments, str) else raw_arguments
    except json.JSONDecodeError as error:
        raise ValueError(f"The model sent invalid JSON arguments for {name}.") from error
    if not isinstance(arguments, dict):
        raise ValueError(f"The model sent non-object arguments for {name}.")
    call_id = raw.get("id")
    if not isinstance(call_id, str) or not call_id:
        raise ValueError(f"The model requested {name} without a call id.")
    return call_id, name, arguments


def _tool_result_payload(result: Any, maximum_characters: int) -> dict[str, Any]:
    payload = _as_json(result)
    encoded = json.dumps(payload, ensure_ascii=False, default=str)
    if len(encoded) <= maximum_characters:
        return payload
    return {
        "content": [{"type": "text", "text": encoded[:maximum_characters]}],
        "isError": True,
        "truncated": True,
        "message": f"Catence returned more evidence than this chat permits ({maximum_characters:,} characters per tool result).",
    }


def _tool_history_message(calls: list[SavedToolCall]) -> str | None:
    """Produce small, result-free context for a resumed or later turn."""

    if not calls:
        return None
    records = []
    for call in calls[-_TOOL_HISTORY_LIMIT:]:
        encoded_arguments = json.dumps(call.arguments, ensure_ascii=False, sort_keys=True, default=str)
        if len(encoded_arguments) > _TOOL_ARGUMENT_PREVIEW_CHARACTERS:
            encoded_arguments = f"{encoded_arguments[:_TOOL_ARGUMENT_PREVIEW_CHARACTERS]}…"
        records.append(
            {
                "callId": call.call_id,
                "tool": call.name,
                "arguments": encoded_arguments,
                "resultAvailable": call.result is not None,
                "isError": call.is_error,
                "calledAt": call.created_at,
            }
        )
    return (
        "Prior tool calls in this chat are persisted below. They identify what was already fetched, "
        "but do not assert that the data is still current. Use recall_saved_tool_result only when "
        "the prior result itself matters; otherwise make a fresh authoritative call.\n"
        + json.dumps(records, ensure_ascii=False)
    )


def _saved_result_payload(store: ToolCallStore | None, thread_id: str | None, arguments: dict[str, Any]) -> dict[str, Any]:
    call_id = arguments.get("callId")
    if not isinstance(call_id, str) or not call_id:
        return {"isError": True, "error": {"message": "recall_saved_tool_result requires a non-empty callId."}}
    if store is None or not thread_id:
        return {"isError": True, "error": {"message": "No persisted tool-call context is available for this chat."}}
    result = store.result(thread_id, call_id)
    if result is None:
        return {"isError": True, "error": {"message": f"No saved result exists for tool call {call_id}."}}
    return result


def _scoped_tool_arguments(name: str, arguments: dict[str, Any], athlete_id: str | None) -> dict[str, Any]:
    if athlete_id and name not in {_RECALL_SAVED_TOOL_RESULT, "list_athletes"}:
        return {**arguments, "athleteId": athlete_id}
    return arguments


async def _invoke_tool(
    session: ClientSession,
    name: str,
    arguments: dict[str, Any],
    maximum_characters: int,
    *,
    tool_call_store: ToolCallStore | None = None,
    thread_id: str | None = None,
    athlete_id: str | None = None,
) -> dict[str, Any]:
    # A shared Console process may see several athlete stores. The selected
    # athlete is server-owned session state, never model-controlled input.
    arguments = _scoped_tool_arguments(name, arguments, athlete_id)
    step = cl.Step(name=f"Catence · {name}", type="tool", default_open=False)
    step.input = arguments
    await step.send()
    try:
        if name == _RECALL_SAVED_TOOL_RESULT:
            payload = _saved_result_payload(tool_call_store, thread_id, arguments)
        else:
            result = await session.call_tool(name, arguments)
            payload = _tool_result_payload(result, maximum_characters)
        step.output = payload
        step.is_error = bool(payload.get("isError"))
        await step.update()
        return payload
    except Exception as error:
        payload = {"isError": True, "error": {"message": str(error)}}
        step.output = payload
        step.is_error = True
        await step.update()
        return payload


async def respond(
    *,
    profile: ProviderProfile,
    model_id: str,
    reasoning_effort: str | None,
    history: list[dict[str, Any]],
    mcp_url: str,
    tool_round_limit: int = DEFAULT_TOOL_ROUND_LIMIT,
    tool_result_character_limit: int = DEFAULT_TOOL_RESULT_CHARACTER_LIMIT,
    tool_call_store: ToolCallStore | None = None,
    thread_id: str | None = None,
    athlete_id: str | None = None,
    complete: Callable[..., Awaitable[Any]] = acompletion,
) -> str:
    """Run one bounded Chat turn, displaying each evidence-producing MCP call."""

    # Resolve reasoning_effort priority: per-chat selection > model option >
    # profile default (the profile default is resolved upstream by _session_settings).
    model_option = profile.model_option(model_id)
    effective_reasoning_effort = reasoning_effort or model_option.reasoning_effort

    try:
        async with streamablehttp_client(mcp_url) as transport:
            read_stream, write_stream = transport[:2]
            async with ClientSession(read_stream, write_stream) as session:
                initialized = await session.initialize()
                listed_tools = await session.list_tools()
                tools = _tool_definitions(list(listed_tools.tools))
                messages: list[dict[str, Any]] = [{"role": "system", "content": SYSTEM_PROMPT}, *history]
                if athlete_id:
                    messages.insert(
                        1,
                        {
                            "role": "system",
                            "content": (
                                f"This Console chat is scoped to athleteId {athlete_id!r}. "
                                "Every Catence data tool call is forced to that athlete; do not try to select or compare another athlete."
                            ),
                        },
                    )
                initialized_raw = _as_json(initialized)
                server_instructions = initialized_raw.get("instructions") if isinstance(initialized_raw, dict) else None
                if isinstance(server_instructions, str) and server_instructions.strip():
                    messages.insert(1, {"role": "system", "content": f"Catence MCP server instructions:\n{server_instructions}"})
                if tool_call_store is not None and thread_id:
                    tool_history = _tool_history_message(tool_call_store.list(thread_id, limit=_TOOL_HISTORY_LIMIT))
                    if tool_history:
                        messages.insert(1, {"role": "system", "content": tool_history})

                for _ in range(tool_round_limit):
                    options: dict[str, Any] = {
                        **profile.litellm_options(model_id),
                        "messages": messages,
                        "tools": tools,
                        "tool_choice": "auto",
                    }
                    if effective_reasoning_effort:
                        options["reasoning_effort"] = effective_reasoning_effort
                        options["allowed_openai_params"] = ["reasoning_effort"]
                    completion = await complete(**options)
                    message = completion.choices[0].message
                    content = getattr(message, "content", None)
                    tool_calls = list(getattr(message, "tool_calls", None) or [])
                    if not tool_calls:
                        return content or "The provider finished without a written response."

                    messages.append(
                        {
                            "role": "assistant",
                            "content": content,
                            "tool_calls": _as_json(tool_calls),
                        }
                    )
                    for tool_call in tool_calls:
                        call_id, name, arguments = _tool_call_parts(tool_call)
                        arguments = _scoped_tool_arguments(name, arguments, athlete_id)
                        payload = await _invoke_tool(
                            session,
                            name,
                            arguments,
                            tool_result_character_limit,
                            tool_call_store=tool_call_store,
                            thread_id=thread_id,
                            athlete_id=None,
                        )
                        if tool_call_store is not None and thread_id and name != _RECALL_SAVED_TOOL_RESULT:
                            tool_call_store.record(
                                thread_id=thread_id,
                                call_id=call_id,
                                name=name,
                                arguments=arguments,
                                result=payload,
                            )
                        messages.append(
                            {
                                "role": "tool",
                                "tool_call_id": call_id,
                                "content": json.dumps(payload, ensure_ascii=False, default=str),
                            }
                        )

    except BaseExceptionGroup as group:
        raise _unwrap_exception_group(group) from None

    return f"I stopped after {tool_round_limit} Catence tool calls. Please narrow the question or raise the tool-round limit in settings."
