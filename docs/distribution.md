# Distribution and release readiness

## Artifacts

| Surface | Source | Consumer path |
| --- | --- | --- |
| npm | `package.json` and compiled `dist/` | `npm install --global catence` or `npx --yes catence@<version> demo` |
| PyPI Console | `console/pyproject.toml` | `uvx catence-console@<python-version> serve`; it starts the matching npm runtime unless `--mcp-url` is supplied |
| PyPI UI runtime | `catence-ui` fork | `catence-chainlit==<python-version>` provides the prebuilt maintained Chainlit frontend used by Console |
| APM | `apm.yml` | `apm install rifusaki/catence#v<version>` configures normal and generated-demo MCP entries |
| MCPB | `mcpb/manifest.json` | Attach the platform-specific `catence-demo-<version>-<platform>-<arch>.mcpb` release asset in an MCPB-capable desktop client |

The package exposes two binaries:

- `catence` starts the stdio MCP server, `catence serve` starts the loopback Streamable HTTP server, and `catence demo` creates a generated store before starting stdio.
- `catence-data` manages catalog `setup`, athlete selection, per-athlete secrets,
  `sync`, `backfill`, provider authentication, retrieval-index rebuilding, and
  `demo` generation.

`catence-data demo` and `catence demo` use `~/.catence-demo` by default. Both
commands refuse to modify an existing directory unless it contains the Catence
demo marker. Generated data is marked in every MCP tool response.

## Release gates

`release/manifest.json` maps the npm version to its PEP 440 Console and
Chainlit versions. The release check requires those fields and the protocol
version to agree with the npm package, Console package, runtime health
contract, APM manifest, and MCPB manifest. When invoked for a Git tag, it also
requires the tag to be `v<package-version>`.

The verification workflow runs TypeScript checking, a moderate-or-higher npm dependency audit, all tests, a npm-pack dry run, and MCPB-manifest validation. The tag workflow then:

1. builds an MCPB on Linux, macOS, and Windows, with the bundle manifest restricted to its native platform because DuckDB includes a native binding;
2. publishes npm with provenance;
3. validates that the versioned APM manifest installs the two intended MCP entries in a clean consumer root; and
4. builds and publishes the matching `catence-console` wheel after confirming that the manifest's exact `catence-chainlit` version is already available; and
5. uploads the MCPB artifacts to the GitHub release. The tagged source tree is itself the APM package.

The `release` GitHub environment is intentional: publishing waits for that environment's approval rules. Configure npm trusted publishing for `rifusaki/catence` before creating the first `v0.1.0` tag. Its publish job upgrades to npm 11.5.1 or newer and deliberately avoids `setup-node`'s registry authentication so npm uses the GitHub Actions OIDC identity. Before releasing the two Python artifacts, configure PyPI Trusted Publishing for the `pypi` environment in both the maintained `catence-ui` fork (`catence-chainlit`) and this repository (`catence-console`).

For beta tags, the dedicated `Beta` workflow publishes npm with the `beta`
dist-tag and creates a GitHub prerelease after the corresponding Chainlit beta
is available. The server procedure and acceptance criteria are in
[release/beta-checklist.md](../release/beta-checklist.md).