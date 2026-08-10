"""Chainlit callbacks for Catence Console."""

from __future__ import annotations

import logging
import os
from pathlib import Path
from typing import Any

import chainlit as cl
from chainlit.input_widget import NumberInput, Select

from catence_console.agent import respond
from catence_console.config import (
    DEFAULT_TOOL_RESULT_CHARACTER_LIMIT,
    DEFAULT_TOOL_ROUND_LIMIT,
    MAX_TOOL_RESULT_CHARACTER_LIMIT,
    MAX_TOOL_ROUND_LIMIT,
    MIN_TOOL_RESULT_CHARACTER_LIMIT,
    MIN_TOOL_ROUND_LIMIT,
    ConsoleConfiguration,
    ConsoleConfigurationError,
    load_console_configuration,
    missing_environment,
    write_provider_setup,
)
from catence_console.persistence import local_data_layer

DATA_DIRECTORY = Path(os.environ.get("CATENCE_DATA_DIR", ".catence")).expanduser().resolve()
MCP_URL = os.environ.get("CATENCE_MCP_URL", "http://127.0.0.1:8787/mcp")
logger = logging.getLogger(__name__)


@cl.data_layer
def data_layer():
    """Keep Console chats in the local Catence data directory."""

    return local_data_layer(DATA_DIRECTORY)


def _configuration():
    return load_console_configuration(DATA_DIRECTORY)


def _limit_setting(value: Any, minimum: int, maximum: int) -> int | None:
    """Normalize Chainlit's number-input payload, which arrives as a string."""

    if isinstance(value, str):
        try:
            value = int(value.strip())
        except ValueError:
            return None
    if not isinstance(value, (int, float)) or isinstance(value, bool):
        return None
    return max(minimum, min(int(value), maximum))


def _selected_settings() -> tuple[str, str, str | None, int, int]:
    configuration = _configuration()
    model_choice = cl.user_session.get("catence_model")
    if not isinstance(model_choice, str):
        model_choice = configuration.default_model_choice()
    profile, model_id = configuration.selected_model(model_choice)
    reasoning_effort = cl.user_session.get("catence_reasoning_effort")
    if not isinstance(reasoning_effort, str):
        reasoning_effort = profile.default_reasoning_effort
    if reasoning_effort == "default":
        reasoning_effort = None
    tool_rounds = cl.user_session.get("catence_tool_rounds")
    if not isinstance(tool_rounds, int) or isinstance(tool_rounds, bool):
        tool_rounds = configuration.limits.tool_rounds
    tool_rounds = max(MIN_TOOL_ROUND_LIMIT, min(tool_rounds, MAX_TOOL_ROUND_LIMIT))
    tool_result_characters = cl.user_session.get("catence_tool_result_characters")
    if not isinstance(tool_result_characters, int) or isinstance(tool_result_characters, bool):
        tool_result_characters = configuration.limits.tool_result_characters
    tool_result_characters = max(
        MIN_TOOL_RESULT_CHARACTER_LIMIT,
        min(tool_result_characters, MAX_TOOL_RESULT_CHARACTER_LIMIT),
    )
    return profile.id, model_id, reasoning_effort, tool_rounds, tool_result_characters


async def _ask_setup_question(content: str) -> str | None:
    response = await cl.AskUserMessage(content=content, timeout=600).send()
    answer = response.get("output") if response else None
    return answer.strip() if isinstance(answer, str) else None


async def _setup_wizard() -> ConsoleConfiguration | None:
    await cl.Message(
        content=(
            "Welcome to Catence Console. Let’s set up your first model. "
            "This wizard writes only provider and model names; API keys stay in your terminal environment."
        )
    ).send()
    provider = await _ask_setup_question("Choose a provider: `azure`, `openai`, or `anthropic`.")
    if provider is None:
        return None
    provider = provider.lower()
    examples = {
        "azure": "Azure deployment name, for example `gpt-5.6-terra`",
        "openai": "OpenAI model name, for example `gpt-5-mini`",
        "anthropic": "Anthropic model name, for example `claude-sonnet-4-5`",
    }
    if provider not in examples:
        await cl.Message(content="Setup paused: choose `azure`, `openai`, or `anthropic` and start a new chat to try again.").send()
        return None
    model = await _ask_setup_question(f"Enter the {examples[provider]}.")
    if model is None:
        return None
    try:
        configuration = write_provider_setup(DATA_DIRECTORY, provider, model)
    except ConsoleConfigurationError as error:
        await cl.Message(content=f"Setup could not save the model: {error}").send()
        return None

    environment = {
        "azure": "Set `AZURE_API_KEY`, `AZURE_API_BASE`, and `AZURE_API_VERSION=preview`, then restart the Console.",
        "openai": "Set `OPENAI_API_KEY`, then restart the Console.",
        "anthropic": "Set `ANTHROPIC_API_KEY`, then restart the Console.",
    }
    await cl.Message(content=f"Setup saved. {environment[provider]}").send()
    return configuration


async def _initialize_chat(configuration: ConsoleConfiguration) -> None:
    """Send configurable widgets and the current readiness message."""


    default_profile = configuration.profile(configuration.default_profile)
    default_model_choice = configuration.default_model_choice()
    await cl.ChatSettings(
        [
            Select(
                id="model",
                label="Model",
                items=configuration.model_choices(),
                initial_value=default_model_choice,
                description="Choose a deployment. Credentials stay in the Console process environment.",
            ),
            Select(
                id="reasoningEffort",
                label="Thinking effort",
                items={
                    "Provider default": "default",
                    **{effort.title(): effort for effort in ("minimal", "low", "medium", "high", "xhigh")},
                },
                initial_value=default_profile.default_reasoning_effort or "default",
                description="Passed to models that support OpenAI reasoning effort.",
            ),
            NumberInput(
                id="toolRounds",
                label="Tool-call rounds",
                initial=configuration.limits.tool_rounds,
                placeholder=str(DEFAULT_TOOL_ROUND_LIMIT),
                description=f"Maximum model → tool → model rounds for this chat ({MIN_TOOL_ROUND_LIMIT}–{MAX_TOOL_ROUND_LIMIT}).",
            ),
            NumberInput(
                id="toolResultCharacters",
                label="Evidence per tool result",
                initial=configuration.limits.tool_result_characters,
                placeholder=str(DEFAULT_TOOL_RESULT_CHARACTER_LIMIT),
                description=(
                    "Maximum characters of each tool result passed to the model "
                    f"({MIN_TOOL_RESULT_CHARACTER_LIMIT:,}–{MAX_TOOL_RESULT_CHARACTER_LIMIT:,})."
                ),
            ),
        ]
    ).send()
    cl.user_session.set("catence_model", default_model_choice)
    cl.user_session.set("catence_reasoning_effort", default_profile.default_reasoning_effort or "default")
    cl.user_session.set("catence_tool_rounds", configuration.limits.tool_rounds)
    cl.user_session.set("catence_tool_result_characters", configuration.limits.tool_result_characters)

    missing = missing_environment(default_profile)
    readiness = "ready" if not missing else f"missing environment variables: {', '.join(missing)}"
    default_model = default_profile.model_option(default_profile.default_model)
    default_effort = default_profile.default_reasoning_effort or "provider default"
    await cl.Message(
        content=(
            f"Catence Console is {readiness}. Using **{default_model.label}** with **{default_effort}** thinking, "
            f"up to **{configuration.limits.tool_rounds}** tool rounds and **{configuration.limits.tool_result_characters:,}** evidence characters per result. "
            "I can use the same local MCP tools as your coding agent. "
            "Try a recovery review, training-load check, or a question about a recent activity."
        )
    ).send()


@cl.on_chat_start
async def start() -> None:
    try:
        configuration = _configuration()
    except ConsoleConfigurationError as error:
        if str(error).startswith("No Catence config") or str(error) == "console must be an object.":
            configuration = await _setup_wizard()
            if configuration is None:
                return
        else:
            await cl.Message(
                content=(
                    f"Console configuration needs attention: {error}\n\n"
                    "Run `catence-console doctor` to inspect the existing configuration without exposing its secrets."
                )
            ).send()
            return
    await _initialize_chat(configuration)


@cl.on_settings_update
async def update_settings(settings: dict[str, Any]) -> None:
    configuration = _configuration()
    model_choice = settings.get("model", configuration.default_model_choice())
    selected_profile = None
    selected_model_id = None
    if isinstance(model_choice, str):
        try:
            selected_profile, selected_model_id = configuration.selected_model(model_choice)
        except ConsoleConfigurationError:
            pass
        else:
            cl.user_session.set("catence_model", model_choice)
    reasoning_effort = settings.get("reasoningEffort")
    if reasoning_effort in {"default", "minimal", "low", "medium", "high", "xhigh"}:
        cl.user_session.set("catence_reasoning_effort", reasoning_effort)
    tool_rounds = settings.get("toolRounds")
    if normalized_rounds := _limit_setting(tool_rounds, MIN_TOOL_ROUND_LIMIT, MAX_TOOL_ROUND_LIMIT):
        cl.user_session.set("catence_tool_rounds", normalized_rounds)
    tool_result_characters = settings.get("toolResultCharacters")
    if normalized_characters := _limit_setting(
        tool_result_characters, MIN_TOOL_RESULT_CHARACTER_LIMIT, MAX_TOOL_RESULT_CHARACTER_LIMIT
    ):
        cl.user_session.set("catence_tool_result_characters", normalized_characters)
    if selected_profile is not None and selected_model_id is not None:
        selected_model = selected_profile.model_option(selected_model_id)
        effort_label = reasoning_effort if isinstance(reasoning_effort, str) else selected_profile.default_reasoning_effort
        rounds = cl.user_session.get("catence_tool_rounds", configuration.limits.tool_rounds)
        characters = cl.user_session.get("catence_tool_result_characters", configuration.limits.tool_result_characters)
        await cl.Message(
            content=(
                f"Settings applied: **{selected_model.label}** with **{effort_label or 'provider default'}** thinking, "
                f"**{rounds}** tool rounds, and **{characters:,}** evidence characters per result."
            )
        ).send()


@cl.on_message
async def on_message(message: cl.Message) -> None:
    try:
        configuration = _configuration()
        profile_id, model_id, reasoning_effort, tool_round_limit, tool_result_character_limit = _selected_settings()
        profile = configuration.profile(profile_id)
    except ConsoleConfigurationError as error:
        await cl.Message(content=f"Console configuration error: {error}").send()
        return

    missing = missing_environment(profile)
    if missing:
        await cl.Message(
            content=f"Profile **{profile.label}** is not ready. Set {', '.join(missing)} in the Console process environment, then restart it."
        ).send()
        return

    try:
        answer = await respond(
            profile=profile,
            model_id=model_id,
            reasoning_effort=reasoning_effort,
            history=cl.chat_context.to_openai(),
            mcp_url=MCP_URL,
            tool_round_limit=tool_round_limit,
            tool_result_character_limit=tool_result_character_limit,
        )
    except Exception as error:
        logger.exception("Catence model request failed for profile %s and model %s", profile.id, model_id)
        await cl.Message(
            content=(
                f"I could not complete that Catence review: {error}\n\n"
                "Run `catence-console doctor` to verify the profile and local Catence server."
            )
        ).send()
        return
    await cl.Message(content=answer).send()
