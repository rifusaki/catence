import { createHash } from 'node:crypto';
import type { WriteDataStore } from '../../contracts/storage.js';
import type { DataFilter } from '../query/analytics.js';
import { compileFilters } from '../query/analytics.js';
import { getDataset, QueryValidationError } from '../query/catalog.js';
import { jsonSafe, ReadOnlyRepository } from '../query/repository.js';

type RetrievalDocument = {
  entityType: string;
  entityId: string;
  activitySourceId?: string | null;
  provider?: string | null;
  occurredOn?: string | null;
  text: string;
  metadata: Record<string, unknown>;
};

function short(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const normalized = value.replace(/\s+/g, ' ').trim();
  return normalized ? normalized.slice(0, 2_000) : null;
}

function dateText(value: unknown): string | null {
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  if (typeof value === 'string') return value.slice(0, 10) || null;
  return null;
}

function documentId(document: RetrievalDocument): string {
  return createHash('sha256').update(`${document.entityType}\u0000${document.entityId}\u0000${document.text}`).digest('hex');
}

function words(...parts: Array<string | null | undefined>): string {
  return parts.filter((part): part is string => Boolean(part)).join('. ').replace(/\s+/g, ' ').trim();
}

function payloadObject(value: unknown): Record<string, unknown> {
  if (typeof value === 'string') {
    try { return JSON.parse(value) as Record<string, unknown>; } catch { return {}; }
  }
  return value && typeof value === 'object' ? value as Record<string, unknown> : {};
}

function selectedPayloadText(payload: Record<string, unknown>): string[] {
  const fields = ['name', 'title', 'description', 'notes', 'note', 'message', 'text', 'tags', 'workoutName', 'routeName', 'eventName'];
  return fields.flatMap((field) => {
    const value = payload[field];
    if (Array.isArray(value)) return value.map(short).filter((entry): entry is string => Boolean(entry));
    const result = short(value);
    return result ? [result] : [];
  });
}

export async function buildRetrievalIndex(database: WriteDataStore): Promise<{ documents: number; mode: 'full_text' | 'keyword'; watermark: string | null }> {
  const documents: RetrievalDocument[] = [];
  const activities = await database.rows<Record<string, unknown>>(`
    SELECT summary.activity_source_id, source.activity_id, source.provider, cast(activity.started_at_utc AS DATE) AS occurred_on,
      activity.name, activity.sport, summary.distance_m, summary.moving_s, summary.training_load, summary.avg_hr, summary.avg_power, summary.weighted_power, summary.calories, summary.metrics_json
    FROM activity_summaries summary
    JOIN activity_sources source USING (activity_source_id)
    JOIN activities activity USING (activity_id)
  `);
  for (const activity of activities) {
    const facts = [
      activity.sport ? `sport ${activity.sport}` : null,
      activity.distance_m ? `${Number(activity.distance_m).toFixed(0)} m` : null,
      activity.moving_s ? `${Math.round(Number(activity.moving_s) / 60)} min moving` : null,
      activity.training_load ? `training load ${activity.training_load}` : null,
      activity.avg_hr ? `average heart rate ${activity.avg_hr} bpm` : null,
      activity.avg_power ? `average power ${activity.avg_power} W` : null,
      activity.calories ? `${activity.calories} kcal` : null,
    ].filter(Boolean).join(', ');
    const text = words(short(activity.name), facts ? `Activity summary: ${facts}` : null);
    if (text) documents.push({ entityType: 'activity', entityId: String(activity.activity_id), activitySourceId: String(activity.activity_source_id), provider: String(activity.provider), occurredOn: dateText(activity.occurred_on), text, metadata: { sport: activity.sport, name: activity.name } });
  }
  const intervals = await database.rows<Record<string, unknown>>(`
    SELECT intervals.activity_source_id, source.activity_id, source.provider, cast(activity.started_at_utc AS DATE) AS occurred_on,
      intervals.interval_key, intervals.label, intervals.start_s, intervals.end_s, intervals.avg_power, intervals.avg_hr
    FROM activity_intervals intervals JOIN activity_sources source USING (activity_source_id) JOIN activities activity USING (activity_id)
  `);
  for (const interval of intervals) {
    const text = words(short(interval.label), `Interval ${interval.interval_key}`, interval.avg_power ? `average power ${interval.avg_power} W` : null, interval.avg_hr ? `average heart rate ${interval.avg_hr} bpm` : null);
    documents.push({ entityType: 'activity_interval', entityId: `${interval.activity_source_id}:${interval.interval_key}`, activitySourceId: String(interval.activity_source_id), provider: String(interval.provider), occurredOn: dateText(interval.occurred_on), text, metadata: { activityId: interval.activity_id, label: interval.label } });
  }
  const nutritionDays = await database.rows<Record<string, unknown>>('SELECT provider, cast(nutrition_date AS VARCHAR) AS nutrition_date, energy_kcal, carbohydrates_g, protein_g, fat_g, hydration_ml FROM nutrition_days');
  for (const day of nutritionDays) {
    const parts = [day.energy_kcal ? `${day.energy_kcal} kcal` : null, day.carbohydrates_g ? `${day.carbohydrates_g} g carbohydrate` : null, day.protein_g ? `${day.protein_g} g protein` : null, day.fat_g ? `${day.fat_g} g fat` : null, day.hydration_ml ? `${day.hydration_ml} ml hydration` : null];
    documents.push({ entityType: 'nutrition_day', entityId: `${day.provider}:${dateText(day.nutrition_date)}`, provider: String(day.provider), occurredOn: dateText(day.nutrition_date), text: words('Nutrition summary', ...parts), metadata: {} });
  }
  const nutritionItems = await database.rows<Record<string, unknown>>('SELECT provider, remote_item_id, cast(nutrition_date AS VARCHAR) AS nutrition_date, meal, food_name, energy_kcal, carbohydrates_g, protein_g, fat_g FROM nutrition_items');
  for (const item of nutritionItems) {
    const text = words(short(item.food_name), short(item.meal), item.energy_kcal ? `${item.energy_kcal} kcal` : null, item.carbohydrates_g ? `${item.carbohydrates_g} g carbohydrate` : null, item.protein_g ? `${item.protein_g} g protein` : null);
    if (text) documents.push({ entityType: 'nutrition_item', entityId: `${item.provider}:${item.remote_item_id}`, provider: String(item.provider), occurredOn: dateText(item.nutrition_date), text, metadata: { meal: item.meal, foodName: item.food_name } });
  }
  const domain = await database.rows<Record<string, unknown>>(`
    SELECT provider, entity_type, remote_id, cast(occurred_on AS VARCHAR) AS occurred_on, payload_json
    FROM domain_entities
    WHERE entity_type IN ('event', 'workout', 'scheduled_workout', 'training_plan', 'route', 'message')
  `);
  for (const entity of domain) {
    const fields = selectedPayloadText(payloadObject(entity.payload_json));
    const entityType = String(entity.entity_type);
    if (fields.length) documents.push({ entityType, entityId: String(entity.remote_id), provider: String(entity.provider), occurredOn: dateText(entity.occurred_on), text: words(`${entityType.replaceAll('_', ' ')}`, ...fields), metadata: {} });
  }
  const weekly = await database.rows<Record<string, unknown>>(`
    SELECT date_trunc('week', started_at_utc)::DATE AS week, count(*)::INTEGER AS activities, sum(moving_s) AS moving_s, sum(training_load) AS training_load
    FROM canonical_activity_training GROUP BY 1
  `);
  for (const week of weekly) {
    const weekDate = dateText(week.week);
    if (weekDate) documents.push({ entityType: 'weekly_training_summary', entityId: weekDate, occurredOn: weekDate, text: words(`Week beginning ${weekDate}`, `${week.activities} activities`, week.moving_s ? `${Math.round(Number(week.moving_s) / 60)} minutes training` : null, week.training_load ? `training load ${week.training_load}` : null), metadata: {} });
  }
  const trainingMetrics = await database.rows<Record<string, unknown>>(`
    SELECT observation_id, provider, metric_name, sport, device_id, cast(observed_at AS VARCHAR) AS observed_at,
      value_number, value_text, unit, source_type
    FROM training_metric_observations
  `);
  for (const metric of trainingMetrics) {
    const value = metric.value_number !== null && metric.value_number !== undefined
      ? `${metric.value_number}${metric.unit ? ` ${metric.unit}` : ''}`
      : short(metric.value_text);
    const text = words(
      String(metric.metric_name).replaceAll('_', ' '),
      value ? `value ${value}` : null,
      metric.sport ? `sport ${metric.sport}` : null,
      metric.device_id ? `device ${metric.device_id}` : null,
      metric.source_type ? `source ${metric.source_type}` : null,
    );
    if (text) documents.push({
      entityType: 'training_metric', entityId: String(metric.observation_id), provider: String(metric.provider),
      occurredOn: dateText(metric.observed_at), text, metadata: { metricName: metric.metric_name, sport: metric.sport, deviceId: metric.device_id },
    });
  }
  const deduplicated = new Map(documents.map((document) => [documentId(document), document]));
  const watermarkRows = await database.rows<{ watermark: string | null }>('SELECT max(cast(fetched_at AS VARCHAR)) AS watermark FROM raw_objects');
  const watermark = watermarkRows[0]?.watermark ?? null;
  let mode: 'full_text' | 'keyword' = 'keyword';
  await database.run('BEGIN TRANSACTION');
  try {
    await database.run('DELETE FROM retrieval_documents');
    for (const document of deduplicated.values()) {
      const id = documentId(document);
      await database.run(`INSERT INTO retrieval_documents (document_id, entity_type, entity_id, activity_source_id, provider, occurred_on, document_text, metadata_json, content_hash)
        VALUES ($id, $entityType, $entityId, $activitySourceId, $provider, $occurredOn, $text, $metadata, $hash)`, {
        id, entityType: document.entityType, entityId: document.entityId, activitySourceId: document.activitySourceId ?? null, provider: document.provider ?? null, occurredOn: document.occurredOn || null, text: document.text, metadata: JSON.stringify(document.metadata), hash: id,
      });
    }
    await database.run(`INSERT INTO retrieval_index_state (index_name, status, mode, source_watermark, built_at, detail_json)
      VALUES ('context', 'ready', $mode, $watermark, now(), $detail)
      ON CONFLICT (index_name) DO UPDATE SET status = excluded.status, mode = excluded.mode, source_watermark = excluded.source_watermark, built_at = excluded.built_at, detail_json = excluded.detail_json`, {
      mode, watermark, detail: JSON.stringify({ documentCount: deduplicated.size }),
    });
    await database.run('COMMIT');
  } catch (error) {
    await database.run('ROLLBACK');
    throw error;
  }
  mode = await tryBuildFts(database);
  if (mode === 'full_text') {
    await database.run("UPDATE retrieval_index_state SET mode = 'full_text' WHERE index_name = 'context'");
  }
  return { documents: deduplicated.size, mode, watermark };
}

async function tryBuildFts(database: WriteDataStore): Promise<'full_text' | 'keyword'> {
  try {
    // No INSTALL: extensions must already be local.  Failure intentionally falls back to keyword search.
    await database.run('LOAD fts');
    try { await database.run("PRAGMA drop_fts_index('retrieval_documents')"); } catch { /* index may not exist */ }
    await database.run("PRAGMA create_fts_index('retrieval_documents', 'document_id', 'document_text')");
    await database.rows("SELECT fts_main_retrieval_documents.match_bm25(document_id, 'catence') AS score FROM retrieval_documents LIMIT 1");
    return 'full_text';
  } catch {
    return 'keyword';
  }
}

export async function searchContext(repository: ReadOnlyRepository, request: { query: string; filters?: DataFilter[]; limit?: number }): Promise<Record<string, unknown>> {
  const query = request.query.trim();
  if (query.length < 2 || query.length > 500) throw new QueryValidationError('search_context requires a 2–500 character query.');
  const limit = Math.min(Math.max(request.limit ?? 10, 1), 50);
  const state = await repository.rows<{ mode: 'full_text' | 'keyword'; status: string }>("SELECT mode, status FROM retrieval_index_state WHERE index_name = 'context'");
  const { where, values } = compileFilters(getDataset('source_entities'), [], undefined, undefined); // Creates a parameter-safe empty baseline; retrieval has its own filter allowlist below.
  void where;
  void values;
  const metadataClauses: string[] = [];
  const params: Record<string, unknown> = { query, limit };
  for (const [index, filter] of (request.filters ?? []).entries()) {
    if (!['provider', 'entity_type', 'occurred_on'].includes(filter.column) || !['eq', 'between', 'in'].includes(filter.op)) throw new QueryValidationError('search_context permits only provider, entity_type, and occurred_on eq/in/between filters.');
    const column = `"${filter.column}"`;
    const key = `filter${index}`;
    if (filter.op === 'eq') { metadataClauses.push(`${column} = $${key}`); params[key] = filter.value; }
    else if (filter.op === 'between') { if (!Array.isArray(filter.value) || filter.value.length !== 2) throw new QueryValidationError('between requires two values.'); metadataClauses.push(`${column} BETWEEN $${key}a AND $${key}b`); params[`${key}a`] = filter.value[0]; params[`${key}b`] = filter.value[1]; }
    else { if (!Array.isArray(filter.value) || filter.value.length === 0 || filter.value.length > 100) throw new QueryValidationError('in requires 1–100 values.'); const placeholders = filter.value.map((value, itemIndex) => { const itemKey = `${key}_${itemIndex}`; params[itemKey] = value; return `$${itemKey}`; }); metadataClauses.push(`${column} IN (${placeholders.join(', ')})`); }
  }
  const filterSql = metadataClauses.length ? ` AND ${metadataClauses.join(' AND ')}` : '';
  const terms = query.split(/\s+/).filter(Boolean).slice(0, 12);
  const keywordScore = terms.map((_, index) => `CASE WHEN lower(document_text) LIKE '%' || lower($term${index}) || '%' THEN 1 ELSE 0 END`).join(' + ');
  terms.forEach((term, index) => { params[`term${index}`] = term; });
  let rows: Record<string, unknown>[] | undefined;
  let mode: 'full_text' | 'keyword' = 'keyword';
  if (state[0]?.mode === 'full_text') {
    try {
      rows = await repository.rows(`SELECT document_id, entity_type, entity_id, activity_source_id, provider, occurred_on, left(document_text, 600) AS snippet, fts_main_retrieval_documents.match_bm25(document_id, $query) AS score FROM retrieval_documents WHERE fts_main_retrieval_documents.match_bm25(document_id, $query) IS NOT NULL${filterSql} ORDER BY score DESC LIMIT $limit`, params as never);
      mode = 'full_text';
    } catch { /* a stale or unsupported local FTS extension safely uses the keyword path */ }
  }
  if (!rows) {
    const { query: ignoredQuery, ...keywordParams } = params;
    void ignoredQuery;
    rows = await repository.rows(`SELECT document_id, entity_type, entity_id, activity_source_id, provider, occurred_on, left(document_text, 600) AS snippet, (${keywordScore}) AS score FROM retrieval_documents WHERE (${keywordScore}) > 0${filterSql} ORDER BY score DESC, occurred_on DESC NULLS LAST, document_id ASC LIMIT $limit`, keywordParams as never);
  }
  const indexStatus = state[0]?.status ?? 'stale';
  const indexIsFresh = indexStatus === 'ready';
  return jsonSafe({
    data: rows.map((row) => ({ ...row, recommendedFollowUpTool: recommendedTool(String(row.entity_type)) })),
    retrievalIndex: {
      status: indexStatus,
      fresh: indexIsFresh,
      authoritativeAlternative: indexIsFresh ? null : 'Use find_activities or query_read_only_data for authoritative activity discovery until the index is rebuilt.',
    },
    provenance: { dataset: 'retrieval_documents', mode, indexStatus },
    query: { query, filters: request.filters ?? [], limit },
    caveats: !indexIsFresh
      ? ['Index stale; use direct activity query (find_activities or query_read_only_data) for authoritative results. Run catence-data build-retrieval-index after sync.']
      : ['Search results are context pointers; use the recommended tool for authoritative numeric facts.'],
  });
}

function recommendedTool(entityType: string): string {
  if (entityType.startsWith('activity')) return 'find_activities';
  if (entityType.startsWith('nutrition')) return 'aggregate_data';
  if (entityType === 'weekly_training_summary' || entityType === 'training_metric') return 'aggregate_data';
  return 'query_read_only_data';
}
