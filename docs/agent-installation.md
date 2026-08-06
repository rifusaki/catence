# Install Catence for local coding agents

`catence` is a local stdio MCP server. Ordinary tools serve an existing DuckDB/Parquet snapshot read-only. The only write capabilities are explicit, synchronous Strava activity, serial activity-batch, and segment-history hydration tools; they use the shared data-directory lock and the stored local Strava connection, never credentials supplied by the MCP client.

## 1. Prepare one local data directory

Choose an absolute path outside a source checkout. For example,
`/Users/you/Library/Application Support/catence` on macOS or
`C:\Users\you\AppData\Local\catence` on Windows.

```sh
npx --yes --package=catence catence-data --data-dir /absolute/path/to/catence-data init
```

Run imports and retrieval-index generation through the management CLI:

```sh
npx --yes --package=catence catence-data --data-dir /absolute/path/to/catence-data sync --provider all
npx --yes --package=catence catence-data --data-dir /absolute/path/to/catence-data build-retrieval-index
```

`sync --provider intervals` needs the Intervals environment variables. Garmin
imports additionally require Python 3.12+ and `uv`; the npm package includes
the worker source and keeps the `uv` environment in
`<data-dir>/python-venv`. Ordinary server reads do not need those credentials or Python. The Strava hydration tools require the local Strava connection and Python worker, but still receive no secrets through the MCP client.

For a repeatable local executable instead of an on-demand `npx` download:

```sh
npm install --global catence
catence-data --data-dir /absolute/path/to/catence-data status
```

## 2. Configure the agent

Every configuration below starts the same command. Use an absolute
`--data-dir` so the snapshot does not depend on the agent's working directory.

### Codex

With the Codex CLI:

```sh
codex mcp add catence -- npx --yes catence --data-dir /absolute/path/to/catence-data
```

Or add the following to `~/.codex/config.toml` for a personal default, or
`.codex/config.toml` for one trusted repository:

```toml
[mcp_servers.catence]
command = "npx"
args = ["--yes", "catence", "--data-dir", "/absolute/path/to/catence-data"]
startup_timeout_sec = 30
```

Codex supports stdio MCP servers and shares this configuration between its CLI
and IDE extension. The `30`-second startup allowance avoids first-run `npx`
download delays. After the package is installed globally, replace `command`
and `args` with:

```toml
command = "catence"
args = ["--data-dir", "/absolute/path/to/catence-data"]
```

### OpenCode

OpenCode uses a local MCP definition in `opencode.json` or `opencode.jsonc`:

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "mcp": {
    "catence": {
      "type": "local",
      "command": [
        "npx",
        "--yes",
        "catence",
        "--data-dir",
        "/absolute/path/to/catence-data"
      ],
      "enabled": true
    }
  }
}
```

For a global install, set `command` to
`["catence", "--data-dir", "/absolute/path/to/catence-data"]`.

### Any other stdio MCP client

Use the executable and argument vector below in the client's local/stdio MCP
configuration:

```text
command: npx
args:    ["--yes", "catence", "--data-dir", "/absolute/path/to/catence-data"]
```

The MCP command accepts only `--data-dir` (or `CATENCE_DATA_DIR`) and `--help`.
It intentionally has no CLI network, sync, provider-authentication, or arbitrary file-path options. Its two declared hydration tools are the sole network/write exception and use only the Strava GET allowlist.

## Publishing checklist

The npm package is named `catence`. Before the first publish, run:

```sh
npm run check
npm test
npm pack --dry-run
npm publish --access public
```

`npm pack` includes the compiled Node entry points, this documentation, and the
Garmin Python worker/project metadata. It excludes runtime data, credentials,
and development caches.

## APM producer ramp (future)

[Agent Package Manager (APM)](https://microsoft.github.io/apm/) can distribute
Catence configuration to Codex, OpenCode, and other coding-agent harnesses from
one reviewed manifest. It complements the npm package; it does not install data,
run provider syncs, or host Catence for Open WebUI.

### Prerequisites

- Publish `catence` to npm and pin its version in every APM declaration.
- Create a public Git repository with commits, semantic-release tags, repository
  metadata, and a license.
- Keep the current npm/package validation in CI, then add APM validation and a
  scratch-consumer installation test.
- Require `CATENCE_DATA_DIR` to point at an already-created private snapshot.
  Never put provider credentials or health data in the package; supply the data directory at install time.

### APM package shape

Use `apm plugin init` when this becomes a real producer package. The package
should have an `apm.yml` plus optional `.apm/skills/` and
`.apm/instructions/` content that teaches agents about Catence provenance,
read-only behavior, and the distinction between source and logical activity IDs.

The MCP declaration is a self-defined stdio primitive, conceptually:

```yaml
name: catence
version: 0.1.0

dependencies:
  mcp:
    - name: catence
      registry: false
      transport: stdio
      command: npx
      args: ["--yes", "catence@0.1.0"]
      env:
        CATENCE_DATA_DIR: "${CATENCE_DATA_DIR}"
```

APM materializes that single declaration into each installed harness config. The
package must be installed as a direct dependency: APM intentionally skips a
transitive self-defined MCP server unless the consumer explicitly trusts it. The
installer should provide `CATENCE_DATA_DIR`; unresolved environment placeholders
are not a safe substitute for a known data location.

### Producer validation and release

Before shipping, run the APM producer loop in a scratch repository:

```sh
apm compile --validate
apm compile --dry-run
apm install ./path/to/catence-package
apm mcp list
apm audit
apm pack --dry-run --verbose
```

Then inspect the generated Codex and OpenCode configurations, test the pinned
`npx` command against a disposable data directory, publish the corresponding npm
version, and tag the Git release. APM bundles and marketplaces are useful only
after this direct install loop is reproducible.

### Relationship to future Open WebUI hosting

APM solves portable installation into local coding agents. It does not turn the
stdio process into a shared service. An Open WebUI-style integration still needs
a separate authenticated Streamable HTTP adapter around the same read-only query
layer, with per-user data isolation, TLS, rate/query limits, secret management,
and auditability. At that point APM can also declare the remote endpoint with
`transport: streamable-http`; it should not replace the local stdio option.

See the [APM producer guide](https://microsoft.github.io/apm/producer/),
[MCP primitive reference](https://microsoft.github.io/apm/producer/author-primitives/mcp-as-primitive/),
and [preview/validation loop](https://microsoft.github.io/apm/producer/preview-and-validate/).

## Open WebUI-style hosting: deliberately a later layer

This MVP is local-only and stdio-only. That remains the right boundary for private fitness data: ordinary MCP calls open a read-only DuckDB snapshot, while declared Strava hydration tools use the locked local writer path. It is not currently an HTTP service and should not be exposed
with a reverse proxy or a public tunnel.

When a web host is needed, add a separate Streamable HTTP adapter around the
same read-only server/query layer. It should require authentication, bind each
user to an isolated data directory, retain the current query limits and
provenance envelopes, and never turn an MCP argument into a filesystem path. The hosted boundary must preserve the same narrow writer lock, token isolation, and Strava GET allowlist.
That adapter can serve Open WebUI-like hosts without weakening the local MCP
contract.
