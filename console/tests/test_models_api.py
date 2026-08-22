import json
from pathlib import Path

import pytest
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
