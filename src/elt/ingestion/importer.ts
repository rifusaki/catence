import { createReadStream } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { createInterface } from 'node:readline';
import { randomUUID } from 'node:crypto';
import type { CatenceDatabase } from '../storage/database.js';
import { stagingRecordSchema, type StagingRecord } from '../../contracts/staging.js';
import { importSourceEntity, refreshActivityQuality } from '../normalization/normalizers.js';
import { normalizeStravaEntity } from '../normalization/segments/strava-normalizer.js';
import { reconcileActivityLink } from '../normalization/activities/linking.js';
import { json } from '../storage/sql.js';
import type { SyncLogger } from '../../core/logging.js';

export async function importRecord(database: CatenceDatabase, runId: string, record: StagingRecord, log?: SyncLogger): Promise<void> {
  if (record.kind === 'run_manifest') {
    if (record.runId !== runId) throw new Error(`Staging manifest run ${record.runId} does not match importer run ${runId}.`);
    return;
  }
  if (record.kind === 'raw_object') {
    await database.run(
      `INSERT OR IGNORE INTO raw_objects VALUES
       ($contentHash, $provider, $endpoint, $remoteId, $fetchedAt, $contentType, $relativePath, $scope, $parserVersion)`,
      {
        contentHash: record.contentHash, provider: record.provider, endpoint: record.endpoint, remoteId: record.remoteId,
        fetchedAt: record.fetchedAt, contentType: record.contentType, relativePath: record.relativePath,
        scope: json(record.scope), parserVersion: record.schemaVersion,
      },
    );
    return;
  }
  if (record.kind === 'source_entity') {
    if (record.provider === 'strava') await normalizeStravaEntity(database, record);
    else await importSourceEntity(database, record);
    if (record.entityType === 'activity') {
      await reconcileActivityLink(database, record.provider + ':' + record.remoteId);
      const activity = await database.rows<{ activity_id: string }>('SELECT activity_id FROM activity_sources WHERE activity_source_id = $activitySourceId', { activitySourceId: record.provider + ':' + record.remoteId });
      if (activity[0]?.activity_id) await refreshActivityQuality(database, activity[0].activity_id);
    }
    if (record.provider === 'garmin' && ['activity_detail', 'activity_interval', 'activity_exercise_set'].includes(record.entityType) && record.parentRemoteId) {
      const activity = await database.rows<{ activity_id: string }>('SELECT activity_id FROM activity_sources WHERE activity_source_id = $activitySourceId', { activitySourceId: `garmin:${record.parentRemoteId}` });
      if (activity[0]?.activity_id) await refreshActivityQuality(database, activity[0].activity_id);
    }
    return;
  }
  if (record.kind === 'stream_manifest') {
    const activitySourceId = `${record.provider}:${record.activityRemoteId}`;
    await database.run(
      `INSERT OR IGNORE INTO stream_manifest VALUES
       ($provider, $activitySourceId, $contentHash, $relativePath, $rowCount, $startAt, $endAt, $columns, $rawHash)`,
      {
        provider: record.provider, activitySourceId, contentHash: record.contentHash, relativePath: record.relativePath,
        rowCount: record.rowCount, startAt: record.startAt, endAt: record.endAt, columns: json(record.columns), rawHash: record.rawObjectHash,
      },
    );
    return;
  }
  if (record.kind === 'activity_sync_state') {
    await database.recordActivitySyncState(record.provider, record.activityRemoteId, record.summaryHash, runId, record.detailsFetched);
    return;
  }
  await database.addError(runId, record.provider, record.endpoint, record.remoteId, record.message, record.retryable);
  log?.warn('Staging record reported an extraction error', { runId, provider: record.provider, endpoint: record.endpoint, remoteId: record.remoteId, error: record.message });
}

export async function importJsonl(database: CatenceDatabase, runId: string, filePath: string, log?: SyncLogger): Promise<number> {
  let count = 0;
  const file = createReadStream(filePath, { encoding: 'utf8' });
  const lines = createInterface({ input: file, crlfDelay: Infinity });
  for await (const line of lines) {
    if (!line.trim()) continue;
    const record = stagingRecordSchema.parse(JSON.parse(line));
    await importRecord(database, runId, record, log);
    count += 1;
  }
  return count;
}

export async function importSingleStagingFile(database: CatenceDatabase, runId: string, filePath: string): Promise<number> {
  await readFile(filePath, 'utf8');
  return importJsonl(database, runId, filePath);
}

export async function queueWorkItem(database: CatenceDatabase, runId: string, provider: 'intervals' | 'garmin' | 'strava', endpoint: string, remoteId: string | null, scope: unknown): Promise<string> {
  const itemId = randomUUID();
  await database.run(
    `INSERT INTO sync_items (item_id, run_id, provider, endpoint, remote_id, scope_json, status)
     VALUES ($itemId, $runId, $provider, $endpoint, $remoteId, $scope, 'pending')`,
    { itemId, runId, provider, endpoint, remoteId, scope: json(scope) },
  );
  return itemId;
}

export async function completeWorkItem(database: CatenceDatabase, itemId: string): Promise<void> {
  await database.run(`UPDATE sync_items SET status = 'completed', attempts = attempts + 1, completed_at = now() WHERE item_id = $itemId`, { itemId });
}

export async function failWorkItem(database: CatenceDatabase, itemId: string, message: string): Promise<void> {
  await database.run(`UPDATE sync_items SET status = 'failed', attempts = attempts + 1, error_message = $message, completed_at = now() WHERE item_id = $itemId`, { itemId, message });
}
