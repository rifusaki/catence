import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { catenceConfigSchema } from './configuration.js';

export const OPENCODE_GO_DEFAULT_BASE_URL = 'https://opencode.ai/zen/go/v1';
export const OPENCODE_GO_API_KEY_ENV = 'OPENCODE_GO_API_KEY';
export const OPENCODE_GO_API_BASE_ENV = 'OPENCODE_GO_API_BASE';
export const OPENCODE_GO_MESSAGES_API_BASE_ENV = 'OPENCODE_GO_MESSAGES_API_BASE';

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

const CHAT_PROFILE_ID = 'opencode-go';
const MESSAGES_PROFILE_ID = 'opencode-go-messages';

export type OpenCodeGoRoute = 'chat' | 'responses' | 'messages';

/** Live model ids plus trusted routing metadata ("live discovery + trusted metadata"). */
export function classifyOpenCodeGoModel(id: string): { route: OpenCodeGoRoute; guessed: boolean } {
  if (RESPONSES_MODELS.has(id)) return { route: 'responses', guessed: false };
  if (MESSAGES_MODELS.has(id)) return { route: 'messages', guessed: false };
  if (/^(grok-|gpt-)/.test(id)) return { route: 'responses', guessed: true };
  if (/^(minimax-|qwen)/.test(id)) return { route: 'messages', guessed: true };
  return { route: 'chat', guessed: false };
}

function modelReference(id: string, route: OpenCodeGoRoute): string {
  if (route === 'responses') return `openai/responses/${id}`;
  if (route === 'messages') return `anthropic/${id}`;
  return `openai/${id}`;
}

function labelFor(id: string): string {
  return id
    .split('-')
    .map((segment) => BRAND_NAMES.get(segment) ?? segment.charAt(0).toUpperCase() + segment.slice(1))
    .join(' ');
}

export type OpenCodeGoConsoleProfiles = {
  profiles: Record<string, Record<string, unknown>>;
  defaultProfile: string;
  counts: { chat: number; responses: number; messages: number };
  guessedRoutes: string[];
};

/**
 * Build the two ready-made Console profiles from live model ids.
 *
 * The public `GET /models` endpoint returns only ids, not which API each model
 * needs, so routing comes from the trusted table intersected with the live
 * list; prefix-guessed routes are reported so callers can warn.
 */
export function buildOpenCodeGoConsoleProfiles(modelIds: readonly string[], baseUrl = OPENCODE_GO_DEFAULT_BASE_URL): OpenCodeGoConsoleProfiles {
  const groups: Record<OpenCodeGoRoute, string[]> = { chat: [], responses: [], messages: [] };
  const guessedRoutes: string[] = [];
  for (const id of modelIds) {
    if (!id) continue;
    const { route, guessed } = classifyOpenCodeGoModel(id);
    groups[route].push(id);
    if (guessed) guessedRoutes.push(`${id} -> ${route}`);
  }
  for (const route of Object.keys(groups) as OpenCodeGoRoute[]) groups[route].sort();

  const chatModels: Record<string, { label: string; model: string }> = {};
  for (const id of [...groups.chat, ...groups.responses]) {
    chatModels[id] = { label: labelFor(id), model: modelReference(id, groups.chat.includes(id) ? 'chat' : 'responses') };
  }
  const messagesModels: Record<string, { label: string; model: string }> = {};
  for (const id of groups.messages) {
    messagesModels[id] = { label: labelFor(id), model: modelReference(id, 'messages') };
  }

  const chatDefault = groups.chat[0] ?? groups.responses[0];
  const profiles: Record<string, Record<string, unknown>> = {
    [CHAT_PROFILE_ID]: {
      label: 'OpenCode Go',
      ...(chatDefault ? { defaultModel: chatDefault } : {}),
      models: chatModels,
      apiKeyEnv: OPENCODE_GO_API_KEY_ENV,
      apiBaseEnv: OPENCODE_GO_API_BASE_ENV,
    },
  };
  if (groups.messages.length) {
    profiles[MESSAGES_PROFILE_ID] = {
      label: 'OpenCode Go (Anthropic)',
      defaultModel: groups.messages[0],
      models: messagesModels,
      apiKeyEnv: OPENCODE_GO_API_KEY_ENV,
      apiBaseEnv: OPENCODE_GO_MESSAGES_API_BASE_ENV,
    };
  }

  return {
    profiles,
    defaultProfile: CHAT_PROFILE_ID,
    counts: { chat: groups.chat.length, responses: groups.responses.length, messages: groups.messages.length },
    guessedRoutes,
  };
}

export async function fetchOpenCodeGoModelIds(baseUrl = OPENCODE_GO_DEFAULT_BASE_URL): Promise<string[]> {
  const modelsUrl = `${baseUrl.replace(/\/$/, '')}/models`;
  let response: Response;
  try {
    response = await fetch(modelsUrl, { headers: { accept: 'application/json' } });
  } catch (error) {
    throw new Error(`Could not reach ${modelsUrl}: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (!response.ok) throw new Error(`GET ${modelsUrl} returned HTTP ${response.status}.`);
  const payload = (await response.json()) as { data?: Array<{ id?: unknown }> };
  const ids = (payload.data ?? []).map((entry) => entry.id).filter((id): id is string => typeof id === 'string' && Boolean(id));
  if (!ids.length) throw new Error(`GET ${modelsUrl} returned no models.`);
  return ids;
}

async function readConfigRoot(configPath: string): Promise<Record<string, unknown>> {
  try {
    const root: unknown = JSON.parse(await readFile(configPath, 'utf8'));
    if (typeof root !== 'object' || root === null || Array.isArray(root)) {
      throw new Error(`${configPath} must contain a JSON object.`);
    }
    return root as Record<string, unknown>;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return {};
    throw error;
  }
}

export type OpenCodeGoMergeResult = {
  configPath: string;
  mergedProfileIds: string[];
  defaultProfile: string;
  counts: { chat: number; responses: number; messages: number };
  guessedRoutes: string[];
};

/**
 * Fetch the live OpenCode Go catalog and merge the two Console profiles into
 * `configPath`, preserving every other section plus existing console fields
 * (`limits`, other profiles) and the existing `defaultProfile` unless
 * `setDefault` is passed. The written file is re-validated with the same
 * strict schema the runtime applies on load, then replaced atomically.
 */
export async function mergeOpenCodeGoConsoleProfiles(
  options: {
    configPath: string;
    baseUrl?: string;
    setDefault?: boolean;
  },
): Promise<OpenCodeGoMergeResult> {
  const baseUrl = options.baseUrl ?? OPENCODE_GO_DEFAULT_BASE_URL;
  const modelIds = await fetchOpenCodeGoModelIds(baseUrl);
  const built = buildOpenCodeGoConsoleProfiles(modelIds, baseUrl);

  const root = await readConfigRoot(options.configPath);
  const existingConsole = typeof root.console === 'object' && root.console !== null && !Array.isArray(root.console)
    ? (root.console as Record<string, unknown>)
    : {};
  const existingProfiles = typeof existingConsole.profiles === 'object' && existingConsole.profiles !== null && !Array.isArray(existingConsole.profiles)
    ? (existingConsole.profiles as Record<string, unknown>)
    : {};
  const defaultProfile =
    typeof existingConsole.defaultProfile === 'string' && existingConsole.defaultProfile && !options.setDefault
      ? existingConsole.defaultProfile
      : built.defaultProfile;
  const updatedConsole: Record<string, unknown> = {
    ...existingConsole,
    defaultProfile,
    profiles: { ...existingProfiles, ...built.profiles },
  };

  // Validate before writing anything: the runtime rejects invalid configs at
  // load time, so a bad merge must never reach disk.
  const candidate = { ...root, console: updatedConsole } as Record<string, unknown>;
  catenceConfigSchema.parse(candidate);

  await mkdir(path.dirname(options.configPath), { recursive: true });
  const temporaryPath = `${options.configPath}.tmp`;
  await writeFile(temporaryPath, `${JSON.stringify(candidate, null, 2)}\n`, 'utf8');
  await rename(temporaryPath, options.configPath);

  return {
    configPath: options.configPath,
    mergedProfileIds: Object.keys(built.profiles),
    defaultProfile,
    counts: built.counts,
    guessedRoutes: built.guessedRoutes,
  };
}
