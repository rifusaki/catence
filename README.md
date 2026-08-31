# Catence

Local MCP server for primary Garmin data, with added Intervals.icu metrics and Strava enrichment.

![Catence](docs/assets/image.png)

## ... what?

As a context, I'm both an endurance athlete and a data junkie. I already got a coach for all the serious stuff, but I wanted to hook up some—any—LLM to the insane amount of data collected from Garmin, derived on Intervals.icu (I don't pay for TrainingPeaks) and comparable efforts on Strava segments. Naturally, the first answer was a local MCP server for my current tooling.

## What is included

- Garmin, Intervals.icu, and Strava ingestion with source-aware normalization.
- Read-only MCP tools, plus explicitly named, lock-guarded write tools for Strava hydration and detached syncs.
- One shared Catence agent can serve several isolated athlete stores. Every personal-data MCP call names an `athleteId`; Catence never silently combines athletes.
- A password-protected Chainlit Console with an authenticated dashboard, a data-sync button with live progress, and in-app model management.
- A generated demo catalog for safe evaluation in Glama, desktop MCP clients, or local development.

Catence helps explore recovery, training load, trends, activity detail, swimming/cycling/running progress, segments, gear, and data quality. It reports the evidence and coverage it can see; it does not diagnose or prescribe training.

## Requirements

- Node.js 22+
- Python 3.12+ and [uv](https://docs.astral.sh/uv/) for Garmin and Strava provider workers
- Provider credentials for the athletes you choose to sync

## Quick start

Install Catence and create the first athlete. The default catalog home is `~/.catence`; set `CATENCE_HOME` or pass `--home` to use a different location.

Every `catence-data` command requires `--athlete <id>`; there is no default athlete. Pair it with `--home <dir>` to select the catalog when not using the default home.

```sh
npm install --global catence@beta          # or catence@latest for stable
catence-data setup --athlete alex --label "Alex"
```

Store each provider value through stdin so it does not enter shell history. Values are written to the selected athlete's owner-only local secret file.

```sh
printf %s 'alex@example.com' | catence-data --athlete alex secret set --provider garmin --field email --value-stdin
printf %s 'your-garmin-password' | catence-data --athlete alex secret set --provider garmin --field password --value-stdin
printf %s 'intervals-api-key' | catence-data --athlete alex secret set --provider intervals --field apiKey --value-stdin
printf %s '12345' | catence-data --athlete alex secret set --provider intervals --field athleteId --value-stdin
```

Sync and create retrieval context:

```sh
catence-data --athlete alex sync --provider all
catence-data --athlete alex build-retrieval-index
```

Start the stdio MCP server:

```sh
catence
```

An agent first calls `list_athletes`, then includes `athleteId` with every data tool. This is intentional: a shared agent may access the stores you configured, but no tool implicitly aggregates or crosses between athletes.

### Add another athlete

```sh
catence-data athlete add --id sam --label "Sam"
printf %s 'sam@example.com' | catence-data --athlete sam secret set --provider garmin --field email --value-stdin
printf %s 'sam-password' | catence-data --athlete sam secret set --provider garmin --field password --value-stdin
catence-data --athlete sam sync --provider garmin
catence-data athlete list
```

Garmin, Intervals, and Strava client credentials are isolated per athlete. Strava OAuth tokens remain in that athlete's own store. The old 0.1 single-store directory cannot be migrated safely: create a fresh home and re-sync each athlete.

### Common operations

```sh
catence-data --athlete alex status
catence-data --athlete alex sync --provider intervals
catence-data --athlete alex sync --provider garmin --from 2025-07-29
catence-data --athlete alex backfill --provider garmin --from 2020-01-01 --refresh
catence-data --athlete alex retry --run <run-id>
catence-data --athlete alex progress --watch
catence-data --athlete alex auth strava --callback
catence-data --athlete alex disconnect strava
catence-data update --check
catence-data update
```

## Documentation

| Document | Covers |
| --- | --- |
| [Deployment: local MCP](docs/deployment/local-mcp.md) | Install, catalog, secrets, sync, background progress, stdio/HTTP MCP, demo, common operations |
| [Deployment: local Console](docs/deployment/local-console.md) | Local web chat setup, model config, doctor, updates, troubleshooting |
| [Deployment: Docker](docs/deployment/docker.md) | One-container stack: deploy script, `.env`, sync.sh, MCP exposure (SSH/Tailscale), Cloudflare Tunnel |
| [Configuration](docs/configuration.md) | Complete `config.json` schema: rate limits, Strava budget, Console profiles, environment variables |
| [LLM providers](docs/llm-providers.md) | Model providers (OpenAI, Anthropic, OpenAI-compatible/Azure, Opencode Go/Zen), reasoning effort |
| [Architecture](docs/architecture.md) | Design rationale, layers, data flow, serving |
| [MCP activity retrieval](docs/mcp-activity-retrieval.md) | Implementation contract for answering questions, current tools, planned endpoints |
| [Distribution](docs/distribution.md) | Release artifacts: npm, PyPI, APM, MCPB |

## MCP clients and HTTP

For a packaged installation, point a client at `catence`:

```sh
codex mcp add catence -- catence
claude mcp add --transport stdio catence -- catence
```

For a source checkout:

```sh
codex mcp add catence -- npm --prefix /absolute/path/to/catence run mcp
```

Optional local Streamable HTTP MCP and dashboard APIs:

```sh
catence serve --host 127.0.0.1 --port 8787
```

`GET /api/v1/athletes` returns IDs and labels only. `GET /api/v1/dashboard` requires `athleteId`, for example `http://127.0.0.1:8787/api/v1/dashboard?athleteId=alex&days=28`. Browser origins must be listed with `--allow-origin`; the packaged Console instead proxies the dashboard through its authenticated same-origin route. The MCP server has no authentication of its own.

## Configuration

[`config.example.json`](config.example.json) documents rate limits, Strava budgets, and Console model profiles. Keep per-athlete provider values in `catence-data secret set`, not in `.env` or `config.json`. The full `config.json` schema —including per-model reasoning effort— is documented in [`docs/configuration.md`](docs/configuration.md) and [`docs/llm-providers.md`](docs/llm-providers.md).

For source development:

```sh
npm ci
npm run check
npm test
UV_CACHE_DIR=$PWD/.cache/uv uv run --project console --group dev python -m pytest console/tests -q
```

## Data and caveats

The current available sources respond to my own used platforms. I used some wrappers:

- [cyberjunky/python-garminconnect](https://github.com/cyberjunky/python-garminconnect)
- [paladini/node-intervals-icu](https://github.com/paladini/node-intervals-icu)
- [stravalib/stravalib](https://github.com/stravalib/stravalib)

Strava is only used for segments and gear.

### Caveats

There are two caveats to the data fetching, both coming from the fact that this was created to be used by a single person. Accessing the full Garmin API requires applying via a company—which I don't have—and getting Strava data for multiple users is another headache I don't want to get into.

- I don't use the official Garmin Connect API. The library uses email/pwd.
- Connecting Strava requires the user to be a Strava Premium subscriber and create an [API application](https://stravalib.readthedocs.io/en/latest/get-started/authenticate-with-strava.html). The rotating token is stored locally in
`<data-dir>/secrets/strava.json`.
