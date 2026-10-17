import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { describe, expect, it } from 'vitest';
import { addAthlete, athleteStorePaths, createDemoStore, initializeCatalog, resolveCatalogPaths, type CatalogPaths } from '../src/runtime/index.js';
import { createCatenceMcpServer, type CatenceMcpServerOptions } from '../src/interfaces/mcp/server.js';

type ToolPayload = { content: Array<{ text: string }>; isError?: boolean };

async function scopedCatalog(): Promise<CatalogPaths> {
  const home = await mkdtemp(path.join(tmpdir(), 'catence-mcp-scope-'));
  const catalogPaths = resolveCatalogPaths(home);
  await initializeCatalog(catalogPaths, { id: 'alex', label: 'Alex' });
  await addAthlete(catalogPaths, { id: 'sam', label: 'Sam' });
  await createDemoStore(athleteStorePaths(catalogPaths, 'alex'), { days: 14, seed: 1, endDate: '2026-08-10' });
  await createDemoStore(athleteStorePaths(catalogPaths, 'sam'), { days: 14, seed: 2, endDate: '2026-08-10' });
  return catalogPaths;
}

async function scopedClient(options: CatenceMcpServerOptions): Promise<{ client: Client; close: () => Promise<void> }> {
  const catalogPaths = await scopedCatalog();
  const server = createCatenceMcpServer(catalogPaths, {}, options);
  const client = new Client({ name: 'mcp-scope-test', version: '0.1.0' });
  const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  return { client, close: async () => { await client.close(); await server.close(); } };
}

function payload(result: unknown): Record<string, any> {
  return JSON.parse((result as ToolPayload).content[0]!.text);
}

describe('scoped MCP server', () => {
  it('filters the roster and rejects out-of-scope athletes with athlete_forbidden', { timeout: 60_000 }, async () => {
    const { client, close } = await scopedClient({ scope: { athleteIds: ['alex'] } });
    try {
      // The roster and its resource are narrowed to the scope.
      const roster = await client.callTool({ name: 'list_athletes', arguments: {} });
      expect(payload(roster)).toMatchObject({
        data: { defaultAthleteId: 'alex', athletes: [{ id: 'alex', label: 'Alex' }] },
      });
      const resource = await client.readResource({ uri: 'catence://athletes' });
      const contents = resource.contents[0]!;
      expect('text' in contents && typeof contents.text === 'string').toBe(true);
      expect(JSON.parse((contents as { text: string }).text)).toMatchObject({
        defaultAthleteId: 'alex',
        athletes: [{ id: 'alex', label: 'Alex' }],
      });

      // An in-scope athlete works exactly as before.
      const alex = await client.callTool({ name: 'catence_status', arguments: { athleteId: 'alex' } });
      expect(alex.isError).toBeFalsy();
      expect(payload(alex)).toMatchObject({ athlete: { id: 'alex', label: 'Alex' } });

      // An out-of-scope athlete is a classified tool error, not a protocol error.
      const sam = await client.callTool({ name: 'catence_status', arguments: { athleteId: 'sam' } });
      expect(sam.isError).toBe(true);
      expect(payload(sam)).toMatchObject({
        data: null,
        error: { code: 'athlete_forbidden', message: expect.stringContaining('sam') },
      });
    } finally {
      await close();
    }
  });

  it('treats an "all" scope exactly like no scope', { timeout: 60_000 }, async () => {
    const { client, close } = await scopedClient({ scope: { athleteIds: 'all' } });
    try {
      const roster = await client.callTool({ name: 'list_athletes', arguments: {} });
      expect(payload(roster)).toMatchObject({
        data: {
          defaultAthleteId: 'alex',
          athletes: [{ id: 'alex', label: 'Alex' }, { id: 'sam', label: 'Sam' }],
        },
      });
      const sam = await client.callTool({ name: 'catence_status', arguments: { athleteId: 'sam' } });
      expect(sam.isError).toBeFalsy();
    } finally {
      await close();
    }
  });
});
