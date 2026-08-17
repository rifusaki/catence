// Discover OpenCode Zen models and emit Catence Console profiles for them.
//
// OpenCode Zen serves its catalog through `GET /v1/models` at
// `https://opencode.ai/zen/v1`. Models are split between the chat/completions
// endpoint and the responses endpoint. Routing is determined by model ID prefix:
// GPT-5.x models use the responses API; everything else uses chat/completions.
//
// Usage:
//   node scripts/discover-opencode-zen.mjs [--base-url <url>] [--write <config.json>] [--set-default] [--free-only]
//
// Flags:
//   --base-url <url>   Root of the OpenCode Zen API (default https://opencode.ai/zen/v1).
//   --write <path>     Merge the two profiles into an existing config.json instead of printing to stdout.
//   --set-default      With --write, set console.defaultProfile to opencode-zen even when one already exists.
//   --free-only        Only include free models (those with -free suffix or known free model IDs).

import process from 'node:process';
import { readFile, writeFile } from 'node:fs/promises';

const DEFAULT_BASE_URL = 'https://opencode.ai/zen/v1';
const API_KEY_ENV = 'OPENCODE_API_KEY';
const API_BASE_ENV = 'OPENCODE_ZEN_API_BASE';
const RESPONSES_BASE_ENV = 'OPENCODE_ZEN_RESPONSES_API_BASE';

// Models that use the OpenAI Responses API (gpt-5.x series)
const RESPONSES_PREFIXES = ['gpt-5', 'gpt-5.'];

// Known free model IDs (in case the API doesn't mark them explicitly)
const KNOWN_FREE_MODELS = new Set([
  'deepseek-v4-flash-free',
  'mimo-v2.5-free',
  'nemotron-3-ultra-free',
  'nemotron-3.5-lightning-free',
  'hy3-free',
  'laguna-s-2.1-free',
  'big-pickle',
  'north-mini-code-free',
  'longcat-2.0-free',
  'ling-3.0-flash-free',
  'ling-3.0-tiny-free',
]);

const BRAND_NAMES = new Map([
  ['deepseek', 'DeepSeek'],
  ['gpt', 'GPT'],
  ['mimo', 'MiMo'],
  ['nemotron', 'Nemotron'],
  ['hy3', 'Hy3'],
  ['laguna', 'Laguna'],
  ['big', 'Big'],
  ['pickle', 'Pickle'],
  ['north', 'North'],
  ['mini', 'Mini'],
  ['code', 'Code'],
  ['longcat', 'LongCat'],
  ['ling', 'Ling'],
]);

function isFreeModel(id) {
  return id.endsWith('-free') || KNOWN_FREE_MODELS.has(id);
}

function classify(id) {
  for (const prefix of RESPONSES_PREFIXES) {
    if (id.startsWith(prefix)) return { route: 'responses', guessed: false };
  }
  return { route: 'chat', guessed: false };
}

function modelReference(id, route) {
  if (route === 'responses') return `openai/responses/${id}`;
  return `openai/${id}`;
}

function labelFor(id) {
  return id
    .split('-')
    .map((segment) => BRAND_NAMES.get(segment) ?? segment.charAt(0).toUpperCase() + segment.slice(1))
    .join(' ');
}

function usage() {
  process.stderr.write(
    'Usage: node scripts/discover-opencode-zen.mjs [--base-url <url>] [--write <config.json>] [--set-default] [--free-only]\n',
  );
}

async function main() {
  const args = process.argv.slice(2);
  let baseUrl = DEFAULT_BASE_URL;
  let writePath = null;
  let setDefault = false;
  let freeOnly = false;

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
    } else if (arg === '--free-only') {
      freeOnly = true;
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
  const modelsUrl = `${baseUrl.replace(/\/$/, '')}/models`;

  let response;
  try {
    response = await fetch(modelsUrl, { headers: { accept: 'application/json' } });
  } catch (error) {
    throw new Error(`Could not reach ${modelsUrl}: ${error.message}`);
  }
  if (!response.ok) {
    throw new Error(`GET ${modelsUrl} returned HTTP ${response.status}.`);
  }
  const payload = await response.json();
  const ids = (payload.data ?? [])
    .map((entry) => entry.id)
    .filter((id) => typeof id === 'string' && id);

  const filteredIds = freeOnly ? ids.filter(isFreeModel) : ids;

  const groups = { chat: [], responses: [] };
  for (const id of filteredIds) {
    const { route } = classify(id);
    if (!(route in groups)) continue;
    groups[route].push(id);
  }
  for (const route of Object.keys(groups)) groups[route].sort();

  const chatProfileModels = {};
  for (const id of groups.chat) {
    chatProfileModels[id] = { label: labelFor(id), model: modelReference(id, 'chat') };
  }
  const responsesProfileModels = {};
  for (const id of groups.responses) {
    responsesProfileModels[id] = { label: labelFor(id), model: modelReference(id, 'responses') };
  }

  const chatDefault = groups.chat[0];
  const responsesDefault = groups.responses[0];

  const profiles = {};
  if (groups.chat.length) {
    profiles['opencode-zen'] = {
      label: 'OpenCode Zen',
      ...(chatDefault ? { defaultModel: chatDefault } : {}),
      models: chatProfileModels,
      apiKeyEnv: API_KEY_ENV,
      apiBaseEnv: API_BASE_ENV,
    };
  }
  if (groups.responses.length) {
    profiles['opencode-zen-responses'] = {
      label: 'OpenCode Zen (Responses)',
      ...(responsesDefault ? { defaultModel: responsesDefault } : {}),
      models: responsesProfileModels,
      apiKeyEnv: API_KEY_ENV,
      apiBaseEnv: RESPONSES_BASE_ENV,
    };
  }

  const consoleSection = { defaultProfile: 'opencode-zen', profiles };

  process.stderr.write(
    `Discovered ${ids.length} models (${groups.chat.length} chat, ${groups.responses.length} responses).` +
    (freeOnly ? ` Filtered to ${filteredIds.length} free models.` : '') + '\n',
  );

  if (writePath) {
    let root = {};
    try {
      root = JSON.parse(await readFile(writePath, 'utf8'));
    } catch (error) {
      if (error.code !== 'ENOENT') throw new Error(`Could not read ${writePath}: ${error.message}`);
    }
    if (typeof root !== 'object' || root === null || Array.isArray(root)) {
      throw new Error(`${writePath} must contain a JSON object.`);
    }
    const existingConsole = typeof root.console === 'object' && root.console !== null ? root.console : {};
    const mergedProfiles = { ...(existingConsole.profiles ?? {}), ...profiles };
    const defaultProfile =
      existingConsole.defaultProfile && !setDefault ? existingConsole.defaultProfile : 'opencode-zen';
    root.console = { ...existingConsole, defaultProfile, profiles: mergedProfiles };
    await writeFile(writePath, `${JSON.stringify(root, null, 2)}\n`);
    process.stderr.write(`Merged profiles into ${writePath} (defaultProfile: ${defaultProfile}).\n`);
    return;
  }

  process.stderr.write(
    `Export the key and base URLs, then add the JSON below under "console" in config.json:\n` +
      `  export ${API_KEY_ENV}='sk-…'\n` +
      `  export ${API_BASE_ENV}='${baseUrl}'\n` +
      `  export ${RESPONSES_BASE_ENV}='${baseUrl}'\n` +
      `(or rerun with --write ~/.catence/config.json to merge into an existing config.)\n`,
  );
  process.stdout.write(`${JSON.stringify(consoleSection, null, 2)}\n`);
}

await main().catch((error) => {
  process.stderr.write(`Error: ${error.message}\n`);
  process.exit(1);
});