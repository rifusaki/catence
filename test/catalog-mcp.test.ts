import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { describe, expect, it } from 'vitest';
import { addAthlete, athleteStorePaths, createDemoStore, initializeCatalog, resolveCatalogPaths } from '../src/runtime/index.js';
import { createCatenceMcpServer } from '../src/interfaces/mcp/server.js';

describe('shared athlete catalog MCP server', () => {
  it('lists a roster and requires every personal-data tool to select one athlete', async () => {
    const home = await mkdtemp(path.join(tmpdir(), 'catence-catalog-'));
    const catalogPaths = resolveCatalogPaths(home);
    await initializeCatalog(catalogPaths, { id: 'alex', label: 'Alex' });
    await addAthlete(catalogPaths, { id: 'sam', label: 'Sam' });
    await createDemoStore(athleteStorePaths(catalogPaths, 'alex'), { days: 14, seed: 1, endDate: '2026-08-10' });
    await createDemoStore(athleteStorePaths(catalogPaths, 'sam'), { days: 14, seed: 2, endDate: '2026-08-10' });

    const server = createCatenceMcpServer(catalogPaths);
    const client = new Client({ name: 'catalog-scope-test', version: '0.2.0' });
    const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    try {
      const tools = await client.listTools();
      const status = tools.tools.find((tool) => tool.name === 'catence_status');
      expect(status?.inputSchema.required).toContain('athleteId');
      expect(tools.tools.find((tool) => tool.name === 'list_athletes')?.inputSchema.required ?? []).not.toContain('athleteId');

      const roster = await client.callTool({ name: 'list_athletes', arguments: {} });
      expect(JSON.parse((roster.content as Array<{ text: string }>)[0]!.text)).toMatchObject({
        data: { defaultAthleteId: 'alex', athletes: [{ id: 'alex', label: 'Alex' }, { id: 'sam', label: 'Sam' }] },
      });

      const missingScope = await client.callTool({ name: 'catence_status', arguments: {} });
      expect(missingScope.isError).toBe(true);

      const alex = await client.callTool({ name: 'catence_status', arguments: { athleteId: 'alex' } });
      const sam = await client.callTool({ name: 'catence_status', arguments: { athleteId: 'sam' } });
      expect(JSON.parse((alex.content as Array<{ text: string }>)[0]!.text)).toMatchObject({ athlete: { id: 'alex', label: 'Alex' } });
      expect(JSON.parse((sam.content as Array<{ text: string }>)[0]!.text)).toMatchObject({ athlete: { id: 'sam', label: 'Sam' } });
    } finally {
      await client.close();
      await server.close();
    }
  });
});
