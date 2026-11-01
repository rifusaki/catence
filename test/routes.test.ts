import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { temporaryDatabase } from './helpers.js';
import { importRecord } from '../src/elt/ingestion/importer.js';
import { canonicalRouteId, normalizeRouteSport, reconcileRouteSources } from '../src/elt/normalization/routes.js';
import { RoutesService } from '../src/core/query/routes.js';
import { openReadOnlyRepository } from '../src/elt/storage/database.js';
import { readGarminStagedInventory, reconcileGarminCalendarEntities } from '../src/elt/application/management.js';
import type { SourceEntity } from '../src/contracts/staging.js';

function routeEntity(provider: 'garmin' | 'strava', remoteId: string, payload: Record<string, unknown>): SourceEntity {
  return {
    kind: 'source_entity',
    schemaVersion: 1,
    provider,
    entityType: 'route',
    remoteId,
    parentRemoteId: null,
    occurredOn: null,
    sourceUpdatedAt: null,
    rawObjectHash: `hash-${provider}-${remoteId}`,
    payload,
    extension: {},
  };
}

const MORNING_LOOP = {
  name: 'Morning Loop',
  sport: 'running',
  distance: 10_000,
  elevationGain: 120,
  segments: [{ id: '101', name: 'Hill Climb', distance: 800, average_grade: 6.5, activity_type: 'Run' }, { id: '102', name: 'River Sprint', distance: 400 }],
};

describe('route normalization', () => {
  it('merges Strava and Garmin occurrences of a same-named route into one canonical route with two sources', async () => {
    const { paths, database } = await temporaryDatabase();
    try {
      await importRecord(database, 'run-seed', routeEntity('strava', '555', MORNING_LOOP));
      await importRecord(database, 'run-seed', routeEntity('garmin', 'g-77', {
        courseName: 'Morning Loop',
        activityType: { typeKey: 'running' },
        distanceInMeters: 10_000,
        elevationGainInMeters: 120,
      }));

      const routes = await database.rows('SELECT route_id, name, sport, distance_m FROM route_facts');
      expect(routes).toHaveLength(1);
      expect(routes[0].name).toBe('Morning Loop');
      const expectedId = canonicalRouteId('Morning Loop', 'running');
      expect(routes[0].route_id).toBe(expectedId);

      const sources = await database.rows('SELECT route_source_id, provider, remote_route_id FROM route_sources ORDER BY provider');
      expect(sources.map((row) => row.route_source_id)).toEqual(['garmin:g-77', 'strava:555']);
      const sourceRouteIds = await database.rows<{ route_id: string }>('SELECT route_id FROM route_sources');
      expect(new Set(sourceRouteIds.map((row) => row.route_id))).toEqual(new Set([expectedId]));

      const segments = await database.rows('SELECT segment_id, position FROM route_segments ORDER BY position');
      expect(segments.map((row) => row.segment_id)).toEqual(['101', '102']);
      const stravaSegments = await database.rows("SELECT segment_id, name FROM strava_segments WHERE segment_id IN ('101', '102') ORDER BY segment_id");
      expect(stravaSegments.map((row) => row.name)).toEqual(['Hill Climb', 'River Sprint']);
    } finally {
      await database.close();
    }
  });

  it('does not rewrite unchanged routes and drops segments removed upstream', async () => {
    const { database } = await temporaryDatabase();
    try {
      await importRecord(database, 'run-1', routeEntity('strava', '555', MORNING_LOOP));
      const [before] = await database.rows<{ updated_at: string }>('SELECT cast(updated_at AS VARCHAR) AS updated_at FROM route_facts');
      await new Promise((resolve) => setTimeout(resolve, 1100));
      await importRecord(database, 'run-2', routeEntity('strava', '555', MORNING_LOOP));
      const [after] = await database.rows<{ updated_at: string }>('SELECT cast(updated_at AS VARCHAR) AS updated_at FROM route_facts');
      expect(after.updated_at).toBe(before.updated_at);

      await importRecord(database, 'run-3', routeEntity('strava', '555', { ...MORNING_LOOP, segments: [MORNING_LOOP.segments[0]] }));
      const segments = await database.rows('SELECT segment_id FROM route_segments');
      expect(segments.map((row) => row.segment_id)).toEqual(['101']);
    } finally {
      await database.close();
    }
  });

  it('refreshes route facts when a changed payload arrives', async () => {
    const { database } = await temporaryDatabase();
    try {
      await importRecord(database, 'run-1', routeEntity('strava', '555', MORNING_LOOP));
      const [before] = await database.rows<{ updated_at: string; distance_m: number }>(
        'SELECT cast(updated_at AS VARCHAR) AS updated_at, distance_m FROM route_facts',
      );
      await new Promise((resolve) => setTimeout(resolve, 1100));
      await importRecord(database, 'run-2', {
        ...routeEntity('strava', '555', { ...MORNING_LOOP, distance: 12_000, elevationGain: 180 }),
        rawObjectHash: 'hash-strava-555-changed',
      });
      const [after] = await database.rows<{ updated_at: string; distance_m: number; total_elevation_gain_m: number }>(
        'SELECT cast(updated_at AS VARCHAR) AS updated_at, distance_m, total_elevation_gain_m FROM route_facts',
      );
      expect(after.distance_m).toBe(12_000);
      expect(after.total_elevation_gain_m).toBe(180);
      expect(after.updated_at).not.toBe(before.updated_at);
    } finally {
      await database.close();
    }
  });

  it('maps Strava numeric route types and Garmin activityType families to one canonical route', async () => {
    const { database } = await temporaryDatabase();
    try {
      await importRecord(database, 'run-seed', routeEntity('strava', '555', {
        name: 'Coastal Loop', type: 1, distance: 50_000, elevation_gain: 300,
      }));
      await importRecord(database, 'run-seed', routeEntity('garmin', 'g-88', {
        courseName: 'Coastal Loop', activityType: { typeKey: 'road_biking' }, distanceInMeters: 50_000, elevationGainInMeters: 300,
      }));

      const routes = await database.rows<{ route_id: string; sport: string }>('SELECT route_id, sport FROM route_facts');
      expect(routes).toHaveLength(1);
      expect(routes[0].sport).toBe('cycling');
      expect(routes[0].route_id).toBe(canonicalRouteId('Coastal Loop', 'cycling'));
      const sources = await database.rows<{ route_source_id: string }>('SELECT route_source_id FROM route_sources ORDER BY route_source_id');
      expect(sources.map((row) => row.route_source_id)).toEqual(['garmin:g-88', 'strava:555']);
      expect(normalizeRouteSport(2)).toBe('running');
      expect(normalizeRouteSport({ typeKey: 'trail_running' })).toBe('running');
    } finally {
      await database.close();
    }
  });

  it('skips Garmin route reconciliation when the saved-route listing failed', async () => {
    const { paths, database } = await temporaryDatabase();
    try {
      await importRecord(database, 'run-seed', routeEntity('garmin', 'g-77', MORNING_LOOP));
      const manifest = path.join(paths.staging, 'garmin', 'failed.jsonl');
      await mkdir(path.dirname(manifest), { recursive: true });
      await writeFile(manifest, [
        JSON.stringify({ kind: 'run_manifest', runId: 'run-failed' }),
        JSON.stringify({ kind: 'extraction_error', provider: 'garmin', endpoint: 'routes', message: 'boom' }),
      ].join('\n'));
      const inventory = await readGarminStagedInventory(manifest);
      expect(inventory.routeListingFailed).toBe(true);
      await reconcileGarminCalendarEntities(database, manifest);
      const sources = await database.rows<{ route_source_id: string }>('SELECT route_source_id FROM route_sources');
      expect(sources.map((row) => row.route_source_id)).toEqual(['garmin:g-77']);
    } finally {
      await database.close();
    }
  });

  it('preserves Strava segments when a Garmin mirror imports, then drops them when the Strava source is removed', async () => {
    const { database } = await temporaryDatabase();
    try {
      await importRecord(database, 'run-seed', routeEntity('strava', '555', MORNING_LOOP));
      await importRecord(database, 'run-seed', routeEntity('garmin', 'g-77', {
        courseName: 'Morning Loop',
        activityType: { typeKey: 'running' },
        distanceInMeters: 10_000,
        elevationGainInMeters: 120,
      }));

      const before = await database.rows('SELECT segment_id FROM route_segments ORDER BY segment_id');
      expect(before.map((row) => row.segment_id)).toEqual(['101', '102']);

      const result = await reconcileRouteSources(database, 'strava', []);
      expect(result.deletedSources).toBe(1);
      expect(result.deletedRoutes).toBe(0);

      const sources = await database.rows('SELECT route_source_id FROM route_sources');
      expect(sources.map((row) => row.route_source_id)).toEqual(['garmin:g-77']);
      const routes = await database.rows('SELECT route_id FROM route_facts');
      expect(routes).toHaveLength(1);
      const segments = await database.rows('SELECT segment_id FROM route_segments');
      expect(segments).toHaveLength(0);
    } finally {
      await database.close();
    }
  });

  it('mirror-sync deletes sources missing from the latest listing and routes left sourceless', async () => {
    const { database } = await temporaryDatabase();
    try {
      await importRecord(database, 'run-seed', routeEntity('strava', 'keep', { name: 'Keep Me', sport: 'Ride' }));
      await importRecord(database, 'run-seed', routeEntity('strava', 'ghost', { name: 'Ghost Route', sport: 'Ride', segments: [{ id: '9' }] }));
      await importRecord(database, 'run-seed', routeEntity('garmin', 'shared', { name: 'Keep Me', sport: 'Ride' }));

      const result = await reconcileRouteSources(database, 'strava', ['keep']);
      expect(result.deletedSources).toBe(1);
      expect(result.deletedRoutes).toBe(1);

      const sources = await database.rows('SELECT route_source_id FROM route_sources ORDER BY route_source_id');
      expect(sources.map((row) => row.route_source_id)).toEqual(['garmin:shared', 'strava:keep']);
      // The shared route survives because the Garmin occurrence remains.
      const routes = await database.rows('SELECT route_id FROM route_facts');
      expect(routes).toHaveLength(1);
      const orphanSegments = await database.rows("SELECT segment_id FROM route_segments WHERE segment_id = '9'");
      expect(orphanSegments).toHaveLength(0);

      // Reconciling the other provider leaves the Strava occurrence alone.
      await reconcileRouteSources(database, 'garmin', []);
      const remaining = await database.rows('SELECT route_source_id FROM route_sources');
      expect(remaining.map((row) => row.route_source_id)).toEqual(['strava:keep']);
    } finally {
      await database.close();
    }
  });
});

describe('RoutesService', () => {
  it('finds routes by friendly name and hydrates route segments', async () => {
    const { paths, database } = await temporaryDatabase();
    try {
      await importRecord(database, 'run-seed', routeEntity('strava', '555', MORNING_LOOP));
      await importRecord(database, 'run-seed', routeEntity('strava', '556', { name: 'Morning Loop Long', sport: 'running', distance: 21_000 }));
      await database.close();

      const repository = await openReadOnlyRepository(paths);
      try {
        const service = new RoutesService(repository);
        const found = await service.findRoutes('morning loop');
        expect(found.exact?.name).toBe('Morning Loop');
        expect(found.matches).toHaveLength(2);
        expect(found.matches[0].sources).toEqual([{ route_source_id: 'strava:555', provider: 'strava', remote_route_id: '555' }]);

        const segments = await service.routeSegments(found.exact!.route_id, 100);
        expect(segments.route?.route_id).toBe(found.exact!.route_id);
        expect(segments.segments.map((segment) => [segment.segment_id, segment.segment_name, segment.average_grade_pct])).toEqual([
          ['101', 'Hill Climb', 6.5],
          ['102', 'River Sprint', null],
        ]);

        const bySourceId = await service.resolveRoute('strava:555');
        expect(bySourceId?.route_id).toBe(found.exact!.route_id);

        const missing = await service.routeSegments('route:nope', 100);
        expect(missing.route).toBeNull();
        expect(missing.caveats[0]).toContain('find_route');
      } finally {
        await repository.close();
      }
    } finally {
      // database already closed above
    }
  });
});
