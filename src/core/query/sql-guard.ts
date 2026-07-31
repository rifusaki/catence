import { DATASET_CATALOG, QueryValidationError } from './catalog.js';
import { jsonSafe, ReadOnlyRepository } from './repository.js';

const forbidden = /\b(attach|detach|copy|export|import|install|load|pragma|set|reset|create|alter|drop|delete|insert|update|merge|vacuum|checkpoint|call|execute|prepare|transaction|begin|commit|rollback|read_parquet|read_csv|read_json|glob|parquet_scan|csv_scan|httpfs|sqlite_scan)\b/i;
const comments = /(--|\/\*|\*\/)/;

function safeSql(sql: string): string {
  const normalized = sql.trim();
  if (!normalized) throw new QueryValidationError('SQL is required.');
  if (!/^(select\b|with\b)/i.test(normalized)) throw new QueryValidationError('Only a single SELECT or WITH … SELECT statement is allowed.');
  if (normalized.includes(';') || comments.test(normalized)) throw new QueryValidationError('SQL comments and multiple statements are not allowed.');
  if (forbidden.test(normalized)) throw new QueryValidationError('SQL contains a prohibited keyword or filesystem table function.');
  return normalized;
}

function normalizeRelation(name: string): string {
  return name.replaceAll('"', '').split('.').at(-1)!.toLowerCase();
}

export async function queryReadOnlyData(repository: ReadOnlyRepository, request: { sql: string; values?: Record<string, string | number | boolean | null> }): Promise<Record<string, unknown>> {
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
  const timeout = setTimeout(() => repository.database.interrupt(), 4_000);
  let rows: Record<string, unknown>[];
  try {
    rows = await repository.rows(`SELECT * FROM (${sql}) AS guarded_query LIMIT 500`, values);
  } catch (error) {
    throw new QueryValidationError(`Read-only query failed: ${error instanceof Error ? error.message : String(error)}`);
  } finally {
    clearTimeout(timeout);
  }
  const withinByteLimit: Record<string, unknown>[] = [];
  let bytes = 0;
  for (const row of rows) {
    const serialized = JSON.stringify(jsonSafe(row));
    if (bytes + Buffer.byteLength(serialized) > 512_000) break;
    bytes += Buffer.byteLength(serialized);
    withinByteLimit.push(row);
  }
  return jsonSafe({
    data: withinByteLimit,
    provenance: { resolvedViews: relations.map(normalizeRelation), readOnly: true },
    query: { sql, bindNames: Object.keys(values), rowCap: 500, timeoutMs: 4_000 },
    caveats: withinByteLimit.length < rows.length ? ['Response was truncated at the 512 KB response-size limit.'] : [],
    columnTypes: withinByteLimit[0] ? Object.fromEntries(Object.entries(withinByteLimit[0]).map(([key, value]) => [key, value === null ? 'NULL' : typeof value])) : {},
  });
}
