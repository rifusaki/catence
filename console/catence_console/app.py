"""Chainlit callbacks for Catence Console."""

from __future__ import annotations

import logging
import os
import asyncio
import json
import urllib.error
import urllib.request
from datetime import UTC, datetime
from pathlib import Path
from typing import Any, TypeGuard
from urllib.parse import parse_qsl, urlencode

import chainlit as cl
from chainlit.auth.cookie import get_token_from_cookies
from chainlit.auth.jwt import decode_jwt
from chainlit.input_widget import NumberInput, Select
from chainlit.server import app as chainlit_server
from fastapi import Request
from fastapi.responses import JSONResponse, Response

from catence_console import auth as _auth  # Registers Chainlit's password callback.
from catence_console.accounts import (
    ALL_ATHLETES,
    AccountExistsError,
    AccountNotFoundError,
    AccountValidationError,
    AccountsStoreError,
    ConsoleAccount,
    account_can_access,
    add_account,
    env_account,
    load_accounts,
    remove_account,
    update_account,
)
from catence_console.agent import describe_model_failure, respond
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
from catence_console.config_io import read_config_root, write_console_section
from catence_console.generation_sidecar import finish_generation_sidecar
from catence_console.persistence import (
    SavedConsolePreferences,
    console_preferences_store,
    disabled_models_store,
    hidden_profiles_store,
    local_data_layer,
    tool_call_store,
)

DATA_DIRECTORY = Path(os.environ.get("CATENCE_HOME", str(Path.home() / ".catence"))).expanduser().resolve()
MCP_URL = os.environ.get("CATENCE_MCP_URL", "http://127.0.0.1:8787/mcp")
logger = logging.getLogger(__name__)

# Detached generation tasks, keyed by thread id. A turn runs here (not bound to
# the websocket session) so a page refresh or disconnect cannot abort it; the
# answer is persisted to the data layer and recovered when the thread reloads.
_ACTIVE_GENERATIONS: dict[str, "asyncio.Task[None]"] = {}


def _mcp_http_url(path: str) -> str:
    return f"{MCP_URL.rsplit('/mcp', 1)[0].rstrip('/')}{path}"


NOTICE_METADATA = {"catenceNotice": True}

NO_ATHLETE_ACCESS_NOTICE = "You don't have access to any athlete yet. Ask an administrator to grant you access."


def _notice(content: str) -> cl.Message:
    """A Console-generated message that must never enter the model prompt."""
    return cl.Message(content=content, metadata=dict(NOTICE_METADATA))


def _model_history() -> list[dict[str, Any]]:
    """chat_context as provider messages, excluding Console notices.

    Readiness and setup-wizard messages describe the Console itself; keeping
    them out of ``to_openai``-shaped history stops them from polluting every
    later model turn.
    """

    messages: list[dict[str, Any]] = []
    for message in cl.chat_context.get():
        if isinstance(message.metadata, dict) and message.metadata.get("catenceNotice"):
            continue
        if message.type == "assistant_message":
            role = "assistant"
        elif message.type == "user_message":
            role = "user"
        else:
            role = "system"
        messages.append({"role": role, "content": message.content})
    return messages


def resolve_account(identifier: str) -> ConsoleAccount | None:
    """The Console account behind a session identifier, if any.

    Stored accounts win, then the environment break-glass admin, then the
    ``CHAINLIT_LOCAL_USER`` development identity (an implicit admin so local
    development needs no accounts.json). ``None`` means the identifier belongs
    to no account, and the request must not be trusted.
    """

    try:
        stored = load_accounts(_auth.accounts_path())
    except AccountsStoreError as error:
        # Mirror login: an unusable store disables store logins only.
        logger.warning("Ignoring unusable Console accounts store: %s", error)
        stored = []
    account = next((account for account in stored if account.username == identifier), None)
    if account is not None:
        return account
    break_glass = env_account()
    if break_glass is not None and break_glass.username == identifier:
        return break_glass
    if identifier and identifier == os.environ.get("CHAINLIT_LOCAL_USER"):
        return ConsoleAccount(
            username=identifier,
            password_hash="",  # The development identity never verifies a password.
            role="admin",
            athletes=ALL_ATHLETES,
            created_at=datetime.now(UTC).isoformat(),
        )
    return None


def _request_identity(request: Request) -> ConsoleAccount | None:
    """The account behind the request's session cookie, or None when it does not resolve."""

    token = get_token_from_cookies(request.cookies)
    if not token:
        return None
    try:
        user = decode_jwt(token)
    except Exception:
        return None
    identifier = getattr(user, "identifier", None)
    if not isinstance(identifier, str) or not identifier:
        return None
    return resolve_account(identifier)


def _authenticated(request: Request) -> bool:
    return _request_identity(request) is not None


def account_sees_all_athletes(account: ConsoleAccount | None) -> bool:
    """True when the account is not narrowed to an athlete grant list."""

    return account is None or account.role == "admin" or account.athletes == ALL_ATHLETES


def athlete_scope(account: ConsoleAccount, requested: str | None) -> tuple[bool, str | None]:
    """Resolve an athlete-scoped request against the account's grants.

    Returns ``(allowed, athlete_id)``. Admins and members holding ``"all"``
    pass through unchanged, so the id repeats the request (None lets the
    runtime apply its own default). A member may only name a granted athlete;
    an unnamed request falls back to the first grant, and a member holding no
    grants is refused.
    """

    if account_sees_all_athletes(account):
        return True, requested
    if requested is not None:
        return (True, requested) if account_can_access(account, requested) else (False, None)
    granted = account.athletes if isinstance(account.athletes, list) else []
    if not granted:
        return False, None
    return True, granted[0]


def filter_roster(payload: dict[str, Any], account: ConsoleAccount | None) -> dict[str, Any]:
    """Narrow a parsed runtime athlete roster to the account's grants.

    Admins and accounts without a grant list see the payload unchanged. A
    member only sees granted athletes, the default moves to the first grant,
    and a member holding no grants gets an empty roster with a blank default.
    """

    if account_sees_all_athletes(account):
        return payload
    granted = account.athletes if isinstance(account.athletes, list) else []
    athletes = [
        athlete
        for athlete in payload.get("athletes", [])
        if isinstance(athlete, dict) and isinstance(athlete.get("id"), str) and athlete["id"] in granted
    ]
    visible_ids = [athlete["id"] for athlete in athletes]
    default_athlete_id = payload.get("defaultAthleteId")
    if default_athlete_id not in visible_ids:
        default_athlete_id = visible_ids[0] if visible_ids else ""
    return {**payload, "defaultAthleteId": default_athlete_id, "athletes": athletes}


def can_run_agent_turn(athlete_id: str | None) -> bool:
    """True when a Console chat is scoped to an athlete and may call the model.

    A member with no athlete grant can sign in and browse, but an agent turn
    would have no athlete to scope its Catence tool calls to.
    """

    return isinstance(athlete_id, str) and bool(athlete_id)


async def _proxy_mcp_get(request: Request, path: str, query: str | None = None) -> Response:
    """Expose dashboard data only through Chainlit's authenticated origin."""

    if not _authenticated(request):
        return JSONResponse({"error": {"code": "unauthorized", "message": "Console login is required."}}, status_code=401)
    target = _mcp_http_url(path)
    effective_query = request.url.query if query is None else query
    if effective_query:
        target = f"{target}?{effective_query}"

    def fetch() -> tuple[int, bytes, str]:
        try:
            with urllib.request.urlopen(target, timeout=10) as upstream:
                return upstream.status, upstream.read(), upstream.headers.get_content_type()
        except urllib.error.HTTPError as error:
            return error.code, error.read(), error.headers.get_content_type()
        except urllib.error.URLError as error:
            return 502, json.dumps({"error": {"code": "mcp_unavailable", "message": str(error)}}).encode("utf-8"), "application/json"

    status, body, content_type = await asyncio.to_thread(fetch)
    return Response(content=body, status_code=status, media_type=content_type)


async def dashboard_proxy(request: Request) -> Response:
    return await _athlete_scoped_get(request, "/api/v1/dashboard")


async def athletes_proxy(request: Request) -> Response:
    """Expose the athlete roster narrowed to the session account's grants."""

    account = _request_identity(request)
    if account is None:
        return _unauthorized()
    response = await _proxy_mcp_get(request, "/api/v1/athletes")
    if account_sees_all_athletes(account) or response.status_code != 200:
        return response
    payload = _parsed_json_object(response.body)
    if not _valid_roster(payload):
        return JSONResponse(
            {"error": {"code": "invalid_roster", "message": "Catence returned an invalid athlete roster."}},
            status_code=502,
        )
    return JSONResponse(filter_roster(payload, account))


async def health_proxy(request: Request) -> Response:
    return await _proxy_mcp_get(request, "/api/v1/health")

async def athlete_file_proxy(request: Request) -> Response:
    """Read or write the athlete file through the runtime's hash-guarded route."""

    if request.method == "PUT":
        return await _athlete_scoped_put(request, "/api/v1/athlete-file")
    return await _athlete_scoped_get(request, "/api/v1/athlete-file")


def _parsed_json_object(body: bytes) -> dict[str, Any] | None:
    """Decode a JSON-object response body, or None when it is not one."""

    try:
        payload = json.loads(body)
    except (TypeError, ValueError):
        return None
    return payload if isinstance(payload, dict) else None


def _requested_athlete(request: Request) -> str | None:
    """The athleteId a request names, treating a blank value as absent."""

    athlete_id = request.query_params.get("athleteId")
    return athlete_id or None


def _query_with_athlete(request: Request, athlete_id: str) -> str:
    """The request query with athleteId forced to one granted athlete."""

    pairs = [
        (key, value)
        for key, value in parse_qsl(request.url.query, keep_blank_values=True)
        if key != "athleteId"
    ]
    pairs.append(("athleteId", athlete_id))
    return urlencode(pairs)


async def _athlete_scoped_get(request: Request, path: str) -> Response:
    """Proxy a GET route after enforcing the session account's athlete grant."""

    account = _request_identity(request)
    if account is None:
        return _unauthorized()
    requested = _requested_athlete(request)
    allowed, athlete_id = athlete_scope(account, requested)
    if not allowed:
        return _athlete_forbidden()
    if athlete_id is not None and athlete_id != requested:
        return await _proxy_mcp_get(request, path, query=_query_with_athlete(request, athlete_id))
    return await _proxy_mcp_get(request, path)


async def _athlete_scoped_put(request: Request, path: str) -> Response:
    """Proxy a PUT route after enforcing the session account's athlete grant."""

    account = _request_identity(request)
    if account is None:
        return _unauthorized()
    requested = _requested_athlete(request)
    allowed, athlete_id = athlete_scope(account, requested)
    if not allowed:
        return _athlete_forbidden()
    if athlete_id is not None and athlete_id != requested:
        return await _proxy_mcp_put(request, path, query=_query_with_athlete(request, athlete_id))
    return await _proxy_mcp_put(request, path)


@chainlit_server.middleware("http")
async def authenticated_dashboard_proxy(request: Request, call_next: Any) -> Response:
    """Handle these paths before Chainlit's catch-all SPA route."""

    if request.method == "GET" and request.url.path == "/api/v1/dashboard":
        return await dashboard_proxy(request)
    if request.method == "GET" and request.url.path == "/api/v1/athletes":
        return await athletes_proxy(request)
    if request.method == "GET" and request.url.path == "/api/v1/health":
        return await health_proxy(request)
    if request.url.path == "/api/v1/models":
        if request.method == "GET":
            return await models_overview(request)
        return JSONResponse({"error": {"code": "method_not_allowed", "message": "Use GET for /api/v1/models."}}, status_code=405)
    if request.method == "POST" and request.url.path == "/api/v1/models/discover":
        return await discover_models_proxy(request)
    if request.method == "POST" and request.url.path.startswith("/api/v1/models/"):
        action = request.url.path.rsplit("/", 1)[-1]
        if action in {"toggle", "add", "update", "remove", "default", "hide"}:
            return await mutate_models(request, action)
    if request.method == "GET" and request.url.path == "/api/v1/whoami":
        return await whoami(request)
    if request.url.path == "/api/v1/accounts":
        if request.method == "GET":
            return await accounts_overview(request)
        return JSONResponse({"error": {"code": "method_not_allowed", "message": "Use GET for /api/v1/accounts."}}, status_code=405)
    if request.method == "POST" and request.url.path.startswith("/api/v1/accounts/"):
        action = request.url.path.rsplit("/", 1)[-1]
        if action in {"add", "update", "remove", "passwd"}:
            return await mutate_accounts(request, action)
    if request.method == "POST" and request.url.path == "/api/v1/sync":
        return await sync_trigger_proxy(request)
    if request.method == "GET" and request.url.path == "/api/v1/sync/status":
        return await sync_status_proxy(request)
    if request.url.path == "/api/v1/athlete-file":
        if request.method in {"GET", "PUT"}:
            return await athlete_file_proxy(request)
        return JSONResponse({"error": {"code": "method_not_allowed", "message": "Use GET or PUT for /api/v1/athlete-file."}}, status_code=405)
    return await call_next(request)


def _unauthorized() -> JSONResponse:
    return JSONResponse({"error": {"code": "unauthorized", "message": "Console login is required."}}, status_code=401)


def _athlete_forbidden() -> JSONResponse:
    return JSONResponse(
        {
            "error": {
                "code": "athlete_forbidden",
                "message": "Your Console account does not have access to this athlete.",
            }
        },
        status_code=403,
    )


def _admin_required() -> JSONResponse:
    return JSONResponse(
        {
            "error": {
                "code": "admin_required",
                "message": "Your Console account must be an admin to manage Console accounts.",
            }
        },
        status_code=403,
    )


def _models_error(error: Exception, code: str) -> JSONResponse:
    return JSONResponse({"error": {"code": code, "message": str(error)}}, status_code=400)


def _configured_models(configuration: ConsoleConfiguration, profile_id: str) -> dict[str, Any]:
    """The usable model map of one profile, tolerating legacy single-model profiles."""

    profile = configuration.profile(profile_id)
    return profile.models or {"default": profile.model_option()}


def _models_payload(configuration: ConsoleConfiguration) -> dict[str, Any]:
    """The authenticated model-management view: config plus per-user flags."""

    disabled = disabled_models_store(DATA_DIRECTORY).list()
    hidden_profiles = hidden_profiles_store(DATA_DIRECTORY).list()
    profiles: list[dict[str, Any]] = []
    for profile in configuration.profiles.values():
        models = [
            {
                "id": model_id,
                "label": option.label,
                "model": option.model,
                "reasoningEffort": option.reasoning_effort,
                "variants": option.variants,
                "disabled": (profile.id, model_id) in disabled,
            }
            for model_id, option in _configured_models(configuration, profile.id).items()
        ]
        profiles.append(
            {
                "id": profile.id,
                "label": profile.label,
                "defaultModel": profile.default_model or "default",
                "requiredEnvironment": list(profile.required_environment),
                "missingEnvironment": list(missing_environment(profile)),
                "hidden": profile.id in hidden_profiles,
                "models": models,
            }
        )
    return {"defaultProfile": configuration.default_profile, "profiles": profiles}


async def models_overview(request: Request) -> Response:
    if not _authenticated(request):
        return _unauthorized()
    try:
        return JSONResponse(_models_payload(_configuration()))
    except ConsoleConfigurationError as error:
        return _models_error(error, "configuration_invalid")


async def _json_body(request: Request) -> dict[str, Any]:
    try:
        body = await request.json()
    except Exception as error:
        raise ConsoleConfigurationError("Request body must be valid JSON.") from error
    if not isinstance(body, dict):
        raise ConsoleConfigurationError("Request body must be a JSON object.")
    return body


def _require_model_fields(body: dict[str, Any], fields: tuple[str, ...]) -> None:
    for field in fields:
        value = body.get(field)
        if not isinstance(value, str) or not value.strip():
            raise ConsoleConfigurationError(f"{field} is required.")


def _enabled_pairs(configuration: ConsoleConfiguration, disabled: set[tuple[str, str]]) -> set[tuple[str, str]]:
    pairs: set[tuple[str, str]] = set()
    for profile in configuration.profiles.values():
        for model_id in _configured_models(configuration, profile.id):
            if (profile.id, model_id) not in disabled:
                pairs.add((profile.id, model_id))
    return pairs


async def _toggle_model(body: dict[str, Any]) -> None:
    """Enable or disable one configured model in the local sqlite store."""

    _require_model_fields(body, ("profileId", "modelId"))
    disabled_flag = body.get("disabled")
    if not isinstance(disabled_flag, bool):
        raise ConsoleConfigurationError("disabled must be a boolean.")
    profile_id, model_id = body["profileId"], body["modelId"]
    configuration = _configuration()
    if model_id not in _configured_models(configuration, profile_id):
        raise ConsoleConfigurationError(f"Unknown model {model_id!r} for Console profile {profile_id!r}.")
    store = disabled_models_store(DATA_DIRECTORY)
    if not disabled_flag:
        store.remove(profile_id, model_id)
        return
    remaining = _enabled_pairs(configuration, store.list() | {(profile_id, model_id)})
    if not remaining:
        raise ConsoleConfigurationError("Cannot disable the only enabled model. Enable another model first.")
    store.add(profile_id, model_id)


def _add_model(console: dict[str, Any], body: dict[str, Any]) -> None:
    _require_model_fields(body, ("profileId", "modelId", "label", "model"))
    profiles = console.setdefault("profiles", {})
    raw_profile = profiles.get(body["profileId"])
    if not isinstance(raw_profile, dict):
        raise ConsoleConfigurationError(f"Unknown Console profile: {body['profileId']}")
    models = raw_profile.get("models")
    if not isinstance(models, dict):
        raise ConsoleConfigurationError(
            f"Console profile {body['profileId']} does not use a models map; custom variants require one."
        )
    if body["modelId"] in models:
        raise ConsoleConfigurationError(f"Model {body['modelId']!r} already exists in profile {body['profileId']!r}.")
    entry: dict[str, Any] = {"label": body["label"], "model": body["model"]}
    if body.get("reasoningEffort") is not None:
        if not isinstance(body["reasoningEffort"], str):
            raise ConsoleConfigurationError("reasoningEffort must be a string.")
        entry["reasoningEffort"] = body["reasoningEffort"]
    if body.get("variants") is not None:
        variants = body["variants"]
        if not isinstance(variants, dict) or any(not isinstance(key, str) or not isinstance(value, str) for key, value in variants.items()):
            raise ConsoleConfigurationError("variants must map labels to reasoning-effort values.")
        entry["variants"] = variants
    models[body["modelId"]] = entry


def _update_model(console: dict[str, Any], body: dict[str, Any]) -> None:
    """Edit one existing model entry: label, routing, reasoningEffort, variants.

    Only fields present in the request body change; a field set to null is
    cleared (except ``model``, which must always stay configured). This is how
    custom thinking-effort variants are attached to an already-discovered
    model without removing and re-adding it.
    """

    _require_model_fields(body, ("profileId", "modelId"))
    profile_id, model_id = body["profileId"], body["modelId"]
    profiles = console.setdefault("profiles", {})
    raw_profile = profiles.get(profile_id)
    if not isinstance(raw_profile, dict) or not isinstance(raw_profile.get("models"), dict):
        raise ConsoleConfigurationError(f"Unknown Console profile or unsupported layout: {profile_id}")
    models = raw_profile["models"]
    if model_id not in models:
        raise ConsoleConfigurationError(f"Unknown model {model_id!r} for Console profile {profile_id!r}.")
    entry = models[model_id]
    for field in ("label", "model"):
        if field not in body:
            continue
        value = body[field]
        if field == "model" and (value is None or not isinstance(value, str) or not value.strip()):
            raise ConsoleConfigurationError("model must be a non-empty string; it cannot be cleared.")
        if value is None:
            entry.pop(field, None)
        elif isinstance(value, str) and value.strip():
            entry[field] = value
        else:
            raise ConsoleConfigurationError(f"{field} must be a non-empty string when provided.")
    for field in ("reasoningEffort", "variants"):
        if field not in body:
            continue
        value = body[field]
        if value is None:
            entry.pop(field, None)
        elif field == "reasoningEffort" and isinstance(value, str) and value.strip():
            entry["reasoningEffort"] = value
        elif field == "reasoningEffort":
            raise ConsoleConfigurationError("reasoningEffort must be a string.")
        elif isinstance(value, dict) and all(isinstance(key, str) and isinstance(item, str) for key, item in value.items()):
            entry["variants"] = value
        else:
            raise ConsoleConfigurationError("variants must map labels to reasoning-effort values.")
    # Mirror the strict startup loader's cross-field rule before writing.
    if isinstance(entry.get("reasoningEffort"), str) and entry.get("variants") == {}:
        raise ConsoleConfigurationError(
            f"{profile_id}.models.{model_id} cannot combine a fixed reasoningEffort with empty variants."
        )
    if not isinstance(entry.get("label"), str) or not entry.get("label", "").strip():
        entry["label"] = model_id


def _remove_model(console: dict[str, Any], body: dict[str, Any]) -> None:
    _require_model_fields(body, ("profileId", "modelId"))
    profile_id, model_id = body["profileId"], body["modelId"]
    profiles = console.setdefault("profiles", {})
    raw_profile = profiles.get(profile_id)
    if not isinstance(raw_profile, dict) or not isinstance(raw_profile.get("models"), dict):
        raise ConsoleConfigurationError(f"Unknown Console profile or unsupported layout: {profile_id}")
    models = raw_profile["models"]
    if model_id not in models:
        raise ConsoleConfigurationError(f"Unknown model {model_id!r} for Console profile {profile_id!r}.")
    if len(models) <= 1:
        raise ConsoleConfigurationError("Cannot remove the last model of a profile.")
    del models[model_id]
    if raw_profile.get("defaultModel") == model_id:
        raw_profile["defaultModel"] = next(iter(models))


async def _hide_profile(body: dict[str, Any]) -> None:
    """Hide or unhide one provider profile for this local user (UI state only)."""

    _require_model_fields(body, ("profileId",))
    hidden_flag = body.get("hidden")
    if not isinstance(hidden_flag, bool):
        raise ConsoleConfigurationError("hidden must be a boolean.")
    profile_id = body["profileId"]
    _configuration().profile(profile_id)  # Unknown ids are rejected, not stored.
    store = hidden_profiles_store(DATA_DIRECTORY)
    if hidden_flag:
        store.add(profile_id)
    else:
        store.remove(profile_id)


async def mutate_models(request: Request, action: str) -> Response:
    if not _authenticated(request):
        return _unauthorized()
    try:
        body = await _json_body(request)
        if action == "toggle":
            await _toggle_model(body)
            return JSONResponse(_models_payload(_configuration()))
        if action == "add":
            configuration = write_console_section(DATA_DIRECTORY, lambda console: _add_model(console, body))
            return JSONResponse(_models_payload(configuration))
        if action == "update":
            configuration = write_console_section(DATA_DIRECTORY, lambda console: _update_model(console, body))
            return JSONResponse(_models_payload(configuration))
        if action == "remove":
            write_console_section(DATA_DIRECTORY, lambda console: _remove_model(console, body))
            # Only after the config write succeeded: a stale disable flag must
            # not survive so a later re-add starts enabled.
            disabled_models_store(DATA_DIRECTORY).remove(body["profileId"], body["modelId"])
            return JSONResponse(_models_payload(_configuration()))
        if action == "default":
            _require_model_fields(body, ("profileId", "modelId"))

            def set_default(console: dict[str, Any]) -> None:
                profiles = console.setdefault("profiles", {})
                raw_profile = profiles.get(body["profileId"])
                if not isinstance(raw_profile, dict):
                    raise ConsoleConfigurationError(f"Unknown Console profile: {body['profileId']}")
                raw_profile["defaultModel"] = body["modelId"]

            configuration = write_console_section(DATA_DIRECTORY, set_default)
            return JSONResponse(_models_payload(configuration))
        if action == "hide":
            await _hide_profile(body)
            return JSONResponse(_models_payload(_configuration()))
        raise ConsoleConfigurationError(f"Unknown model management action: {action}")
    except ConsoleConfigurationError as error:
        return _models_error(error, "invalid_request")


class _AccountApiError(Exception):
    """A Console accounts API failure carrying the error code and status one response needs."""

    def __init__(self, code: str, status_code: int, message: str):
        super().__init__(message)
        self.code = code
        self.status_code = status_code


def _accounts_error(code: str, message: str, status_code: int) -> JSONResponse:
    return JSONResponse({"error": {"code": code, "message": message}}, status_code=status_code)


def _account_not_found(username: str) -> _AccountApiError:
    return _AccountApiError("account_not_found", 404, f"Console account {username!r} was not found.")


def _account_payload(account: ConsoleAccount) -> dict[str, Any]:
    """The public JSON view of a Console account; never the password hash or store path."""

    return {
        "username": account.username,
        "role": account.role,
        "athletes": account.athletes,
        "createdAt": account.created_at,
    }


def _required_account_username(body: dict[str, Any]) -> str:
    username = body.get("username")
    if not isinstance(username, str) or not username:
        raise AccountValidationError("username is required.")
    return username


def _add_console_account(path: Path, body: dict[str, Any]) -> dict[str, Any]:
    """Add one account from an admin request; the hash never enters the response."""

    username = _required_account_username(body)
    password = body.get("password")
    if not isinstance(password, str):
        raise AccountValidationError("Console password must be a string.")
    try:
        created = add_account(
            path,
            username=username,
            password=password,
            role=body.get("role"),
            athletes=body.get("athletes"),
        )
    except AccountExistsError as error:
        raise _AccountApiError("account_exists", 409, f"Console account {username!r} already exists.") from error
    return _account_payload(created)


def _update_console_account(path: Path, body: dict[str, Any]) -> dict[str, Any]:
    """Apply role and athlete-grant changes; omitted fields keep their current values."""

    username = _required_account_username(body)
    role = body.get("role")
    if role is not None and not isinstance(role, str):
        raise AccountValidationError("role must be a string.")
    athletes = body.get("athletes")
    if athletes is not None and not isinstance(athletes, (str, list)):
        raise AccountValidationError("athletes must be 'all' or a list of athlete ids.")
    try:
        updated = update_account(path, username, role=role, athletes=athletes)
    except AccountNotFoundError as error:
        raise _account_not_found(username) from error
    return _account_payload(updated)


def _refuse_removing_the_last_admin(path: Path, username: str) -> None:
    """Stop a removal that would leave no way to administer the Console.

    The environment break-glass admin always keeps a way in, so the guard only
    applies while the store is the sole login source.
    """

    if env_account() is not None:
        return
    stored = load_accounts(path)
    target = next((account for account in stored if account.username == username), None)
    if target is None or target.role != "admin":
        return
    if any(account.role == "admin" and account.username != username for account in stored):
        return
    raise _AccountApiError(
        "last_admin",
        400,
        f"Console account {username!r} is the last admin. Configure the environment break-glass admin or promote "
        "another account before removing it.",
    )


def _remove_console_account(path: Path, body: dict[str, Any]) -> dict[str, bool]:
    username = _required_account_username(body)
    _refuse_removing_the_last_admin(path, username)
    try:
        remove_account(path, username)
    except AccountNotFoundError as error:
        raise _account_not_found(username) from error
    return {"ok": True}


def _change_console_password(path: Path, body: dict[str, Any]) -> dict[str, bool]:
    username = _required_account_username(body)
    password = body.get("password")
    if not isinstance(password, str):
        raise AccountValidationError("Console password must be a string.")
    try:
        update_account(path, username, password=password)
    except AccountNotFoundError as error:
        raise _account_not_found(username) from error
    return {"ok": True}


async def whoami(request: Request) -> Response:
    """The session account's public identity; the fork gates admin UI on ``role``."""

    account = _request_identity(request)
    if account is None:
        return _unauthorized()
    return JSONResponse({"username": account.username, "role": account.role, "athletes": account.athletes})


async def accounts_overview(request: Request) -> Response:
    """List stored Console accounts and the environment break-glass username, for admins only."""

    account = _request_identity(request)
    if account is None:
        return _unauthorized()
    if account.role != "admin":
        return _admin_required()
    try:
        stored = sorted(load_accounts(_auth.accounts_path()), key=lambda stored_account: stored_account.username)
    except AccountsStoreError as error:
        logger.exception("Could not list Console accounts: %s", error)
        return _accounts_error("accounts_store_error", "The Console accounts store is unusable.", 500)
    break_glass = env_account()
    return JSONResponse(
        {
            "accounts": [_account_payload(stored_account) for stored_account in stored],
            "breakGlass": None if break_glass is None else {"username": break_glass.username},
        }
    )


async def mutate_accounts(request: Request, action: str) -> Response:
    """Manage stored Console accounts; the admin check runs before the body is parsed."""

    account = _request_identity(request)
    if account is None:
        return _unauthorized()
    if account.role != "admin":
        return _admin_required()
    try:
        body = await _json_body(request)
        path = _auth.accounts_path()
        if action == "add":
            return JSONResponse(_add_console_account(path, body))
        if action == "update":
            return JSONResponse(_update_console_account(path, body))
        if action == "remove":
            return JSONResponse(_remove_console_account(path, body))
        if action == "passwd":
            return JSONResponse(_change_console_password(path, body))
        raise _AccountApiError("invalid_request", 400, f"Unknown account management action: {action}")
    except _AccountApiError as error:
        return _accounts_error(error.code, str(error), error.status_code)
    except (AccountValidationError, ConsoleConfigurationError) as error:
        return _accounts_error("invalid_request", str(error), 400)
    except AccountsStoreError as error:
        logger.exception("Console accounts store failed during %s: %s", action, error)
        return _accounts_error("accounts_store_error", "The Console accounts store is unusable.", 500)


async def _proxy_mcp_put(request: Request, path: str, query: str | None = None) -> Response:
    """Forward an authenticated PUT body to the runtime's JSON API."""

    if not _authenticated(request):
        return JSONResponse({"error": {"code": "unauthorized", "message": "Console login is required."}}, status_code=401)
    target = _mcp_http_url(path)
    effective_query = request.url.query if query is None else query
    if effective_query:
        target = f"{target}?{effective_query}"
    payload = await request.body()
    headers = {"content-type": "application/json"}
    expected_hash = request.headers.get("if-match")
    if expected_hash:
        headers["if-match"] = expected_hash

    def fetch() -> tuple[int, bytes, str]:
        request_ = urllib.request.Request(target, data=payload, method="PUT", headers=headers)
        try:
            with urllib.request.urlopen(request_, timeout=15) as upstream:
                return upstream.status, upstream.read(), upstream.headers.get_content_type()
        except urllib.error.HTTPError as error:
            return error.code, error.read(), error.headers.get_content_type()
        except urllib.error.URLError as error:
            return 502, json.dumps({"error": {"code": "mcp_unavailable", "message": str(error)}}).encode("utf-8"), "application/json"

    status, response_body, content_type = await asyncio.to_thread(fetch)
    return Response(content=response_body, status_code=status, media_type=content_type)


async def _proxy_mcp_post(request: Request, path: str, payload: bytes | None = None) -> Response:
    """Forward an authenticated POST body to the runtime's JSON API."""

    target = _mcp_http_url(path)
    if payload is None:
        payload = await request.body()

    def fetch() -> tuple[int, bytes, str]:
        request_ = urllib.request.Request(target, data=payload, method="POST", headers={"content-type": "application/json"})
        try:
            with urllib.request.urlopen(request_, timeout=15) as upstream:
                return upstream.status, upstream.read(), upstream.headers.get_content_type()
        except urllib.error.HTTPError as error:
            return error.code, error.read(), error.headers.get_content_type()
        except urllib.error.URLError as error:
            return 502, json.dumps({"error": {"code": "mcp_unavailable", "message": str(error)}}).encode("utf-8"), "application/json"

    status, response_body, content_type = await asyncio.to_thread(fetch)
    return Response(content=response_body, status_code=status, media_type=content_type)


async def sync_trigger_proxy(request: Request) -> Response:
    """Start a detached data sync through the runtime's /api/v1/sync route."""

    account = _request_identity(request)
    if account is None:
        return _unauthorized()
    # Read the body once so the same bytes (or a rewritten body) reach the runtime.
    payload = await request.body()
    body = _parsed_json_object(payload)
    named = body.get("athleteId") if body is not None else None
    requested = named if isinstance(named, str) and named else None
    allowed, athlete_id = athlete_scope(account, requested)
    if not allowed:
        return _athlete_forbidden()
    if athlete_id is not None and athlete_id != requested:
        if body is None:
            return JSONResponse(
                {"error": {"code": "invalid_request", "message": "Request body must be a JSON object."}},
                status_code=400,
            )
        payload = json.dumps({**body, "athleteId": athlete_id}).encode("utf-8")
    return await _proxy_mcp_post(request, "/api/v1/sync", payload=payload)


async def discover_models_proxy(request: Request) -> Response:
    """Refresh the OpenCode Go model profiles through the runtime route."""

    if not _authenticated(request):
        return _unauthorized()
    return await _proxy_mcp_post(request, "/api/v1/models/discover")


async def sync_status_proxy(request: Request) -> Response:
    """Proxy live sync progress and last-completion timestamps from the runtime."""

    return await _athlete_scoped_get(request, "/api/v1/sync/status")


def _session_identity() -> ConsoleAccount | None:
    """The Console account of the current Chainlit session, if any."""

    user = cl.user_session.get("user")
    identifier = getattr(user, "identifier", None)
    if not isinstance(identifier, str) or not identifier:
        return None
    return resolve_account(identifier)


def _valid_roster(payload: object) -> TypeGuard[dict[str, Any]]:
    """True when a runtime payload has the athlete-roster shape."""

    return (
        isinstance(payload, dict)
        and isinstance(payload.get("defaultAthleteId"), str)
        and isinstance(payload.get("athletes"), list)
    )


def _roster_payload() -> dict[str, Any]:
    """Fetch and validate the runtime's athlete roster."""

    try:
        with urllib.request.urlopen(_mcp_http_url("/api/v1/athletes"), timeout=3) as response:
            payload = json.loads(response.read().decode("utf-8"))
    except (urllib.error.URLError, TimeoutError, json.JSONDecodeError) as error:
        raise ConsoleConfigurationError(f"Could not load the Catence athlete roster: {error}") from error
    if not _valid_roster(payload):
        raise ConsoleConfigurationError("Catence returned an invalid athlete roster.")
    if not any(
        isinstance(athlete, dict) and athlete.get("id") == payload["defaultAthleteId"]
        for athlete in payload["athletes"]
    ):
        raise ConsoleConfigurationError("Catence returned an athlete roster with an invalid default.")
    return payload


def _athlete_roster() -> tuple[str | None, dict[str, str]]:
    """Read only IDs and labels; health data remains behind scoped MCP tools.

    The roster is narrowed to the session account's grants, so a member with
    no grants gets empty choices and no default instead of a raised error.
    """

    payload = filter_roster(_roster_payload(), _session_identity())
    choices: dict[str, str] = {}
    for athlete in payload["athletes"]:
        if isinstance(athlete, dict) and isinstance(athlete.get("id"), str) and isinstance(athlete.get("label"), str):
            choices[athlete["label"]] = athlete["id"]
    default_athlete_id = payload["defaultAthleteId"]
    if default_athlete_id in choices.values():
        return default_athlete_id, choices
    if choices:
        raise ConsoleConfigurationError("Catence returned an athlete roster with an invalid default.")
    return None, {}


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


def _disabled_choices(configuration: ConsoleConfiguration) -> set[tuple[str, str]]:
    return disabled_models_store(DATA_DIRECTORY).list()


def _hidden_profile_ids() -> set[str]:
    return hidden_profiles_store(DATA_DIRECTORY).list()


def _available_model_choices(configuration: ConsoleConfiguration) -> dict[str, str]:
    """Model dropdown choices minus disabled models and hidden profiles.

    Hiding every profile must never empty the dropdown: when the filtered map
    would be empty, the unfiltered choices come back so the chat stays usable
    (and the athlete can unhide a profile on the Models page).
    """

    disabled = _disabled_choices(configuration)
    hidden = _hidden_profile_ids()
    choices = configuration.model_choices()
    visible = {
        label: value
        for label, value in choices.items()
        if value.partition(":")[0] not in hidden
        and (value.partition(":")[0], value.partition(":")[2]) not in disabled
    }
    return visible or choices


def _effort_dynamic_options(configuration: ConsoleConfiguration) -> dict[str, Any] | None:
    """Per-model thinking-effort options for the settings panel.

    Sent as Select.dynamic_options so the frontend swaps the effort dropdown
    the moment the model dropdown changes, without saving and reopening.
    """

    cases: dict[str, Any] = {}
    for choice in _available_model_choices(configuration).values():
        profile_id, _, model_id = choice.partition(":")
        try:
            profile = configuration.profile(profile_id)
        except ConsoleConfigurationError:
            continue
        cases[choice] = {
            "items": {"Provider default": "default", **profile.reasoning_effort_choices(model_id)},
            "initialValue": profile.default_reasoning_effort or "default",
            "disabled": profile.reasoning_effort_disabled(model_id),
        }
    if not cases:
        return None
    return {"watchId": "model", "cases": cases}


def _choice_available(configuration: ConsoleConfiguration, value: str) -> bool:
    profile_id, _, model_id = value.partition(":")
    try:
        configuration.profile(profile_id)
        _configured_models(configuration, profile_id)
    except ConsoleConfigurationError:
        return False
    return (
        profile_id not in _hidden_profile_ids()
        and (profile_id, model_id) not in _disabled_choices(configuration)
    )


def _session_settings(
    configuration: ConsoleConfiguration,
    default_athlete_id: str | None,
    athlete_ids: set[str],
) -> tuple[str, str, str | None, int, int, str | None]:
    """Return the current chat's safe, valid settings.

    Startup and resume apply the local user's durable preferences before this
    function runs. Falling back to configured defaults also lets a chat remain
    usable after its saved model has been removed from config.json.
    """

    model_choice = cl.user_session.get("catence_model")
    if isinstance(model_choice, str) and _choice_available(configuration, model_choice):
        try:
            profile, model_id = configuration.selected_model(model_choice)
        except ConsoleConfigurationError:
            model_choice = configuration.default_model_choice()
            profile, model_id = configuration.selected_model(model_choice)
    else:
        # Fall back to the configured default, then to any enabled model, so a
        # chat stays usable after its saved model was disabled or removed.
        fallback = configuration.default_model_choice()
        if not _choice_available(configuration, fallback):
            available = _available_model_choices(configuration)
            if not available:
                raise ConsoleConfigurationError("Every Console model is disabled. Enable one in the models page.")
            fallback = next(iter(available.values()))
        model_choice = fallback
        profile, model_id = configuration.selected_model(fallback)
    reasoning_effort = cl.user_session.get("catence_reasoning_effort")
    valid = profile.valid_reasoning_effort(model_id)
    if reasoning_effort not in valid:
        reasoning_effort = profile.default_reasoning_effort
        if reasoning_effort not in valid:
            reasoning_effort = "default"
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
    athlete_id = cl.user_session.get("catence_athlete_id")
    if not isinstance(athlete_id, str) or athlete_id not in athlete_ids:
        athlete_id = default_athlete_id
    return profile.id, model_id, reasoning_effort, tool_rounds, tool_result_characters, athlete_id


def _selected_settings() -> tuple[str, str, str | None, int, int, str | None, str | None]:
    """The current chat's safe settings plus the selected athlete's label."""

    default_athlete_id, athletes = _athlete_roster()
    (
        profile_id,
        model_id,
        reasoning_effort,
        tool_rounds,
        tool_result_characters,
        athlete_id,
    ) = _session_settings(_configuration(), default_athlete_id, set(athletes.values()))
    athlete_label = next((label for label, granted_id in athletes.items() if granted_id == athlete_id), None)
    return profile_id, model_id, reasoning_effort, tool_rounds, tool_result_characters, athlete_id, athlete_label


def _configured_preferences(configuration: ConsoleConfiguration, default_athlete_id: str | None = None) -> SavedConsolePreferences:
    profile = configuration.profile(configuration.default_profile)
    return SavedConsolePreferences(
        model_choice=configuration.default_model_choice(),
        reasoning_effort=profile.default_reasoning_effort or "default",
        tool_rounds=configuration.limits.tool_rounds,
        tool_result_characters=configuration.limits.tool_result_characters,
        athlete_id=default_athlete_id,
    )


def _user_identifier() -> str:
    user = cl.user_session.get("user")
    identifier = getattr(user, "identifier", None)
    return identifier if isinstance(identifier, str) and identifier else os.environ.get("CHAINLIT_LOCAL_USER", "catence-local")


def _normalized_preferences(
    configuration: ConsoleConfiguration, preferences: SavedConsolePreferences, default_athlete_id: str | None, athlete_ids: set[str]
) -> SavedConsolePreferences:
    default = _configured_preferences(configuration, default_athlete_id)
    try:
        if not _choice_available(configuration, preferences.model_choice):
            raise ConsoleConfigurationError("The saved model is disabled.")
        profile, model_id = configuration.selected_model(preferences.model_choice)
        model_choice = preferences.model_choice
    except ConsoleConfigurationError:
        profile, model_id = configuration.selected_model(default.model_choice)
        model_choice = default.model_choice
    reasoning_effort = preferences.reasoning_effort
    valid = profile.valid_reasoning_effort(model_id)
    if reasoning_effort not in valid:
        reasoning_effort = default.reasoning_effort
    return SavedConsolePreferences(
        model_choice=model_choice,
        reasoning_effort=reasoning_effort,
        tool_rounds=max(MIN_TOOL_ROUND_LIMIT, min(preferences.tool_rounds, MAX_TOOL_ROUND_LIMIT)),
        tool_result_characters=max(
            MIN_TOOL_RESULT_CHARACTER_LIMIT,
            min(preferences.tool_result_characters, MAX_TOOL_RESULT_CHARACTER_LIMIT),
        ),
        athlete_id=preferences.athlete_id if preferences.athlete_id in athlete_ids else default_athlete_id,
    )


def _apply_preferences(preferences: SavedConsolePreferences) -> None:
    cl.user_session.set("catence_model", preferences.model_choice)
    cl.user_session.set("catence_reasoning_effort", preferences.reasoning_effort)
    cl.user_session.set("catence_tool_rounds", preferences.tool_rounds)
    cl.user_session.set("catence_tool_result_characters", preferences.tool_result_characters)
    cl.user_session.set("catence_athlete_id", preferences.athlete_id)


def _restore_preferences(configuration: ConsoleConfiguration) -> SavedConsolePreferences:
    default_athlete_id, athletes = _athlete_roster()
    saved = console_preferences_store(DATA_DIRECTORY).load(_user_identifier())
    preferences = _normalized_preferences(
        configuration,
        saved or _configured_preferences(configuration, default_athlete_id),
        default_athlete_id,
        set(athletes.values()),
    )
    _apply_preferences(preferences)
    return preferences


def _persist_preferences(configuration: ConsoleConfiguration, preferences: SavedConsolePreferences) -> None:
    store = console_preferences_store(DATA_DIRECTORY)
    default_athlete_id, _ = _athlete_roster()
    if preferences == _configured_preferences(configuration, default_athlete_id):
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
    athlete_id: str | None,
    athletes: dict[str, str],
    default_athlete_id: str | None,
) -> cl.ChatSettings:
    defaults = _configured_preferences(configuration, default_athlete_id)
    try:
        profile, model_id = configuration.selected_model(model_choice)
    except ConsoleConfigurationError:
        profile, model_id = configuration.selected_model(defaults.model_choice)
    effort_choices = {"Provider default": "default", **profile.reasoning_effort_choices(model_id)}
    effort_disabled = profile.reasoning_effort_disabled(model_id)
    return cl.ChatSettings(
        [
            Select(
                id="athleteId",
                label="Athlete",
                # Chainlit refuses an empty Select; a disabled placeholder keeps
                # a member without grants able to browse the Console.
                items=athletes or {"No athletes available": ""},
                initial_value=athlete_id,
                reset_value=defaults.athlete_id,
                disabled=not athletes,
                description=(
                    NO_ATHLETE_ACCESS_NOTICE
                    if not athletes
                    else "Every Catence data tool call in this chat is restricted to this athlete."
                ),
            ),
            Select(
                id="model",
                label="Model",
                items=_available_model_choices(configuration),
                initial_value=model_choice,
                reset_value=defaults.model_choice,
                description="Choose a deployment. Credentials stay in the Console process environment. Manage the list on the models page.",
            ),
            Select(
                id="reasoningEffort",
                label="Thinking effort",
                items=effort_choices,
                initial_value=reasoning_effort or "default",
                reset_value=defaults.reasoning_effort,
                disabled=effort_disabled,
                dynamic_options=_effort_dynamic_options(configuration),
                description=(
                    "This model does not expose reasoning-effort levels; the provider default is always used."
                    if effort_disabled
                    else "Reasoning-effort level for this model. The dropdown follows the selected model; variants come from the model's config, falling back to the OpenAI-standard set."
                ),
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
    await _notice(
        content=(
            "Welcome to Catence Console. Let’s set up your first model. "
            "This wizard writes only provider and model names; API keys stay in your terminal environment."
        )
    ).send()
    provider = await _ask_setup_question(
        "Choose a provider: `openai-compatible`, `openai`, or `anthropic`. "
        "Use `openai-compatible` for any OpenAI-compatible endpoint such as Azure or Opencode."
    )
    if provider is None:
        return None
    provider = provider.lower()
    examples = {
        "openai-compatible": "OpenAI-compatible model or deployment name, for example `gpt-5-mini`",
        "openai": "OpenAI model name, for example `gpt-5-mini`",
        "anthropic": "Anthropic model name, for example `claude-sonnet-4-5`",
    }
    if provider not in examples:
        await _notice(content="Setup paused: choose `openai-compatible`, `openai`, or `anthropic` and start a new chat to try again.").send()
        return None
    model = await _ask_setup_question(f"Enter the {examples[provider]}.")
    if model is None:
        return None
    try:
        configuration = write_provider_setup(DATA_DIRECTORY, provider, model)
    except ConsoleConfigurationError as error:
        await _notice(content=f"Setup could not save the model: {error}").send()
        return None

    environment = {
        "openai-compatible": "Set `OPENAI_API_KEY` and `OPENAI_API_BASE`, then restart the Console. See docs/llm-providers.md for Azure and Opencode.",
        "openai": "Set `OPENAI_API_KEY`, then restart the Console.",
        "anthropic": "Set `ANTHROPIC_API_KEY`, then restart the Console.",
    }
    await _notice(content=f"Setup saved. {environment[provider]}").send()
    return configuration


async def _initialize_chat(configuration: ConsoleConfiguration) -> None:
    """Send configurable widgets and the current readiness message."""

    preferences = _restore_preferences(configuration)
    default_athlete_id, athletes = _athlete_roster()
    profile, model_id = configuration.selected_model(preferences.model_choice)
    await _chat_settings(
        configuration,
        model_choice=preferences.model_choice,
        reasoning_effort=None if preferences.reasoning_effort == "default" else preferences.reasoning_effort,
        tool_rounds=preferences.tool_rounds,
        tool_result_characters=preferences.tool_result_characters,
        athlete_id=preferences.athlete_id or default_athlete_id,
        athletes=athletes,
        default_athlete_id=default_athlete_id,
    ).send()

    missing = missing_environment(profile)
    readiness = "ready" if not missing else f"missing environment variables: {', '.join(missing)}"
    selected_model = profile.model_option(model_id)
    selected_effort = None if preferences.reasoning_effort == "default" else preferences.reasoning_effort
    scoped_athlete_id = preferences.athlete_id or default_athlete_id
    scope = (
        f"This chat is scoped to athlete **{scoped_athlete_id}**."
        if scoped_athlete_id
        else NO_ATHLETE_ACCESS_NOTICE
    )
    await _notice(
        content=(
            f"Catence Console is {readiness}. Using **{selected_model.label}** with **{selected_effort or 'provider default'}** thinking, "
            f"up to **{preferences.tool_rounds}** tool rounds and **{preferences.tool_result_characters:,}** evidence characters per result. "
            f"{scope} "
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
        default_athlete_id, athletes = _athlete_roster()
        await _chat_settings(
            configuration,
            model_choice=preferences.model_choice,
            reasoning_effort=None if preferences.reasoning_effort == "default" else preferences.reasoning_effort,
            tool_rounds=preferences.tool_rounds,
            tool_result_characters=preferences.tool_result_characters,
            athlete_id=preferences.athlete_id or default_athlete_id,
            athletes=athletes,
            default_athlete_id=default_athlete_id,
        ).refresh()
    except ConsoleConfigurationError as error:
        # The thread itself remains readable; a following message will show
        # the same actionable configuration error as a new chat would.
        logger.warning("Could not restore Catence Console settings for a resumed chat: %s", error)


@cl.on_settings_update
async def update_settings(settings: dict[str, Any]) -> None:
    configuration = _configuration()
    current = _restore_preferences(configuration)
    default_athlete_id, athletes = _athlete_roster()
    model_choice = settings.get("model", current.model_choice)
    if not isinstance(model_choice, str) or not _choice_available(configuration, model_choice):
        model_choice = current.model_choice
    try:
        profile, model_id = configuration.selected_model(model_choice)
    except ConsoleConfigurationError:
        profile, model_id = configuration.selected_model(current.model_choice)
        model_choice = current.model_choice
    reasoning_effort = settings.get("reasoningEffort", current.reasoning_effort)
    valid = profile.valid_reasoning_effort(model_id)
    if reasoning_effort not in valid:
        reasoning_effort = current.reasoning_effort if current.reasoning_effort in valid else "default"
    tool_rounds = _limit_setting(settings.get("toolRounds"), MIN_TOOL_ROUND_LIMIT, MAX_TOOL_ROUND_LIMIT)
    tool_result_characters = _limit_setting(
        settings.get("toolResultCharacters"), MIN_TOOL_RESULT_CHARACTER_LIMIT, MAX_TOOL_RESULT_CHARACTER_LIMIT
    )
    athlete_id = settings.get("athleteId", current.athlete_id)
    if not isinstance(athlete_id, str) or athlete_id not in athletes.values():
        athlete_id = current.athlete_id if current.athlete_id in athletes.values() else default_athlete_id
    preferences = SavedConsolePreferences(
        model_choice=model_choice,
        reasoning_effort=reasoning_effort,
        tool_rounds=tool_rounds if tool_rounds is not None else current.tool_rounds,
        tool_result_characters=(
            tool_result_characters if tool_result_characters is not None else current.tool_result_characters
        ),
        athlete_id=athlete_id,
    )
    _apply_preferences(preferences)
    _persist_preferences(configuration, preferences)
    settings_widgets = _chat_settings(
        configuration,
        model_choice=preferences.model_choice,
        reasoning_effort=preferences.reasoning_effort,
        tool_rounds=preferences.tool_rounds,
        tool_result_characters=preferences.tool_result_characters,
        athlete_id=preferences.athlete_id,
        athletes=athletes,
        default_athlete_id=default_athlete_id,
    )
    await settings_widgets.refresh()
    selected_model = profile.model_option(model_id)
    athlete_summary = (
        f", and athlete **{preferences.athlete_id}**."
        if preferences.athlete_id
        else f". {NO_ATHLETE_ACCESS_NOTICE}"
    )
    await cl.Message(
        content=(
            f"Settings applied: **{selected_model.label}** with **{preferences.reasoning_effort if preferences.reasoning_effort != 'default' else 'provider default'}** thinking, "
            f"**{preferences.tool_rounds}** tool rounds, **{preferences.tool_result_characters:,}** evidence characters per result"
            f"{athlete_summary}"
        )
    ).send()


async def _run_generation(
    message: cl.Message,
    profile,
    model_id: str,
    reasoning_effort,
    history: list[dict[str, Any]],
    tool_round_limit: int,
    tool_result_character_limit: int,
    athlete_id: str | None,
    athlete_label: str | None,
) -> None:
    """Execute one agent turn detached from the websocket session.

    The answer is persisted to the data layer so a client that refreshes or
    disconnects mid-turn can recover it when the thread reloads.
    """

    thread_id = cl.context.session.thread_id
    try:
        answer = await respond(
            profile=profile,
            model_id=model_id,
            reasoning_effort=reasoning_effort,
            history=history,
            mcp_url=MCP_URL,
            tool_round_limit=tool_round_limit,
            tool_result_character_limit=tool_result_character_limit,
            tool_call_store=tool_call_store(DATA_DIRECTORY),
            thread_id=thread_id,
            athlete_id=athlete_id,
            athlete_label=athlete_label,
            step_parent_id=message.id,
        )
        await cl.Message(content=answer).send()
    except asyncio.CancelledError:
        logger.info("Catence generation cancelled for thread %s", thread_id)
        finish_generation_sidecar(thread_id, stage="interrupted")
        return
    except Exception as error:
        logger.exception(
            "Catence model request failed for profile %s and model %s",
            profile.id,
            model_id,
        )
        try:
            await _notice(content=describe_model_failure(profile, model_id, error)).send()
        except Exception:
            pass
    finally:
        finish_generation_sidecar(thread_id, stage="completed")
        _ACTIVE_GENERATIONS.pop(thread_id, None)


@cl.on_stop
async def on_stop() -> None:
    """Cancel a detached generation when the user presses Stop."""

    thread_id = cl.context.session.thread_id
    task = _ACTIVE_GENERATIONS.get(thread_id)
    if task is not None and not task.done():
        task.cancel()


@cl.on_message
async def on_message(message: cl.Message) -> None:
    try:
        configuration = _configuration()
        (
            profile_id,
            model_id,
            reasoning_effort,
            tool_round_limit,
            tool_result_character_limit,
            athlete_id,
            athlete_label,
        ) = _selected_settings()
        profile = configuration.profile(profile_id)
    except ConsoleConfigurationError as error:
        await _notice(content=f"Console configuration error: {error}").send()
        return

    if not can_run_agent_turn(athlete_id):
        await _notice(content=NO_ATHLETE_ACCESS_NOTICE).send()
        return

    missing = missing_environment(profile)
    if missing:
        await _notice(
            content=f"Profile **{profile.label}** is not ready. Set {', '.join(missing)} in the Console process environment, then restart it."
        ).send()
        return

    thread_id = cl.context.session.thread_id
    existing = _ACTIVE_GENERATIONS.get(thread_id)
    if existing is not None and not existing.done():
        await _notice(
            content="A generation is already running for this chat. Wait for it to finish, or press Stop."
        ).send()
        return

    # Detach the turn so a disconnect/refresh cannot abort it. The live client
    # still receives streamed steps over the socket while connected; the answer
    # is persisted to the data layer and recovered when the thread reloads.
    _ACTIVE_GENERATIONS[thread_id] = asyncio.create_task(
        _run_generation(
            message,
            profile,
            model_id,
            reasoning_effort,
            _model_history(),
            tool_round_limit,
            tool_result_character_limit,
            athlete_id,
            athlete_label,
        )
    )
