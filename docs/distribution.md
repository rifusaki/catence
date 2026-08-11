# Distribution and release readiness

Catence now has a repeatable distribution path without publishing a package or
creating a release as part of normal development.

## Artifacts

| Surface | Source | Consumer path |
| --- | --- | --- |
| npm | `package.json` and compiled `dist/` | `npm install --global catence` or `npx --yes catence@<version> demo` |
| APM | `apm.yml` | `apm install rifusaki/catence#v<version>` configures normal and generated-demo MCP entries |
| MCPB | `mcpb/manifest.json` | Attach the platform-specific `catence-demo-<version>-<platform>-<arch>.mcpb` release asset in an MCPB-capable desktop client |

The package exposes two binaries:

- `catence` starts the stdio MCP server, `catence serve` starts the loopback
  Streamable HTTP server, and `catence demo` creates a generated store before
  starting stdio.
- `catence-data` manages `init`, `sync`, `backfill`, provider authentication,
  retrieval-index rebuilding, and `demo` generation.

`catence-data demo` defaults to `./catence-demo`; `catence demo` does the same.
Both commands refuse to modify an existing directory unless it contains the
Catence demo marker. Generated data is marked in every MCP tool response.

## Release gates

`npm run release:check` requires the version in `package.json`, `apm.yml`, and
`mcpb/manifest.json` to agree. When invoked for a Git tag, it also requires
the tag to be `v<package-version>`.

The verification workflow runs TypeScript checking, a moderate-or-higher npm
dependency audit, all tests, a npm-pack dry run, and MCPB-manifest validation.
The tag workflow then:

1. builds an MCPB on Linux, macOS, and Windows, with the bundle manifest
   restricted to its native platform because DuckDB includes a native binding;
2. publishes npm with provenance;
3. validates that the versioned APM manifest installs the two intended MCP
   entries in a clean consumer root; and
4. uploads the MCPB artifacts to the GitHub release. The tagged source tree is
   itself the APM package.

The `release` GitHub environment is intentional: publishing waits for that
environment's approval rules. Configure npm trusted publishing for
`rifusaki/catence` or supply `NPM_TOKEN` before creating the first `v0.1.0`
tag.

## Current operational gaps

- The npm package name is available at the time this document was written, but
  it is not claimed until the first successful npm publish.
- The MCPB demo bundle includes Node dependencies for its target platform. It
  is intentionally a generated-data experience; live Garmin/Intervals/Strava
  setup remains explicit so a desktop extension never receives provider
  credentials by surprise.
- Live Garmin and Strava extraction still require Python 3.12 and `uv`; a
  future fully bundled provider runtime would remove that prerequisite.
- MCPB artifacts are unsigned until a production code-signing certificate is
  configured. MCPB-capable clients may show an unsigned-extension warning.
- The Console currently remains a source-checkout experience because it uses a
  sibling `catence-ui` workspace. It is not part of the npm or MCPB runtime.
- CI produces native MCPB assets for the standard GitHub runner architectures.
  ARM Linux and Windows-on-ARM need additional runners before assets can be
  advertised for those targets.

These gaps are product/release work, not silent runtime fallbacks: the npm and
APM paths make their assumptions explicit, and the demo stays synthetic until
the user runs the separate live sync workflow.
