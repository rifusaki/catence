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
from catence_console.persistence import (
    SavedConsolePreferences,
    console_preferences_store,
    local_data_layer,
    tool_call_store,
)

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


def _session_settings(
    configuration: ConsoleConfiguration,
) -> tuple[str, str, str | None, int, int]:
    """Return the current chat's safe, valid settings.

    Startup and resume apply the local user's durable preferences before this
    function runs. Falling back to configured defaults also lets a chat remain
    usable after its saved model has been removed from config.json.
    """

    model_choice = cl.user_session.get("catence_model")
    if isinstance(model_choice, str):
        try:
            profile, model_id = configuration.selected_model(model_choice)
        except ConsoleConfigurationError:
            model_choice = configuration.default_model_choice()
            profile, model_id = configuration.selected_model(model_choice)
    else:
        model_choice = configuration.default_model_choice()
        profile, model_id = configuration.selected_model(model_choice)
    reasoning_effort = cl.user_session.get("catence_reasoning_effort")
    if reasoning_effort not in {"default", "minimal", "low", "medium", "high", "xhigh"}:
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


def _selected_settings() -> tuple[str, str, str | None, int, int]:
    return _session_settings(_configuration())


def _configured_preferences(configuration: ConsoleConfiguration) -> SavedConsolePreferences:
    profile = configuration.profile(configuration.default_profile)
    return SavedConsolePreferences(
        model_choice=configuration.default_model_choice(),
        reasoning_effort=profile.default_reasoning_effort or "default",
        tool_rounds=configuration.limits.tool_rounds,
        tool_result_characters=configuration.limits.tool_result_characters,
    )


def _user_identifier() -> str:
    user = cl.user_session.get("user")
    identifier = getattr(user, "identifier", None)
    return identifier if isinstance(identifier, str) and identifier else os.environ.get("CHAINLIT_LOCAL_USER", "catence-local")


def _normalized_preferences(
    configuration: ConsoleConfiguration, preferences: SavedConsolePreferences
) -> SavedConsolePreferences:
    default = _configured_preferences(configuration)
    try:
        configuration.selected_model(preferences.model_choice)
        model_choice = preferences.model_choice
    except ConsoleConfigurationError:
        model_choice = default.model_choice
    reasoning_effort = preferences.reasoning_effort
    if reasoning_effort not in {"default", "minimal", "low", "medium", "high", "xhigh"}:
        reasoning_effort = default.reasoning_effort
    return SavedConsolePreferences(
        model_choice=model_choice,
        reasoning_effort=reasoning_effort,
        tool_rounds=max(MIN_TOOL_ROUND_LIMIT, min(preferences.tool_rounds, MAX_TOOL_ROUND_LIMIT)),
        tool_result_characters=max(
            MIN_TOOL_RESULT_CHARACTER_LIMIT,
            min(preferences.tool_result_characters, MAX_TOOL_RESULT_CHARACTER_LIMIT),
        ),
    )


def _apply_preferences(preferences: SavedConsolePreferences) -> None:
    cl.user_session.set("catence_model", preferences.model_choice)
    cl.user_session.set("catence_reasoning_effort", preferences.reasoning_effort)
    cl.user_session.set("catence_tool_rounds", preferences.tool_rounds)
    cl.user_session.set("catence_tool_result_characters", preferences.tool_result_characters)


def _restore_preferences(configuration: ConsoleConfiguration) -> SavedConsolePreferences:
    saved = console_preferences_store(DATA_DIRECTORY).load(_user_identifier())
    preferences = _normalized_preferences(configuration, saved or _configured_preferences(configuration))
    _apply_preferences(preferences)
    return preferences


def _persist_preferences(configuration: ConsoleConfiguration, preferences: SavedConsolePreferences) -> None:
    store = console_preferences_store(DATA_DIRECTORY)
    if preferences == _configured_preferences(configuration):
        store.delete(_user_identifier())
    else:
        store.save(_user_identifier(), preferences)


def _chat_settings(
    configuration: ConsoleConfiguration,
    *,
    model_choice: str,
    reasoning_effort: str | None,
    tool_rounds: int,
    tool_result_characters: int,
) -> cl.ChatSettings:
    defaults = _configured_preferences(configuration)
    return cl.ChatSettings(
        [
            Select(
                id="model",
                label="Model",
                items=configuration.model_choices(),
                initial_value=model_choice,
                reset_value=defaults.model_choice,
                description="Choose a deployment. Credentials stay in the Console process environment.",
            ),
            Select(
                id="reasoningEffort",
                label="Thinking effort",
                items={
                    "Provider default": "default",
                    **{effort.title(): effort for effort in ("minimal", "low", "medium", "high", "xhigh")},
                },
                initial_value=reasoning_effort or "default",
                reset_value=defaults.reasoning_effort,
                description="Passed to models that support OpenAI reasoning effort.",
            ),
            NumberInput(
                id="toolRounds",
                label="Tool-call rounds",
                initial=tool_rounds,
                reset_value=defaults.tool_rounds,
                placeholder=str(DEFAULT_TOOL_ROUND_LIMIT),
                description=f"Maximum model → tool → model rounds for this chat ({MIN_TOOL_ROUND_LIMIT}–{MAX_TOOL_ROUND_LIMIT}).",
            ),
            NumberInput(
                id="toolResultCharacters",
                label="Evidence per tool result",
                initial=tool_result_characters,
                reset_value=defaults.tool_result_characters,
                placeholder=str(DEFAULT_TOOL_RESULT_CHARACTER_LIMIT),
                description=(
                    "Maximum characters of each tool result passed to the model "
                    f"({MIN_TOOL_RESULT_CHARACTER_LIMIT:,}–{MAX_TOOL_RESULT_CHARACTER_LIMIT:,})."
                ),
            ),
        ]
    )


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

    preferences = _restore_preferences(configuration)
    profile, model_id = configuration.selected_model(preferences.model_choice)
    await _chat_settings(
        configuration,
        model_choice=preferences.model_choice,
        reasoning_effort=None if preferences.reasoning_effort == "default" else preferences.reasoning_effort,
        tool_rounds=preferences.tool_rounds,
        tool_result_characters=preferences.tool_result_characters,
    ).send()

    missing = missing_environment(profile)
    readiness = "ready" if not missing else f"missing environment variables: {', '.join(missing)}"
    selected_model = profile.model_option(model_id)
    selected_effort = None if preferences.reasoning_effort == "default" else preferences.reasoning_effort
    await cl.Message(
        content=(
            f"Catence Console is {readiness}. Using **{selected_model.label}** with **{selected_effort or 'provider default'}** thinking, "
            f"up to **{preferences.tool_rounds}** tool rounds and **{preferences.tool_result_characters:,}** evidence characters per result. "
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


@cl.on_chat_resume
async def resume(_thread: dict[str, Any]) -> None:
    """Make a persisted local thread live again without changing its history."""

    try:
        configuration = _configuration()
        preferences = _restore_preferences(configuration)
        await _chat_settings(
            configuration,
            model_choice=preferences.model_choice,
            reasoning_effort=None if preferences.reasoning_effort == "default" else preferences.reasoning_effort,
            tool_rounds=preferences.tool_rounds,
            tool_result_characters=preferences.tool_result_characters,
        ).refresh()
    except ConsoleConfigurationError as error:
        # The thread itself remains readable; a following message will show
        # the same actionable configuration error as a new chat would.
        logger.warning("Could not restore Catence Console settings for a resumed chat: %s", error)


@cl.on_settings_update
async def update_settings(settings: dict[str, Any]) -> None:
    configuration = _configuration()
    current = _restore_preferences(configuration)
    model_choice = settings.get("model", current.model_choice)
    if not isinstance(model_choice, str):
        model_choice = current.model_choice
    try:
        profile, model_id = configuration.selected_model(model_choice)
    except ConsoleConfigurationError:
        profile, model_id = configuration.selected_model(current.model_choice)
        model_choice = current.model_choice
    reasoning_effort = settings.get("reasoningEffort", current.reasoning_effort)
    if reasoning_effort not in {"default", "minimal", "low", "medium", "high", "xhigh"}:
        reasoning_effort = current.reasoning_effort
    tool_rounds = _limit_setting(settings.get("toolRounds"), MIN_TOOL_ROUND_LIMIT, MAX_TOOL_ROUND_LIMIT)
    tool_result_characters = _limit_setting(
        settings.get("toolResultCharacters"), MIN_TOOL_RESULT_CHARACTER_LIMIT, MAX_TOOL_RESULT_CHARACTER_LIMIT
    )
    preferences = SavedConsolePreferences(
        model_choice=model_choice,
        reasoning_effort=reasoning_effort,
        tool_rounds=tool_rounds if tool_rounds is not None else current.tool_rounds,
        tool_result_characters=(
            tool_result_characters if tool_result_characters is not None else current.tool_result_characters
        ),
    )
    _apply_preferences(preferences)
    _persist_preferences(configuration, preferences)
    selected_model = profile.model_option(model_id)
    await cl.Message(
        content=(
            f"Settings applied: **{selected_model.label}** with **{preferences.reasoning_effort if preferences.reasoning_effort != 'default' else 'provider default'}** thinking, "
            f"**{preferences.tool_rounds}** tool rounds, and **{preferences.tool_result_characters:,}** evidence characters per result."
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
            tool_call_store=tool_call_store(DATA_DIRECTORY),
            thread_id=cl.context.session.thread_id,
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
