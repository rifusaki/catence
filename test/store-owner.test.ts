import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { describe, expect, it } from 'vitest';
import { createCatenceMcpServer } from '../src/interfaces/mcp/server.js';
import { CatenceDatabase } from '../src/elt/storage/database.js';
import { CatenceStore, CatenceStoreRegistry } from '../src/elt/storage/store.js';
import { ensurePaths, resolvePaths } from '../src/core/runtime/configuration.js';
import { temporaryDatabase } from './helpers.js';

type ToolPayload = { content: Array<{ type: string; text: string }>; isError?: boolean };

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function startMcp(paths: ReturnType<typeof resolvePaths>, options: Parameters<typeof createCatenceMcpServer>[2] = {}) {
  const server = createCatenceMcpServer(paths, {}, options);
  const client = new Client({ name: 'store-owner-test', version: '0.2.0' });
  const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  return { client, close: async () => { await client.close(); await server.close(); } };
}

describe('single-owner DuckDB store', () => {
  it('shares one instance across independent read and write connections', async () => {
    const { paths, database } = await temporaryDatabase();
    await database.close();
    const store = await CatenceStore.open(paths);
    const writer = await store.database();
    const reader = await store.database();
    try {
      await writer.run('CREATE OR REPLACE TABLE store_probe (id INTEGER, note VARCHAR)');
      await writer.run("INSERT INTO store_probe VALUES (1, 'one')");
      expect(await reader.rows<{ id: number; note: string }>('SELECT id, note FROM store_probe')).toEqual([{ id: 1, note: 'one' }]);
    } finally {
      await writer.close();
      await reader.close();
      await store.close();
    }
  });

  it('lets a second connection commit while another holds an open transaction', async () => {
    const { paths, database } = await temporaryDatabase();
    await database.close();
    const store = await CatenceStore.open(paths);
    const first = await store.database();
    const second = await store.database();
    try {
      await first.run('CREATE OR REPLACE TABLE store_probe (id INTEGER)');
      await first.run('BEGIN TRANSACTION');
      await first.run('INSERT INTO store_probe VALUES (1)');
      const startedAt = Date.now();
      await second.run('INSERT INTO store_probe VALUES (2)');
      expect(Date.now() - startedAt).toBeLessThan(1_000);
      await first.run('COMMIT');
      expect((await second.rows('SELECT id FROM store_probe ORDER BY id')).map((row) => Number(row.id))).toEqual([1, 2]);
    } finally {
      await first.close();
      await second.close();
      await store.close();
    }
  });

  it('serializes stacked hydration jobs without involving sync writes', async () => {
    const { paths, database } = await temporaryDatabase();
    await database.close();
    const store = await CatenceStore.open(paths);
    const order: number[] = [];
    let active = 0;
    let maximum = 0;
    const job = (id: number, ms: number) => store.withHydration(async () => {
      active += 1;
      maximum = Math.max(maximum, active);
      await sleep(ms);
      order.push(id);
      active -= 1;
    });
    try {
      await Promise.all([job(1, 15), job(2, 5), job(3, 1)]);
      expect(order).toEqual([1, 2, 3]);
      expect(maximum).toBe(1);
    } finally {
      await store.close();
    }
  });

  it('releases the file lock after the registry goes idle', async () => {
    const { paths, database } = await temporaryDatabase();
    await database.close();
    const registry = new CatenceStoreRegistry();
    try {
      await registry.withStore(paths, async (store) => {
        const connection = await store.database();
        await connection.run('CREATE TABLE IF NOT EXISTS store_probe (id INTEGER)');
        await connection.close();
      });
      expect(registry.openStoreCount).toBe(1);
      await sleep(1_300);
      expect(registry.openStoreCount).toBe(0);
      const direct = await CatenceDatabase.open(paths);
      await direct.close();
    } finally {
      await registry.closeAll();
    }
  });

  it('reports sidecar progress without requiring a readable database', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'catence-store-progress-'));
    const paths = resolvePaths(root);
    await ensurePaths(paths);
    await mkdir(path.join(paths.staging, 'garmin'), { recursive: true });
    await writeFile(path.join(paths.staging, 'garmin', 'active.progress.json'), JSON.stringify({
      runId: 'sidecar-run', provider: 'garmin', stage: 'importing', currentStep: 'importing',
      completedUnits: 10, totalUnits: 20, percentComplete: 50, elapsedSeconds: 2,
      estimatedRemainingSeconds: 2, heartbeatAt: new Date().toISOString(),
    }), 'utf8');
    const { client, close } = await startMcp(paths);
    try {
      const response = await client.callTool({ name: 'catence_sync_progress', arguments: {} }) as ToolPayload;
      expect(response.isError).toBeFalsy();
      const payload = JSON.parse(response.content[0]!.text);
      expect(payload.data.running[0]).toMatchObject({ runId: 'sidecar-run', stage: 'importing' });
    } finally {
      await close();
    }
  });

  it('routes start_detached_sync through the in-process store registry', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'catence-store-sync-'));
    const paths = resolvePaths(root);
    let captured: Record<string, unknown> | null = null;
    const stores = {
      startSync: async (request: Record<string, unknown>) => {
        captured = request;
        return { started: true, athleteId: 'local', provider: 'garmin', logFile: `${root}/logs/sync.log` };
      },
    } as unknown as CatenceStoreRegistry;
    const { client, close } = await startMcp(paths, { stores });
    try {
      const response = await client.callTool({ name: 'start_detached_sync', arguments: { provider: 'garmin', refresh: true } }) as ToolPayload;
      expect(response.isError).toBeFalsy();
      expect(captured).toMatchObject({ athleteId: 'local', provider: 'garmin', refresh: true });
    } finally {
      await close();
    }
  });
});
