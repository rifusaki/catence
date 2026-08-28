import type { QueryValues } from '../../contracts/storage.js';
import { ReadOnlyRepository } from './repository.js';

type JsonObject = Record<string, unknown>;

/** A courseId resolved from an event (or activity) payload, or null when absent. */
export type ResolvedCourseId = string | null;

export interface ResolveEventCourseResult {
  eventId: string;
  provider: string | null;
  courseId: ResolvedCourseId;
  courseSynced: boolean;
  geometrySampleCount: number;
  caveats: string[];
}

export interface DiffCourseProfilesResult {
  eventCourseId: ResolvedCourseId;
  pastActivityCourseId: ResolvedCourseId;
  sameCourse: boolean | null;
  differentCourse: boolean | null;
  caveats: string[];
}

const COURSE_ID_KEYS = ['courseId', 'course_id', 'courseID'] as const;

/** Pull a courseId from a Garmin/Intervals event/activity payload, tolerating the
 * common key spellings and a nested `course.id` shape. Returns null when the
 * payload carries no course reference rather than guessing. */
export function extractCourseId(payload: unknown): ResolvedCourseId {
  let normalized = payload;
  if (typeof payload === 'string') {
    try {
      normalized = JSON.parse(payload);
    } catch {
      normalized = {};
    }
  }
  const record = (typeof normalized === 'object' && normalized !== null && !Array.isArray(normalized)
    ? normalized
    : {}) as JsonObject;
  for (const key of COURSE_ID_KEYS) {
    const value = record[key];
    if (typeof value === 'string' && value.length > 0) return value;
    if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  }
  const nested = record.course;
  if (nested !== null && typeof nested === 'object' && !Array.isArray(nested)) {
    const nestedId = (nested as JsonObject).id;
    if (typeof nestedId === 'string' && nestedId.length > 0) return nestedId;
    if (typeof nestedId === 'number' && Number.isFinite(nestedId)) return String(nestedId);
  }
  return null;
}

export class EventsService {
  constructor(private readonly repository: ReadOnlyRepository) {}

  /** Resolve an event's referenced Garmin courseId and report whether its
   * geometry has been synced. When geometry is absent, the result carries an
   * explicit caveat so the agent never silently reuses a prior course profile. */
  async resolveEventCourse(eventId: string): Promise<ResolveEventCourseResult> {
    const caveats: string[] = [];
    const events = await this.repository.rows<{ provider: string; payload_json: unknown }>(
      `SELECT provider, payload_json FROM source_entities
       WHERE entity_type = 'event' AND remote_id = $eventId
       ORDER BY provider = 'garmin' DESC, remote_id LIMIT 1`,
      { eventId } satisfies QueryValues,
    );
    if (events.length === 0) {
      return {
        eventId,
        provider: null,
        courseId: null,
        courseSynced: false,
        geometrySampleCount: 0,
        caveats: [`No event source entity found for eventId ${eventId}.`],
      };
    }
    const event = events[0];
    const courseId = extractCourseId(event.payload_json);
    if (courseId === null) {
      return {
        eventId,
        provider: event.provider,
        courseId: null,
        courseSynced: false,
        geometrySampleCount: 0,
        caveats: [`Event ${eventId} does not reference a courseId; no course profile to resolve.`],
      };
    }

    const synced = await this.repository.rows<{ remote_id: string }>(
      `SELECT remote_id FROM source_entities
       WHERE entity_type = 'course' AND remote_id = $courseId LIMIT 1`,
      { courseId } satisfies QueryValues,
    );
    const geometry = await this.repository.rows<{ sample_count: number | bigint }>(
      `SELECT count(*) AS sample_count FROM course_geometry WHERE course_id = $courseId`,
      { courseId } satisfies QueryValues,
    );
    const geometrySampleCount = geometry.length > 0 ? Number(geometry[0].sample_count) : 0;
    const courseSynced = synced.length > 0 && geometrySampleCount > 0;
    if (!courseSynced) {
      caveats.push(
        `Course geometry for courseId ${courseId} is not yet synced; this year's gradient is unverified until a recon run maps to that course. Do not reuse a prior course profile.`,
      );
    }
    return {
      eventId,
      provider: event.provider,
      courseId,
      courseSynced,
      geometrySampleCount,
      caveats,
    };
  }

  /** Compare an event's course against a past activity's course. A different
   * courseId means the prior profile does not apply; an absent reference is
   * reported as unknown rather than assumed equal. */
  async diffCourseProfiles(eventCourseId: ResolvedCourseId, pastActivityId?: string): Promise<DiffCourseProfilesResult> {
    const caveats: string[] = [];
    let pastActivityCourseId: ResolvedCourseId = null;
    if (pastActivityId) {
      const activities = await this.repository.rows<{ payload_json: unknown }>(
        `SELECT payload_json FROM source_entities
         WHERE entity_type = 'activity' AND remote_id = $activityId LIMIT 1`,
        { activityId: pastActivityId } satisfies QueryValues,
      );
      if (activities.length > 0) {
        pastActivityCourseId = extractCourseId(activities[0].payload_json);
      } else {
        caveats.push(`No activity source entity found for pastActivityId ${pastActivityId}; could not resolve its course.`);
      }
    }

    let sameCourse: boolean | null = null;
    let differentCourse: boolean | null = null;
    if (eventCourseId !== null && pastActivityCourseId !== null) {
      sameCourse = eventCourseId === pastActivityCourseId;
      differentCourse = !sameCourse;
      if (differentCourse) {
        caveats.push(
          `Event courseId ${eventCourseId} differs from past activity courseId ${pastActivityCourseId}; do not reuse the prior course profile.`,
        );
      }
    } else if (eventCourseId === null) {
      caveats.push('Event courseId is unknown; a prior course profile cannot be validated against it.');
    } else {
      caveats.push('Past activity courseId is unknown; a prior course profile cannot be confirmed or refuted.');
    }

    return { eventCourseId, pastActivityCourseId, sameCourse, differentCourse, caveats };
  }
}
