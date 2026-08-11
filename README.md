# Catence

Local MCP server for primary Garmin data, with added Intervals.icu metrics and Strava enrichment.

![](docs/assets/image.png)

## What?

As a context, I'm both an endurance athlete and a data junkie. I already got a coach for all the serious stuff, but I wanted to hook up some—any—LLM to the insane amount of data collected from Garmin, derived on Intervals.icu (I don't pay for TrainingPeaks) and comparable efforts on Strava segments. Naturally, the first answer was a local MCP server for my current tooling.

## Scope

Currently a bit limited but I'd like to expand it:

- [x] Garmin, Intervals.icu, Strava data fetching
- [x] Data normalization and storage
- [x] Read-only local MCP server
- [x] Local Streamable HTTP server
- [x] Release-ready npm, [APM](https://github.com/microsoft/apm), and MCPB distribution artifacts
- [x] Generated demo store for safe MCP evaluation
- [x] Bundled local Chainlit Console with persisted chat history
- [ ] Data writing (training sessions, plans)
  - [ ] TrainingPeaks support?
- [ ] Limited multi-user support (see Caveats)

## What Catence can help you do

Catence is most useful when a question benefits from checking several local signals instead of reacting to a single score. The Console and MCP tools can help you explore questions such as:

- **Recovery and readiness:** “What changed in my sleep, HRV, resting heart rate, stress, and recent load before today’s session?”
- **Training load:** “Is this week harder than my recent baseline, and which sessions contributed most?”
- **Performance trends:** “How has my threshold pace, cycling power, or swim efficiency changed across the season?”
- **Session review:** “Compare this long run or interval set with similar recent efforts, including pace/power, heart rate, terrain, and recovery.”
- **Segments and gear:** “Show my history on this climb,” or “which shoes and bikes have carried the most recent training volume?”
- **Data-quality review:** “Which recent activities lack streams, power, health context, or a matching provider record?”

## Sources

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

What I mean by multi-user is being able to manage and serve various users' data on the same server.

## Data

Priority is assigned per data type. Missing values mean the provider did not supply that metric.

| Data group | Priority and provenance | Data available per activity or date | Aggregated data |
| --- | --- | --- | --- |
| Generic activity data | <ol><li>Garmin (canonical activity data)</li><li>Intervals.icu (supplemental analysis)</li></ol> | Date/time, timezone, sport, name, distance, elapsed/moving time, elevation, calories, average/max HR, source identity, and quality flags | Activity count, distance, duration, elevation, and calories by date range |
| Running — indoor and outdoor | <ol><li>Garmin (activity facts and streams)</li><li>Intervals.icu (analysis values)</li></ol> | Pace/speed, cadence, HR, power when available, GPS, elevation, grade, splits, intervals, VO₂max, lactate-threshold metrics, and race predictions | Running volume, pace/load trends, and training-metric history |
| Cycling — indoor and outdoor | <ol><li>Garmin (activity facts, FIT streams, and settings)</li><li>Intervals.icu (load, RPE, feel, and weighted power)</li></ol> | Average/weighted power, cadence, speed, HR, GPS, elevation, grade, temperature, cycling dynamics, splits, and FTP observations | Power-duration bests, power coverage, cycling volume/load, and FTP trends |
| Swimming — pool and open water | <ol><li>Garmin (explicit lengths and summaries)</li><li>Intervals.icu (auto-detected sets)</li></ol> | Lengths/laps, pool length, distance, duration, stroke count/rate, SWOLF, average/max HR, sets, and GPS when supplied | Swim volume, session comparisons, and data-completeness summaries |
| Structured intervals and sets | <ol><li>Intervals.icu (Intervals-based intervals)</li><li>Garmin (Garmin splits and sets)</li></ol> | Interval labels, repetitions, duration, moving time, distance, pace, power, HR, intensity, and swim-set details | Interval volume, intensity, and provider-specific comparisons |
| Daily health and wellness | <ol><li>Garmin (primary health data)</li></ol> | HR, resting HR, HRV, sleep, sleep score, stress, Body Battery, readiness, SpO₂, weight, steps, hydration, and nutrition | Daily, weekly, and monthly health and nutrition trends |
| Strava segments and gear | <ol><li>Strava (source of record)</li></ol> | Segment names, grades, climb category, elevation, effort time/distance, power, HR, cadence, PR/KOM ranks, bikes, shoes, and historic efforts | Segment, climb, effort-history, and gear comparisons |
| Derived and cross-source analytics | <ol><li>Garmin (canonical inputs)</li><li>Intervals.icu (interval inputs)</li><li>Strava (segment and gear inputs)</li><li>Catence (derived results)</li></ol> | Reconciled activity values and source-quality flags | Rolling statistics, baselines, correlations, seasonal comparisons, trends, descriptive model fits, and progress reports |

## Set up

Catence exposes the same local MCP server over stdio and optional Streamable HTTP. A tagged release publishes the `catence` npm package, platform-specific MCPB demo bundles, and an APM package. Until that first public release is available, the source-checkout commands below remain fully supported.

### Safe one-command demo

After publication, start a no-account MCP server with generated data:

```sh
npx --yes catence@0.1.0 demo
```

It creates `./catence-demo` by default and refuses to replace a directory that is not already marked as a Catence demo. The synthetic store deliberately
contains lagged training-load/recovery effects, a multi-signal anomaly period, and some missing sleep-score dates. Every MCP result includes a generated-data disclaimer, so it cannot be mistaken for a personal health record.

From a source checkout, the equivalent command is:

```sh
npm run catence-data -- demo
npm run mcp -- demo --data-dir ./catence-demo
```

### Install for live data

After publication, install the package once, then create and synchronize a store that you own:

```sh
npm install --global catence@0.1.0
catence-data --data-dir /absolute/path/to/catence-data init
catence-data --data-dir /absolute/path/to/catence-data sync --provider all
catence-data --data-dir /absolute/path/to/catence-data build-retrieval-index
catence --data-dir /absolute/path/to/catence-data
```

### Prerequisites

- Node.js 22 or later
- Python 3.12 or later and [uv](https://docs.astral.sh/uv/) for Garmin and Strava provider syncs

Clone the repository, install the Node and Python dependencies, and create your local `.env` with the following credentials:

- Garmin email/password
- Intervals.icu [API Key and Athlete ID](https://forum.intervals.icu/t/api-access-to-intervals-icu/609)
- Strava [Client ID and Secret](https://stravalib.readthedocs.io/en/latest/get-started/authenticate-with-strava.html)

### Create and sync a local data store

By default, runtime data is placed in `.catence/` inside the checkout. You can also choose an absolute path outside the repository and supply it consistently with `--data-dir` (or set `CATENCE_DATA_DIR`). The examples below use an absolute path.

```sh
npm run catence-data -- --data-dir /absolute/path/to/catence-data init
npm run catence-data -- --data-dir /absolute/path/to/catence-data sync --provider all
npm run catence-data -- --data-dir /absolute/path/to/catence-data build-retrieval-index
```

The retrieval index is derived context for agent search; rebuild it after a sync. Syncs are incremental after the first import. Use `backfill` only for an explicit historical range, and add `--refresh` only when you intentionally want to re-fetch already covered Garmin activity details, files, and streams.

### Common commands

Run these from the repository root. Omit `--data-dir` to use the checkout's `.catence/` directory.

```sh
# Inspect local coverage and sync individual providers
npm run catence-data -- status
npm run catence-data -- sync --provider intervals
npm run catence-data -- sync --provider garmin --from 2025-07-29
npm run catence-data -- sync --provider strava
npm run catence-data -- sync --provider all

# Recover or import a specific historical range
npm run catence-data -- retry --run <run-id>
npm run catence-data -- backfill --from 2020-01-01
npm run catence-data -- backfill --provider garmin --from 2026-07-01 --refresh

# Refresh derived search context and launch the local MCP server
npm run catence-data -- build-retrieval-index
npm run mcp
npm run mcp -- --data-dir /absolute/path/to/catence-data

# Optional local Streamable HTTP MCP and dashboard API
npm run mcp -- serve --data-dir /absolute/path/to/catence-data --allow-origin http://127.0.0.1:8000
npm run mcp -- serve --allow-origin http://127.0.0.1:8000
```

The first manual sync uses the previous 12 months only when there is no local normalized coverage. `sync --provider strava` refreshes gear data. Strava activity segments and gear are enriched on demand by the MCP tools.

### Connect Strava

With `STRAVA_CLIENT_ID` and `STRAVA_CLIENT_SECRET` in `.env`, the local callback flow avoids copying a code out of the browser URL. Register `http://127.0.0.1:8765/strava/callback` as the authorization callback in the Strava application, then run:

```sh
npm run catence-data -- auth strava --callback
```

The command prints the authorization URL to the terminal, waits up to five minutes for the browser callback, validates OAuth state, and stores the resulting token only in `<data-dir>/secrets/strava.json`.

The existing manual flow remains available for headless use:

```sh
npm run catence-data -- auth strava
npm run catence-data -- auth strava --code <authorization-code>
```

Catence requests `read`, `activity:read_all`, and `read_all`. To remove the stored Strava connection later, run:

```sh
npm run catence-data -- disconnect strava
```

## Run the local Console

The Console is Catence’s local chat experience. It sends model calls through LiteLLM in-process and calls the same Streamable HTTP MCP tools that a coding agent uses. Provider keys are never written to Catence configuration or chat storage.

### Install and launch

After publication, the Console is a separate Python distribution. It includes the Catence-maintained Chainlit frontend and starts the matching npm runtime on loopback automatically:

```sh
uvx catence-console@0.1.0 serve --data-dir /absolute/path/to/catence-data
```

The command needs Node.js 22 and `npx`, but does not require a Catence or `catence-ui` checkout. Pass `--mcp-url http://127.0.0.1:8787/mcp` when you intentionally want to use an already-running compatible Catence runtime.

For source development, install the locally built `catence-chainlit` wheel and run `uv run --project console catence-console serve` from this repository.

### First-run setup

Launch the Console once with your selected provider’s environment variables in the terminal. If `<data-dir>/config.json` has no Console section, the browser walks through provider and model selection (Azure, OpenAI, or Anthropic) and writes only non-secret configuration. For example:

```sh
# Azure OpenAI / Foundry: use the Azure resource root and the Responses API route.
export AZURE_API_KEY='…'
export AZURE_API_BASE='https://your-resource.openai.azure.com'
export AZURE_API_VERSION='preview'

uvx catence-console@0.1.0 serve --data-dir /absolute/path/to/catence-data
```

For an existing configuration or an automated setup, add a `console` section to `<data-dir>/config.json`. It defines named providers and deployments and environment-variable *names*, never credential values. The complete shape is in [`config.example.json`](config.example.json). For the two common direct providers, the minimal profiles are:

```json
{
  "openai": {
    "label": "OpenAI",
    "model": "openai/gpt-5-mini",
    "apiKeyEnv": "OPENAI_API_KEY"
  },
  "anthropic": {
    "label": "Anthropic",
    "model": "anthropic/claude-sonnet-4-5",
    "apiKeyEnv": "ANTHROPIC_API_KEY"
  }
}
```

A provider with several deployments looks like this:

```json
{
  "console": {
    "defaultProfile": "provider",
    "limits": {
      "toolRounds": 8,
      "toolResultCharacters": 24000
    },
    "profiles": {
      "azure-foundry": {
        "label": "Provider",
        "defaultModel": "terra",
        "defaultReasoningEffort": "medium",
        "models": {
          "terra": { "label": "GPT-5.6 Terra", "model": "provider/gpt-5.6-terra" },
          "luna": { "label": "GPT-5.6 Luna", "model": "provider/gpt-5.6-luna" },
          "sol": { "label": "GPT-5.6 Sol", "model": "provider/gpt-5.6-sol" }
        },
        "apiKeyEnv": "API_KEY",
        "apiBaseEnv": "API_BASE",
        "apiVersionEnv": "API_VERSION"
      }
    }
  }
}
```

An OpenAI-compatible provider such as OpenCode uses a model such as `openai/your-model` plus `apiBaseEnv` and, if needed, `apiKeyEnv`. LiteLLM handles provider normalization.

The Console shows all configured deployments in its Model selector and sends the selected Thinking effort to LiteLLM as `reasoning_effort`. Choose only efforts supported by the selected deployment. Existing profiles with a single `model` remain supported.

### Launching

Set the referenced variables in the terminal that will run the Console, then launch everything on loopback with one command:

```sh
uvx catence-console@0.1.0 serve --data-dir /absolute/path/to/catence-data
```

On its first normal launch this starts the matching Catence runtime at `http://127.0.0.1:8787`, permits only the local Console origins, and serves the prebuilt chat and dashboard at `http://127.0.0.1:8000`.

To preflight a profile and an already-running Catence HTTP server, use:

```sh
uvx catence-console@0.1.0 doctor \
  --data-dir /absolute/path/to/catence-data \
  --mcp-url http://127.0.0.1:8787/mcp
```

`doctor` reports profile IDs, models, missing environment-variable names, and Catence health.

### Local chat history

Console chats, messages, tool steps, and thread metadata are persisted at `<data-dir>/console/chat-history.sqlite3`. A later turn receives a compact list of prior calls (not their results); it can lazily load one saved result when it is material, or repeat the authoritative call for fresh data.

## Add Catence to an MCP client

First complete the setup and at least one sync. For a packaged install, point a client to the installed `catence` binary (or use the safe demo command):

```sh
catence --data-dir /absolute/path/to/catence-data
npx --yes catence@0.1.0 demo
```

For a source checkout, each client should start the same local command, pointing at the same absolute data directory:

```sh
npm --prefix /absolute/path/to/catence run mcp -- --data-dir /absolute/path/to/catence-data
```

The MCP server's ordinary reads are local and read-only. Its explicit Strava hydration tools are the exception; they use the already stored local connection and a shared write lock. `catence serve` retains the same tools at `/mcp` and also exposes loopback dashboard data at `/api/v1/dashboard`; browser origins must be allowed explicitly with `--allow-origin`.

### Codex

For a first look, add the generated demo server from the terminal:

```sh
codex mcp add catence-demo -- npx --yes catence@0.1.0 demo
```

For a live npm install, use:

```sh
codex mcp add catence -- catence --data-dir /absolute/path/to/catence-data
```

For a source checkout, use:

```sh
codex mcp add catence -- npm --prefix /absolute/path/to/catence run mcp -- --data-dir /absolute/path/to/catence-data
```

Alternatively, add this to `~/.codex/config.toml` for a personal installation, or `.codex/config.toml` in a trusted repository:

```toml
[mcp_servers.catence]
command = "npm"
args = ["--prefix", "/absolute/path/to/catence", "run", "mcp", "--", "--data-dir", "/absolute/path/to/catence-data"]
startup_timeout_sec = 30
```

### OpenCode

Add this local MCP definition to `opencode.json` or `opencode.jsonc`:

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "mcp": {
    "catence": {
      "type": "local",
      "command": [
        "npm",
        "--prefix",
        "/absolute/path/to/catence",
        "run",
        "mcp",
        "--",
        "--data-dir",
        "/absolute/path/to/catence-data"
      ],
      "enabled": true
    }
  }
}
```

### Claude Code

Add the local stdio server from a terminal:

```sh
claude mcp add --transport stdio catence -- npm --prefix /absolute/path/to/catence run mcp -- --data-dir /absolute/path/to/catence-data
```

Use Claude Code's MCP listing command to confirm it was added:

```sh
claude mcp list
```

### APM and MCPB

The repository's [`apm.yml`](apm.yml) registers both `catence` and the safe `catence-demo` server with supported agent clients. After a tag is published:

```sh
apm install rifusaki/catence#v0.1.0
```

Each release also attaches platform-specific `catence-demo-*.mcpb` files. Open the matching file in an MCPB-capable desktop client (including Claude Desktop) to install the one-click generated demo. Live-source setup remains an explicit CLI step, so the bundle never requests or stores provider credentials.

## Wellness shortcuts

Catence keeps its flexible catalog and analytical tools, and now exposes four small opinionated wellness tools for common recovery questions:

- `wellness_correlate` compares curated recovery/training metrics and can scan lags from −7 to +7 days.
- `wellness_baselines` returns a trailing mean, standard-deviation band, latest value, and latest z-score.
- `wellness_anomalies` finds statistical outliers and dates with multiple unusual signals; it does not diagnose or prescribe.
- `wellness_coverage` shows absent dates and unresolved extraction errors without assuming that missing data means rest or a health outcome.

They use the same source-aware `daily_health` and `canonical_activity_training` projections as the general query tools. See [distribution and release notes](docs/distribution.md) for the current tooling.
