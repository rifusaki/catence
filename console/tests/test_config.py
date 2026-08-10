import json

import pytest

from catence_console.config import ConsoleConfigurationError, load_console_configuration


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
