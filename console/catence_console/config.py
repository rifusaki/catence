"""Non-secret Console configuration loaded from Catence's data directory."""

from __future__ import annotations

import json
import os
import re
from dataclasses import dataclass
from pathlib import Path
from typing import Any

ENVIRONMENT_VARIABLE = re.compile(r"^[A-Z][A-Z0-9_]*$")
REASONING_EFFORTS = ("minimal", "low", "medium", "high", "xhigh")


class ConsoleConfigurationError(ValueError):
    """Raised when Console configuration is absent or cannot be used safely."""


@dataclass(frozen=True)
class ModelOption:
    """One deployment available through a provider profile."""

    id: str
    label: str
    model: str


@dataclass(frozen=True)
class ProviderProfile:
    """A named LiteLLM profile whose credentials remain in the environment."""

    id: str
    label: str
    model: str
    models: dict[str, ModelOption] | None = None
    default_model: str | None = None
    default_reasoning_effort: str | None = None
    api_key_env: str | None = None
    api_base_env: str | None = None
    api_version_env: str | None = None

    @property
    def required_environment(self) -> tuple[str, ...]:
        return tuple(
            name
            for name in (self.api_key_env, self.api_base_env, self.api_version_env)
            if name is not None
        )

    def model_option(self, model_id: str | None = None) -> ModelOption:
        """Resolve a configured deployment, preserving legacy single-model profiles."""

        if not self.models:
            return ModelOption(id="default", label=self.label, model=self.model)
        selected_id = model_id or self.default_model
        try:
            return self.models[selected_id or ""]
        except KeyError as error:
            raise ConsoleConfigurationError(f"Unknown model {model_id!r} for Console profile {self.id!r}.") from error

    def litellm_options(self, model_id: str | None = None) -> dict[str, str]:
        """Return only present credentials; values are never logged or persisted."""

        options: dict[str, str] = {"model": self.model_option(model_id).model}
        mappings = (
            ("api_key", self.api_key_env),
            ("api_base", self.api_base_env),
            ("api_version", self.api_version_env),
        )
        for option, environment_name in mappings:
            if environment_name and (value := os.environ.get(environment_name)):
                options[option] = value
        return options


@dataclass(frozen=True)
class ConsoleConfiguration:
    default_profile: str
    profiles: dict[str, ProviderProfile]

    def profile(self, profile_id: str) -> ProviderProfile:
        try:
            return self.profiles[profile_id]
        except KeyError as error:
            raise ConsoleConfigurationError(f"Unknown Console profile: {profile_id}") from error

    def model_choices(self) -> dict[str, str]:
        """Return Chainlit labels mapped to stable ``profile:model`` selection values."""

        choices: dict[str, str] = {}
        for profile in self.profiles.values():
            options = profile.models or {"default": profile.model_option()}
            for model_id, option in options.items():
                choices[f"{profile.label} · {option.label}"] = f"{profile.id}:{model_id}"
        return choices

    def default_model_choice(self) -> str:
        profile = self.profile(self.default_profile)
        return f"{profile.id}:{profile.default_model or 'default'}"

    def selected_model(self, value: str | None) -> tuple[ProviderProfile, str]:
        selected = value or self.default_model_choice()
        profile_id, separator, model_id = selected.partition(":")
        if not separator or not model_id:
            raise ConsoleConfigurationError("The selected Console model is invalid.")
        profile = self.profile(profile_id)
        profile.model_option(model_id)
        return profile, model_id


def _object(value: Any, description: str) -> dict[str, Any]:
    if not isinstance(value, dict):
        raise ConsoleConfigurationError(f"{description} must be an object.")
    return value


def _environment_name(value: Any, field: str, profile_id: str) -> str | None:
    if value is None:
        return None
    if not isinstance(value, str) or not ENVIRONMENT_VARIABLE.fullmatch(value):
        raise ConsoleConfigurationError(
            f"console.profiles.{profile_id}.{field} must be an uppercase environment-variable name."
        )
    return value


def _model_option(value: Any, profile_id: str, model_id: str) -> ModelOption:
    model = _object(value, f"console.profiles.{profile_id}.models.{model_id}")
    unknown_fields = set(model) - {"label", "model"}
    if unknown_fields:
        raise ConsoleConfigurationError(
            f"console.profiles.{profile_id}.models.{model_id} contains unsupported fields: {', '.join(sorted(unknown_fields))}."
        )
    name = model.get("model")
    if not isinstance(name, str) or not name.strip():
        raise ConsoleConfigurationError(f"console.profiles.{profile_id}.models.{model_id}.model must be a non-empty string.")
    label = model.get("label", model_id)
    if not isinstance(label, str) or not label.strip():
        raise ConsoleConfigurationError(f"console.profiles.{profile_id}.models.{model_id}.label must be a non-empty string.")
    return ModelOption(id=model_id, label=label, model=name)


def load_console_configuration(data_directory: Path) -> ConsoleConfiguration:
    """Read named provider profiles without allowing secrets in ``config.json``."""

    path = data_directory / "config.json"
    try:
        root = _object(json.loads(path.read_text(encoding="utf-8")), "Catence config")
    except FileNotFoundError as error:
        raise ConsoleConfigurationError(
            f"No Catence config exists at {path}. Copy the console section from config.example.json first."
        ) from error
    except json.JSONDecodeError as error:
        raise ConsoleConfigurationError(f"Invalid JSON in {path}: {error.msg}") from error

    console = _object(root.get("console"), "console")
    unknown_console_fields = set(console) - {"defaultProfile", "profiles"}
    if unknown_console_fields:
        raise ConsoleConfigurationError(
            f"console contains unsupported fields: {', '.join(sorted(unknown_console_fields))}."
        )
    raw_profiles = _object(console.get("profiles"), "console.profiles")
    if not raw_profiles:
        raise ConsoleConfigurationError("console.profiles must contain at least one named profile.")

    profiles: dict[str, ProviderProfile] = {}
    for profile_id, raw_profile in raw_profiles.items():
        if not isinstance(profile_id, str) or not profile_id:
            raise ConsoleConfigurationError("console profile names must be non-empty strings.")
        profile = _object(raw_profile, f"console.profiles.{profile_id}")
        unknown_profile_fields = set(profile) - {
            "label",
            "model",
            "models",
            "defaultModel",
            "defaultReasoningEffort",
            "apiKeyEnv",
            "apiBaseEnv",
            "apiVersionEnv",
        }
        if unknown_profile_fields:
            raise ConsoleConfigurationError(
                f"console.profiles.{profile_id} contains unsupported fields: {', '.join(sorted(unknown_profile_fields))}."
            )
        model = profile.get("model")
        raw_models = profile.get("models")
        if model is not None and raw_models is not None:
            raise ConsoleConfigurationError(f"console.profiles.{profile_id} must define either model or models, not both.")
        models: dict[str, ModelOption] | None = None
        default_model: str | None = None
        if raw_models is not None:
            raw_models = _object(raw_models, f"console.profiles.{profile_id}.models")
            if not raw_models:
                raise ConsoleConfigurationError(f"console.profiles.{profile_id}.models must contain at least one model.")
            models = {}
            for model_id, raw_model in raw_models.items():
                if not isinstance(model_id, str) or not model_id:
                    raise ConsoleConfigurationError(f"console.profiles.{profile_id}.models names must be non-empty strings.")
                models[model_id] = _model_option(raw_model, profile_id, model_id)
            default_model = profile.get("defaultModel", next(iter(models)))
            if not isinstance(default_model, str) or default_model not in models:
                raise ConsoleConfigurationError(f"console.profiles.{profile_id}.defaultModel must name one of its models.")
            model = models[default_model].model
        elif not isinstance(model, str) or not model.strip():
            raise ConsoleConfigurationError(f"console.profiles.{profile_id} must define a non-empty model or models.")
        elif "defaultModel" in profile:
            raise ConsoleConfigurationError(f"console.profiles.{profile_id}.defaultModel requires models.")
        reasoning_effort = profile.get("defaultReasoningEffort")
        if reasoning_effort is not None and reasoning_effort not in REASONING_EFFORTS:
            allowed = ", ".join(REASONING_EFFORTS)
            raise ConsoleConfigurationError(f"console.profiles.{profile_id}.defaultReasoningEffort must be one of: {allowed}.")
        label = profile.get("label", profile_id)
        if not isinstance(label, str) or not label.strip():
            raise ConsoleConfigurationError(f"console.profiles.{profile_id}.label must be a non-empty string.")
        profiles[profile_id] = ProviderProfile(
            id=profile_id,
            label=label,
            model=model,
            models=models,
            default_model=default_model,
            default_reasoning_effort=reasoning_effort,
            api_key_env=_environment_name(profile.get("apiKeyEnv"), "apiKeyEnv", profile_id),
            api_base_env=_environment_name(profile.get("apiBaseEnv"), "apiBaseEnv", profile_id),
            api_version_env=_environment_name(profile.get("apiVersionEnv"), "apiVersionEnv", profile_id),
        )

    default_profile = console.get("defaultProfile", next(iter(profiles)))
    if not isinstance(default_profile, str) or default_profile not in profiles:
        raise ConsoleConfigurationError("console.defaultProfile must name one of console.profiles.")
    return ConsoleConfiguration(default_profile=default_profile, profiles=profiles)


def missing_environment(profile: ProviderProfile) -> tuple[str, ...]:
    return tuple(name for name in profile.required_environment if not os.environ.get(name))
