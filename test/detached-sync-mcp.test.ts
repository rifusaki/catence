import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { describe, expect, it } from 'vitest';
import { createCatenceMcpServer } from '../src/interfaces/mcp/server.js';
import { resolvePaths } from '../src/runtime/index.js';

type ToolPayload = { content: Array<{ type: string; text: string }>; isError?: boolean };

async function start(
  paths: Parameters<typeof createCatenceMcpServer>[0],
  dependencies?: Parameters<typeof createCatenceMcpServer>[1],
) {
  const server = createCatenceMcpServer(paths, dependencies);
  const client = new Client({ name: 'detached-sync-test', version: '0.2.0' });
  const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  return { server, client, close: async () => { await client.close(); await server.close(); } };
}

describe('start_detached_sync MCP tool', () => {
  it('spawns a detached sync and points at catence_sync_progress', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'catence-mcp-sync-'));
    const paths = resolvePaths(root);
    let capturedArguments: Record<string, unknown> | null = null;
    const { client, close } = await start(paths, {
      startDetachedSync: async (request) => {
        capturedArguments = request as unknown as Record<string, unknown>;
        return { started: true, athleteId: request.athleteId, provider: request.provider ?? 'all', logFile: `${root}/logs/sync.log` };
      },
    });
    try {
      const response = await client.callTool({ name: 'start_detached_sync', arguments: { provider: 'garmin', refresh: true } }) as ToolPayload;
      expect(response.isError).toBeFalsy();
      const payload = JSON.parse(response.content[0]!.text);
      expect(payload.data).toMatchObject({ started: true, athleteId: 'local', provider: 'garmin', progressTool: 'catence_sync_progress' });
      expect(capturedArguments).toMatchObject({ athleteId: 'local', provider: 'garmin', refresh: true });
    } finally {
      await close();
    }
  });

  it('refuses concurrent runs through the shared busy guard', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'catence-mcp-sync-'));
    const paths = resolvePaths(root);
    await mkdir(path.join(paths.staging, 'garmin'), { recursive: true });
    await writeFile(
      path.join(paths.staging, 'garmin', 'active.progress.json'),
      JSON.stringify({ runId: 'active-1', provider: 'garmin', stage: 'daily', completedUnits: 0, totalUnits: null, percentComplete: 0, elapsedSeconds: 0, estimatedRemainingSeconds: null, heartbeatAt: new Date().toISOString() }),
      'utf8',
    );
    const { client, close } = await start(paths);
    try {
      const response = await client.callTool({ name: 'start_detached_sync', arguments: {} }) as ToolPayload;
      expect(response.isError).toBe(true);
      const payload = JSON.parse(response.content[0]!.text);
      expect(payload.error).toMatchObject({ code: 'sync_in_progress', runId: 'active-1' });
    } finally {
      await close();
    }
  });

  it('requires athleteId in catalog mode like every other personal-data tool', async () => {
    const home = await mkdtemp(path.join(tmpdir(), 'catence-mcp-sync-catalog-'));
    const { resolveCatalogPaths } = await import('../src/runtime/index.js');
    const catalogPaths = resolveCatalogPaths(home);
    const { initializeCatalog } = await import('../src/runtime/index.js');
    await initializeCatalog(catalogPaths, { id: 'alex', label: 'Alex' });
    const { client, close } = await start(catalogPaths, {
      startDetachedSync: async (request) => ({ started: true, athleteId: request.athleteId, provider: request.provider ?? 'all', logFile: 'log' }),
    });
    try {
      const tools = await client.listTools();
      expect(tools.tools.find((tool) => tool.name === 'start_detached_sync')?.inputSchema.required).toContain('athleteId');

      const missingScope = await client.callTool({ name: 'start_detached_sync', arguments: {} });
      expect(missingScope.isError).toBe(true);

      const scoped = await client.callTool({ name: 'start_detached_sync', arguments: { athleteId: 'alex' } }) as ToolPayload;
      expect(JSON.parse(scoped.content[0]!.text)).toMatchObject({ data: { athleteId: 'alex', started: true } });
    } finally {
      await close();
    }
  });
});
