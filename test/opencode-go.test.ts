import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { loadCatenceConfig, resolvePaths } from '../src/core/runtime/configuration.js';
import { buildOpenCodeGoConsoleProfiles, classifyOpenCodeGoModel, mergeOpenCodeGoConsoleProfiles } from '../src/core/runtime/opencode-go.js';

const LIVE_CATALOG = {
  data: [{ id: 'deepseek-v4' }, { id: 'grok-4.5' }, { id: 'minimax-m3' }, { id: 'ox-alpha-free' }],
};

function stubLiveCatalog(payload: unknown = LIVE_CATALOG): void {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => new Response(JSON.stringify(payload), { status: 200, headers: { 'content-type': 'application/json' } })),
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('OpenCode Go model routing', () => {
  it('routes trusted models exactly and unknown prefixes heuristically', () => {
    expect(classifyOpenCodeGoModel('grok-4.5')).toEqual({ route: 'responses', guessed: false });
    expect(classifyOpenCodeGoModel('minimax-m3')).toEqual({ route: 'messages', guessed: false });
    expect(classifyOpenCodeGoModel('kimi-k3')).toEqual({ route: 'chat', guessed: false });
    expect(classifyOpenCodeGoModel('grok-9')).toEqual({ route: 'responses', guessed: true });
    expect(classifyOpenCodeGoModel('qwen4-plus')).toEqual({ route: 'messages', guessed: true });
  });

  it('builds the two ready-made profiles with LiteLLM route references', () => {
    const built = buildOpenCodeGoConsoleProfiles(['deepseek-v4', 'grok-4.5', 'minimax-m3'], 'https://opencode.ai/zen/go/v1');
    expect(Object.keys(built.profiles).sort()).toEqual(['opencode-go', 'opencode-go-messages']);
    const chat = built.profiles['opencode-go'] as { models: Record<string, { model: string }>; defaultModel?: string };
    expect(chat.models['deepseek-v4'].model).toBe('openai/deepseek-v4');
    expect(chat.models['grok-4.5'].model).toBe('openai/responses/grok-4.5');
    const messages = built.profiles['opencode-go-messages'] as { models: Record<string, { model: string }> };
    expect(messages.models['minimax-m3'].model).toBe('anthropic/minimax-m3');
    expect(built.defaultProfile).toBe('opencode-go');
  });
});

describe('mergeOpenCodeGoConsoleProfiles', () => {
  async function temporaryConfig(initial?: string): Promise<{ configPath: string; paths: ReturnType<typeof resolvePaths> }> {
    const root = await mkdtemp(path.join(tmpdir(), 'catence-opencode-go-'));
    const configPath = path.join(root, 'config.json');
    if (initial !== undefined) await writeFile(configPath, initial, 'utf8');
    return { configPath, paths: resolvePaths(root) };
  }

  it('merges profiles while preserving unrelated sections and existing console fields', async () => {
    const { configPath } = await temporaryConfig(
      JSON.stringify({
        mcp: { rateLimits: { server: { requests: 5, windowSeconds: 10 } } },
        console: {
          defaultProfile: 'openai',
          limits: { toolRounds: 12 },
          profiles: { openai: { label: 'OpenAI', model: 'openai/gpt-5-mini', apiKeyEnv: 'OPENAI_API_KEY' } },
        },
      }),
    );

    const result = await mergeOpenCodeGoConsoleProfiles({ configPath });

    // defaultProfile is preserved unless --set-default.
    expect(result.defaultProfile).toBe('openai');
    const root = JSON.parse(await readFile(configPath, 'utf8'));
    expect(root.mcp).toEqual({ rateLimits: { server: { requests: 5, windowSeconds: 10 } } });
    expect(root.console.limits).toEqual({ toolRounds: 12 });
    expect(root.console.profiles.openai.model).toBe('openai/gpt-5-mini');
    expect(root.console.profiles['opencode-go'].apiKeyEnv).toBe('OPENCODE_GO_API_KEY');
    // The written file must satisfy the runtime's strict load-time schema.
    await expect(loadCatenceConfig(resolvePaths(path.dirname(configPath)))).resolves.toMatchObject({
      console: { defaultProfile: 'openai' },
    });
  });

  it('honors setDefault to move the default profile', async () => {
    const { configPath } = await temporaryConfig(JSON.stringify({ console: { defaultProfile: 'openai', profiles: { openai: { model: 'openai/x' } } } }));
    const result = await mergeOpenCodeGoConsoleProfiles({ configPath, setDefault: true });
    expect(result.defaultProfile).toBe('opencode-go');
  });

  it('rejects a pre-existing invalid console section instead of repairing it silently', async () => {
    const { configPath } = await temporaryConfig(JSON.stringify({ console: { nonsenseField: true, profiles: {} } }));
    await expect(mergeOpenCodeGoConsoleProfiles({ configPath })).rejects.toThrow();
    // The invalid file is left untouched on disk.
    expect(JSON.parse(await readFile(configPath, 'utf8')).console.nonsenseField).toBe(true);
  });

  it('creates the config when none exists yet', async () => {
    const { configPath } = await temporaryConfig();
    const result = await mergeOpenCodeGoConsoleProfiles({ configPath });
    expect(result.defaultProfile).toBe('opencode-go');
    const root = JSON.parse(await readFile(configPath, 'utf8'));
    expect(root.console.profiles['opencode-go']).toBeTruthy();
  });

  it('preserves per-model customizations and prunes models that left the live catalog', async () => {
    stubLiveCatalog();
    const initial = {
      console: {
        defaultProfile: 'opencode-go',
        profiles: {
          'opencode-go': {
            label: 'OpenCode Go',
            defaultModel: 'ox-alpha-free',
            apiKeyEnv: 'OPENCODE_GO_API_KEY',
            apiBaseEnv: 'OPENCODE_GO_API_BASE',
            models: {
              'ox-alpha-free': {
                label: 'Ox Alpha Free',
                model: 'openai/ox-alpha-free',
                variants: { Default: 'default', Thinking: 'high' },
              },
              'retired-model': { label: 'Retired', model: 'openai/retired-model', reasoningEffort: 'low' },
              'custom-local': { label: 'Custom Local', model: 'openai/custom-local', reasoningEffort: 'low' },
            },
          },
        },
      },
    };
    const { configPath } = await temporaryConfig(JSON.stringify(initial));
    const result = await mergeOpenCodeGoConsoleProfiles({ configPath });
    const root = JSON.parse(await readFile(configPath, 'utf8'));
    const profile = root.console.profiles['opencode-go'];
    // Human-added thinking-effort variants and labels survive the refresh.
    expect(profile.models['ox-alpha-free'].variants).toEqual({ Default: 'default', Thinking: 'high' });
    expect(profile.models['ox-alpha-free'].label).toBe('Ox Alpha Free');
    expect(profile.models['ox-alpha-free'].model).toBe('openai/ox-alpha-free');
    // Models absent from the live catalog are pruned so the list cannot go stale.
    expect(profile.models['retired-model']).toBeUndefined();
    expect(profile.models['custom-local']).toBeUndefined();
    expect(result.prunedModelIds).toEqual(['opencode-go:retired-model', 'opencode-go:custom-local']);
    // A previously customized default model is not reset by discovery.
    expect(profile.defaultModel).toBe('ox-alpha-free');
    await expect(loadCatenceConfig(resolvePaths(path.dirname(configPath)))).resolves.toBeTruthy();
  });

  it('reassigns the profile default when the previous default is pruned', async () => {
    stubLiveCatalog({
      data: [{ id: 'kimi-k3' }],
    });
    const initial = {
      console: {
        defaultProfile: 'opencode-go',
        profiles: {
          'opencode-go': {
            label: 'OpenCode Go',
            defaultModel: 'ox-alpha-free',
            apiKeyEnv: 'OPENCODE_GO_API_KEY',
            apiBaseEnv: 'OPENCODE_GO_API_BASE',
            models: { 'ox-alpha-free': { label: 'Ox Alpha Free', model: 'openai/ox-alpha-free' } },
          },
        },
      },
    };
    const { configPath } = await temporaryConfig(JSON.stringify(initial));
    const result = await mergeOpenCodeGoConsoleProfiles({ configPath });
    const root = JSON.parse(await readFile(configPath, 'utf8'));
    const profile = root.console.profiles['opencode-go'];
    expect(profile.defaultModel).toBe('kimi-k3');
    expect(Object.keys(profile.models)).toEqual(['kimi-k3']);
    expect(result.prunedModelIds).toEqual(['opencode-go:ox-alpha-free']);
    await expect(loadCatenceConfig(resolvePaths(path.dirname(configPath)))).resolves.toBeTruthy();
  });
});
