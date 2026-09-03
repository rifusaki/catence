import asyncio
import json
from types import SimpleNamespace

import pytest

from catence_console.config import (
    ConsoleConfigurationError,
    ProviderProfile,
    load_console_configuration,
    write_provider_setup,
)
from catence_console.app import _chat_settings, _configured_preferences, _limit_setting, _normalized_preferences, _session_settings
from catence_console.persistence import SavedConsolePreferences


def write_config(tmp_path, console):
    (tmp_path / "config.json").write_text(json.dumps({"console": console}), encoding="utf-8")


def test_loads_named_profiles_without_storing_values(tmp_path, monkeypatch):
    write_config(
        tmp_path,
        {
            "defaultProfile": "openai-compatible",
            "profiles": {
                "openai-compatible": {
                    "label": "OpenAI-compatible",
                    "model": "openai/catence",
                    "apiKeyEnv": "OPENAI_API_KEY",
                    "apiBaseEnv": "OPENAI_API_BASE",
                }
            },
        },
    )
    monkeypatch.setenv("OPENAI_API_KEY", "not-printed")
    monkeypatch.setenv("OPENAI_API_BASE", "https://example.test")

    configuration = load_console_configuration(tmp_path)

    assert configuration.default_profile == "openai-compatible"
    assert configuration.profile("openai-compatible").litellm_options() == {
        "model": "openai/catence",
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


def test_is_opencode_go_detects_profiles_wired_to_the_go_environment():
    assert ProviderProfile(
        id="opencode-go",
        label="OpenCode Go",
        model="openai/deepseek-v4-flash",
        api_key_env="OPENCODE_GO_API_KEY",
        api_base_env="OPENCODE_GO_API_BASE",
    ).is_opencode_go
    assert ProviderProfile(
        id="opencode-go-messages",
        label="OpenCode Go (Anthropic)",
        model="anthropic/minimax-m2.5",
        api_key_env="OPENCODE_GO_API_KEY",
        api_base_env="OPENCODE_GO_MESSAGES_API_BASE",
    ).is_opencode_go
    assert not ProviderProfile(
        id="openai",
        label="OpenAI",
        model="openai/o4-mini",
        api_key_env="OPENAI_API_KEY",
    ).is_opencode_go


def test_loads_multiple_models_and_a_default_reasoning_effort(tmp_path):
    write_config(
        tmp_path,
        {
            "defaultProfile": "openai-compatible",
            "profiles": {
                "openai-compatible": {
                    "models": {
                        "terra": {"model": "openai/gpt-5.6-terra"},
                        "luna": {"label": "Luna", "model": "openai/gpt-5.6-luna"},
                    },
                    "defaultModel": "luna",
                    "defaultReasoningEffort": "high",
                }
            },
        },
    )

    configuration = load_console_configuration(tmp_path)

    assert configuration.default_model_choice() == "openai-compatible:luna"
    assert configuration.model_choices() == {
        "openai-compatible · terra": "openai-compatible:terra",
        "openai-compatible · Luna": "openai-compatible:luna",
    }
    profile, model_id = configuration.selected_model("openai-compatible:terra")
    assert profile.litellm_options(model_id) == {"model": "openai/gpt-5.6-terra"}
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
    profile_id, model_id, reasoning_effort, tool_rounds, tool_result_characters, athlete_id = _session_settings(
        configuration, "athlete-a", {"athlete-a"}
    )

    assert (profile_id, model_id, reasoning_effort) == ("openai", "default", None)
    assert tool_rounds == configuration.limits.tool_rounds
    assert tool_result_characters == configuration.limits.tool_result_characters
    assert athlete_id == "athlete-a"


def test_persistent_preferences_are_normalized_and_settings_expose_configured_reset_values(tmp_path):
    write_config(
        tmp_path,
        {
            "defaultProfile": "openai-compatible",
            "limits": {"toolRounds": 8, "toolResultCharacters": 24_000},
            "profiles": {
                "openai-compatible": {
                    "models": {
                        "terra": {"model": "openai/gpt-5.6-terra"},
                        "luna": {"model": "openai/gpt-5.6-luna"},
                    },
                    "defaultModel": "terra",
                }
            },
        },
    )
    configuration = load_console_configuration(tmp_path)
    saved = SavedConsolePreferences(
        model_choice="openai-compatible:luna",
        reasoning_effort="high",
        tool_rounds=12,
        tool_result_characters=48_000,
    )

    normalized = _normalized_preferences(configuration, saved, "athlete-a", {"athlete-a"})

    assert normalized == SavedConsolePreferences(
        model_choice="openai-compatible:luna", reasoning_effort="high", tool_rounds=12, tool_result_characters=48_000, athlete_id="athlete-a"
    )
    assert _configured_preferences(configuration, "athlete-a") == SavedConsolePreferences(
        model_choice="openai-compatible:terra",
        reasoning_effort="default",
        tool_rounds=8,
        tool_result_characters=24_000,
        athlete_id="athlete-a",
    )
    settings = _chat_settings(
        configuration,
        model_choice=normalized.model_choice,
        reasoning_effort=normalized.reasoning_effort,
        tool_rounds=normalized.tool_rounds,
        tool_result_characters=normalized.tool_result_characters,
        athlete_id="athlete-a",
        athletes={"Athlete A": "athlete-a"},
        default_athlete_id="athlete-a",
    )
    values = {input["id"]: input for input in settings._inputs_as_dicts()}
    assert values["model"]["initial"] == "openai-compatible:luna"
    assert values["model"]["resetValue"] == "openai-compatible:terra"
    assert values["reasoningEffort"]["initial"] == "high"
    assert values["reasoningEffort"]["resetValue"] == "default"
    assert values["toolRounds"]["resetValue"] == 8
    assert values["toolResultCharacters"]["resetValue"] == 24_000


def test_confirming_custom_settings_persists_them_and_confirming_reset_clears_them(tmp_path, monkeypatch):
    write_config(
        tmp_path,
        {
            "defaultProfile": "openai-compatible",
            "limits": {"toolRounds": 8, "toolResultCharacters": 24_000},
            "profiles": {
                "openai-compatible": {
                    "models": {
                        "terra": {"model": "openai/gpt-5.6-terra"},
                        "luna": {"model": "openai/gpt-5.6-luna"},
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
    monkeypatch.setattr(app, "_athlete_roster", lambda: ("athlete-a", {"Athlete A": "athlete-a"}))

    class FakeMessage:
        def __init__(self, **_kwargs):
            pass

        async def send(self):
            return None

    monkeypatch.setattr(app.cl, "Message", FakeMessage)

    refreshes: list[dict] = []

    class FakeChatSettings:
        def __init__(self, inputs):
            self.inputs = inputs

        async def refresh(self):
            refreshes.append({input_.id: input_ for input_ in self.inputs})

    monkeypatch.setattr(app.cl, "ChatSettings", FakeChatSettings)

    asyncio.run(
        app.update_settings(
            {
                "model": "openai-compatible:luna",
                "reasoningEffort": "high",
                "toolRounds": 12,
                "toolResultCharacters": 48_000,
            }
        )
    )
    store = app.console_preferences_store(tmp_path)
    assert store.load("athlete-a") == SavedConsolePreferences(
        model_choice="openai-compatible:luna",
        reasoning_effort="high",
        tool_rounds=12,
        tool_result_characters=48_000,
        athlete_id="athlete-a",
    )
    assert len(refreshes) == 1
    assert refreshes[0]["reasoningEffort"].disabled is False
    assert refreshes[0]["model"].initial_value == "openai-compatible:luna"

    asyncio.run(
        app.update_settings(
            {
                "model": "openai-compatible:terra",
                "reasoningEffort": "default",
                "toolRounds": 8,
                "toolResultCharacters": 24_000,
            }
        )
    )
    assert store.load("athlete-a") is None
    assert len(refreshes) == 2
    assert refreshes[1]["model"].initial_value == "openai-compatible:terra"


def test_model_variants_map_dropdown_labels_to_reasoning_effort_values(tmp_path):
    write_config(
        tmp_path,
        {
            "defaultProfile": "opencode-go",
            "profiles": {
                "opencode-go": {
                    "models": {
                        "deepseek-v4-flash": {
                            "label": "DeepSeek V4 Flash",
                            "model": "openai/deepseek-v4-flash",
                            "variants": {"High": "high", "Max": "max"},
                        }
                    },
                    "defaultModel": "deepseek-v4-flash",
                }
            },
        },
    )

    configuration = load_console_configuration(tmp_path)
    profile, model_id = configuration.selected_model("opencode-go:deepseek-v4-flash")
    model = profile.model_option(model_id)

    assert model.variants == {"High": "high", "Max": "max"}
    assert profile.reasoning_effort_choices(model_id) == {"High": "high", "Max": "max"}
    assert profile.valid_reasoning_effort(model_id) == {"high", "max", "default"}


def test_model_variants_reach_the_chat_settings_dropdown(tmp_path):
    write_config(
        tmp_path,
        {
            "defaultProfile": "opencode-go",
            "profiles": {
                "opencode-go": {
                    "models": {
                        "deepseek-v4-flash": {
                            "label": "DeepSeek V4 Flash",
                            "model": "openai/deepseek-v4-flash",
                            "variants": {"High": "high", "Max": "max"},
                        }
                    },
                    "defaultModel": "deepseek-v4-flash",
                }
            },
        },
    )
    configuration = load_console_configuration(tmp_path)
    settings = _chat_settings(
        configuration,
        model_choice="opencode-go:deepseek-v4-flash",
        reasoning_effort="high",
        tool_rounds=8,
        tool_result_characters=24_000,
        athlete_id="athlete-a",
        athletes={"Athlete A": "athlete-a"},
        default_athlete_id="athlete-a",
    )
    values = {input["id"]: input for input in settings._inputs_as_dicts()}
    effort = values["reasoningEffort"]
    assert effort["items"] == [
        {"label": "Provider default", "value": "default"},
        {"label": "High", "value": "high"},
        {"label": "Max", "value": "max"},
    ]
    assert effort["initial"] == "high"


def test_empty_variants_disable_reasoning_effort_for_a_model(tmp_path):
    write_config(
        tmp_path,
        {
            "defaultProfile": "opencode-go",
            "profiles": {
                "opencode-go": {
                    "models": {
                        "mimo-v2.5": {
                            "label": "MiMo V2.5",
                            "model": "openai/mimo-v2.5",
                            "variants": {},
                        }
                    },
                    "defaultModel": "mimo-v2.5",
                }
            },
        },
    )

    configuration = load_console_configuration(tmp_path)
    profile, model_id = configuration.selected_model("opencode-go:mimo-v2.5")
    model = profile.model_option(model_id)

    assert model.reasoning_effort_disabled is True
    assert profile.reasoning_effort_choices(model_id) == {}
    assert profile.valid_reasoning_effort(model_id) == {"default"}
    assert profile.litellm_options(model_id) == {"model": "openai/mimo-v2.5"}


def test_rejects_fixed_reasoning_effort_combined_with_empty_variants(tmp_path):
    write_config(
        tmp_path,
        {
            "profiles": {
                "opencode-go": {
                    "models": {
                        "mimo-v2.5": {
                            "label": "MiMo V2.5",
                            "model": "openai/mimo-v2.5",
                            "reasoningEffort": "high",
                            "variants": {},
                        }
                    },
                }
            },
        },
    )

    with pytest.raises(ConsoleConfigurationError, match="empty variants"):
        load_console_configuration(tmp_path)


def test_disabled_reasoning_effort_disables_the_dropdown(tmp_path):
    write_config(
        tmp_path,
        {
            "defaultProfile": "opencode-go",
            "profiles": {
                "opencode-go": {
                    "models": {
                        "mimo-v2.5": {
                            "label": "MiMo V2.5",
                            "model": "openai/mimo-v2.5",
                            "variants": {},
                        }
                    },
                    "defaultModel": "mimo-v2.5",
                }
            },
        },
    )
    configuration = load_console_configuration(tmp_path)
    settings = _chat_settings(
        configuration,
        model_choice="opencode-go:mimo-v2.5",
        reasoning_effort=None,
        tool_rounds=8,
        tool_result_characters=24_000,
        athlete_id="athlete-a",
        athletes={"Athlete A": "athlete-a"},
        default_athlete_id="athlete-a",
    )
    values = {input["id"]: input for input in settings._inputs_as_dicts()}
    effort = values["reasoningEffort"]
    assert effort["disabled"] is True
    assert effort["items"] == [{"label": "Provider default", "value": "default"}]
    assert effort["initial"] == "default"


def test_session_settings_validate_reasoning_effort_against_model_variants(tmp_path, monkeypatch):
    write_config(
        tmp_path,
        {
            "defaultProfile": "opencode-go",
            "profiles": {
                "opencode-go": {
                    "models": {
                        "deepseek-v4-flash": {
                            "label": "DeepSeek V4 Flash",
                            "model": "openai/deepseek-v4-flash",
                            "variants": {"High": "high", "Max": "max"},
                        }
                    },
                    "defaultModel": "deepseek-v4-flash",
                }
            },
        },
    )
    configuration = load_console_configuration(tmp_path)

    from catence_console import app

    monkeypatch.setattr(app.cl.user_session, "get", lambda key: "opencode-go:deepseek-v4-flash" if key == "catence_model" else "high")
    _, _, reasoning_effort, _, _, _ = _session_settings(configuration, "athlete-a", {"athlete-a"})
    assert reasoning_effort == "high"

    monkeypatch.setattr(app.cl.user_session, "get", lambda key: "opencode-go:deepseek-v4-flash" if key == "catence_model" else "minimal")
    _, _, reasoning_effort, _, _, _ = _session_settings(configuration, "athlete-a", {"athlete-a"})
    assert reasoning_effort is None


@pytest.mark.parametrize(
    "variants",
    [
        {"High": ""},
        {"High": 3},
        {"High": None},
    ],
)
def test_rejects_invalid_model_variants(tmp_path, variants):
    write_config(
        tmp_path,
        {
            "profiles": {
                "opencode-go": {
                    "models": {
                        "deepseek-v4-flash": {
                            "model": "openai/deepseek-v4-flash",
                            "variants": variants,
                        }
                    }
                }
            },
        },
    )

    with pytest.raises(ConsoleConfigurationError, match="variants"):
        load_console_configuration(tmp_path)
