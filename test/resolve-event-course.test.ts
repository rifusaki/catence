import { describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { importRecord } from '../src/elt/ingestion/importer.js';
import { EventsService } from '../src/core/query/events.js';
import { openReadOnlyRepository } from '../src/elt/storage/database.js';
import { createCatenceMcpServer } from '../src/interfaces/mcp/server.js';
import { temporaryDatabase } from './helpers.js';

const EVENT_ID = '29653696';
const COURSE_ID = '507213271';

type Db = Awaited<ReturnType<typeof temporaryDatabase>>['database'];

async function seedEvent(db: Db, withCourseEntity: boolean, withCoursePoints = false): Promise<void> {
  const runId = await db.beginRun('garmin', '2026-08-25');
  await importRecord(db, runId, {
    kind: 'source_entity', schemaVersion: 1, provider: 'garmin', entityType: 'event', remoteId: EVENT_ID,
    parentRemoteId: null, occurredOn: '2026-08-25', sourceUpdatedAt: null, rawObjectHash: null,
    payload: { courseId: COURSE_ID, name: 'Autumn Half Marathon' }, extension: {},
  });
  if (withCourseEntity) {
    await importRecord(db, runId, {
      kind: 'source_entity', schemaVersion: 1, provider: 'garmin', entityType: 'course', remoteId: COURSE_ID,
      parentRemoteId: null, occurredOn: '2026-08-25', sourceUpdatedAt: null, rawObjectHash: null,
      payload: withCoursePoints
        ? { courseId: COURSE_ID, geoPoints: [
            { latitude: 47.3, longitude: 11.2, elevation: 540, distance: 0 },
            { latitude: 47.301, longitude: 11.2, elevation: 550, distance: 100 },
            { latitude: 47.302, longitude: 11.2, elevation: 560, distance: 200 },
          ] }
        : { courseId: COURSE_ID },
      extension: {},
    });
  }
}

describe('resolve_event_course (A4)', () => {
  it('resolves the event courseId and flags unsynced geometry honestly', async () => {
    const setup = await temporaryDatabase();
    await seedEvent(setup.database, true); // course entity present, no geometry yet
    const repository = await openReadOnlyRepository(setup.paths);
    try {
      const resolved = await new EventsService(repository).resolveEventCourse(EVENT_ID);
      expect(resolved.eventId).toBe(EVENT_ID);
      expect(resolved.courseId).toBe(COURSE_ID);
      expect(resolved.courseSynced).toBe(false);
      expect(resolved.caveats.join(' ')).toMatch(/not yet synced/i);
    } finally {
      await repository.close();
    }
  });

  it('importGarminCourse normalizes course geometry so the course reads as synced', async () => {
    const setup = await temporaryDatabase();
    await seedEvent(setup.database, true, true); // course entity with points -> importGarminCourse
    const repository = await openReadOnlyRepository(setup.paths);
    try {
      const resolved = await new EventsService(repository).resolveEventCourse(EVENT_ID);
      expect(resolved.courseSynced).toBe(true);
      expect(resolved.geometrySampleCount).toBe(3);
      expect(resolved.caveats).toHaveLength(0);
    } finally {
      await repository.close();
    }
  });

  it('diffs the event course against a past activity with a different courseId', async () => {
    const setup = await temporaryDatabase();
    await seedEvent(setup.database, true);
    const runId = await setup.database.beginRun('garmin', '2026-08-20');
    await importRecord(setup.database, runId, {
      kind: 'source_entity', schemaVersion: 1, provider: 'garmin', entityType: 'activity', remoteId: 'garmin-prior-run',
      parentRemoteId: null, occurredOn: '2026-08-20', sourceUpdatedAt: null, rawObjectHash: null,
      payload: { courseId: '999999999', activityId: 'garmin-prior-run' }, extension: {},
    });
    const repository = await openReadOnlyRepository(setup.paths);
    try {
      const events = new EventsService(repository);
      const resolved = await events.resolveEventCourse(EVENT_ID);
      const diff = await events.diffCourseProfiles(resolved.courseId, 'garmin-prior-run');
      expect(diff.eventCourseId).toBe(COURSE_ID);
      expect(diff.pastActivityCourseId).toBe('999999999');
      expect(diff.differentCourse).toBe(true);
      expect(diff.caveats.join(' ')).toMatch(/differs from past activity courseId/i);
    } finally {
      await repository.close();
    }
  });

  it('exposes resolve_event_course through MCP with honest caveats before sync', async () => {
    const setup = await temporaryDatabase();
    await seedEvent(setup.database, true);
    const server = createCatenceMcpServer(setup.paths);
    const client = new Client({ name: 'resolve-event-course-test', version: '0.2.0' });
    const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    try {
      const result = await client.callTool({ name: 'resolve_event_course', arguments: { eventId: EVENT_ID } });
      expect(result.isError).toBeFalsy();
      const parsed = JSON.parse((result.content as Array<{ text: string }>)[0]!.text);
      expect(parsed.data.event.courseId).toBe(COURSE_ID);
      expect(parsed.data.event.courseSynced).toBe(false);
      expect(parsed.caveats.join(' ')).toMatch(/not yet synced/i);
    } finally {
      await client.close();
      await server.close();
    }
  });

  it('exposes course_geometry as a queryable catalog dataset for elevation profiles', async () => {
    const setup = await temporaryDatabase();
    await seedEvent(setup.database, true, true); // course entity with points -> importGarminCourse
    const server = createCatenceMcpServer(setup.paths);
    const client = new Client({ name: 'resolve-event-course-test', version: '0.2.0' });
    const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    try {
      const data = await client.callTool({ name: 'describe_data', arguments: {} });
      const payload = JSON.parse((data.content as Array<{ text: string }>)[0]!.text) as { data: { datasets: Array<{ name: string; columns: Array<{ name: string }> }> } };
      const course = payload.data.datasets.find((dataset) => dataset.name === 'course_geometry');
      expect(course).toBeDefined();
      expect(course?.columns.map((column) => column.name)).toEqual(expect.arrayContaining(['course_id', 'lat', 'lon', 'altitude_m', 'distance_m', 'seq']));
      const aggregate = await client.callTool({ name: 'aggregate_data', arguments: { dataset: 'course_geometry', metrics: [{ column: 'altitude_m', operation: 'mean', as: 'mean_alt' }, { column: 'altitude_m', operation: 'min', as: 'min_alt' }, { column: 'altitude_m', operation: 'max', as: 'max_alt' }], dimensions: ['course_id'] } });
      expect(aggregate.isError).toBeFalsy();
      const aggregatePayload = JSON.parse((aggregate.content as Array<{ text: string }>)[0]!.text) as { data: Array<{ course_id: string; mean_alt: number; min_alt: number; max_alt: number }> };
      expect(aggregatePayload.data).toEqual([expect.objectContaining({ course_id: COURSE_ID, min_alt: 540, max_alt: 560 })]);
    } finally {
      await client.close();
      await server.close();
    }
  });
});
