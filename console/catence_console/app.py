"""Chainlit callbacks for Catence Console."""

from __future__ import annotations

import logging
import os
from pathlib import Path
from typing import Any

import chainlit as cl
from chainlit.input_widget import Select

from catence_console.agent import respond
from catence_console.config import ConsoleConfigurationError, load_console_configuration, missing_environment

DATA_DIRECTORY = Path(os.environ.get("CATENCE_DATA_DIR", ".catence")).expanduser().resolve()
MCP_URL = os.environ.get("CATENCE_MCP_URL", "http://127.0.0.1:8787/mcp")
logger = logging.getLogger(__name__)


def _configuration():
    return load_console_configuration(DATA_DIRECTORY)


def _selected_settings() -> tuple[str, str, str | None]:
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
    return profile.id, model_id, reasoning_effort


@cl.on_chat_start
async def start() -> None:
    try:
        configuration = _configuration()
    except ConsoleConfigurationError as error:
        await cl.Message(
            content=(
                f"Console configuration needs attention: {error}\n\n"
                "Copy the `console` section in `config.example.json` into your Catence data directory, "
                "then run `catence-console doctor`."
            )
        ).send()
        return

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
        ]
    ).send()
    cl.user_session.set("catence_model", default_model_choice)
    cl.user_session.set("catence_reasoning_effort", default_profile.default_reasoning_effort or "default")

    missing = missing_environment(default_profile)
    readiness = "ready" if not missing else f"missing environment variables: {', '.join(missing)}"
    default_model = default_profile.model_option(default_profile.default_model)
    default_effort = default_profile.default_reasoning_effort or "provider default"
    await cl.Message(
        content=(
            f"Catence Console is {readiness}. Using **{default_model.label}** with **{default_effort}** thinking. "
            "I can use the same local MCP tools as your coding agent. "
            "Try a recovery review, training-load check, or a question about a recent activity."
        )
    ).send()


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
    if selected_profile is not None and selected_model_id is not None:
        selected_model = selected_profile.model_option(selected_model_id)
        effort_label = reasoning_effort if isinstance(reasoning_effort, str) else selected_profile.default_reasoning_effort
        await cl.Message(
            content=f"Settings applied: **{selected_model.label}** with **{effort_label or 'provider default'}** thinking."
        ).send()


@cl.on_message
async def on_message(message: cl.Message) -> None:
    try:
        configuration = _configuration()
        profile_id, model_id, reasoning_effort = _selected_settings()
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
