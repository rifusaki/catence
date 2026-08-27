import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { describe, expect, it } from 'vitest';
import { addAthlete, athleteStorePaths, createDemoStore, initializeCatalog, resolveCatalogPaths } from '../src/runtime/index.js';
import { createCatenceMcpServer } from '../src/interfaces/mcp/server.js';

describe('readiness_baseline MCP tool', () => {
  it('combines the full indicator set in one call and requires athleteId', { timeout: 60_000 }, async () => {
    const home = await mkdtemp(path.join(tmpdir(), 'catence-readiness-'));
    const catalogPaths = resolveCatalogPaths(home);
    await initializeCatalog(catalogPaths, { id: 'martina', label: 'Martina' });
    await createDemoStore(athleteStorePaths(catalogPaths, 'martina'), { days: 30, seed: 1, endDate: '2026-08-10' });

    const server = createCatenceMcpServer(catalogPaths);
    const client = new Client({ name: 'readiness-baseline-test', version: '0.2.0' });
    const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    try {
      const tools = await client.listTools();
      expect(tools.tools.find((tool) => tool.name === 'readiness_baseline')?.inputSchema.required ?? []).toContain('athleteId');

      const missingScope = await client.callTool({ name: 'readiness_baseline', arguments: {} });
      expect(missingScope.isError).toBe(true);

      const result = await client.callTool({ name: 'readiness_baseline', arguments: { athleteId: 'martina' } });
      expect(result.isError).toBeFalsy();
      const parsed = JSON.parse((result.content as Array<{ text: string }>)[0]!.text);
      const baseline = parsed.data;
      expect(baseline).toMatchObject({
        sport: 'running',
        lactateThreshold: expect.any(Object),
        vo2max: expect.any(Object),
        racePrediction: expect.any(Object),
        powerCurve: expect.any(Object),
        powerCoverage: expect.any(Object),
      });
      expect(Array.isArray(parsed.caveats)).toBe(true);
      expect(parsed.caveats.length).toBeGreaterThanOrEqual(2);
    } finally {
      await client.close();
      await server.close();
    }
  });
});
