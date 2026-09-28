"""Tests for the runtime-managed Console tool-server credential store."""

import json
import os
import stat

import pytest

from catence_console.tool_server_secrets import (
    TOOL_SERVER_SECRETS_FORMAT_VERSION,
    ToolServerSecretValidationError,
    ToolServerSecretsStoreError,
    clear_tool_server_secret,
    default_tool_server_secrets_path,
    load_tool_server_secrets,
    save_tool_server_secrets,
    set_tool_server_secret,
)


def test_default_path_lives_under_the_console_directory(tmp_path):
    assert default_tool_server_secrets_path(tmp_path) == tmp_path / "console" / "tool_server_secrets.json"


def test_missing_store_is_empty(tmp_path):
    assert load_tool_server_secrets(default_tool_server_secrets_path(tmp_path)) == {}


def test_set_round_trips_and_clear_removes(tmp_path):
    path = default_tool_server_secrets_path(tmp_path)

    assert set_tool_server_secret(path, "EXA_API_KEY", "exa-secret") == {"EXA_API_KEY": "exa-secret"}
    assert set_tool_server_secret(path, "TAVILY_API_KEY", "tavily-secret") == {
        "EXA_API_KEY": "exa-secret",
        "TAVILY_API_KEY": "tavily-secret",
    }
    assert load_tool_server_secrets(path) == {
        "EXA_API_KEY": "exa-secret",
        "TAVILY_API_KEY": "tavily-secret",
    }

    assert clear_tool_server_secret(path, "EXA_API_KEY") == {"TAVILY_API_KEY": "tavily-secret"}
    assert load_tool_server_secrets(path) == {"TAVILY_API_KEY": "tavily-secret"}
    # Clearing a credential that is not stored is a no-op, not an error.
    assert clear_tool_server_secret(path, "MISSING_KEY") == {"TAVILY_API_KEY": "tavily-secret"}


def test_store_keeps_a_private_payload_on_disk(tmp_path):
    path = default_tool_server_secrets_path(tmp_path)
    set_tool_server_secret(path, "EXA_API_KEY", "exa-secret")

    payload = json.loads(path.read_text(encoding="utf-8"))
    assert payload == {
        "formatVersion": TOOL_SERVER_SECRETS_FORMAT_VERSION,
        "secrets": {"EXA_API_KEY": "exa-secret"},
    }
    assert stat.S_IMODE(os.stat(path.parent).st_mode) == 0o700
    assert stat.S_IMODE(os.stat(path).st_mode) == 0o600


@pytest.mark.parametrize("name", ["", "1KEY", "with space", "lower-case", "a" * 129])
def test_invalid_names_are_rejected(tmp_path, name):
    with pytest.raises(ToolServerSecretValidationError):
        set_tool_server_secret(default_tool_server_secrets_path(tmp_path), name, "value")


@pytest.mark.parametrize("value", ["", 7, None])
def test_invalid_values_are_rejected(tmp_path, value):
    with pytest.raises(ToolServerSecretValidationError):
        set_tool_server_secret(
            default_tool_server_secrets_path(tmp_path),
            "EXA_API_KEY",
            value,  # type: ignore[arg-type]
        )


def test_oversized_values_are_rejected(tmp_path):
    with pytest.raises(ToolServerSecretValidationError):
        set_tool_server_secret(default_tool_server_secrets_path(tmp_path), "EXA_API_KEY", "x" * 8_193)


def test_save_validates_every_entry(tmp_path):
    with pytest.raises(ToolServerSecretValidationError):
        save_tool_server_secrets(
            default_tool_server_secrets_path(tmp_path),
            {"EXA_API_KEY": "ok", "BAD NAME": "no"},
        )


@pytest.mark.parametrize(
    "payload",
    [
        "[]",
        '{"formatVersion": 1, "secrets": {}, "extra": true}',
        '{"formatVersion": 2, "secrets": {}}',
        '{"formatVersion": true, "secrets": {}}',
        '{"formatVersion": 1}',
        '{"formatVersion": 1, "secrets": []}',
        '{"formatVersion": 1, "secrets": {"BAD NAME": "value"}}',
        '{"formatVersion": 1, "secrets": {"EXA_API_KEY": ""}}',
    ],
)
def test_malformed_stores_fail_closed(tmp_path, payload):
    path = tmp_path / "console" / "tool_server_secrets.json"
    path.parent.mkdir(parents=True)
    path.write_text(payload, encoding="utf-8")

    with pytest.raises(ToolServerSecretsStoreError):
        load_tool_server_secrets(path)


def test_invalid_json_fails_closed(tmp_path):
    path = tmp_path / "console" / "tool_server_secrets.json"
    path.parent.mkdir(parents=True)
    path.write_text("{not json", encoding="utf-8")

    with pytest.raises(ToolServerSecretsStoreError):
        load_tool_server_secrets(path)
