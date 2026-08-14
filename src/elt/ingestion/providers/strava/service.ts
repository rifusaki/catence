import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import type { CatencePaths } from '../../../../contracts/runtime.js';
import { ensurePaths, loadCatenceConfig } from '../../../../core/runtime/configuration.js';
import { athleteProviderEnvironment } from '../../../../core/runtime/secrets.js';
import { CatenceDatabase, openReadOnlyRepository } from '../../../storage/database.js';
import { importJsonl } from '../../importer.js';
import { withDataWriteLock } from '../../../storage/write-lock.js';

const execFileAsync = promisify(execFile);

type WorkerStatus = 'completed' | 'partial' | 'not_found' | 'ambiguous' | 'connected' | 'authorization_required' | 'error';
type WorkerResult = {
  status: WorkerStatus;
  message?: string;
  authorizationUrl?: string;
  stravaActivityId?: string;
  segmentId?: string;
  gearCount?: number;
  effortCount?: number;
  continuationPage?: number;
  lastCompletedPage?: number;
  candidateCount?: number;
  rawHash?: string;
  matchEvidence?: Record<string, unknown>;
  matchDiagnostics?: Record<string, unknown>;
  rateHeaders?: Record<string, string>;
};

export class StravaRateLimitError extends Error {
  constructor(message: string, readonly retryAfterSeconds?: number) {
    super(message);
    this.name = 'StravaRateLimitError';
  }
}

export class StravaEnrichmentError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'StravaEnrichmentError';
  }
}

function packageRoot(): string {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../../..');
}

function toFiniteInteger(value: string | undefined): number | null {
  if (!value) return null;
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : null;
}

function parsePair(value: string | undefined): [number | null, number | null] {
  if (!value) return [null, null];
  const [first, second] = value.split(',').map((part) => toFiniteInteger(part.trim()));
  return [first ?? null, second ?? null];
}

async function readWorkerResult(filePath: string): Promise<WorkerResult> {
  if (!existsSync(filePath)) throw new StravaEnrichmentError('Strava worker did not write its result manifest.');
  const parsed = JSON.parse(await readFile(filePath, 'utf8')) as WorkerResult;
  if (!parsed || typeof parsed.status !== 'string') throw new StravaEnrichmentError('Strava worker wrote an invalid result manifest.');
  return parsed;
}

async function invokeWorker(paths: CatencePaths, args: string[], resultPath: string): Promise<WorkerResult> {
  try {
    await execFileAsync('uv', ['run', 'python', '-m', 'python.catence.providers.strava.cli', ...args, '--data-dir', paths.root, '--result', resultPath], {
      cwd: packageRoot(),
      env: { ...(await athleteProviderEnvironment(paths)), UV_PROJECT_ENVIRONMENT: process.env.UV_PROJECT_ENVIRONMENT ?? path.join(paths.root, 'python-venv') },
    });
  } catch (error) {
    if (!existsSync(resultPath)) {
      const message = error instanceof Error ? error.message : String(error);
      throw new StravaEnrichmentError(`Strava worker failed before it could report a result: ${message}`);
    }
  }
  return readWorkerResult(resultPath);
}

async function storeRateState(database: CatenceDatabase, result: WorkerResult): Promise<void> {
  const headers = result.rateHeaders ?? {};
  const [limit15, limitDay] = parsePair(headers['x-ratelimit-limit']);
  const [usage15, usageDay] = parsePair(headers['x-ratelimit-usage']);
  const isThrottled = result.status === 'partial' && /rate limit|429/i.test(result.message ?? '');
  await database.run(
    `INSERT INTO strava_rate_state (account_id, read_limit_15m, read_usage_15m, read_limit_day, read_usage_day, blocked_until, observed_at)
     VALUES ('authenticated_athlete', $limit15, $usage15, $limitDay, $usageDay, CASE WHEN $throttled THEN now() + INTERVAL 15 MINUTE ELSE NULL END, now())
     ON CONFLICT (account_id) DO UPDATE SET
       read_limit_15m = COALESCE(excluded.read_limit_15m, strava_rate_state.read_limit_15m),
       read_usage_15m = COALESCE(excluded.read_usage_15m, strava_rate_state.read_usage_15m),
       read_limit_day = COALESCE(excluded.read_limit_day, strava_rate_state.read_limit_day),
       read_usage_day = COALESCE(excluded.read_usage_day, strava_rate_state.read_usage_day),
       blocked_until = CASE WHEN excluded.blocked_until IS NOT NULL THEN excluded.blocked_until ELSE strava_rate_state.blocked_until END,
       observed_at = now()`,
    { limit15, usage15, limitDay, usageDay, throttled: isThrottled },
  );
}

async function checkBudget(database: CatenceDatabase, paths: CatencePaths): Promise<void> {
  const config = await loadCatenceConfig(paths);
  const budget = config.providers?.strava?.budget;
  const rate = (await database.rows<{ blocked_until: string | Date | null; read_usage_15m: number | null; read_usage_day: number | null }>(
    `SELECT blocked_until, read_usage_15m, read_usage_day FROM strava_rate_state WHERE account_id = 'authenticated_athlete'`,
  ))[0];
  const blockedUntil = rate?.blocked_until ? new Date(rate.blocked_until).getTime() : 0;
  if (blockedUntil > Date.now()) throw new StravaRateLimitError('Strava has recently throttled Catence; retry after its remote rate-limit window.', Math.ceil((blockedUntil - Date.now()) / 1_000));
  if (budget?.readRequestsPer15Minutes && (rate?.read_usage_15m ?? 0) >= budget.readRequestsPer15Minutes) throw new StravaRateLimitError('Catence local Strava 15-minute request budget has been reached.');
  if (budget?.readRequestsPerDay && (rate?.read_usage_day ?? 0) >= budget.readRequestsPerDay) throw new StravaRateLimitError('Catence local Strava daily request budget has been reached.');
}

async function writeState(database: CatenceDatabase, resourceType: string, remoteId: string, result: WorkerResult): Promise<void> {
  const status = result.status === 'completed' ? 'completed' : result.status;
  await database.run(
    `INSERT INTO strava_enrichment_state (resource_type, remote_id, status, fetched_at, completed_at, continuation_page, detail_json)
     VALUES ($resourceType, $remoteId, $status, now(), CASE WHEN $status = 'completed' THEN now() ELSE NULL END, $continuationPage, $detail)
     ON CONFLICT (resource_type, remote_id) DO UPDATE SET
       status = excluded.status, fetched_at = now(), completed_at = CASE WHEN excluded.status = 'completed' THEN now() ELSE strava_enrichment_state.completed_at END,
       continuation_page = excluded.continuation_page, detail_json = excluded.detail_json`,
    { resourceType, remoteId, status, continuationPage: result.continuationPage ?? null, detail: JSON.stringify(result) },
  );
}

async function cachedState(database: CatenceDatabase, resourceType: string, remoteId: string): Promise<Record<string, unknown> | null> {
  const state = await database.rows<{ status: string; detail_json: string | Record<string, unknown>; fetched_at: string | Date; completed_at: string | Date | null }>(
    `SELECT status, detail_json, fetched_at, completed_at FROM strava_enrichment_state WHERE resource_type = $resourceType AND remote_id = $remoteId`, { resourceType, remoteId },
  );
  const row = state[0];
  if (!row || row.status !== 'completed') return null;
  const detail = typeof row.detail_json === 'string' ? JSON.parse(row.detail_json) as Record<string, unknown> : row.detail_json;
  return { ...detail, cache: { reused: true, fetchedAt: row.fetched_at, completedAt: row.completed_at } };
}

async function runReadOperation(paths: CatencePaths, operation: 'gear' | 'activity' | 'segment-history', extraArgs: string[], resource: { type: string; id: string }, refresh = false): Promise<WorkerResult | Record<string, unknown>> {
  return withDataWriteLock(paths, async () => {
    await ensurePaths(paths);
    const database = await CatenceDatabase.open(paths);
    try {
      if (!refresh) {
        const cached = await cachedState(database, resource.type, resource.id);
        if (cached) return cached;
      }
      await checkBudget(database, paths);
      const runId = await database.beginRun('strava', new Date().toISOString().slice(0, 10));
      const directory = path.join(paths.staging, 'strava');
      const stagingPath = path.join(directory, `${runId}.jsonl`);
      const resultPath = path.join(directory, `${runId}.result.json`);
      let result: WorkerResult;
      try {
        result = await invokeWorker(paths, ['--mode', operation, '--run-id', runId, '--output', stagingPath, ...extraArgs], resultPath);
        if (existsSync(stagingPath)) await importJsonl(database, runId, stagingPath);
        await storeRateState(database, result);
        await writeState(database, resource.type, resource.id, result);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        await database.addError(runId, 'strava', operation, resource.id, message, true);
        throw error;
      } finally {
        await database.finishRun(runId);
      }
      if (result.status === 'error') throw new StravaEnrichmentError(result.message ?? 'Strava did not complete the requested enrichment.');
      return result;
    } finally {
      await database.close();
    }
  });
}

export async function syncStravaGear(paths: CatencePaths, refresh = true): Promise<WorkerResult | Record<string, unknown>> {
  return runReadOperation(paths, 'gear', [], { type: 'gear', id: 'authenticated_athlete' }, refresh);
}

type ActivityMatch = { activity_source_id: string; activity_id: string; provider: string; remote_activity_id: string; external_id: string | null; source_payload: string | Record<string, unknown> | null; started_at_utc: string | Date | null; sport: string | null; distance_m: number | null; elapsed_s: number | null };

/** Returns a Strava activity ID only for formats that identify one directly. */
export function stravaActivityIdFromExternalId(value: string | null | undefined): string | null {
  const externalId = value?.trim();
  if (!externalId) return null;
  const match = externalId.match(/^strava:(\d+)$/i)
    ?? externalId.match(/^https?:\/\/(?:www\.)?strava\.com\/activities\/(\d+)\/?$/i);
  return match?.[1] ?? null;
}

function object(value: string | Record<string, unknown> | null): Record<string, unknown> {
  if (value && typeof value === 'object') return value;
  if (typeof value !== 'string') return {};
  try {
    const parsed: unknown = JSON.parse(value);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {};
  } catch {
    return {};
  }
}

export function stravaActivityIdFromSourcePayload(value: string | Record<string, unknown> | null): string | null {
  const stravaId = object(value).strava_id;
  const candidate = typeof stravaId === 'number' ? String(stravaId) : typeof stravaId === 'string' ? stravaId.trim() : '';
  return /^\d+$/.test(candidate) ? candidate : null;
}

/** Prefer a persisted Strava source over a generic provider external ID. */
export function resolveStravaActivityId(activityId: string, matches: Array<{ provider: string; remote_activity_id: string; external_id: string | null }>): string | null {
  return stravaActivityIdFromExternalId(activityId)
    ?? matches.find((match) => match.provider === 'strava')?.remote_activity_id
    ?? null;
}

export async function multisportChildActivitySourceIds(paths: CatencePaths, activityId: string): Promise<string[] | null> {
  const repository = await openReadOnlyRepository(paths);
  try {
    const parent = (await repository.rows<{ is_multisport_parent: boolean }>(`
      SELECT coalesce(
        try_cast(json_extract_string(raw.payload_json, '$.isMultiSportParent') AS BOOLEAN),
        try_cast(json_extract_string(raw.payload_json, '$.isParent') AS BOOLEAN),
        false
      ) AS is_multisport_parent
      FROM activity_sources AS source
      JOIN source_entities AS raw ON raw.provider = source.provider AND raw.entity_type = 'activity' AND raw.remote_id = source.remote_activity_id
      WHERE source.activity_source_id = $activityId AND source.provider = 'garmin'
    `, { activityId }))[0];
    if (!parent?.is_multisport_parent) return null;
    const children = await repository.rows<{ activity_source_id: string }>(`
      SELECT child_source.activity_source_id
      FROM activity_sources AS parent_source
      JOIN source_entities AS child_raw
        ON child_raw.provider = 'garmin' AND child_raw.entity_type = 'activity' AND child_raw.parent_remote_id = parent_source.remote_activity_id
      JOIN activity_sources AS child_source
        ON child_source.provider = 'garmin' AND child_source.remote_activity_id = child_raw.remote_id
      JOIN activities AS child_activity ON child_activity.activity_id = child_source.activity_id
      WHERE parent_source.activity_source_id = $activityId
        AND parent_source.provider = 'garmin'
        AND lower(coalesce(child_activity.sport, '')) NOT LIKE '%transition%'
      ORDER BY child_activity.started_at_utc, child_source.activity_source_id
    `, { activityId });
    return children.map((child) => child.activity_source_id);
  } finally {
    await repository.close();
  }
}

export async function hydrateStravaActivity(paths: CatencePaths, activityId: string, refresh = false): Promise<WorkerResult | Record<string, unknown>> {
  const multisportChildren = await multisportChildActivitySourceIds(paths, activityId);
  if (multisportChildren) {
    if (!multisportChildren.length) {
      throw new StravaEnrichmentError('This Garmin multisport parent has no staged child activities. Refresh the Garmin activity before hydrating Strava.');
    }
    const childOutcomes: Array<{ activityId: string; status: string; result: WorkerResult | Record<string, unknown> }> = [];
    for (const childActivityId of multisportChildren) {
      const result = await hydrateStravaActivity(paths, childActivityId, refresh);
      const status = typeof result.status === 'string' ? result.status : 'completed';
      childOutcomes.push({ activityId: childActivityId, status, result });
    }
    return {
      status: childOutcomes.every((outcome) => outcome.status === 'completed') ? 'completed' : 'partial',
      hydrationStrategy: 'garmin_multisport_children',
      childOutcomes,
    };
  }
  return withDataWriteLock(paths, async () => {
    await ensurePaths(paths);
    const database = await CatenceDatabase.open(paths);
    try {
      const matches = await database.rows<ActivityMatch>(`
        SELECT source.activity_source_id, source.activity_id, source.provider, source.remote_activity_id, source.external_id, raw.payload_json AS source_payload, activity.started_at_utc, activity.sport, summary.distance_m, summary.elapsed_s
        FROM activity_sources source JOIN activities activity USING (activity_id)
        LEFT JOIN activity_summaries summary USING (activity_source_id)
        LEFT JOIN source_entities raw ON raw.provider = source.provider AND raw.entity_type = 'activity' AND raw.remote_id = source.remote_activity_id
        LEFT JOIN activity_links link USING (activity_source_id)
        WHERE source.activity_source_id = $activityId
          OR source.activity_id = (SELECT activity_id FROM activity_sources WHERE activity_source_id = $activityId)
          OR link.activity_id = (SELECT activity_id FROM activity_sources WHERE activity_source_id = $activityId)
        ORDER BY CASE source.provider WHEN 'garmin' THEN 0 WHEN 'intervals' THEN 1 ELSE 2 END
      `, { activityId });
      const activity = matches[0];
      if (!activity) throw new StravaEnrichmentError(`No Catence activity or activity source named ${activityId} exists.`);
      const requestedSource = matches.find((match) => match.activity_source_id === activityId);
      const sourceStravaActivityId = requestedSource ? stravaActivityIdFromSourcePayload(requestedSource.source_payload) : null;
      const directStravaActivityId = sourceStravaActivityId ?? resolveStravaActivityId(activityId, matches);
      const matchMethod = sourceStravaActivityId ? 'source_strava_id' : directStravaActivityId ? 'linked_strava_source' : null;
      const resource = { type: 'activity', id: activity.activity_source_id };
      if (!refresh) {
        const cached = await cachedState(database, resource.type, resource.id);
        if (cached) return cached;
      }
      if (!directStravaActivityId && (!activity.started_at_utc || !activity.sport || activity.distance_m === null || activity.elapsed_s === null)) {
        throw new StravaEnrichmentError('This activity lacks the timestamp, sport, distance, or elapsed duration required for safe Strava matching.');
      }
      await checkBudget(database, paths);
      const runId = await database.beginRun('strava', new Date().toISOString().slice(0, 10));
      const directory = path.join(paths.staging, 'strava');
      const stagingPath = path.join(directory, `${runId}.jsonl`);
      const resultPath = path.join(directory, `${runId}.result.json`);
      let result: WorkerResult;
      try {
        const matchingArguments = [
          ...(directStravaActivityId ? ['--strava-activity-id', directStravaActivityId] : []),
          ...(matchMethod ? ['--strava-match-method', matchMethod] : []),
          ...(activity.started_at_utc && activity.sport && activity.distance_m !== null && activity.elapsed_s !== null
            ? ['--started-at', new Date(activity.started_at_utc).toISOString(), '--sport', activity.sport, '--distance-m', String(activity.distance_m), '--elapsed-s', String(activity.elapsed_s)]
            : []),
        ];
        result = await invokeWorker(paths, [
          '--mode', 'activity', '--run-id', runId, '--output', stagingPath,
          '--activity-id', activity.activity_source_id, ...matchingArguments,
          ...(refresh ? ['--refresh'] : []),
        ], resultPath);
        if (existsSync(stagingPath)) await importJsonl(database, runId, stagingPath);
        await storeRateState(database, result);
        await writeState(database, resource.type, resource.id, result);
      } catch (error) {
        await database.addError(runId, 'strava', 'activity', activity.activity_source_id, error instanceof Error ? error.message : String(error), true);
        throw error;
      } finally {
        await database.finishRun(runId);
      }
      if (result.status === 'error') throw new StravaEnrichmentError(result.message ?? 'Strava activity hydration failed.');
      return result;
    } finally {
      await database.close();
    }
  });
}

export async function hydrateStravaSegmentHistory(paths: CatencePaths, segmentId: string, refresh = false): Promise<WorkerResult | Record<string, unknown>> {
  return withDataWriteLock(paths, async () => {
    await ensurePaths(paths);
    const database = await CatenceDatabase.open(paths);
    try {
      const found = await database.rows<{ segment_id: string }>('SELECT segment_id FROM strava_segments WHERE segment_id = $segmentId', { segmentId });
      if (!found[0]) throw new StravaEnrichmentError(`Strava segment ${segmentId} is not persisted. Hydrate an activity containing it first.`);
      const resource = { type: 'segment_history', id: segmentId };
      if (!refresh) {
        const cached = await cachedState(database, resource.type, resource.id);
        if (cached) return cached;
      }
      const continuation = (await database.rows<{ continuation_page: number | null }>('SELECT continuation_page FROM strava_enrichment_state WHERE resource_type = $type AND remote_id = $segmentId', { type: resource.type, segmentId }))[0]?.continuation_page;
      await checkBudget(database, paths);
      const runId = await database.beginRun('strava', new Date().toISOString().slice(0, 10));
      const directory = path.join(paths.staging, 'strava');
      const stagingPath = path.join(directory, `${runId}.jsonl`);
      const resultPath = path.join(directory, `${runId}.result.json`);
      let result: WorkerResult;
      try {
        result = await invokeWorker(paths, ['--mode', 'segment-history', '--run-id', runId, '--output', stagingPath, '--segment-id', segmentId, '--start-page', String(continuation ?? 1), ...(refresh ? ['--refresh'] : [])], resultPath);
        if (existsSync(stagingPath)) await importJsonl(database, runId, stagingPath);
        await storeRateState(database, result);
        await writeState(database, resource.type, resource.id, result);
      } catch (error) {
        await database.addError(runId, 'strava', 'segment-history', segmentId, error instanceof Error ? error.message : String(error), true);
        throw error;
      } finally {
        await database.finishRun(runId);
      }
      if (result.status === 'error') throw new StravaEnrichmentError(result.message ?? 'Strava segment history hydration failed.');
      return result;
    } finally {
      await database.close();
    }
  });
}

export async function getStravaAuthorizationUrl(paths: CatencePaths, redirectUri: string): Promise<WorkerResult> {
  await ensurePaths(paths);
  const resultPath = path.join(paths.staging, 'strava', `authorization-${Date.now()}.json`);
  return invokeWorker(paths, ['--mode', 'authorization-url', '--redirect-uri', redirectUri], resultPath);
}

export async function completeStravaAuthorization(paths: CatencePaths, code: string, redirectUri: string): Promise<WorkerResult> {
  await ensurePaths(paths);
  const resultPath = path.join(paths.staging, 'strava', `authorization-${Date.now()}.json`);
  return invokeWorker(paths, ['--mode', 'auth', '--code', code, '--redirect-uri', redirectUri], resultPath);
}

export async function disconnectStrava(paths: CatencePaths): Promise<void> {
  await withDataWriteLock(paths, async () => {
    await rm(path.join(paths.secrets, 'strava.json'), { force: true });
  });
}
