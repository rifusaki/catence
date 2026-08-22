#!/usr/bin/env node
// Discover OpenCode Go models and emit Catence Console profiles for them.
//
// Thin CLI wrapper around the runtime's src/core/runtime/opencode-go.ts
// module, which owns the "live discovery + trusted metadata" logic: the
// public `GET /models` endpoint returns only model ids, not which API each
// model needs, so routing comes from a trusted table intersected with the
// live list (the same approach OpenClaw uses).
//
// Usage:
//   node scripts/discover-opencode-go.mjs [--base-url <url>] [--write <config.json>] [--set-default]
//
// Flags:
//   --base-url <url>   Root of the OpenCode Go API (default https://opencode.ai/zen/go/v1).
//   --write <path>     Merge the two profiles into an existing config.json instead of printing to stdout.
//   --set-default      With --write, set console.defaultProfile to opencode-go even when one already exists.

import process from 'node:process';

let runtime;
try {
  runtime = await import(new URL('../dist/core/runtime/opencode-go.js', import.meta.url).href);
} catch (error) {
  if (error?.code !== 'ERR_MODULE_NOT_FOUND') throw error;
  process.stderr.write(
    'The discovery module is not built yet. Run `npm run build` in the catence checkout first, or use an installed `catence` package.\n',
  );
  process.exit(1);
}

const { OPENCODE_GO_API_BASE_ENV, OPENCODE_GO_API_KEY_ENV, OPENCODE_GO_MESSAGES_API_BASE_ENV } = runtime;

function usage() {
  process.stderr.write(
    'Usage: node scripts/discover-opencode-go.mjs [--base-url <url>] [--write <config.json>] [--set-default]\n',
  );
}

async function main() {
  const args = process.argv.slice(2);
  let baseUrl = runtime.OPENCODE_GO_DEFAULT_BASE_URL;
  let writePath = null;
  let setDefault = false;
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === '--base-url') {
      baseUrl = args[i + 1];
      if (!baseUrl) throw new Error('--base-url requires a URL.');
      i += 1;
    } else if (arg === '--write') {
      writePath = args[i + 1];
      if (!writePath) throw new Error('--write requires a config.json path.');
      i += 1;
    } else if (arg === '--set-default') {
      setDefault = true;
    } else if (arg === '--help' || arg === '-h') {
      usage();
      return;
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }

  if (!baseUrl.endsWith('/v1')) {
    process.stderr.write(`Warning: --base-url ${baseUrl} does not end in /v1; chat and responses URLs may be wrong.\n`);
  }
  const messagesBase = baseUrl.replace(/\/v1\/?$/, '');

  if (writePath) {
    const result = await runtime.mergeOpenCodeGoConsoleProfiles({ configPath: writePath, baseUrl, setDefault });
    if (result.guessedRoutes.length) {
      process.stderr.write('Routed by prefix heuristic (verify before use):\n');
      for (const line of result.guessedRoutes) process.stderr.write(`  ${line}\n`);
    }
    process.stderr.write(
      `Merged ${result.counts.chat} chat, ${result.counts.responses} responses, and ${result.counts.messages} messages models into ${result.configPath}` +
        ` as ${result.mergedProfileIds.join(' + ')} (defaultProfile: ${result.defaultProfile}).\n`,
    );
    return;
  }

  const ids = await runtime.fetchOpenCodeGoModelIds(baseUrl);
  const built = runtime.buildOpenCodeGoConsoleProfiles(ids, baseUrl);
  if (built.guessedRoutes.length) {
    process.stderr.write('Routed by prefix heuristic (verify before use):\n');
    for (const line of built.guessedRoutes) process.stderr.write(`  ${line}\n`);
  }
  process.stderr.write(
    `Discovered ${ids.length} models (${built.counts.chat} chat, ${built.counts.responses} responses, ${built.counts.messages} messages).\n` +
      `Export the key and base URLs, then add the JSON below under "console" in config.json:\n` +
      `  export ${OPENCODE_GO_API_KEY_ENV}='sk-…'\n` +
      `  export ${OPENCODE_GO_API_BASE_ENV}='${baseUrl}'\n` +
      `  export ${OPENCODE_GO_MESSAGES_API_BASE_ENV}='${messagesBase}'\n` +
      `(or rerun with --write ~/.catence/config.json to merge into an existing config.)\n`,
  );
  process.stdout.write(`${JSON.stringify({ defaultProfile: built.defaultProfile, profiles: built.profiles }, null, 2)}\n`);
}

await main().catch((error) => {
  process.stderr.write(`Error: ${error.message}\n`);
  process.exit(1);
});
