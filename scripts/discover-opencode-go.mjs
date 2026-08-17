// Discover OpenCode Go models and emit Catence Console profiles for them.
//
// OpenCode Go serves its catalog through three APIs: most models speak the
// OpenAI Chat Completions API, Grok and GPT-5.6 Luna speak the OpenAI
// Responses API, and MiniMax and Qwen speak the Anthropic Messages API. The
// public `GET /models` endpoint returns only model ids, not which API each
// model needs, so routing comes from the trusted table below and is intersected
// with the live list (the same "live discovery + trusted metadata" approach
// OpenClaw uses).
//
// Usage:
//   node scripts/discover-opencode-go.mjs [--base-url <url>] [--write <config.json>] [--set-default]
//
// Flags:
//   --base-url <url>   Root of the OpenCode Go API (default https://opencode.ai/zen/go/v1).
//   --write <path>     Merge the two profiles into an existing config.json instead of printing to stdout.
//   --set-default      With --write, set console.defaultProfile to opencode-go even when one already exists.

import process from 'node:process';
import { readFile, writeFile } from 'node:fs/promises';

const DEFAULT_BASE_URL = 'https://opencode.ai/zen/go/v1';
const API_KEY_ENV = 'OPENCODE_GO_API_KEY';
const API_BASE_ENV = 'OPENCODE_GO_API_BASE';
const MESSAGES_BASE_ENV = 'OPENCODE_GO_MESSAGES_API_BASE';

// LiteLLM appends a fixed suffix to the profile base URL per provider, so the
// three APIs need different prefixes and two base URLs:
//   openai/<id>             -> {base}/chat/completions
//   openai/responses/<id>   -> {base}/responses
//   anthropic/<id>          -> {base minus /v1}/v1/messages
const RESPONSES_MODELS = new Set(['grok-4.5', 'gpt-5.6-luna']);
const MESSAGES_MODELS = new Set([
  'minimax-m2.5',
  'minimax-m2.7',
  'minimax-m3',
  'qwen3.5-plus',
  'qwen3.6-plus',
  'qwen3.7-plus',
  'qwen3.7-max',
  'qwen3.8-max',
]);

const BRAND_NAMES = new Map([
  ['deepseek', 'DeepSeek'],
  ['glm', 'GLM'],
  ['gpt', 'GPT'],
  ['grok', 'Grok'],
  ['hy3', 'Hy3'],
  ['kimi', 'Kimi'],
  ['mimo', 'MiMo'],
  ['minimax', 'MiniMax'],
  ['qwen', 'Qwen'],
]);

function classify(id) {
  if (RESPONSES_MODELS.has(id)) return { route: 'responses', guessed: false };
  if (MESSAGES_MODELS.has(id)) return { route: 'messages', guessed: false };
  if (/^(grok-|gpt-)/.test(id)) return { route: 'responses', guessed: true };
  if (/^(minimax-|qwen)/.test(id)) return { route: 'messages', guessed: true };
  return { route: 'chat', guessed: false };
}

function modelReference(id, route) {
  if (route === 'responses') return `openai/responses/${id}`;
  if (route === 'messages') return `anthropic/${id}`;
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
    'Usage: node scripts/discover-opencode-go.mjs [--base-url <url>] [--write <config.json>] [--set-default]\n',
  );
}

async function main() {
  const args = process.argv.slice(2);
  let baseUrl = DEFAULT_BASE_URL;
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
  const modelsUrl = `${baseUrl.replace(/\/$/, '')}/models`;
  const messagesBase = baseUrl.replace(/\/v1\/?$/, '');

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
  const ids = (payload.data ?? []).map((entry) => entry.id).filter((id) => typeof id === 'string' && id);

  const groups = { chat: [], responses: [], messages: [] };
  const guessed = [];
  for (const id of ids) {
    const { route, guessed: wasGuessed } = classify(id);
    if (!(route in groups)) continue;
    groups[route].push(id);
    if (wasGuessed) guessed.push(`${id} -> ${route}`);
  }
  for (const route of Object.keys(groups)) groups[route].sort();

  const chatProfileModels = {};
  for (const id of groups.chat) {
    chatProfileModels[id] = { label: labelFor(id), model: modelReference(id, 'chat') };
  }
  for (const id of groups.responses) {
    chatProfileModels[id] = { label: labelFor(id), model: modelReference(id, 'responses') };
  }
  const messagesProfileModels = {};
  for (const id of groups.messages) {
    messagesProfileModels[id] = { label: labelFor(id), model: modelReference(id, 'messages') };
  }

  const chatDefault = groups.chat[0] ?? groups.responses[0];
  const profiles = {};
  profiles['opencode-go'] = {
    label: 'OpenCode Go',
    ...(chatDefault ? { defaultModel: chatDefault } : {}),
    models: chatProfileModels,
    apiKeyEnv: API_KEY_ENV,
    apiBaseEnv: API_BASE_ENV,
  };
  if (messagesProfileModels && groups.messages.length) {
    profiles['opencode-go-messages'] = {
      label: 'OpenCode Go (Anthropic)',
      defaultModel: groups.messages[0],
      models: messagesProfileModels,
      apiKeyEnv: API_KEY_ENV,
      apiBaseEnv: MESSAGES_BASE_ENV,
    };
  }

  const consoleSection = { defaultProfile: 'opencode-go', profiles };

  if (guessed.length) {
    process.stderr.write('Routed by prefix heuristic (verify before use):\n');
    for (const line of guessed) process.stderr.write(`  ${line}\n`);
  }
  process.stderr.write(
    `Discovered ${ids.length} models (${groups.chat.length} chat, ${groups.responses.length} responses, ${groups.messages.length} messages).\n`,
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
      existingConsole.defaultProfile && !setDefault ? existingConsole.defaultProfile : 'opencode-go';
    root.console = { ...existingConsole, defaultProfile, profiles: mergedProfiles };
    await writeFile(writePath, `${JSON.stringify(root, null, 2)}\n`);
    process.stderr.write(`Merged profiles into ${writePath} (defaultProfile: ${defaultProfile}).\n`);
    return;
  }

  process.stderr.write(
    `Export the key and base URLs, then add the JSON below under "console" in config.json:\n` +
      `  export ${API_KEY_ENV}='sk-…'\n` +
      `  export ${API_BASE_ENV}='${baseUrl}'\n` +
      `  export ${MESSAGES_BASE_ENV}='${messagesBase}'\n` +
      `(or rerun with --write ~/.catence/config.json to merge into an existing config.)\n`,
  );
  process.stdout.write(`${JSON.stringify(consoleSection, null, 2)}\n`);
}

await main().catch((error) => {
  process.stderr.write(`Error: ${error.message}\n`);
  process.exit(1);
});
