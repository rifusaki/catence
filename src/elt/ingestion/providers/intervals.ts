import { IntervalsClient } from 'intervals-icu';
import { randomUUID } from 'node:crypto';
import type { CatenceDatabase } from '../../storage/database.js';
import type { CatencePaths } from '../../../contracts/runtime.js';
import { stableJsonHash, storeArtifact, storeJsonArtifact } from '../../storage/artifacts.js';
import { importRecord, queueWorkItem, completeWorkItem, failWorkItem } from '../importer.js';
import { intervalsActivityReadEndpoints, intervalsSecondaryReadRegistry, intervalsEventSyncWindow, assertReadOnlyRegistry } from './registry.js';
import { intervalsStreamsToSamples, writeParquetSamples } from '../../streams.js';
import type { SourceEntity } from '../../../contracts/staging.js';
import type { SyncLogger } from '../../../core/logging.js';

type JsonObject = Record<string, unknown>;

const apiBaseUrl = 'https://intervals.icu/api/v1';

function asObject(value: unknown): JsonObject {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as JsonObject : {};
}

function asItems(value: unknown): JsonObject[] {
  if (Array.isArray(value)) return value.map(asObject);
  const object = asObject(value);
  for (const key of ['items', 'data', 'activities', 'events', 'workouts', 'wellness']) {
    if (Array.isArray(object[key])) return object[key].map(asObject);
  }
  return Object.keys(object).length > 0 ? [object] : [];
}

function idOf(payload: JsonObject, fallback: string): string {
  for (const key of ['id', 'activity_id', 'activityId', 'date', 'name']) {
    const value = payload[key];
    if (typeof value === 'string' || typeof value === 'number') return String(value);
  }
  return fallback;
}

function entityDate(payload: JsonObject): string | null {
  for (const key of ['id', 'date', 'start_date_local', 'start_date', 'updated']) {
    const value = payload[key];
    if (typeof value === 'string' && /^\d{4}-\d{2}-\d{2}/.test(value)) return value;
  }
  return null;
}

function basicAuth(apiKey: string): string {
  return `Basic ${Buffer.from(`API_KEY:${apiKey}`).toString('base64')}`;
}

export class IntervalsExtractor {
  private readonly client: IntervalsClient;

  constructor(
    private readonly database: CatenceDatabase,
    private readonly paths: CatencePaths,
    private readonly apiKey: string,
    private readonly athleteId: string,
    private readonly log: SyncLogger,
  ) {
    // The typed client is used for provider-compatible authentication and the
    // primary identity request. Manifest-only calls below intentionally use
    // the same read-only credentials to cover endpoint families not wrapped by it.
    this.client = new IntervalsClient({ apiKey, athleteId, maxRetries: 3 });
  }

  async sync(runId: string, activityWindow: { fromDate: string; toDate: string } | null, includeAccount = true): Promise<void> {
    assertReadOnlyRegistry();
    let resolvedAthleteId = this.athleteId;
    if (includeAccount) {
      const athlete = await this.capture(runId, 'athlete', null, {}, async () => this.client.athletes.getAthlete());
      const athletePayload = asObject(athlete);
      resolvedAthleteId = typeof athletePayload.id === 'string' ? athletePayload.id : this.athleteId;
      await this.database.insertSourceAccount('intervals', resolvedAthleteId, typeof athletePayload.name === 'string' ? athletePayload.name : null, athletePayload);
    }

    for (const endpoint of intervalsSecondaryReadRegistry) {
      if (endpoint.name === 'athlete') continue;
      // Calendar events straddle today (past for activity association,
      // future for planning); they must not inherit the cursor-bounded
      // activity window, which always ends at today.
      if (endpoint.name === 'events') {
        const window = intervalsEventSyncWindow();
        const payload = await this.capture(runId, 'events', null, window, async () => this.getCollection('events', resolvedAthleteId, window.fromDate, window.toDate));
        if (payload === undefined) continue;
        await this.importEntities('event', 'events', payload, null, runId);
        continue;
      }
      if (!activityWindow) continue;
      const { fromDate, toDate } = activityWindow;
      const payload = await this.capture(runId, endpoint.name, null, { fromDate, toDate }, async () => this.getCollection(endpoint.name, resolvedAthleteId, fromDate, toDate));
      if (payload === undefined) continue;
      await this.importEntities(endpoint.entityType, endpoint.name, payload, null, runId);
      if (endpoint.name === 'activities') {
        for (const activity of asItems(payload)) {
          const activityId = idOf(activity, randomUUID());
          const summaryHash = stableJsonHash(activity);
          // The activity-list payload already contains the Intervals-only
          // training calculations. Garmin remains the source of record for
          // detail, files, streams, and structured activity data.
          await this.database.recordActivitySyncState('intervals', activityId, summaryHash, runId, false);
        }
      }
    }
  }

  private async captureCollectionChildren(runId: string, collection: string, payload: unknown, athleteId: string): Promise<void> {
    const children: Record<string, Array<{ suffix: (id: string) => string; entityType: string; binary?: boolean }>> = {
      events: [{ suffix: (id) => `/athlete/${athleteId}/events/${id}`, entityType: 'event' }],
      workouts: [{ suffix: (id) => `/athlete/${athleteId}/workouts/${id}`, entityType: 'workout' }],
      folders: [
        { suffix: (id) => `/athlete/${athleteId}/folders/${id}`, entityType: 'folder' },
        { suffix: (id) => `/athlete/${athleteId}/folders/${id}/workouts`, entityType: 'workout' },
        { suffix: (id) => `/athlete/${athleteId}/folders/${id}/shared-with`, entityType: 'folder_share' },
      ],
      gear: [
        { suffix: (id) => `/athlete/${athleteId}/gear/${id}`, entityType: 'gear' },
        { suffix: (id) => `/athlete/${athleteId}/gear/${id}/reminder`, entityType: 'gear_reminder' },
      ],
      routes: [{ suffix: (id) => `/athlete/${athleteId}/routes/${id}`, entityType: 'route' }],
      sport_settings: [{ suffix: (id) => `/athlete/${athleteId}/sport-settings/${id}`, entityType: 'sport_setting' }],
      custom_items: [
        { suffix: (id) => `/athlete/${athleteId}/custom-item/${id}`, entityType: 'custom_item' },
        { suffix: (id) => `/athlete/${athleteId}/custom-item/${id}/image`, entityType: 'custom_item_image', binary: true },
      ],
      chats: [
        { suffix: (id) => `/chats/${id}`, entityType: 'chat' },
        { suffix: (id) => `/chats/${id}/messages`, entityType: 'message' },
      ],
    };
    for (const item of asItems(payload)) {
      const remoteId = idOf(item, 'unknown');
      for (const child of children[collection] ?? []) {
        const endpoint = `${collection}_${child.entityType}`;
        const childPayload = await this.capture(runId, endpoint, remoteId, { parent: collection }, async () => child.binary ? this.getBinary(child.suffix(remoteId)) : this.getJson(child.suffix(remoteId)));
        if (childPayload === undefined || childPayload instanceof Uint8Array) continue;
        await this.importEntities(child.entityType, endpoint, childPayload, remoteId, runId);
      }
    }
  }

  private async getCollection(name: string, athleteId: string, fromDate: string, toDate: string): Promise<unknown> {
    const query = new URLSearchParams({ oldest: fromDate, newest: toDate, resolve: 'true' });
    const routes: Record<string, string> = {
      profile: `/athlete/${athleteId}/profile`, connections: `/athlete/${athleteId}/connections`, sport_settings: `/athlete/${athleteId}/sport-settings`,
      activities: `/athlete/${athleteId}/activities`, wellness: `/athlete/${athleteId}/wellness`, events: `/athlete/${athleteId}/events`,
      workouts: `/athlete/${athleteId}/workouts`, folders: `/athlete/${athleteId}/folders`, gear: `/athlete/${athleteId}/gear`, routes: `/athlete/${athleteId}/routes`,
      custom_items: `/athlete/${athleteId}/custom-item`, fitness: `/athlete/${athleteId}/fitness`, activity_summary: `/athlete/${athleteId}/activity-summary`,
      power_curves: `/athlete/${athleteId}/power-curves`, pace_curves: `/athlete/${athleteId}/pace-curves`, hr_curves: `/athlete/${athleteId}/hr-curves`,
      activity_power_curves: `/athlete/${athleteId}/activity-power-curves`, activity_hr_curves: `/athlete/${athleteId}/activity-hr-curves`,
      weather_config: `/athlete/${athleteId}/weather-config`, weather_forecast: `/athlete/${athleteId}/weather`, chats: `/athlete/${athleteId}/chats`,
      activity_tags: `/athlete/${athleteId}/activity-tags`, event_tags: `/athlete/${athleteId}/event-tags`, workout_tags: `/athlete/${athleteId}/workout-tags`,
    };
    const route = routes[name];
    if (!route) throw new Error(`Endpoint ${name} is not on the Intervals read-only route map.`);
    return this.getJson(`${route}?${query.toString()}`);
  }

  private async captureActivity(runId: string, activityId: string, summary: JsonObject): Promise<void> {
    for (const endpoint of intervalsActivityReadEndpoints) {
      const payload = await this.capture(runId, `activity_${endpoint}`, activityId, {}, async () => {
        if (endpoint === 'original_file' || endpoint === 'fit_file' || endpoint === 'gpx_file') {
          const route = endpoint === 'original_file' ? `/activity/${activityId}/file` : endpoint === 'fit_file' ? `/activity/${activityId}/fit-file` : `/activity/${activityId}/gpx-file`;
          return this.getBinary(route);
        }
        const route = endpoint === 'activity' ? `/activity/${activityId}` : `/activity/${activityId}/${endpoint.replaceAll('_', '-')}`;
        return this.getJson(route);
      });
      if (payload === undefined) continue;
      if (payload instanceof Uint8Array) continue;
      if (endpoint === 'streams') {
        const detail = asObject(summary);
        const samples = intervalsStreamsToSamples(`intervals:${activityId}`, Array.isArray(payload) ? payload.map(asObject) : [], typeof detail.start_date === 'string' ? detail.start_date : null);
        if (samples.length > 0) {
          const parquet = await writeParquetSamples(this.database, this.paths, 'intervals', activityId, typeof detail.start_date_local === 'string' ? detail.start_date_local : new Date().toISOString().slice(0, 10), samples);
          await importRecord(this.database, runId, {
            kind: 'stream_manifest', schemaVersion: 1, provider: 'intervals', activityRemoteId: activityId,
            relativePath: parquet.relativePath, contentHash: parquet.contentHash, rowCount: samples.length,
            startAt: samples[0]?.timestamp_utc ?? null, endAt: samples.at(-1)?.timestamp_utc ?? null, columns: parquet.columns, rawObjectHash: null,
          });
        }
      }
      if (endpoint === 'intervals') {
        const intervals = Array.isArray(payload) ? payload : asObject(payload).icu_intervals;
        if (Array.isArray(intervals)) await this.importEntities('activity_interval', 'activity_intervals', intervals, activityId, runId);
      } else if (endpoint !== 'streams') {
        await this.importEntities(`activity_${endpoint}`, `activity_${endpoint}`, payload, activityId, runId);
      }
    }
  }

  private async capture(runId: string, endpoint: string, remoteId: string | null, scope: Record<string, unknown>, action: () => Promise<unknown>): Promise<unknown | undefined> {
    const workId = await queueWorkItem(this.database, runId, 'intervals', endpoint, remoteId, scope);
    try {
      const value = await action();
      const artifact = value instanceof Uint8Array
        ? await storeArtifact(this.paths, 'intervals', endpoint, remoteId, value, endpoint.includes('file') ? 'bin' : 'dat', 'application/octet-stream')
        : await storeJsonArtifact(this.paths, 'intervals', endpoint, remoteId, value);
      await importRecord(this.database, runId, {
        kind: 'raw_object', schemaVersion: 1, provider: 'intervals', endpoint, remoteId, fetchedAt: new Date().toISOString(),
        contentHash: artifact.contentHash, contentType: artifact.contentType, relativePath: artifact.relativePath, scope,
      });
      await completeWorkItem(this.database, workId);
      return value;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await failWorkItem(this.database, workId, message);
      this.log.warn('Endpoint capture failed', { runId, provider: 'intervals', endpoint, remoteId, error: message });
      await this.database.addError(runId, 'intervals', endpoint, remoteId, message, true);
      return undefined;
    }
  }

  private async importEntities(entityType: string, endpoint: string, payload: unknown, parentRemoteId: string | null, runId: string): Promise<void> {
    const artifactHash = (await this.database.rows<{ content_hash: string }>(
      'SELECT content_hash FROM raw_objects WHERE provider = \'intervals\' AND endpoint = $endpoint AND remote_id IS NOT DISTINCT FROM $remoteId ORDER BY fetched_at DESC LIMIT 1',
      { endpoint: endpoint.startsWith('activity_') ? endpoint : endpoint, remoteId: parentRemoteId },
    ))[0]?.content_hash ?? null;
    for (const [index, item] of asItems(payload).entries()) {
      const remoteId = idOf(item, `${endpoint}:${index}`);
      const entity: SourceEntity = {
        kind: 'source_entity', schemaVersion: 1, provider: 'intervals', entityType, remoteId, parentRemoteId,
        occurredOn: entityDate(item), sourceUpdatedAt: typeof item.updated === 'string' ? item.updated : null, rawObjectHash: artifactHash,
        payload: item, extension: {},
      };
      await importRecord(this.database, runId, entity);
      if (entityType === 'wellness') {
        await importRecord(this.database, runId, { ...entity, entityType: 'nutrition_day' });
      }
    }
  }

  private async getJson(route: string): Promise<unknown> {
    const response = await fetch(`${apiBaseUrl}${route}`, { headers: { Authorization: basicAuth(this.apiKey), Accept: 'application/json' } });
    if (!response.ok) throw new Error(`Intervals ${route} failed with HTTP ${response.status}`);
    return response.json();
  }

  private async getBinary(route: string): Promise<Uint8Array> {
    const response = await fetch(`${apiBaseUrl}${route}`, { headers: { Authorization: basicAuth(this.apiKey) } });
    if (!response.ok) throw new Error(`Intervals ${route} failed with HTTP ${response.status}`);
    return new Uint8Array(await response.arrayBuffer());
  }
}
