import { DuckDBInstance, type DuckDBConnection, type DuckDBValue } from '@duckdb/node-api';
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { ReadOnlyRepository } from '../../core/query/repository.js';
import type { CatencePaths } from '../../contracts/runtime.js';
import type { QueryBindings, WriteDataStore } from '../../contracts/storage.js';
import type { Provider } from '../../contracts/staging.js';
import { SYNC_STAGES, STALE_RUN_TIMEOUT_MS, type InterruptedRuns, type SyncProgressSnapshot, type SyncProgressState } from '../../contracts/progress.js';
import { migrations } from './migrations.js';
import { json } from './sql.js';

/**
 * DuckDB's node API throws "Cannot create values of type ANY" when a bound
 * parameter resolves to an untyped value. JS `Date` objects surface as `ANY`
 * (and are not auto-coerced the way strings are), so any date/timestamp
 * parameter read back from the database and re-bound crashes the statement.
 * Serializing dates to ISO strings keeps every parameter concretely typed.
 */
function serializeValue(value: unknown): unknown {
  if (value instanceof Date) return value.toISOString();
  return value;
}

function serializeBindings(bindings?: QueryBindings): QueryBindings | undefined {
  if (!bindings) return bindings;
  if (Array.isArray(bindings)) return bindings.map(serializeValue) as QueryBindings;
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(bindings)) out[key] = serializeValue(value);
  return out as QueryBindings;
}

export class CatenceDatabase implements WriteDataStore {
  private closed = false;

  private constructor(
    private readonly instance: DuckDBInstance,
    private readonly connection: DuckDBConnection,
  ) {}

  static async open(paths: CatencePaths): Promise<CatenceDatabase> {
    const instance = await DuckDBInstance.create(paths.database);
    const connection = await instance.connect();
    const database = new CatenceDatabase(instance, connection);
    await database.migrate();
    return database;
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    try {
      // A connection must be disconnected before its owning instance. Keeping
      // the instance alive for the full database lifetime also prevents the
      // native binding from releasing it during an in-flight connection close.
      this.connection.closeSync();
    } finally {
      this.instance.closeSync();
    }
  }

  async migrate(): Promise<void> {
    await this.connection.run('CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, name VARCHAR NOT NULL, applied_at TIMESTAMPTZ NOT NULL DEFAULT now())');
    const rows = await this.rows<{ version: number }>('SELECT version FROM schema_migrations');
    const applied = new Set(rows.map((row) => Number(row.version)));
    for (const migration of migrations) {
      if (applied.has(migration.version)) continue;
      await this.connection.run('BEGIN TRANSACTION');
      try {
        await this.connection.run(migration.sql);
        await this.connection.run('INSERT INTO schema_migrations (version, name) VALUES ($version, $name)', { version: migration.version, name: migration.name });
        await this.connection.run('COMMIT');
      } catch (error) {
        await this.connection.run('ROLLBACK');
        throw error;
      }
    }
    // Some DuckDB builds abort while committing an index rebuild in the same
    // transaction as an ALTER on its populated table. These statements are
    // idempotent and retried on every open, so a process interruption after a
    // migration commit cannot leave the database permanently under-indexed.
    for (const migration of migrations) {
      if (migration.postCommitSql) await this.connection.run(migration.postCommitSql);
    }
  }

  async run(sql: string, values?: QueryBindings): Promise<void> {
    await this.connection.run(sql, serializeBindings(values) as DuckDBValue[] | Record<string, DuckDBValue> | undefined);
  }

  async rows<T extends Record<string, unknown>>(sql: string, values?: QueryBindings): Promise<T[]> {
    const result = await this.connection.runAndReadAll(sql, serializeBindings(values) as DuckDBValue[] | Record<string, DuckDBValue> | undefined);
    return result.getRowObjectsJS() as T[];
  }

  async tableNames(query: string): Promise<string[]> {
    return [...this.connection.getTableNames(query, true)];
  }

  interrupt(): void {
    this.connection.interrupt();
  }

  async beginRun(provider: Provider, fromDate: string, runId = randomUUID()): Promise<string> {
    await this.run(
      'INSERT INTO sync_runs (run_id, provider, from_date, started_at, status, parser_version) VALUES ($runId, $provider, $fromDate, now(), \'running\', 1)',
      { runId, provider, fromDate },
    );
    return runId;
  }

  async finishRun(runId: string): Promise<void> {
    await this.run(`UPDATE sync_runs SET status = CASE WHEN error_count > 0 THEN 'completed_with_errors' ELSE 'completed' END, completed_at = now() WHERE run_id = $runId`, { runId });
    await this.run("UPDATE retrieval_index_state SET status = 'stale' WHERE index_name = 'context'");
  }

  async heartbeatRun(runId: string, progress: SyncProgressState): Promise<void> {
    await this.run(
      `INSERT INTO sync_run_progress (run_id, provider, stage, current_step, completed_units, total_units, percent, elapsed_seconds, estimated_remaining_seconds, heartbeat_at, detail_json)
       VALUES ($runId, $provider, $stage, $currentStep, $completedUnits, $totalUnits, $percent, $elapsedSeconds, $estimatedRemainingSeconds, now(), '{}')
       ON CONFLICT (run_id) DO UPDATE SET
         provider = EXCLUDED.provider,
         stage = EXCLUDED.stage,
         current_step = EXCLUDED.current_step,
         completed_units = EXCLUDED.completed_units,
         total_units = EXCLUDED.total_units,
         percent = EXCLUDED.percent,
         elapsed_seconds = EXCLUDED.elapsed_seconds,
         estimated_remaining_seconds = EXCLUDED.estimated_remaining_seconds,
         heartbeat_at = now(),
         detail_json = '{}'`,
      {
        runId,
        provider: progress.provider,
        stage: progress.stage,
        currentStep: progress.currentStep,
        completedUnits: progress.completedUnits,
        totalUnits: progress.totalUnits,
        percent: progress.percentComplete,
        elapsedSeconds: progress.elapsedSeconds,
        estimatedRemainingSeconds: progress.estimatedRemainingSeconds,
      },
    );
  }

  async markRunInterrupted(runId: string, stage = 'interrupted'): Promise<void> {
    await this.run("UPDATE sync_runs SET status = 'interrupted', completed_at = now() WHERE run_id = $runId AND status = 'running'", { runId });
    await this.run('UPDATE sync_run_progress SET stage = $stage, heartbeat_at = now() WHERE run_id = $runId', { runId, stage });
  }

  async interruptStaleSyncRuns(timeoutMs = STALE_RUN_TIMEOUT_MS): Promise<InterruptedRuns> {
    const cutoff = new Date(Date.now() - timeoutMs).toISOString();
    const stale = await this.rows<{ run_id: string }>(`SELECT run_id FROM sync_runs WHERE status = 'running' AND started_at < $cutoff`, { cutoff });
    for (const row of stale) {
      await this.run("UPDATE sync_runs SET status = 'timed_out', completed_at = now() WHERE run_id = $runId AND status = 'running'", { runId: row.run_id });
      await this.run("UPDATE sync_run_progress SET stage = 'timed_out', heartbeat_at = now() WHERE run_id = $runId", { runId: row.run_id });
    }
    return { runIds: stale.map((row) => row.run_id) };
  }

  async syncProgress(): Promise<SyncProgressSnapshot> {
    const running = await this.rows<SyncProgressRow>(
      `SELECT runs.run_id, runs.provider,
         coalesce(progress.stage, 'starting') AS stage,
         progress.current_step AS current_step,
         coalesce(progress.completed_units, 0) AS completed_units,
         progress.total_units AS total_units,
         coalesce(progress.percent, 0) AS percent,
         coalesce(progress.elapsed_seconds, 0) AS elapsed_seconds,
         progress.estimated_remaining_seconds AS estimated_remaining_seconds,
         cast(coalesce(progress.heartbeat_at, runs.started_at) AS VARCHAR) AS heartbeat_at
       FROM sync_runs AS runs
       LEFT JOIN sync_run_progress AS progress USING (run_id)
       WHERE runs.status = 'running'
       ORDER BY runs.started_at DESC`,
    );
    const recent = await this.rows<SyncProgressRow>(
      `SELECT progress.run_id, progress.provider, progress.stage, progress.current_step,
         progress.completed_units, progress.total_units, progress.percent, progress.elapsed_seconds,
         progress.estimated_remaining_seconds, cast(progress.heartbeat_at AS VARCHAR) AS heartbeat_at
       FROM sync_run_progress AS progress
       ORDER BY progress.heartbeat_at DESC
       LIMIT 10`,
    );
    return { running: running.map(toSyncProgressState), recent: recent.map(toSyncProgressState) };
  }

  async addError(runId: string, provider: Provider, endpoint: string, remoteId: string | null, message: string, retryable: boolean): Promise<void> {
    await this.run(
      `INSERT INTO normalization_errors (error_id, run_id, provider, endpoint, remote_id, message, retryable)
       VALUES ($errorId, $runId, $provider, $endpoint, $remoteId, $message, $retryable)`,
      { errorId: randomUUID(), runId, provider, endpoint, remoteId, message, retryable },
    );
    await this.run('UPDATE sync_runs SET error_count = error_count + 1 WHERE run_id = $runId', { runId });
  }

  async resolveErrors(opts: { runIds?: string[]; provider?: Provider; before?: string; all?: boolean } = {}): Promise<number> {
    const clauses: string[] = ['resolved_at IS NULL'];
    const values: Record<string, string | number> = {};
    if (opts.runIds && opts.runIds.length > 0) {
      const placeholders = opts.runIds.map((_, index) => `$runId${index}`).join(', ');
      clauses.push(`run_id IN (${placeholders})`);
      opts.runIds.forEach((runId, index) => { values[`runId${index}`] = runId; });
    }
    if (opts.provider) {
      clauses.push('provider = $provider');
      values.provider = opts.provider;
    }
    if (opts.before) {
      clauses.push('created_at < $before');
      values.before = opts.before;
    }
    if (!opts.all && clauses.length === 1) {
      throw new Error('Refusing to resolve all unresolved errors without an explicit --all flag.');
    }
    const resolved = await this.rows<{ error_id: string }>(
      `UPDATE normalization_errors SET resolved_at = now() WHERE ${clauses.join(' AND ')} RETURNING error_id`,
      values,
    );
    return resolved.length;
  }

  async status(): Promise<Record<string, unknown>> {
    // @duckdb/node-api owns native statement state on the connection. Keep
    // status reads sequential instead of issuing several native calls at once.
    const runs = await this.rows('SELECT status, count(*)::INTEGER AS count FROM sync_runs GROUP BY status');
    const errors = await this.rows('SELECT count(*)::INTEGER AS count FROM normalization_errors WHERE resolved_at IS NULL');
    const rawObjects = await this.rows('SELECT count(*)::INTEGER AS count FROM raw_objects');
    const activities = await this.rows('SELECT count(*)::INTEGER AS count FROM activities');
    const streams = await this.rows('SELECT count(*)::INTEGER AS count FROM stream_manifest');
    const errorDetails = await this.rows<{ run_id: string; provider: string; endpoint: string; remote_id: string | null; message: string; created_at: string }>(
      'SELECT run_id, provider, endpoint, remote_id, message, cast(created_at AS VARCHAR) AS created_at FROM normalization_errors WHERE resolved_at IS NULL ORDER BY created_at DESC LIMIT 100',
    );
    const cursors = await this.rows<{ provider: string; cursor_name: string; covered_through_date: string; latest_source_date: string | null; lookback_days: number; last_successful_run_id: string | null; last_completed_at: string; status: string }>('SELECT provider, cursor_name, cast(covered_through_date AS VARCHAR) AS covered_through_date, cast(latest_source_date AS VARCHAR) AS latest_source_date, lookback_days, last_successful_run_id, cast(last_completed_at AS VARCHAR) AS last_completed_at, status FROM sync_cursors ORDER BY provider, cursor_name');
    return {
      runs, unresolvedErrors: errors[0]?.count ?? 0, rawObjects: rawObjects[0]?.count ?? 0, activities: activities[0]?.count ?? 0, streams: streams[0]?.count ?? 0,
      errors: errorDetails,
      cursors: cursors.map((cursor) => ({ ...cursor, next_from_date: subtractDays(cursor.covered_through_date, Number(cursor.lookback_days)) })),
    };
  }

  async getRun(runId: string): Promise<{ provider: Provider; from_date: string } | null> {
    const rows = await this.rows<{ provider: Provider; from_date: string }>(
      'SELECT provider, cast(from_date AS VARCHAR) AS from_date FROM sync_runs WHERE run_id = $runId',
      { runId },
    );
    return rows[0] ?? null;
  }

  async insertSourceAccount(provider: Provider, remoteAccountId: string, displayName: string | null, payload: unknown): Promise<void> {
    await this.run(
      `INSERT OR REPLACE INTO source_accounts VALUES ($provider, $remoteAccountId, $displayName, now(), $payload)`,
      { provider, remoteAccountId, displayName, payload: json(payload) },
    );
  }

  async resolveIncrementalWindow(provider: Provider, cursorName: 'daily' | 'activities', toDate: string, initialFromDate: string, lookbackDays: number): Promise<{ fromDate: string; toDate: string; source: 'cursor' | 'bootstrap' | 'initial' }> {
    const cursor = await this.rows<{ covered_through_date: string }>(
      `SELECT cast(covered_through_date AS VARCHAR) AS covered_through_date
       FROM sync_cursors WHERE provider = $provider AND cursor_name = $cursorName`,
      { provider, cursorName },
    );
    if (cursor[0]?.covered_through_date) {
      return { fromDate: subtractDays(cursor[0].covered_through_date, lookbackDays), toDate, source: 'cursor' };
    }
    const latestSourceDate = await this.latestSourceDate(provider, cursorName);
    if (latestSourceDate) {
      await this.upsertCursor(provider, cursorName, toDate, latestSourceDate, lookbackDays, null, 'bootstrap', { initializedFrom: 'normalized_source_dates' });
      return { fromDate: subtractDays(latestSourceDate, lookbackDays), toDate, source: 'bootstrap' };
    }
    return { fromDate: initialFromDate, toDate, source: 'initial' };
  }

  /**
   * Return the uncovered historical portion of an explicit backfill range.
   *
   * A backfill is normally used to extend history backwards from data already
   * present locally.  Its newest normalized source date is therefore a
   * coverage boundary: re-reading that day and everything after it only
   * creates provider traffic and upserts that the caller did not request.
   * Callers can opt into the complete explicit range with `includeExisting`.
   */
  async resolveBackfillWindow(provider: Provider, cursorName: 'daily' | 'activities', fromDate: string, toDate: string, includeExisting = false): Promise<{ fromDate: string; toDate: string } | null> {
    if (includeExisting) return { fromDate, toDate };
    const latestSourceDate = await this.latestSourceDate(provider, cursorName);
    if (!latestSourceDate || latestSourceDate < fromDate) return { fromDate, toDate };
    if (latestSourceDate >= toDate) return null;
    const uncoveredThrough = subtractDays(latestSourceDate, 1);
    return uncoveredThrough < fromDate ? null : { fromDate, toDate: uncoveredThrough };
  }

  async advanceIncrementalCursor(provider: Provider, cursorName: 'daily' | 'activities', runId: string, coveredThroughDate: string, lookbackDays: number): Promise<void> {
    const latestSourceDate = await this.latestSourceDate(provider, cursorName);
    const run = await this.rows<{ error_count: number }>('SELECT error_count FROM sync_runs WHERE run_id = $runId', { runId });
    const status = Number(run[0]?.error_count ?? 0) > 0 ? 'completed_with_errors' : 'completed';
    await this.upsertCursor(provider, cursorName, coveredThroughDate, latestSourceDate, lookbackDays, runId, status, { reconciliation: 'overlap_window' });
  }

  async activityNeedsDetailSync(provider: Provider, remoteActivityId: string, summaryHash: string): Promise<boolean> {
    const rows = await this.rows<{ summary_hash: string }>(
      'SELECT summary_hash FROM activity_sync_state WHERE provider = $provider AND remote_activity_id = $remoteActivityId',
      { provider, remoteActivityId },
    );
    return rows[0]?.summary_hash !== summaryHash;
  }

  async recordActivitySyncState(provider: Provider, remoteActivityId: string, summaryHash: string, runId: string, detailsFetched: boolean): Promise<void> {
    await this.run(
      `INSERT INTO activity_sync_state (provider, remote_activity_id, summary_hash, last_seen_run_id, last_detail_sync_at, details_status)
       VALUES ($provider, $remoteActivityId, $summaryHash, $runId, CASE WHEN $detailsFetched THEN now() ELSE NULL END, CASE WHEN $detailsFetched THEN 'attempted' ELSE 'unchanged' END)
       ON CONFLICT (provider, remote_activity_id) DO UPDATE SET
         summary_hash = excluded.summary_hash,
         last_seen_run_id = excluded.last_seen_run_id,
         last_seen_at = now(),
         last_detail_sync_at = CASE WHEN $detailsFetched THEN now() ELSE activity_sync_state.last_detail_sync_at END,
         details_status = CASE WHEN $detailsFetched THEN 'attempted' ELSE activity_sync_state.details_status END`,
      { provider, remoteActivityId, summaryHash, runId, detailsFetched },
    );
  }

  async knownActivitySummaryHashes(provider: Provider): Promise<Record<string, string>> {
    const rows = await this.rows<{ remote_activity_id: string; summary_hash: string }>(
      'SELECT remote_activity_id, summary_hash FROM activity_sync_state WHERE provider = $provider',
      { provider },
    );
    return Object.fromEntries(rows.map((row) => [row.remote_activity_id, row.summary_hash]));
  }

  private async latestSourceDate(provider: Provider, cursorName: 'daily' | 'activities'): Promise<string | null> {
    const observations = cursorName === 'daily'
      ? `SELECT max(metric_date) AS observed_date FROM daily_metrics WHERE provider = $provider
         UNION ALL SELECT max(nutrition_date) FROM nutrition_days WHERE provider = $provider
         UNION ALL SELECT max(occurred_on) FROM source_entities WHERE provider = $provider AND entity_type IN ('wellness', 'daily_health', 'nutrition_day', 'nutrition_log')`
      : `SELECT max(cast(started_at_utc AS DATE)) AS observed_date FROM activities activity
           JOIN activity_sources source USING (activity_id) WHERE source.provider = $provider
         UNION ALL SELECT max(occurred_on) FROM source_entities WHERE provider = $provider AND entity_type = 'activity'`;
    const rows = await this.rows<{ latest_source_date: string | Date | null }>(`
      SELECT max(observed_date) AS latest_source_date FROM (${observations})
    `, { provider });
    return toIsoDate(rows[0]?.latest_source_date ?? null);
  }

  private async upsertCursor(provider: Provider, cursorName: 'daily' | 'activities', coveredThroughDate: string, latestSourceDate: string | null, lookbackDays: number, runId: string | null, status: string, detail: Record<string, unknown>): Promise<void> {
    await this.run(
      `INSERT INTO sync_cursors (provider, cursor_name, covered_through_date, latest_source_date, lookback_days, last_successful_run_id, last_completed_at, status, detail_json)
       VALUES ($provider, $cursorName, $coveredThroughDate, $latestSourceDate, $lookbackDays, $runId, now(), $status, $detail)
       ON CONFLICT (provider, cursor_name) DO UPDATE SET
         covered_through_date = excluded.covered_through_date,
         latest_source_date = excluded.latest_source_date,
         lookback_days = excluded.lookback_days,
         last_successful_run_id = excluded.last_successful_run_id,
         last_completed_at = excluded.last_completed_at,
         status = excluded.status,
         detail_json = excluded.detail_json`,
      { provider, cursorName, coveredThroughDate, latestSourceDate, lookbackDays, runId, status, detail: json(detail) },
    );
  }
}

function toIsoDate(value: string | Date | null): string | null {
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  if (typeof value === 'string' && /^\d{4}-\d{2}-\d{2}/.test(value)) return value.slice(0, 10);
  return null;
}

function subtractDays(date: string, days: number): string {
  const timestamp = Date.parse(`${date}T00:00:00Z`);
  return new Date(timestamp - days * 86_400_000).toISOString().slice(0, 10);
}

/**
 * A deliberately small read-only facade for the MCP/query process.  It never
 * applies migrations or exposes a mutating method, so an MCP process cannot
 * turn a question into a DuckDB write.
 */
export class ReadOnlyCatenceDatabase {
  private closed = false;
  // @duckdb/node-api shares prepared-statement state on a connection. Query
  // services may compose independent reads with Promise.all(), so serialize at
  // this boundary instead of relying on every caller to remember that detail.
  private queryTail: Promise<void> = Promise.resolve();

  private constructor(
    private readonly instance: DuckDBInstance,
    private readonly connection: DuckDBConnection,
  ) {}

  static async open(paths: CatencePaths): Promise<ReadOnlyCatenceDatabase> {
    if (!existsSync(paths.database)) {
      throw new ReadOnlyDatabaseError('data_unavailable', 'No Catence database exists yet. Complete a sync before starting MCP.');
    }
    try {
      const instance = await DuckDBInstance.create(paths.database, { access_mode: 'READ_ONLY' });
      const connection = await instance.connect();
      const database = new ReadOnlyCatenceDatabase(instance, connection);
      const migration = await database.rows<{ version: number }>('SELECT max(version) AS version FROM schema_migrations');
      const currentVersion = Number(migration[0]?.version ?? 0);
      const requiredVersion = Math.max(...migrations.map((item) => item.version));
      if (currentVersion < requiredVersion) {
        await database.close();
        throw new ReadOnlyDatabaseError(
          'data_unavailable',
          `Database schema is at version ${currentVersion}; version ${requiredVersion} is required. Run a sync or build-retrieval-index once.`,
        );
      }
      return database;
    } catch (error) {
      if (error instanceof ReadOnlyDatabaseError) throw error;
      const message = error instanceof Error ? error.message : String(error);
      const code = /lock|busy|conflict|read.?only|another process/i.test(message) ? 'data_sync_in_progress' : 'data_unavailable';
      throw new ReadOnlyDatabaseError(code, `Read-only data snapshot is unavailable: ${message}`);
    }
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    await this.queryTail;
    try {
      this.connection.closeSync();
    } finally {
      this.instance.closeSync();
    }
  }

  async rows<T extends Record<string, unknown>>(sql: string, values?: QueryBindings): Promise<T[]> {
    return this.withConnection(async () => {
      const result = await this.connection.runAndReadAll(sql, values as DuckDBValue[] | Record<string, DuckDBValue> | undefined);
      return result.getRowObjectsJS() as T[];
    });
  }

  async tableNames(query: string): Promise<string[]> {
    return this.withConnection(async () => [...this.connection.getTableNames(query, true)]);
  }

  interrupt(): void {
    this.connection.interrupt();
  }

  private async withConnection<T>(operation: () => Promise<T>): Promise<T> {
    let release: (() => void) | undefined;
    const completed = new Promise<void>((resolve) => { release = resolve; });
    const previous = this.queryTail;
    this.queryTail = completed;
    await previous;
    try {
      return await operation();
    } finally {
      release?.();
    }
  }
}

export class ReadOnlyDatabaseError extends Error {
  constructor(readonly code: 'data_sync_in_progress' | 'data_unavailable', message: string) {
    super(message);
    this.name = 'ReadOnlyDatabaseError';
  }
}

/** Compose core read services with the DuckDB-backed, read-only adapter. */
export async function openReadOnlyRepository(paths: CatencePaths): Promise<ReadOnlyRepository> {
  return new ReadOnlyRepository(await ReadOnlyCatenceDatabase.open(paths), paths);
}

interface SyncProgressRow extends Record<string, unknown> {
  run_id: string;
  provider: string;
  stage: string;
  current_step: string | null;
  completed_units: number;
  total_units: number | null;
  percent: number;
  elapsed_seconds: number;
  estimated_remaining_seconds: number | null;
  heartbeat_at: string;
}

function toSyncProgressState(row: SyncProgressRow): SyncProgressState {
  return {
    runId: row.run_id,
    provider: row.provider,
    stage: SYNC_STAGES.includes(row.stage as SyncProgressState['stage']) ? (row.stage as SyncProgressState['stage']) : 'starting',
    currentStep: row.current_step,
    completedUnits: Math.max(0, Number(row.completed_units) || 0),
    totalUnits: row.total_units === null || row.total_units === undefined ? null : Math.max(0, Number(row.total_units) || 0),
    percentComplete: Math.min(100, Math.max(0, Number(row.percent) || 0)),
    elapsedSeconds: Math.max(0, Number(row.elapsed_seconds) || 0),
    estimatedRemainingSeconds: row.estimated_remaining_seconds === null || row.estimated_remaining_seconds === undefined ? null : Math.max(0, Number(row.estimated_remaining_seconds) || 0),
    heartbeatAt: row.heartbeat_at,
  };
}
