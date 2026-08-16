import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { configuredMcpRateLimit, loadCatenceConfig, resolvePaths } from '../../src/core/runtime/configuration.js';
import { SlidingWindowLimiter } from '../../src/core/runtime/limiter.js';

describe('Catence config limits', () => {
  it('treats missing, blank, and empty config as unlimited', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'catence-config-'));
    const paths = resolvePaths(root);
    expect(configuredMcpRateLimit(await loadCatenceConfig(paths), 'tools', 'read_series')).toBeNull();
    await writeFile(paths.config, '  \n');
    expect(configuredMcpRateLimit(await loadCatenceConfig(paths), 'tools', 'read_series')).toBeNull();
    await writeFile(paths.config, '{}');
    expect(configuredMcpRateLimit(await loadCatenceConfig(paths), 'resources', 'status')).toBeNull();
  });

  it('applies named, wildcard, and server limits while rejecting invalid config', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'catence-config-'));
    const paths = resolvePaths(root);
    await writeFile(paths.config, JSON.stringify({ mcp: { rateLimits: { server: { requests: 3, windowSeconds: 60 }, tools: { '*': { requests: 2, windowSeconds: 60 }, read_series: { requests: 1, windowSeconds: 60 } } } } }));
    const config = await loadCatenceConfig(paths);
    expect(configuredMcpRateLimit(config, 'tools', 'read_series')).toEqual({ requests: 1, windowSeconds: 60 });
    expect(configuredMcpRateLimit(config, 'tools', 'aggregate_data')).toEqual({ requests: 2, windowSeconds: 60 });
    expect(configuredMcpRateLimit(config, 'resources', 'status')).toEqual({ requests: 3, windowSeconds: 60 });
    const limiter = new SlidingWindowLimiter();
    expect(limiter.check('read_series', configuredMcpRateLimit(config, 'tools', 'read_series'), 0).allowed).toBe(true);
    expect(limiter.check('read_series', configuredMcpRateLimit(config, 'tools', 'read_series'), 1).allowed).toBe(false);
    await writeFile(paths.config, '{"mcp":{"rateLimits":{"server":0}}}');
    await expect(loadCatenceConfig(paths)).rejects.toThrow('Invalid Catence config');
  });

  it('accepts Console profiles that reference environment variables instead of secret values', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'catence-config-'));
    const paths = resolvePaths(root);
    await writeFile(paths.config, JSON.stringify({
      console: {
        defaultProfile: 'openai-compatible',
        limits: { toolRounds: 12, toolResultCharacters: 48_000 },
        profiles: {
          'openai-compatible': {
            label: 'OpenAI-compatible',
            model: 'openai/catence',
            apiKeyEnv: 'OPENAI_API_KEY',
            apiBaseEnv: 'OPENAI_API_BASE',
          },
        },
      },
    }));
    const config = await loadCatenceConfig(paths);
    expect(config.console?.profiles?.['openai-compatible']).toMatchObject({ model: 'openai/catence', apiKeyEnv: 'OPENAI_API_KEY' });
    expect(config.console?.limits).toEqual({ toolRounds: 12, toolResultCharacters: 48_000 });

    await writeFile(paths.config, JSON.stringify({ console: { profiles: { unsafe: { model: 'openai/model', apiKeyEnv: 'sk-should-not-be-here' } } } }));
    await expect(loadCatenceConfig(paths)).rejects.toThrow('Invalid Catence config');
  });

  it('accepts a provider with multiple Console deployments and a thinking-effort default', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'catence-config-'));
    const paths = resolvePaths(root);
    await writeFile(paths.config, JSON.stringify({
      console: {
        defaultProfile: 'openai-compatible',
        profiles: {
          'openai-compatible': {
            defaultModel: 'luna',
            defaultReasoningEffort: 'medium',
            models: {
              terra: { model: 'openai/gpt-5.6-terra' },
              luna: { label: 'GPT-5.6 Luna', model: 'openai/gpt-5.6-luna' },
              sol: { model: 'openai/gpt-5.6-sol' },
            },
            apiKeyEnv: 'OPENAI_API_KEY',
            apiBaseEnv: 'OPENAI_API_BASE',
          },
        },
      },
    }));

    const config = await loadCatenceConfig(paths);
    expect(config.console?.profiles?.['openai-compatible']).toMatchObject({
      defaultModel: 'luna',
      defaultReasoningEffort: 'medium',
      models: { luna: { model: 'openai/gpt-5.6-luna' } },
    });
  });
});
