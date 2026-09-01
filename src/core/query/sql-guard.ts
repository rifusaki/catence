import { createHash } from 'node:crypto';
import { DATASET_CATALOG, QueryValidationError } from './catalog.js';
import { jsonSafe, ReadOnlyRepository } from './repository.js';

const forbidden = /\b(attach|detach|copy|export|import|install|load|pragma|set|reset|create|alter|drop|delete|insert|update|merge|vacuum|checkpoint|call|execute|prepare|transaction|begin|commit|rollback|read_parquet|read_csv|read_json|glob|parquet_scan|csv_scan|httpfs|sqlite_scan)\b/i;
const comments = /(--|\/\*|\*\/)/;
const MAX_PAGE_SIZE = 500;
// Leave room for metadata and MCP's envelope instead of constructing a data
// payload which is just below the database-side limit but still gets cut off
// by the client transport.
const MAX_RESPONSE_BYTES = 400_000;

type SqlCursor = { hash: string; offset: number };

function queryHash(sql: string, values: Record<string, string | number | boolean | null>): string {
  return createHash('sha256').update(JSON.stringify({ sql, values: Object.fromEntries(Object.entries(values).sort(([left], [right]) => left.localeCompare(right))) })).digest('base64url');
}

function encodeCursor(cursor: SqlCursor): string {
  return Buffer.from(JSON.stringify(cursor)).toString('base64url');
}

function decodeCursor(cursor: string, expectedHash: string): SqlCursor {
  try {
    const decoded = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as SqlCursor;
    if (!Number.isInteger(decoded.offset) || decoded.offset < 0 || decoded.hash !== expectedHash) throw new Error();
    return decoded;
  } catch {
    throw new QueryValidationError('Invalid or mismatched cursor. Start the read-only query again.');
  }
}

function safeSql(sql: string): string {
  const normalized = sql.trim();
  if (!normalized) throw new QueryValidationError('SQL is required.');
  if (!/^(select\b|with\b)/i.test(normalized)) throw new QueryValidationError('Only a single SELECT or WITH … SELECT statement is allowed.');
  if (normalized.includes(';') || comments.test(normalized)) throw new QueryValidationError('SQL comments and multiple statements are not allowed.');
  if (forbidden.test(normalized)) throw new QueryValidationError('SQL contains a prohibited keyword or filesystem table function.');
  return normalized;
}

function normalizeRelation(name: string): string {
  // DuckDB's getTableNames() preserves aliases (for example, "activities AS
  // a"), while the catalog intentionally contains only relation names.
  // Discard that syntactic alias before doing the allow-list comparison.
  const relation = name.trim().replace(/\s+(?:as\s+)?(?:"[^"]+"|[A-Za-z_][A-Za-z0-9_]*)\s*$/i, '');
  return relation.replaceAll('"', '').split('.').at(-1)!.toLowerCase();
}

// Physical base tables that are reachable only through cataloged views
// (e.g. the events/workouts/routes/… domain projections over domain_entities).
// They must be accepted when DuckDB resolves a cataloged view down to its base
// table after tableNames(), but must never be writable directly by name.
const INDIRECT_BASE_TABLES = new Set(['domain_entities']);

// dataset->named tool hints for the common dead-end relations, so a rejected
// query tells the agent where to go instead of just that it was denied.
const RELATION_HINTS: Record<string, string> = {
  events: 'events is a domain projection; use aggregate_data on events or resolve_event_course(eventId) / search_context to read events and races.',
  workouts: 'workouts is a domain projection; use aggregate_data on workouts or search_context to read workouts.',
  workout_documents: 'workout_documents is a domain projection; use aggregate_data on workout_documents or search_context to read workout documents.',
  training_plans: 'training_plans is a domain projection; use aggregate_data on training_plans or search_context to read training plans.',
  routes: 'routes is a domain projection; use aggregate_data on routes or search_context to read routes.',
  gear: 'gear is a domain projection; use aggregate_data on gear or search_context to read saved gear.',
  devices: 'devices is a domain projection; use aggregate_data on devices or search_context to read devices.',
  goals: 'goals is a domain projection; use aggregate_data on goals or search_context to read goals and challenges.',
  achievements: 'achievements is a domain projection; use aggregate_data on achievements or search_context to read badges and personal records.',
  messages: 'messages is a domain projection; use aggregate_data on messages or search_context to read provider messages.',
  course_geometry: 'course_geometry is the per-point course track (lat/lon/altitude_m/distance_m); resolve a race course first with resolve_event_course, then query it for elevation/height profiles.',
};

export async function queryReadOnlyData(repository: ReadOnlyRepository, request: { sql: string; values?: Record<string, string | number | boolean | null>; cursor?: string; pageSize?: number }): Promise<Record<string, unknown>> {
  const sql = safeSql(request.sql);
  let relations: string[];
  try {
    relations = await repository.database.tableNames(sql);
  } catch (error) {
    throw new QueryValidationError(`SQL could not be inspected: ${error instanceof Error ? error.message : String(error)}`);
  }
  // The catalog relation names form the strict allow-list for what a query may
  // name directly (Check B below). Base tables reached only through cataloged
  // views are additionally permitted after DuckDB resolves views for Check A,
  // but they are never valid relation names in the SQL text.
  const allowedNamed = new Set(Object.values(DATASET_CATALOG).filter((dataset) => !dataset.samplesOnly && dataset.relation).map((dataset) => dataset.relation!.toLowerCase()));
  const allowedForExpansion = new Set([...allowedNamed, ...INDIRECT_BASE_TABLES]);
  const rejected: string[] = [];
  for (const relation of relations) {
    const normalized = normalizeRelation(relation);
    if (!allowedForExpansion.has(normalized)) rejected.push(relation);
  }
  if (rejected.length > 0) {
    const name = normalizeRelation(rejected[0]!);
    throw new QueryValidationError(
      `Relation ${rejected[0]!} is not in the read-only catalog.${RELATION_HINTS[name] ? ` ${RELATION_HINTS[name]}` : ''}`
    );
  }
  const ctes = new Set([...sql.matchAll(/(?:\bwith|,)\s*([A-Za-z_][A-Za-z0-9_]*)\s+as\s*\(/gi)].map((match) => match[1].toLowerCase()));
  for (const match of sql.matchAll(/\b(?:from|join)\s+([A-Za-z_][A-Za-z0-9_.]*)/gi)) {
    const relation = normalizeRelation(match[1]);
    if (!allowedNamed.has(relation) && !ctes.has(relation)) {
      throw new QueryValidationError(`Relation ${match[1]} is not in the read-only catalog.${RELATION_HINTS[relation] ? ` ${RELATION_HINTS[relation]}` : ''}`);
    }
  }
  const values = request.values ?? {};
  if ('__catence_page_size' in values || '__catence_offset' in values) throw new QueryValidationError('Bind names prefixed with __catence_ are reserved for pagination.');
  const pageSize = Math.min(Math.max(request.pageSize ?? 100, 1), MAX_PAGE_SIZE);
  const fingerprint = queryHash(sql, values);
  const offset = request.cursor ? decodeCursor(request.cursor, fingerprint).offset : 0;
  const timeout = setTimeout(() => repository.database.interrupt(), 4_000);
  let totalRows: number;
  let rows: Record<string, unknown>[];
  try {
    const total = await repository.rows<{ total_rows: number | bigint }>(`SELECT count(*) AS total_rows FROM (${sql}) AS guarded_query`, values);
    totalRows = Number(total[0]?.total_rows ?? 0);
    // ORDER BY ALL creates one stable ordering from every selected column,
    // including query results without their own ORDER BY. Identical rows are
    // interchangeable, so paging them cannot omit a distinguishable result.
    rows = await repository.rows(`SELECT * FROM (${sql}) AS guarded_query ORDER BY ALL LIMIT $__catence_page_size OFFSET $__catence_offset`, { ...values, __catence_page_size: pageSize, __catence_offset: offset });
  } catch (error) {
    throw new QueryValidationError(`Read-only query failed: ${error instanceof Error ? error.message : String(error)}`);
  } finally {
    clearTimeout(timeout);
  }
  const withinByteLimit: Record<string, unknown>[] = [];
  let bytes = 0;
  let oversizedFirstRow = false;
  for (const row of rows) {
    const serialized = JSON.stringify(jsonSafe(row));
    if (bytes + Buffer.byteLength(serialized) > MAX_RESPONSE_BYTES) {
      oversizedFirstRow = withinByteLimit.length === 0;
      break;
    }
    bytes += Buffer.byteLength(serialized);
    withinByteLimit.push(row);
  }
  const returnedRows = withinByteLimit.length;
  const truncated = offset + returnedRows < totalRows;
  const nextCursor = truncated && returnedRows > 0 ? encodeCursor({ hash: fingerprint, offset: offset + returnedRows }) : undefined;
  return jsonSafe({
    returnedRows,
    totalRows,
    truncated,
    nextCursor,
    data: withinByteLimit,
    provenance: { resolvedViews: relations.map(normalizeRelation), readOnly: true },
    query: { sql, bindNames: Object.keys(values), pageSize, timeoutMs: 4_000, ordering: 'all selected columns ascending' },
    caveats: [
      ...(withinByteLimit.length < rows.length && !oversizedFirstRow ? ['Response reached Catence’s safe response-size limit; continue with nextCursor.'] : []),
      ...(oversizedFirstRow ? ['The next row alone exceeds Catence’s safe response-size limit. Narrow the selected columns before continuing; no cursor was advanced.'] : []),
      ...(truncated ? ['Results are incomplete. Do not draw exhaustive conclusions; retrieve remaining pages with nextCursor or narrow the query.'] : []),
    ],
    columnTypes: withinByteLimit[0] ? Object.fromEntries(Object.entries(withinByteLimit[0]).map(([key, value]) => [key, value === null ? 'NULL' : typeof value])) : {},
  });
}
