"""LiteLLM tool-calling loop backed by Catence's Streamable HTTP MCP endpoint."""

from __future__ import annotations

import json
from collections.abc import Awaitable, Callable
from typing import Any

import chainlit as cl
from litellm import acompletion
from mcp import ClientSession
from mcp.client.streamable_http import streamablehttp_client

from .config import ProviderProfile

SYSTEM_PROMPT = """You are Catence, a careful endurance-training data assistant.
Use Catence MCP tools for athlete-specific facts. Start with a named review tool
when it fits (recovery, training load, or weekly review), then ask a narrow
follow-up tool only when it would change the recommendation. Never invent data
or clinical conclusions. Distinguish a missing measurement from a poor value.
In every conclusion, name the dates and metrics returned by the tools so the
athlete can trace the evidence. Catence's data is personal and local: do not
ask for credentials or expose configuration values."""

MAX_TOOL_ROUNDS = 8
MAX_TOOL_RESULT_CHARACTERS = 24_000


def _as_json(value: Any) -> Any:
    if hasattr(value, "model_dump"):
        return value.model_dump(mode="json", exclude_none=True)
    if isinstance(value, dict):
        return {key: _as_json(item) for key, item in value.items()}
    if isinstance(value, (list, tuple)):
        return [_as_json(item) for item in value]
    return value


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


def _tool_result_payload(result: Any) -> dict[str, Any]:
    payload = _as_json(result)
    encoded = json.dumps(payload, ensure_ascii=False, default=str)
    if len(encoded) <= MAX_TOOL_RESULT_CHARACTERS:
        return payload
    return {
        "content": [{"type": "text", "text": encoded[:MAX_TOOL_RESULT_CHARACTERS]}],
        "isError": True,
        "truncated": True,
        "message": "Catence returned more evidence than the Console can safely pass to the model in one turn.",
    }


async def _invoke_tool(session: ClientSession, name: str, arguments: dict[str, Any]) -> dict[str, Any]:
    step = cl.Step(name=f"Catence · {name}", type="tool", default_open=False)
    step.input = arguments
    await step.send()
    try:
        result = await session.call_tool(name, arguments)
        payload = _tool_result_payload(result)
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
    complete: Callable[..., Awaitable[Any]] = acompletion,
) -> str:
    """Run one bounded Chat turn, displaying each evidence-producing MCP call."""

    async with streamablehttp_client(mcp_url) as transport:
        read_stream, write_stream = transport[:2]
        async with ClientSession(read_stream, write_stream) as session:
            await session.initialize()
            listed_tools = await session.list_tools()
            tools = _tool_definitions(list(listed_tools.tools))
            messages: list[dict[str, Any]] = [{"role": "system", "content": SYSTEM_PROMPT}, *history]

            for _ in range(MAX_TOOL_ROUNDS):
                options: dict[str, Any] = {
                    **profile.litellm_options(model_id),
                    "messages": messages,
                    "tools": tools,
                    "tool_choice": "auto",
                }
                if reasoning_effort:
                    options["reasoning_effort"] = reasoning_effort
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
                    payload = await _invoke_tool(session, name, arguments)
                    messages.append(
                        {
                            "role": "tool",
                            "tool_call_id": call_id,
                            "content": json.dumps(payload, ensure_ascii=False, default=str),
                        }
                    )

    return "I stopped after eight Catence tool calls. Please narrow the question or start with a named review."
