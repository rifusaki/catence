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
});
