import asyncio
import json
from types import SimpleNamespace

import pytest

from catence_console.config import ConsoleConfigurationError, load_console_configuration, write_provider_setup
from catence_console.app import _chat_settings, _configured_preferences, _limit_setting, _normalized_preferences, _session_settings
from catence_console.persistence import SavedConsolePreferences


def write_config(tmp_path, console):
    (tmp_path / "config.json").write_text(json.dumps({"console": console}), encoding="utf-8")


def test_loads_named_profiles_without_storing_values(tmp_path, monkeypatch):
    write_config(
        tmp_path,
        {
            "defaultProfile": "azure",
            "profiles": {
                "azure": {
                    "label": "Azure Foundry",
                    "model": "azure_ai/catence",
                    "apiKeyEnv": "AZURE_API_KEY",
                    "apiBaseEnv": "AZURE_API_BASE",
                }
            },
        },
    )
    monkeypatch.setenv("AZURE_API_KEY", "not-printed")
    monkeypatch.setenv("AZURE_API_BASE", "https://example.test")

    configuration = load_console_configuration(tmp_path)

    assert configuration.default_profile == "azure"
    assert configuration.profile("azure").litellm_options() == {
        "model": "azure_ai/catence",
        "api_key": "not-printed",
        "api_base": "https://example.test",
    }


def test_rejects_secret_values_instead_of_environment_variable_names(tmp_path):
    write_config(
        tmp_path,
        {
            "profiles": {
                "unsafe": {"model": "openai/model", "apiKeyEnv": "sk-a-real-secret"}
            }
        },
    )

    with pytest.raises(ConsoleConfigurationError, match="environment-variable"):
        load_console_configuration(tmp_path)


def test_rejects_unknown_profile_fields_so_secrets_cannot_be_ignored(tmp_path):
    write_config(
        tmp_path,
        {"profiles": {"unsafe": {"model": "openai/model", "apiKey": "a-secret-value"}}},
    )

    with pytest.raises(ConsoleConfigurationError, match="unsupported fields"):
        load_console_configuration(tmp_path)


def test_loads_multiple_models_and_a_default_reasoning_effort(tmp_path):
    write_config(
        tmp_path,
        {
            "defaultProfile": "azure",
            "profiles": {
                "azure": {
                    "models": {
                        "terra": {"model": "azure/gpt-5.6-terra"},
                        "luna": {"label": "Luna", "model": "azure/gpt-5.6-luna"},
                    },
                    "defaultModel": "luna",
                    "defaultReasoningEffort": "high",
                }
            },
        },
    )

    configuration = load_console_configuration(tmp_path)

    assert configuration.default_model_choice() == "azure:luna"
    assert configuration.model_choices() == {
        "azure · terra": "azure:terra",
        "azure · Luna": "azure:luna",
    }
    profile, model_id = configuration.selected_model("azure:terra")
    assert profile.litellm_options(model_id) == {"model": "azure/gpt-5.6-terra"}
    assert profile.default_reasoning_effort == "high"


def test_loads_configurable_tool_limits_and_writes_a_safe_setup(tmp_path):
    write_config(
        tmp_path,
        {
            "limits": {"toolRounds": 12, "toolResultCharacters": 48_000},
            "profiles": {"openai": {"model": "openai/gpt-5-mini"}},
        },
    )
    configuration = load_console_configuration(tmp_path)
    assert configuration.limits.tool_rounds == 12
    assert configuration.limits.tool_result_characters == 48_000

    setup = write_provider_setup(tmp_path, "anthropic", "claude-sonnet-4-5")
    assert setup.default_profile == "anthropic"
    assert setup.profile("anthropic").litellm_options() == {"model": "anthropic/claude-sonnet-4-5"}
    assert setup.model_choices() == {"Anthropic · claude-sonnet-4-5": "anthropic:default"}
    persisted = json.loads((tmp_path / "config.json").read_text(encoding="utf-8"))
    assert "ANTHROPIC_API_KEY" == persisted["console"]["profiles"]["anthropic"]["apiKeyEnv"]


def test_normalizes_number_input_values_for_per_chat_limits():
    assert _limit_setting("48000", 1_000, 250_000) == 48_000
    assert _limit_setting("999999", 1_000, 250_000) == 250_000
    assert _limit_setting("nope", 1_000, 250_000) is None


def test_resumed_chat_falls_back_when_its_saved_model_was_removed(tmp_path, monkeypatch):
    write_config(
        tmp_path,
        {
            "defaultProfile": "openai",
            "profiles": {"openai": {"model": "openai/gpt-5-mini"}},
        },
    )
    configuration = load_console_configuration(tmp_path)

    from catence_console import app

    monkeypatch.setattr(app.cl.user_session, "get", lambda key: "removed:model" if key == "catence_model" else None)
    profile_id, model_id, reasoning_effort, tool_rounds, tool_result_characters = _session_settings(configuration)

    assert (profile_id, model_id, reasoning_effort) == ("openai", "default", None)
    assert tool_rounds == configuration.limits.tool_rounds
    assert tool_result_characters == configuration.limits.tool_result_characters


def test_persistent_preferences_are_normalized_and_settings_expose_configured_reset_values(tmp_path):
    write_config(
        tmp_path,
        {
            "defaultProfile": "azure",
            "limits": {"toolRounds": 8, "toolResultCharacters": 24_000},
            "profiles": {
                "azure": {
                    "models": {
                        "terra": {"model": "azure/gpt-5.6-terra"},
                        "luna": {"model": "azure/gpt-5.6-luna"},
                    },
                    "defaultModel": "terra",
                }
            },
        },
    )
    configuration = load_console_configuration(tmp_path)
    saved = SavedConsolePreferences(
        model_choice="azure:luna",
        reasoning_effort="high",
        tool_rounds=12,
        tool_result_characters=48_000,
    )

    normalized = _normalized_preferences(configuration, saved)

    assert normalized == saved
    assert _configured_preferences(configuration) == SavedConsolePreferences(
        model_choice="azure:terra",
        reasoning_effort="default",
        tool_rounds=8,
        tool_result_characters=24_000,
    )
    settings = _chat_settings(
        configuration,
        model_choice=normalized.model_choice,
        reasoning_effort=normalized.reasoning_effort,
        tool_rounds=normalized.tool_rounds,
        tool_result_characters=normalized.tool_result_characters,
    )
    values = {input["id"]: input for input in settings._inputs_as_dicts()}
    assert values["model"]["initial"] == "azure:luna"
    assert values["model"]["resetValue"] == "azure:terra"
    assert values["reasoningEffort"]["initial"] == "high"
    assert values["reasoningEffort"]["resetValue"] == "default"
    assert values["toolRounds"]["resetValue"] == 8
    assert values["toolResultCharacters"]["resetValue"] == 24_000


def test_confirming_custom_settings_persists_them_and_confirming_reset_clears_them(tmp_path, monkeypatch):
    write_config(
        tmp_path,
        {
            "defaultProfile": "azure",
            "limits": {"toolRounds": 8, "toolResultCharacters": 24_000},
            "profiles": {
                "azure": {
                    "models": {
                        "terra": {"model": "azure/gpt-5.6-terra"},
                        "luna": {"model": "azure/gpt-5.6-luna"},
                    },
                    "defaultModel": "terra",
                }
            },
        },
    )
    from catence_console import app

    session = {"user": SimpleNamespace(identifier="athlete-a")}
    monkeypatch.setattr(app, "DATA_DIRECTORY", tmp_path)
    monkeypatch.setattr(app.cl.user_session, "get", lambda key, default=None: session.get(key, default))
    monkeypatch.setattr(app.cl.user_session, "set", lambda key, value: session.__setitem__(key, value))

    class FakeMessage:
        def __init__(self, **_kwargs):
            pass

        async def send(self):
            return None

    monkeypatch.setattr(app.cl, "Message", FakeMessage)

    asyncio.run(
        app.update_settings(
            {
                "model": "azure:luna",
                "reasoningEffort": "high",
                "toolRounds": 12,
                "toolResultCharacters": 48_000,
            }
        )
    )
    store = app.console_preferences_store(tmp_path)
    assert store.load("athlete-a") == SavedConsolePreferences(
        model_choice="azure:luna",
        reasoning_effort="high",
        tool_rounds=12,
        tool_result_characters=48_000,
    )

    asyncio.run(
        app.update_settings(
            {
                "model": "azure:terra",
                "reasoningEffort": "default",
                "toolRounds": 8,
                "toolResultCharacters": 24_000,
            }
        )
    )
    assert store.load("athlete-a") is None
