import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { resolvePaths } from '../src/core/runtime/configuration.js';
import { CatenceDatabase, ReadOnlyCatenceDatabase } from '../src/elt/storage/database.js';
import type { SourceEntity } from '../src/contracts/staging.js';

function eventEntity(remoteId: string, occurredOn: string): SourceEntity {
  return {
    kind: 'source_entity',
    schemaVersion: 1,
    provider: 'garmin',
    entityType: 'event',
    remoteId,
    parentRemoteId: null,
    occurredOn: `${occurredOn}T00:00:00Z`,
    sourceUpdatedAt: null,
    rawObjectHash: null,
    payload: { eventName: `Event ${remoteId}` },
    extension: {},
  };
}

async function countRows(database: CatenceDatabase | ReadOnlyCatenceDatabase, table: string): Promise<number> {
  const rows = await database.rows<{ n: number }>(`SELECT count(*)::INTEGER AS n FROM ${table} WHERE entity_type = 'event'`);
  return Number(rows[0].n);
}

describe('deleteMissingCalendarEntities', () => {
  it('removes in-window rows missing from the latest listing, preserving dated survivors and out-of-window history', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'catence-reconcile-'));
    const paths = resolvePaths(root);
    const database = await CatenceDatabase.open(paths);
    try {
      const { importRecord } = await import('../src/elt/ingestion/importer.js');
      // keep-1/keep-2 are in the fresh listing; ghost was deleted upstream;
      // ancient predates the lookback window and must survive untouched.
      for (const remoteId of ['keep-1', 'keep-2', 'ghost', 'ancient']) {
        const day = remoteId === 'ancient' ? '2025-01-01' : '2026-09-01';
        await importRecord(database, 'run-seed', eventEntity(remoteId, day));
      }
      expect(await countRows(database, 'source_entities')).toBe(4);
      expect(await countRows(database, 'domain_entities')).toBe(4);

      await database.deleteMissingCalendarEntities('garmin', ['event'], ['keep-1', 'keep-2'], '2026-08-25');

      const survivors = await database.rows(`SELECT remote_id FROM source_entities WHERE entity_type='event' ORDER BY remote_id`);
      expect(survivors.map((row) => row.remote_id)).toEqual(['ancient', 'keep-1', 'keep-2']);
      expect(await countRows(database, 'domain_entities')).toBe(3);

      // Re-running with the same listing is idempotent.
      await database.deleteMissingCalendarEntities('garmin', ['event'], ['keep-1', 'keep-2'], '2026-08-25');
      expect(await countRows(database, 'source_entities')).toBe(3);
    } finally {
      await database.close();
    }
  });

  it('clears the whole window when the listing comes back empty', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'catence-reconcile-empty-'));
    const paths = resolvePaths(root);
    const database = await CatenceDatabase.open(paths);
    try {
      const { importRecord } = await import('../src/elt/ingestion/importer.js');
      await importRecord(database, 'run-seed', eventEntity('vanished', '2026-10-01'));

      await database.deleteMissingCalendarEntities('garmin', ['event'], [], '2026-08-25');

      expect(await countRows(database, 'source_entities')).toBe(0);
      expect(await countRows(database, 'domain_entities')).toBe(0);
    } finally {
      await database.close();
    }
  });
});
