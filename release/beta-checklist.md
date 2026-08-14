# Beta-channel release and server acceptance checklist

Use the protected `beta` branch for release candidates. A beta tag publishes
to npm's `beta` dist-tag, PyPI, and a GitHub prerelease; pushes to `beta`
without a tag only run verification.

## 1. Prepare the three version mappings

Catence's JavaScript version is SemVer while Python package versions follow
PEP 440. For beta number `N`, use exactly this mapping:

| Artifact | Example for beta 1 |
| --- | --- |
| npm package, MCPB, APM, Git tag | `0.2.0-beta.1` / `v0.2.0-beta.1` |
| Console and Chainlit PyPI wheels | `0.2.0b1` |

On the `beta` branch, update `release/manifest.json` first:

```json
{
  "version": "0.2.0-beta.1",
  "pythonVersion": "0.2.0b1",
  "chainlitVersion": "0.2.0b1",
  "channel": "beta"
}
```

Then make the generated release values agree:

- `package.json`, `package-lock.json`, `mcpb/manifest.json`, `apm.yml`,
  `release/registries/glama.json`, and `src/contracts/release.ts` use the npm
  version.
- `console/pyproject.toml` uses the Python Console version and pins
  `catence-chainlit==0.2.0b1`.
- `console/catence_console/release.py` keeps the npm version because it starts
  the matching Node runtime.
- The maintained `catence-ui` fork uses `0.2.0b1` for its
  `catence-chainlit` wheel.

Run `npm run release:check`. It rejects a beta mapping that does not convert
`X.Y.Z-beta.N` to `X.Y.ZbN` exactly.

## 2. Publish the UI runtime first

Build, test, and publish `catence-chainlit==0.2.0b1` from the maintained UI
fork before tagging Catence. The Catence beta workflow explicitly installs that
exact wheel before it will build the Console. This prevents a Console beta from
silently shipping an older dashboard frontend.

Configure PyPI Trusted Publishing for the new `Beta` workflow in both
repositories before the first run. Also configure npm trusted publishing for
the same workflow file. The GitHub `beta` environment should require manual
approval.

## 3. Publish the Catence beta

```sh
git switch beta
npm ci
npm run release:check
npm run check
npm test
git tag v0.2.0-beta.1
git push origin beta v0.2.0-beta.1
```

The workflow publishes `catence@0.2.0-beta.1` with the `beta` tag and the
Console wheel `catence-console==0.2.0b1`. Do not update npm `latest`, Glama's
public stable listing, or an existing production server during this stage.

## 4. Deploy registry artifacts to the beta server

On the server, clone only the release configuration or copy these files from
the candidate commit: `docker-compose.beta.yml`,
`console/Dockerfile.registry`, and `.env.beta.example`.

```sh
cp .env.beta.example .env.beta
# Edit versions, Console credentials, and one model-provider key.
docker compose --env-file .env.beta -f docker-compose.beta.yml build --pull
docker compose --env-file .env.beta -f docker-compose.beta.yml up -d
```

The registry Dockerfile installs `catence@<npm beta>` and
`catence-console==<Python beta>` from public registries. It does not copy the
working tree into the image, so this checks the artifacts users will receive.
Its Catence home is a dedicated named volume, `catence-beta-data`.

Initialize either a generated demo catalog or a deliberately chosen test
athlete. Never mount the production Catence home into this compose stack.

```sh
docker compose --env-file .env.beta -f docker-compose.beta.yml run --rm \
  --entrypoint catence-data console setup --athlete beta-athlete --label "Beta athlete"

# Secrets go through stdin and are stored only in the beta volume.
printf %s 'value' | docker compose --env-file .env.beta -f docker-compose.beta.yml run --rm -T \
  --entrypoint catence-data console --athlete beta-athlete secret set \
  --provider intervals --field apiKey --value-stdin
```

Keep the Console port bound to `127.0.0.1`. Cloudflare Tunnel may route its
HTTPS hostname to `http://127.0.0.1:8000`; never route Catence port 8787 to the
Internet. For remote MCP checks, use SSH port forwarding instead.

```sh
ssh -L 8787:127.0.0.1:8787 beta-server
```

## 5. Acceptance checklist

- [ ] `docker compose ... ps` shows Console healthy.
- [ ] Visiting the Cloudflare hostname redirects to/login requires the shared
      password; an incorrect password is rejected.
- [ ] An unauthenticated `GET /api/v1/dashboard` on the Console origin returns
      `401`; it works after login.
- [ ] The dashboard stays on the Console hostname and the athlete selector
      changes only that athlete's data.
- [ ] `catence-data athlete list` returns only configured IDs and labels.
- [ ] An MCP client can call `list_athletes`; data tools reject a missing or
      unknown `athleteId` and return the selected athlete in successful output.
- [ ] Two demo/test athletes return distinct data and cannot be aggregated by a
      single tool call.
- [ ] Provider credentials are absent from `config.json`, Console chat history,
      logs, and shell history; each `providers.json` file is mode `0600`.
- [ ] Run one incremental provider sync and one Strava hydration (if configured)
      while the Console is live, confirming lock contention is reported safely.
- [ ] Restart the Compose stack and verify data, selected-athlete preference,
      and chat history persist in the beta volume.
- [ ] Test MCP through SSH forwarding; confirm port 8787 has no public listener.

## 6. Promotion or rollback

Promote only by preparing a fresh final `0.2.0` release from the tested beta
commit; do not retag a prerelease as `latest`. To roll back the beta server,
stop the compose project and retain the named beta volume for diagnosis:

```sh
docker compose --env-file .env.beta -f docker-compose.beta.yml down
```

Production data and the production package channels remain untouched.
