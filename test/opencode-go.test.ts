import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadCatenceConfig, resolvePaths } from '../src/core/runtime/configuration.js';
import { buildOpenCodeGoConsoleProfiles, classifyOpenCodeGoModel, mergeOpenCodeGoConsoleProfiles } from '../src/core/runtime/opencode-go.js';

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
});
