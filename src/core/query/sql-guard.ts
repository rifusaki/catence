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

export async function queryReadOnlyData(repository: ReadOnlyRepository, request: { sql: string; values?: Record<string, string | number | boolean | null>; cursor?: string; pageSize?: number }): Promise<Record<string, unknown>> {
  const sql = safeSql(request.sql);
  let relations: string[];
  try {
    relations = await repository.database.tableNames(sql);
  } catch (error) {
    throw new QueryValidationError(`SQL could not be inspected: ${error instanceof Error ? error.message : String(error)}`);
  }
  const allowed = new Set(Object.values(DATASET_CATALOG).filter((dataset) => !dataset.samplesOnly && dataset.relation).map((dataset) => dataset.relation!.toLowerCase()));
  for (const relation of relations) {
    if (!allowed.has(normalizeRelation(relation))) throw new QueryValidationError(`Relation ${relation} is not in the read-only catalog.`);
  }
  const ctes = new Set([...sql.matchAll(/(?:\bwith|,)\s*([A-Za-z_][A-Za-z0-9_]*)\s+as\s*\(/gi)].map((match) => match[1].toLowerCase()));
  for (const match of sql.matchAll(/\b(?:from|join)\s+([A-Za-z_][A-Za-z0-9_.]*)/gi)) {
    const relation = normalizeRelation(match[1]);
    if (!allowed.has(relation) && !ctes.has(relation)) throw new QueryValidationError(`Relation ${match[1]} is not in the read-only catalog.`);
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
