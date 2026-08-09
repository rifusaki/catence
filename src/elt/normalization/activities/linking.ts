import type { CatenceDatabase } from '../../storage/database.js';
import { json } from '../../storage/sql.js';

type ActivityRow = {
  activity_source_id: string;
  activity_id: string;
  provider: string;
  remote_activity_id: string;
  external_id: string | null;
  started_at_utc: string | Date | null;
  sport: string | null;
  distance_m: number | null;
  moving_s: number | null;
};

function sportFamily(value: string | null): string | null {
  if (!value) return null;
  const normalized = value.toLowerCase().replaceAll(/[^a-z]/g, '');
  if (normalized.includes('ride') || normalized.includes('cycling') || normalized.includes('bik')) return 'ride';
  if (normalized.includes('run')) return 'run';
  if (normalized.includes('swim')) return 'swim';
  return normalized || null;
}

function isVirtualOrIndoor(value: string | null): boolean {
  return Boolean(value && /virtual|indoor/i.test(value));
}

function timestamp(value: string | Date | null): number | null {
  if (!value) return null;
  const parsed = Date.parse(value instanceof Date ? value.toISOString() : value);
  return Number.isFinite(parsed) ? parsed : null;
}

function qualifies(source: ActivityRow, candidate: ActivityRow): { score: number; evidence: Record<string, unknown> } | null {
  if (source.provider === candidate.provider || !source.started_at_utc || !candidate.started_at_utc) return null;
  if (!source.distance_m || !candidate.distance_m || !source.moving_s || !candidate.moving_s) return null;
  if (sportFamily(source.sport) !== sportFamily(candidate.sport)) return null;
  if (isVirtualOrIndoor(source.sport) !== isVirtualOrIndoor(candidate.sport)) return null;
  const startDelta = Math.abs(timestamp(source.started_at_utc)! - timestamp(candidate.started_at_utc)!) / 1_000;
  const durationDelta = Math.abs(source.moving_s - candidate.moving_s);
  const distanceDelta = Math.abs(source.distance_m - candidate.distance_m);
  const maxDuration = Math.max(120, source.moving_s * 0.05);
  const maxDistance = Math.max(200, source.distance_m * 0.025);
  if (startDelta > 90 || durationDelta > maxDuration || distanceDelta > maxDistance) return null;
  const score = 1 - ((startDelta / 90) + (durationDelta / maxDuration) + (distanceDelta / maxDistance)) / 3;
  return { score, evidence: { sportFamily: sportFamily(source.sport), startDeltaSeconds: startDelta, durationDeltaSeconds: durationDelta, distanceDeltaMeters: distanceDelta, thresholds: { startSeconds: 90, durationSeconds: maxDuration, distanceMeters: maxDistance } } };
}

/** Attach a source to a logical activity only when its link is provable or uniquely high-confidence. */
export async function reconcileActivityLink(database: CatenceDatabase, activitySourceId: string): Promise<void> {
  const sources = await database.rows<ActivityRow>(`
    SELECT source.activity_source_id, source.activity_id, source.provider, source.remote_activity_id, source.external_id,
      activity.started_at_utc, activity.sport, summary.distance_m, summary.moving_s
    FROM activity_sources source
    JOIN activities activity USING (activity_id)
    LEFT JOIN activity_summaries summary USING (activity_source_id)
    WHERE source.activity_source_id = $activitySourceId
  `, { activitySourceId });
  const source = sources[0];
  if (!source) return;
  const current = await database.rows<{ method: string; activity_id: string }>('SELECT method, activity_id FROM activity_links WHERE activity_source_id = $activitySourceId', { activitySourceId });
  if (current[0]?.method === 'manual' || current[0]?.method === 'fuzzy_high_confidence') {
    if (source.activity_id !== current[0].activity_id) {
      await database.run('UPDATE activity_sources SET activity_id = $activityId WHERE activity_source_id = $activitySourceId', { activityId: current[0].activity_id, activitySourceId });
    }
    return;
  }

  const externalCandidates = source.provider === 'intervals' && source.external_id
    ? await database.rows<ActivityRow>(`
      SELECT source.activity_source_id, source.activity_id, source.provider, source.remote_activity_id, source.external_id,
        activity.started_at_utc, activity.sport, summary.distance_m, summary.moving_s
      FROM activity_sources source
      JOIN activities activity USING (activity_id)
      LEFT JOIN activity_summaries summary USING (activity_source_id)
      WHERE source.provider = 'garmin' AND source.remote_activity_id = $externalId
    `, { externalId: source.external_id })
    : source.provider === 'garmin'
      ? await database.rows<ActivityRow>(`
        SELECT source.activity_source_id, source.activity_id, source.provider, source.remote_activity_id, source.external_id,
          activity.started_at_utc, activity.sport, summary.distance_m, summary.moving_s
        FROM activity_sources source
        JOIN activities activity USING (activity_id)
        LEFT JOIN activity_summaries summary USING (activity_source_id)
        WHERE source.provider = 'intervals' AND source.external_id = $remoteActivityId
      `, { remoteActivityId: source.remote_activity_id })
      : [];
  const externalCandidate = externalCandidates.length === 1 ? externalCandidates[0] : null;
  if (externalCandidate) {
    const linkMethods = await database.rows<{ activity_source_id: string; method: string }>(
      `SELECT activity_source_id, method FROM activity_links WHERE activity_source_id = $sourceId OR activity_source_id = $candidateId`,
      { sourceId: source.activity_source_id, candidateId: externalCandidate.activity_source_id },
    );
    if (!linkMethods.some((link) => link.method === 'manual')) {
      const garmin = source.provider === 'garmin' ? source : externalCandidate;
      const intervals = source.provider === 'intervals' ? source : externalCandidate;
      const targetActivityId = garmin.activity_id;
      const previousActivityIds = new Set([source.activity_id, externalCandidate.activity_id]);
      for (const linkedSource of [source, externalCandidate]) {
        await database.run('UPDATE activity_sources SET activity_id = $activityId WHERE activity_source_id = $activitySourceId', {
          activityId: targetActivityId, activitySourceId: linkedSource.activity_source_id,
        });
        await database.run(
          `INSERT INTO activity_links VALUES ($activitySourceId, $activityId, 'strong_external_id', 1.0, $evidence, now())
           ON CONFLICT (activity_source_id) DO UPDATE SET activity_id = excluded.activity_id, method = excluded.method,
             confidence = excluded.confidence, evidence_json = excluded.evidence_json, linked_at = now()`,
          {
            activitySourceId: linkedSource.activity_source_id, activityId: targetActivityId,
            evidence: json({ matchedActivitySourceId: linkedSource.provider === 'garmin' ? intervals.activity_source_id : garmin.activity_source_id, externalId: intervals.external_id }),
          },
        );
      }
      await database.run(`UPDATE activities SET link_state = 'strong_external_id' WHERE activity_id = $activityId`, { activityId: targetActivityId });
      for (const previousActivityId of previousActivityIds) {
        await database.run('DELETE FROM activities WHERE activity_id = $activityId AND NOT EXISTS (SELECT 1 FROM activity_sources WHERE activity_id = $activityId)', { activityId: previousActivityId });
      }
      return;
    }
  }

  if (source.external_id) {
    await database.run(
      `INSERT INTO activity_links VALUES ($activitySourceId, $activityId, 'strong_external_id', 1.0, '{}', now())
       ON CONFLICT (activity_source_id) DO UPDATE SET activity_id = excluded.activity_id, method = excluded.method, confidence = excluded.confidence, evidence_json = excluded.evidence_json, linked_at = now()`,
      { activitySourceId, activityId: source.activity_id },
    );
    return;
  }

  const candidates = await database.rows<ActivityRow>(`
    SELECT source.activity_source_id, source.activity_id, source.provider, source.remote_activity_id, source.external_id,
      activity.started_at_utc, activity.sport, summary.distance_m, summary.moving_s
    FROM activity_sources source
    JOIN activities activity USING (activity_id)
    LEFT JOIN activity_summaries summary USING (activity_source_id)
    WHERE source.activity_source_id <> $activitySourceId
      AND source.provider <> $provider
      AND activity.started_at_utc BETWEEN $startFloor AND $startCeiling
  `, {
    activitySourceId, provider: source.provider,
    startFloor: new Date(timestamp(source.started_at_utc)! - 90_000).toISOString(),
    startCeiling: new Date(timestamp(source.started_at_utc)! + 90_000).toISOString(),
  });
  const matched = candidates.map((candidate) => ({ candidate, result: qualifies(source, candidate) })).filter((item): item is { candidate: ActivityRow; result: { score: number; evidence: Record<string, unknown> } } => item.result !== null);
  // A provider may already be strongly linked alongside a second source (for
  // example Garmin plus Intervals). Those are one logical candidate, not an
  // ambiguity that should prevent a matching Strava source from joining it.
  const logicalMatches = new Map<string, typeof matched[number]>();
  for (const match of matched) {
    const previous = logicalMatches.get(match.candidate.activity_id);
    if (!previous || match.result.score > previous.result.score) logicalMatches.set(match.candidate.activity_id, match);
  }
  const uniqueMatches = [...logicalMatches.values()];
  if (uniqueMatches.length !== 1) {
    await database.run(
      `INSERT INTO activity_links VALUES ($activitySourceId, $activityId, 'source', NULL, $evidence, now())
       ON CONFLICT (activity_source_id) DO UPDATE SET activity_id = excluded.activity_id, method = excluded.method, confidence = excluded.confidence, evidence_json = excluded.evidence_json, linked_at = now()`,
      { activitySourceId, activityId: source.activity_id, evidence: json({ candidates: uniqueMatches.length, matchingSources: matched.length, reason: uniqueMatches.length ? 'ambiguous' : 'no_qualifying_candidate' }) },
    );
    return;
  }
  const { candidate, result } = uniqueMatches[0]!;
  const oldActivityId = source.activity_id;
  await database.run('UPDATE activity_sources SET activity_id = $activityId WHERE activity_source_id = $activitySourceId', { activityId: candidate.activity_id, activitySourceId });
  await database.run(`UPDATE activities SET link_state = 'fuzzy_high_confidence' WHERE activity_id = $activityId`, { activityId: candidate.activity_id });
  await database.run(
    `INSERT INTO activity_links VALUES ($activitySourceId, $activityId, 'fuzzy_high_confidence', $confidence, $evidence, now())
     ON CONFLICT (activity_source_id) DO UPDATE SET activity_id = excluded.activity_id, method = excluded.method, confidence = excluded.confidence, evidence_json = excluded.evidence_json, linked_at = now()`,
    { activitySourceId, activityId: candidate.activity_id, confidence: result.score, evidence: json({ ...result.evidence, matchedActivitySourceId: candidate.activity_source_id }) },
  );
  await database.run('DELETE FROM activities WHERE activity_id = $activityId AND NOT EXISTS (SELECT 1 FROM activity_sources WHERE activity_id = $activityId)', { activityId: oldActivityId });
}

export async function setManualActivityLink(database: CatenceDatabase, activitySourceId: string, activityId: string): Promise<void> {
  await database.run('UPDATE activity_sources SET activity_id = $activityId WHERE activity_source_id = $activitySourceId', { activityId, activitySourceId });
  await database.run(`UPDATE activities SET link_state = 'manual' WHERE activity_id = $activityId`, { activityId });
  await database.run(
    `INSERT INTO activity_links VALUES ($activitySourceId, $activityId, 'manual', 1.0, '{"command":"link"}', now())
     ON CONFLICT (activity_source_id) DO UPDATE SET activity_id = excluded.activity_id, method = excluded.method, confidence = excluded.confidence, evidence_json = excluded.evidence_json, linked_at = now()`,
    { activitySourceId, activityId },
  );
}

export async function unlinkActivitySource(database: CatenceDatabase, activitySourceId: string): Promise<void> {
  const source = (await database.rows<{ provider: string; remote_activity_id: string }>('SELECT provider, remote_activity_id FROM activity_sources WHERE activity_source_id = $activitySourceId', { activitySourceId }))[0];
  if (!source) throw new Error(`No activity source exists for ${activitySourceId}.`);
  const activityId = `${source.provider}:${source.remote_activity_id}`;
  await database.run(`INSERT INTO activities (activity_id, link_state) VALUES ($activityId, 'unlinked') ON CONFLICT (activity_id) DO NOTHING`, { activityId });
  await database.run('UPDATE activity_sources SET activity_id = $activityId WHERE activity_source_id = $activitySourceId', { activityId, activitySourceId });
  await database.run(`UPDATE activity_links SET activity_id = $activityId, method = 'source', confidence = NULL, evidence_json = '{"command":"unlink"}', linked_at = now() WHERE activity_source_id = $activitySourceId`, { activityId, activitySourceId });
}
