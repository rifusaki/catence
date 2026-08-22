# Catence configuration reference

This is the complete schema for `config.json` in the data home
(`~/.catence/config.json` locally, `/data/config.json` in Docker). It is
validated by the runtime before every run: unknown fields or invalid values
produce an `Invalid Catence config at <path>: …` error. A missing or empty
file is treated as `{}` (no rate limits, no budget, no Console profiles).

The file is shared between the runtime (MCP rate limits, Strava budget) and
the Console (model profiles and limits). It deliberately contains **no
credential values** — only the *names* of environment variables that hold the
values. See [`config.example.json`](../config.example.json) for a complete
worked example and [`llm-providers.md`](llm-providers.md) for the provider
profile how-to.

## Top-level sections

```jsonc
{
  "mcp":        { "rateLimits": { … } },   // optional
  "providers":  { "strava": { "budget": { … } } }, // optional
  "console":    { "defaultProfile": …, "limits": { … }, "profiles": { … } } // optional
}
```

Every section is optional and strict: the schema rejects unknown top-level
keys and unknown keys inside each section.

## `mcp.rateLimits`

Limits the MCP server's sliding-window limiter. Each entry is
`{ "requests": <positive int>, "windowSeconds": <positive int> }` or `null`.

```jsonc
{
  "mcp": {
    "rateLimits": {
      "server": { "requests": 240, "windowSeconds": 60 },
      "tools": {
        "*": { "requests": 60, "windowSeconds": 60 },
        "hydrate_strava_activity": { "requests": 6, "windowSeconds": 60 },
        "hydrate_recent_strava_activities": { "requests": 1, "windowSeconds": 60 },
        "hydrate_strava_segment_history": { "requests": 4, "windowSeconds": 60 }
      },
      "resources": {
        "*": { "requests": 120, "windowSeconds": 60 }
      }
    }
  }
}
```

- `tools` keys are tool names; `resources` keys are resource names; `*` is the
  catch-all default for that kind.
- A specific entry overrides `*`, which overrides `server`.
- **`null` disables the limit** for that specific tool/resource name (or for
  the whole server when set on `server`). This is the escape hatch for
  long-running hydration tools.
- Limits are enforced **per athlete**: each athlete gets its own window
  (keyed `athleteId:tool:<name>` / `athleteId:resource:<name>`).

## `providers.strava.budget`

Throttles Strava API usage during sync and hydration.

```jsonc
{
  "providers": {
    "strava": {
      "budget": {
        "maxConcurrentRequests": 1,
        "readRequestsPer15Minutes": 80,
        "readRequestsPerDay": 800
      }
    }
  }
}
```

- `readRequestsPer15Minutes` and `readRequestsPerDay` are enforced: a sync or
  hydration throws a retryable `rate_limited` / `StravaRateLimitError` when
  the rolling usage reaches either threshold, and when Strava itself reports a
  `blocked_until` timestamp.
- `maxConcurrentRequests` is validated and documented but **not yet enforced**
  by the current sync/hydration worker (hydration already runs serially); it
  is reserved for a future concurrent worker. Set each value to `null` to
  disable that particular check.

## `console`

The Console model configuration. `defaultProfile` must name one of
`profiles`.

```jsonc
{
  "console": {
    "defaultProfile": "openai",
    "limits": { "toolRounds": 8, "toolResultCharacters": 24000 },
    "profiles": { … }
  }
}
```

### `console.limits`

| Field | Default | Range |
| --- | --- | --- |
| `toolRounds` | 8 | 1–32 — max model tool-calling iterations per chat turn |
| `toolResultCharacters` | 24000 | 1,000–250,000 — max characters of a tool result passed to the model (truncated past the limit) |

### `console.profiles`

Each profile holds one set of credentials and one or more model deployments:

```jsonc
"profiles": {
  "openai": {
    "label": "OpenAI",
    "model": "openai/gpt-5-mini",
    "apiKeyEnv": "OPENAI_API_KEY"
  }
}
```

Allowed profile fields (strict):

| Field | Required | Meaning |
| --- | --- | --- |
| `label` | — | Display name in the Model dropdown |
| `model` | exactly one of `model`/`models` | Single LiteLLM model name, e.g. `openai/gpt-5-mini` |
| `models` | exactly one of `model`/`models` | Map of deployment id → per-model object for multiple deployments |
| `defaultModel` | with `models` | Which deployment id is preselected; must name one of `models` (defaults to the first) |
| `defaultReasoningEffort` | — | One of `minimal`, `low`, `medium`, `high`, `xhigh` |
| `apiKeyEnv` | — | Name of the env var holding the API key |
| `apiBaseEnv` | — | Name of the env var holding the base URL (OpenAI-compatible endpoints) |
| `apiVersionEnv` | — | Name of the env var holding an API version, for endpoints that require one |

Every `*Env` value must be a valid uppercase environment-variable name
(`/^[A-Z][A-Z0-9_]*$/`); a raw secret there is rejected. Credentials are read
from the environment only, never persisted.

Per-model objects (under `models`):

| Field | Meaning |
| --- | --- |
| `label` | Display name |
| `model` | LiteLLM model name, e.g. `openai/deepseek-v4-flash-free` |
| `reasoningEffort` | Fixed reasoning-effort level for every request |
| `variants` | Map of dropdown label → exact value sent to the provider (non-OpenAI schemes); `{}` disables reasoning effort for the model |

Validation rules:

- A profile must define **exactly one** of `model` or `models`.
- `defaultModel` requires `models` and must name one of its keys.
- `defaultReasoningEffort` must be one of the OpenAI-standard levels.
- A model cannot combine `variants: {}` with a fixed `reasoningEffort`.
- `console.profiles` must be non-empty; `models` must be non-empty.

Precedence for reasoning effort: per-chat dropdown selection > model
`reasoningEffort` > profile `defaultReasoningEffort` > provider default. See
[`llm-providers.md`](llm-providers.md#reasoning-effort) for the full behavior.

### The Console wizard

On the first authenticated chat, the Console wizard (`write_provider_setup`)
offers presets for `openai-compatible`, `openai`, or `anthropic`. It writes a
single-profile `console` section and **replaces the whole `console` section**,
so re-running it overwrites any hand-edited profiles. The discovery scripts
(`discover:opencode-go`, `discover:opencode-zen`) instead **merge** their
profiles and preserve existing ones, limits, and `defaultProfile` unless
`--set-default` is passed.

## Environment variables

### Catalog home and runtime

| Variable | Purpose |
| --- | --- |
| `CATENCE_HOME` | Catalog home (default `~/.catence`); equivalent to `--home` |
| `CATENCE_HTTP_HOST` / `CATENCE_HTTP_PORT` | Defaults for `catence serve --host/--port` (host `127.0.0.1`, port `8787`) |

Provider credentials are normally stored per athlete with
`catence-data secret set` (see [`local-mcp.md`](deployment/local-mcp.md#3-store-provider-credentials-stdin-only-never-shell-history)); those secrets are injected
into the provider worker environment, and inherited `GARMIN_*`/`INTERVALS_*`/
`STRAVA_*` variables are stripped first so an athlete without a provider cannot
inherit its credentials.

For local and Docker development you can also keep credentials in env without
`secret set` — see the two fallback modes below. File values always win over
env, so a `providers.json` entry overrides any env fallback for that field.

### Provider credentials via env (dev fallback)

Two opt-in env fallbacks are checked **only when a `providers.json` field is
missing** — file values always win. See `src/core/runtime/secrets.ts:51`.

| Mode | Variables | When allowed | Example for athlete `alex` |
|------|-----------|--------------|----------------------------|
| **Per-athlete scoped** (recommended, multi-athlete safe) | `CATENCE_ATHLETE_<ID>_<PROVIDER_VAR>` — prefix is `CATENCE_ATHLETE_` + upper-cased athlete id with `-` → `_` + `_` | **Always** — checked even when the generic flag is off. Only maps to that one athlete. | `CATENCE_ATHLETE_ALEX_GARMIN_EMAIL=alex@example.com` `CATENCE_ATHLETE_ALEX_INTERVALS_API_KEY=…` |
| **Generic** (single-athlete dev, opt-in) | `GARMIN_EMAIL`, `GARMIN_PASSWORD`, `INTERVALS_API_KEY`, `INTERVALS_ATHLETE_ID`, `STRAVA_CLIENT_ID`, `STRAVA_CLIENT_SECRET` | Only when `CATENCE_ALLOW_ENV_SECRETS` (or alias `CATENCE_SECRETS_FROM_ENV`) is `1`/`true`/`yes`/`on` in the worker's env. Without the flag, bare provider env vars are stripped. | `CATENCE_ALLOW_ENV_SECRETS=1` + `GARMIN_EMAIL=…` |

Resolution order per field: `providers.json` → `CATENCE_ATHLETE_<ID>_<VAR>` → (if flag set) `VAR`. Set `CATENCE_ALLOW_ENV_SECRETS=1` in `.env.dev` / `docker-compose.dev.yml` for single-athlete Docker dev, or prefer per-athlete vars for a shared catalog.

### Console auth and serving

| Variable | Purpose |
| --- | --- |
| `CATENCE_CONSOLE_USERNAME` | Console login username (required) |
| `CATENCE_CONSOLE_PASSWORD_HASH` | bcrypt hash for the login password (required; `catence-console auth hash-password`) |
| `CHAINLIT_AUTH_SECRET` | JWT signing secret for the Console session (required) |
| `CATENCE_HOME` | Data home served by the Console (default `~/.catence`) |
| `CATENCE_MCP_URL` | MCP endpoint for the Console (default `http://127.0.0.1:8787/mcp`; when unset the Console auto-starts a runtime) |
| `CATENCE_CONSOLE_HOST` | Default for `--ui-host` (`127.0.0.1`) |

### Model providers

Each env var name is referenced by a profile's `apiKeyEnv` / `apiBaseEnv` /
`apiVersionEnv`; see [`llm-providers.md`](llm-providers.md) for the full
provider guide. Common ones from [`config.example.json`](../config.example.json):

| Variable | Profile |
| --- | --- |
| `OPENAI_API_KEY`, `OPENAI_API_BASE`, `OPENAI_API_VERSION` | `openai`, `openai-compatible`, Azure, Opencode proxy |
| `ANTHROPIC_API_KEY` | `anthropic` |
| `OPENCODE_GO_API_KEY`, `OPENCODE_GO_API_BASE`, `OPENCODE_GO_MESSAGES_API_BASE` | `opencode-go`, `opencode-go-messages` |
| `OPENCODE_API_KEY`, `OPENCODE_ZEN_API_BASE`, `OPENCODE_ZEN_RESPONSES_API_BASE` | `opencode-zen`, `opencode-zen-responses` |

### Docker (`.env`, generated by `deploy-console.sh`)

| Variable | Purpose |
| --- | --- |
| `CATENCE_NPM_VERSION` | npm package version to install in the image |
| `CATENCE_CONSOLE_VERSION` | PyPI `catence-console` version (PEP 440) |
| `CATENCE_CONSOLE_PORT` | Host port for the Console (default 8000) |
| `CATENCE_MCP_BIND` | MCP bind: `127.0.0.1` loopback (default) or `0.0.0.0` for network/Tailscale exposure; also drives the compose port mapping |

See [`docker.md`](deployment/docker.md) for the Docker workflow.