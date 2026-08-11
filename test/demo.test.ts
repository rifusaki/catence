import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { describe, expect, it } from 'vitest';
import { WellnessService } from '../src/core/query/wellness.js';
import { resolvePaths } from '../src/core/runtime/configuration.js';
import { createDemoStore, demoStoreMetadata } from '../src/elt/application/demo.js';
import { openReadOnlyRepository } from '../src/elt/storage/database.js';
import { createCatenceMcpServer } from '../src/interfaces/mcp/server.js';

describe('generated demo store', () => {
  it('creates deterministic, visibly generated wellness/training data without provider access', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'catence-demo-'));
    const paths = resolvePaths(root);
    try {
      const created = await createDemoStore(paths, { days: 45, seed: 9, endDate: '2026-01-31' });
      expect(created).toMatchObject({ created: true, dataDir: root });
      expect(await demoStoreMetadata(paths)).toMatchObject({ generated: true, days: 45, seed: 9, startDate: '2025-12-18', endDate: '2026-01-31' });
      const repository = await openReadOnlyRepository(paths);
      try {
        const wellness = new WellnessService(repository);
        const correlation = await wellness.correlate({ metricA: 'training_load', metricB: 'resting_hr_bpm', startDate: '2025-12-18', endDate: '2026-01-31', scanLags: true });
        expect((correlation.data as { scannedLags: Array<{ lagDays: number; pairedDays: number }> }).scannedLags).toHaveLength(15);
        const coverage = await wellness.coverage({ metrics: ['sleep_score'], startDate: '2025-12-18', endDate: '2026-01-31' });
        expect((coverage.data as { metrics: Array<{ missingDays: number }> }).metrics[0]?.missingDays).toBeGreaterThan(0);
      } finally {
        await repository.close();
      }
      expect(await createDemoStore(paths)).toMatchObject({ created: false });
      const server = createCatenceMcpServer(paths);
      const client = new Client({ name: 'catence-demo-test', version: '0.1.0' });
      const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair();
      await server.connect(serverTransport);
      await client.connect(clientTransport);
      try {
        const status = await client.callTool({ name: 'catence_status', arguments: {} });
        const payload = JSON.parse(((status as { content: Array<{ text: string }> }).content[0]).text) as { demoStore: { generated: boolean }; caveats: string[] };
        expect(payload.demoStore).toMatchObject({ generated: true });
        expect(payload.caveats).toContain('This response uses Catence generated demo data, not personal measurements.');
      } finally {
        await client.close();
        await server.close();
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('never opens a non-empty, unmarked data directory for demo generation', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'catence-demo-protect-'));
    const paths = resolvePaths(root);
    try {
      await writeFile(paths.config, 'not a demo configuration');
      await expect(createDemoStore(paths)).rejects.toThrow('not a Catence demo store');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
