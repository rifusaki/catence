import copy
import json

import pytest

from catence_console import app
from catence_console.config import parse_console_configuration

CONFIG = {
    "console": {
        "defaultProfile": "local",
        "profiles": {
            "local": {
                "label": "Local",
                "defaultModel": "gpt-5",
                "apiKeyEnv": "OPENAI_API_KEY",
                "models": {
                    "gpt-5": {"label": "GPT-5", "model": "openai/gpt-5"},
                    "o4-mini": {"label": "o4 mini", "model": "openai/o4-mini", "variants": {}},
                    "mimo": {"label": "MiMo", "model": "openai/mimo", "variants": {"Default": "default", "Max": "max"}},
                },
            }
        },
    }
}


@pytest.fixture()
def configuration(tmp_path):
    (tmp_path / "config.json").write_text(json.dumps(CONFIG), encoding="utf-8")
    return parse_console_configuration(json.loads(json.dumps(CONFIG)))


def _case(configuration, model_id):
    options = app._effort_dynamic_options(configuration)
    assert options is not None
    assert options["watchId"] == "model"
    choice = f"local:{model_id}"
    assert choice in options["cases"], f"missing dynamic case for {choice}"
    return options["cases"][choice]


def test_effort_cases_cover_every_enabled_model(configuration):
    options = app._effort_dynamic_options(configuration)
    choices = set(app._available_model_choices(configuration).values())
    assert set(options["cases"]) == choices


def test_standard_model_gets_openai_levels_and_default_initial(configuration):
    case = _case(configuration, "gpt-5")
    assert case["items"] == {
        "Provider default": "default",
        "minimal": "minimal",
        "low": "low",
        "medium": "medium",
        "high": "high",
        "xhigh": "xhigh",
    }
    assert case["disabled"] is False
    assert case["initialValue"] == "default"


def test_variants_map_replaces_the_standard_levels(configuration):
    case = _case(configuration, "mimo")
    assert case["items"] == {"Provider default": "default", "Default": "default", "Max": "max"}
    assert "minimal" not in case["items"]


def test_models_without_effort_are_marked_disabled(configuration):
    # Matches the static panel: only the sentinel remains, and the select is
    # rendered disabled so the provider default is always used.
    case = _case(configuration, "o4-mini")
    assert case["items"] == {"Provider default": "default"}
    assert case["disabled"] is True


def test_disabled_models_get_no_case(configuration, tmp_path, monkeypatch):
    monkeypatch.setattr(app, "DATA_DIRECTORY", tmp_path)
    extended = copy.deepcopy(CONFIG)
    extended["console"]["profiles"]["local"]["models"]["extra"] = {"label": "Extra", "model": "openai/extra"}
    (tmp_path / "config.json").write_text(json.dumps(extended), encoding="utf-8")
    configuration = parse_console_configuration(json.loads((tmp_path / "config.json").read_text(encoding="utf-8")))
    app.disabled_models_store(tmp_path).add("local", "extra")

    options = app._effort_dynamic_options(configuration)
    assert options is not None
    assert "local:extra" not in options["cases"]
    assert set(options["cases"]) == set(app._available_model_choices(configuration).values())


def test_vanished_profiles_are_skipped_instead_of_crashing(monkeypatch, configuration):
    from catence_console.config import ConsoleConfigurationError

    original_profile = type(configuration).profile

    def flaky(self, profile_id):
        if profile_id == "local":
            raise ConsoleConfigurationError("gone")
        return original_profile(self, profile_id)

    monkeypatch.setattr(type(configuration), "profile", flaky)
    assert app._effort_dynamic_options(configuration) is None
