import json
from pathlib import Path

import pytest
from fastapi.responses import JSONResponse
from fastapi.testclient import TestClient

from catence_console import app
from catence_console.config import ConsoleConfigurationError, parse_console_configuration
from catence_console.config_io import read_config_root, write_console_section
from catence_console.persistence import disabled_models_store

CONFIG = {
    "mcp": {"rateLimits": {"server": {"requests": 5, "windowSeconds": 10}}},
    "console": {
        "defaultProfile": "openai",
        "limits": {"toolRounds": 12},
        "profiles": {
            "openai": {
                "label": "OpenAI",
                "defaultModel": "gpt-5-mini",
                "apiKeyEnv": "OPENAI_API_KEY",
                "models": {
                    "gpt-5-mini": {"label": "GPT-5 mini", "model": "openai/gpt-5-mini"},
                    "o4-mini": {"label": "o4 mini", "model": "openai/o4-mini", "variants": {}},
                },
            }
        },
    },
}


@pytest.fixture()
def data_directory(tmp_path: Path) -> Path:
    (tmp_path / "config.json").write_text(json.dumps(CONFIG), encoding="utf-8")
    return tmp_path


def test_write_console_section_preserves_unrelated_sections(data_directory: Path):
    def rename_label(console: dict) -> None:
        console["profiles"]["openai"]["models"]["gpt-5-mini"]["label"] = "Renamed"

    configuration = write_console_section(data_directory, rename_label)

    assert configuration.profile("openai").model_option("gpt-5-mini").label == "Renamed"
    root = read_config_root(data_directory)
    assert "mcp" in root
    assert root["console"]["limits"] == {"toolRounds": 12}
    assert root["console"]["defaultProfile"] == "openai"


def test_write_console_section_rejects_invalid_mutations_without_touching_disk(data_directory: Path):
    before = (data_directory / "config.json").read_text(encoding="utf-8")

    def break_it(console: dict) -> None:
        console["nonsenseField"] = True

    with pytest.raises(ConsoleConfigurationError):
        write_console_section(data_directory, break_it)

    assert (data_directory / "config.json").read_text(encoding="utf-8") == before


def test_disabled_models_store_roundtrip(tmp_path: Path):
    store = disabled_models_store(tmp_path)
    assert store.list() == set()
    store.add("openai", "o4-mini")
    store.add("openai", "o4-mini")  # idempotent
    assert store.list() == {("openai", "o4-mini")}
    store.remove("openai", "o4-mini")
    assert store.list() == set()


@pytest.fixture()
def client(monkeypatch, data_directory: Path) -> TestClient:
    monkeypatch.setattr(app, "DATA_DIRECTORY", data_directory)
    monkeypatch.setattr(app, "_authenticated", lambda request: True)
    return TestClient(app.chainlit_server)


def test_models_endpoints_require_login():
    response = TestClient(app.chainlit_server).get("/api/v1/models")
    assert response.status_code == 401


def test_models_overview_lists_profiles_with_environment_readiness(client: TestClient):
    response = client.get("/api/v1/models")
    assert response.status_code == 200
    payload = response.json()
    profile = payload["profiles"][0]
    assert payload["defaultProfile"] == "openai"
    assert profile["id"] == "openai"
    assert [model["id"] for model in profile["models"]] == ["gpt-5-mini", "o4-mini"]
    assert profile["requiredEnvironment"] == ["OPENAI_API_KEY"]
    assert isinstance(profile["missingEnvironment"], list)


def test_toggle_disables_a_model_but_never_the_last_enabled_one(client: TestClient, data_directory: Path):
    response = client.post("/api/v1/models/toggle", json={"profileId": "openai", "modelId": "o4-mini", "disabled": True})
    assert response.status_code == 200
    models = {model["id"]: model for model in response.json()["profiles"][0]["models"]}
    assert models["o4-mini"]["disabled"] is True
    assert models["gpt-5-mini"]["disabled"] is False

    # Disabling the only remaining enabled model must fail cleanly.
    refused = client.post("/api/v1/models/toggle", json={"profileId": "openai", "modelId": "gpt-5-mini", "disabled": True})
    assert refused.status_code == 400
    assert "only enabled model" in refused.json()["error"]["message"]

    reenabled = client.post("/api/v1/models/toggle", json={"profileId": "openai", "modelId": "o4-mini", "disabled": False})
    assert reenabled.status_code == 200
    assert all(not model["disabled"] for model in reenabled.json()["profiles"][0]["models"])

    # Disabled state lives in sqlite; config.json is untouched by toggles.
    assert "disabled" not in (data_directory / "config.json").read_text(encoding="utf-8")


def test_add_and_remove_custom_model_variants(client: TestClient, data_directory: Path):
    added = client.post(
        "/api/v1/models/add",
        json={
            "profileId": "openai",
            "modelId": "custom-deployment",
            "label": "Custom deployment",
            "model": "openai/my-private-deployment",
            "variants": {"Default": "default", "High": "high"},
        },
    )
    assert added.status_code == 200
    models = {model["id"]: model for model in added.json()["profiles"][0]["models"]}
    assert models["custom-deployment"]["model"] == "openai/my-private-deployment"

    # The written file must satisfy the strict startup parser and keep secrets out.
    root = json.loads((data_directory / "config.json").read_text(encoding="utf-8"))
    parsed = parse_console_configuration(root)
    assert parsed.profile("openai").model_option("custom-deployment").model == "openai/my-private-deployment"

    duplicate = client.post(
        "/api/v1/models/add",
        json={"profileId": "openai", "modelId": "custom-deployment", "label": "x", "model": "openai/y"},
    )
    assert duplicate.status_code == 400

    removed = client.post("/api/v1/models/remove", json={"profileId": "openai", "modelId": "custom-deployment"})
    assert removed.status_code == 200
    assert "custom-deployment" not in {model["id"] for model in removed.json()["profiles"][0]["models"]}

    # Removing models one by one must stop at the last one.
    assert client.post("/api/v1/models/remove", json={"profileId": "openai", "modelId": "gpt-5-mini"}).status_code == 200
    last_model_refused = client.post("/api/v1/models/remove", json={"profileId": "openai", "modelId": "o4-mini"})
    assert last_model_refused.status_code == 400
    assert "last model" in last_model_refused.json()["error"]["message"]


def test_remove_reassigns_profile_default_model(client: TestClient):
    client.post(
        "/api/v1/models/add",
        json={"profileId": "openai", "modelId": "temp-model", "label": "Temp", "model": "openai/temp"},
    )
    response = client.post("/api/v1/models/remove", json={"profileId": "openai", "modelId": "gpt-5-mini"})
    assert response.status_code == 200
    profile = response.json()["profiles"][0]
    assert profile["defaultModel"] != "gpt-5-mini"
    assert profile["defaultModel"] in {model["id"] for model in profile["models"]}


def test_default_endpoint_updates_profile_default(client: TestClient):
    response = client.post("/api/v1/models/default", json={"profileId": "openai", "modelId": "o4-mini"})
    assert response.status_code == 200
    assert response.json()["profiles"][0]["defaultModel"] == "o4-mini"

    unknown = client.post("/api/v1/models/default", json={"profileId": "openai", "modelId": "does-not-exist"})
    assert unknown.status_code == 400


def test_update_attaches_variants_to_an_existing_model(client: TestClient, data_directory: Path):
    response = client.post(
        "/api/v1/models/update",
        json={
            "profileId": "openai",
            "modelId": "gpt-5-mini",
            "variants": {"Default": "default", "Thinking": "high"},
        },
    )
    assert response.status_code == 200
    model = next(model for model in response.json()["profiles"][0]["models"] if model["id"] == "gpt-5-mini")
    assert model["variants"] == {"Default": "default", "Thinking": "high"}
    # The written config keeps unrelated sections intact.
    assert "mcp" in read_config_root(data_directory)

    persisted = parse_console_configuration(read_config_root(data_directory))
    assert persisted.profile("openai").model_option("gpt-5-mini").variants == {"Default": "default", "Thinking": "high"}


def test_update_clears_fields_with_null_and_relabels(client: TestClient):
    added = client.post(
        "/api/v1/models/add",
        json={
            "profileId": "openai",
            "modelId": "temp-model",
            "label": "Temp",
            "model": "openai/temp",
            "reasoningEffort": "low",
        },
    )
    assert added.status_code == 200
    cleared = client.post(
        "/api/v1/models/update",
        json={"profileId": "openai", "modelId": "temp-model", "reasoningEffort": None, "label": "Renamed"},
    )
    assert cleared.status_code == 200
    model = next(model for model in cleared.json()["profiles"][0]["models"] if model["id"] == "temp-model")
    assert model["reasoningEffort"] is None
    assert model["label"] == "Renamed"


def test_update_rejects_invalid_edits(client: TestClient, data_directory: Path):
    conflicting = client.post(
        "/api/v1/models/update",
        json={"profileId": "openai", "modelId": "o4-mini", "reasoningEffort": "high"},
    )
    # o4-mini declares empty variants (effort disabled); a fixed effort cannot combine.
    assert conflicting.status_code == 400

    unknown = client.post("/api/v1/models/update", json={"profileId": "openai", "modelId": "ghost", "label": "X"})
    assert unknown.status_code == 400

    cleared_routing = client.post(
        "/api/v1/models/update", json={"profileId": "openai", "modelId": "gpt-5-mini", "model": None}
    )
    assert cleared_routing.status_code == 400
    # Nothing above may have touched the file.
    assert parse_console_configuration(read_config_root(data_directory)).profile("openai").default_model == "gpt-5-mini"


def test_discover_endpoint_requires_login():
    response = TestClient(app.chainlit_server).post("/api/v1/models/discover", json={})
    assert response.status_code == 401


def test_discover_endpoint_still_reaches_the_runtime_proxy(client, monkeypatch):
    captured = {}

    async def fake_proxy(request):
        captured["called"] = True
        return JSONResponse({"counts": {"chat": 0, "responses": 0, "messages": 0}})

    monkeypatch.setattr(app, "discover_models_proxy", fake_proxy)
    response = client.post("/api/v1/models/discover", json={})
    assert response.status_code == 200
    assert captured.get("called") is True


def test_hide_and_unhide_a_profile_without_touching_config(client: TestClient, data_directory: Path):
    before = (data_directory / "config.json").read_text(encoding="utf-8")

    hidden = client.post("/api/v1/models/hide", json={"profileId": "openai", "hidden": True})
    assert hidden.status_code == 200
    assert hidden.json()["profiles"][0]["hidden"] is True

    # Hiding is per-user UI state in sqlite; shared config stays byte-identical.
    assert (data_directory / "config.json").read_text(encoding="utf-8") == before

    unhidden = client.post("/api/v1/models/hide", json={"profileId": "openai", "hidden": False})
    assert unhidden.status_code == 200
    assert unhidden.json()["profiles"][0]["hidden"] is False


def test_hide_rejects_unknown_profiles_and_non_boolean_flags(client: TestClient):
    unknown = client.post("/api/v1/models/hide", json={"profileId": "ghost", "hidden": True})
    assert unknown.status_code == 400
    assert "Unknown Console profile" in unknown.json()["error"]["message"]

    malformed = client.post("/api/v1/models/hide", json={"profileId": "openai", "hidden": "yes"})
    assert malformed.status_code == 400
    assert "hidden must be a boolean" in malformed.json()["error"]["message"]


def test_hidden_profile_leaves_the_chat_dropdown_but_never_empties_it(client: TestClient):
    configuration = app._configuration()

    available = app._available_model_choices(configuration)
    assert any(value.startswith("openai:") for value in available.values())

    assert client.post("/api/v1/models/hide", json={"profileId": "openai", "hidden": True}).status_code == 200

    # The profile is gone from the dropdown...
    assert app._choice_available(configuration, "openai:gpt-5-mini") is False
    # ...but hiding the only configured profile must not empty the dropdown.
    fallback = app._available_model_choices(configuration)
    assert any(value.startswith("openai:") for value in fallback.values())

    assert client.post("/api/v1/models/hide", json={"profileId": "openai", "hidden": False}).status_code == 200
    assert app._choice_available(configuration, "openai:gpt-5-mini") is True


LEGACY_CONFIG = {
    "mcp": {"rateLimits": {"server": {"requests": 5, "windowSeconds": 10}}},
    "console": {
        "defaultProfile": "openai",
        "limits": {"toolRounds": 12},
        "profiles": {
            # Scalar-model layout as shipped by early config.example.json seeds.
            "openai": {
                "label": "OpenAI",
                "model": "openai/gpt-5-mini",
                "apiKeyEnv": "OPENAI_API_KEY",
            },
            "anthropic": {
                "model": "anthropic/claude-sonnet-4-5",
                "apiKeyEnv": "ANTHROPIC_API_KEY",
            },
        },
    },
}


@pytest.fixture()
def legacy_data_directory(tmp_path: Path) -> Path:
    (tmp_path / "config.json").write_text(json.dumps(LEGACY_CONFIG), encoding="utf-8")
    return tmp_path


@pytest.fixture()
def legacy_client(monkeypatch, legacy_data_directory: Path) -> TestClient:
    monkeypatch.setattr(app, "DATA_DIRECTORY", legacy_data_directory)
    monkeypatch.setattr(app, "_authenticated", lambda request: True)
    return TestClient(app.chainlit_server)


def test_remove_on_legacy_scalar_model_profile_is_supported(legacy_client: TestClient, legacy_data_directory: Path):
    """A scalar-model profile must not fail with 'unsupported layout'.

    The first mutation migrates it to the ``models`` map; afterwards the normal
    rules apply (the last remaining model cannot be removed).
    """

    only_model = legacy_client.post("/api/v1/models/remove", json={"profileId": "anthropic", "modelId": "default"})
    # The migration worked; the request now hits the regular single-model guard.
    assert only_model.status_code == 400
    assert "unsupported layout" not in only_model.json()["error"]["message"]
    assert "last model" in only_model.json()["error"]["message"]

    added = legacy_client.post(
        "/api/v1/models/add",
        json={"profileId": "anthropic", "modelId": "haiku", "label": "Haiku", "model": "anthropic/claude-haiku"},
    )
    assert added.status_code == 200

    removed = legacy_client.post("/api/v1/models/remove", json={"profileId": "anthropic", "modelId": "default"})
    assert removed.status_code == 200
    profile = next(p for p in removed.json()["profiles"] if p["id"] == "anthropic")
    assert [model["id"] for model in profile["models"]] == ["haiku"]
    assert profile["defaultModel"] == "haiku"

    root = json.loads((legacy_data_directory / "config.json").read_text(encoding="utf-8"))
    anthropic = root["console"]["profiles"]["anthropic"]
    assert anthropic["models"] == {"haiku": {"label": "Haiku", "model": "anthropic/claude-haiku"}}
    assert "model" not in anthropic
    assert anthropic["apiKeyEnv"] == "ANTHROPIC_API_KEY"
    # The strict startup parser accepts the migrated file.
    parse_console_configuration(root)


def test_update_and_add_work_on_legacy_profiles_after_migration(legacy_client: TestClient, legacy_data_directory: Path):
    relabeled = legacy_client.post(
        "/api/v1/models/update",
        json={"profileId": "openai", "modelId": "default", "label": "GPT-5 mini"},
    )
    assert relabeled.status_code == 200

    added = legacy_client.post(
        "/api/v1/models/add",
        json={"profileId": "openai", "modelId": "o4-mini", "label": "o4 mini", "model": "openai/o4-mini"},
    )
    assert added.status_code == 200
    models = {model["id"]: model for model in added.json()["profiles"][0]["models"]}
    assert models["default"]["label"] == "GPT-5 mini"
    assert models["default"]["model"] == "openai/gpt-5-mini"

    root = json.loads((legacy_data_directory / "config.json").read_text(encoding="utf-8"))
    openai_profile = root["console"]["profiles"]["openai"]
    assert openai_profile["models"] == {
        "default": {"label": "GPT-5 mini", "model": "openai/gpt-5-mini"},
        "o4-mini": {"label": "o4 mini", "model": "openai/o4-mini"},
    }
    # The migrated file must satisfy the strict startup parser.
    parsed = parse_console_configuration(root)
    assert parsed.profile("openai").model_option("default").model == "openai/gpt-5-mini"


def test_legacy_label_is_preserved_in_the_models_map(legacy_client: TestClient):
    """The tolerant readers showed a legacy profile's model under the profile label."""

    response = legacy_client.get("/api/v1/models")
    assert response.status_code == 200
    profiles = {profile["id"]: profile for profile in response.json()["profiles"]}
    # Explicit label wins; an unlabeled legacy profile falls back to its id.
    assert profiles["openai"]["models"][0]["label"] == "OpenAI"
    assert profiles["anthropic"]["models"][0]["label"] == "anthropic"
