import { spawn } from 'node:child_process';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import path from 'node:path';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import {
  addAthlete,
  AthleteFileConflictError,
  AthleteFileTooLargeError,
  AthleteFileValidationError,
  catenceRuntimeHealth,
  DashboardSnapshotService,
  deleteAthleteSecret,
  describeAthleteSecrets,
  DetachedSyncBusyError,
  type DetachedSyncSpawner,
  DETACHED_SYNC_PROVIDERS,
  jsonSafe,
  listAthleteFileRevisions,
  loadCatalog,
  mergeOpenCodeGoConsoleProfiles,
  openReadOnlyRepository,
  readAthleteFile,
  readAthleteFileRevision,
  resolveAthlete,
  resolveCatalogPaths,
  setAthleteSecret,
  startDetachedSync,
  syncProgress,
  updateAthleteFile,
  type AthleteFileOperation,
  type CatalogPaths,
  type CatencePaths,
  type SecretProvider,
} from '../../runtime/index.js';
import { createCatenceMcpServer } from '../mcp/server.js';
import { generationStatus } from './generation-status.js';

const MAX_REQUEST_BYTES = 1_000_000;

export type CatenceHttpServerOptions = {
  /** A shared catalog for public servers. All data APIs then require athleteId. */
  catalogPaths?: CatalogPaths;
  /** Internal compatibility hook for tests and embedded single-store callers. */
  paths?: CatencePaths;
  allowedOrigins?: readonly string[];
  /** Internal compatibility hook for tests: override the detached sync spawner. */
  startSync?: typeof startDetachedSync;
  /** Internal compatibility hook for tests: passed into the default startDetachedSync. */
  syncSpawnProcess?: DetachedSyncSpawner;
  /** Internal compatibility hook for tests: override OpenCode Go model discovery. */
  mergeModels?: typeof mergeOpenCodeGoConsoleProfiles;
};

function json(response: ServerResponse, statusCode: number, value: unknown): void {
  const body = JSON.stringify(jsonSafe(value));
  response.writeHead(statusCode, { 'content-type': 'application/json; charset=utf-8' });
  response.end(body);
}

function addCorsHeaders(request: IncomingMessage, response: ServerResponse, allowedOrigins: readonly string[]): boolean {
  const origin = request.headers.origin;
  if (!origin) return true;
  if (!allowedOrigins.includes(origin)) return false;
  response.setHeader('access-control-allow-origin', origin);
  response.setHeader('vary', 'Origin');
  response.setHeader('access-control-allow-methods', 'GET, POST, PUT, DELETE, OPTIONS');
  response.setHeader('access-control-allow-headers', 'content-type, if-match, mcp-session-id');
  return true;
}

async function readJsonBody(request: IncomingMessage): Promise<unknown> {
  let size = 0;
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > MAX_REQUEST_BYTES) throw new Error(`Request body exceeds the ${MAX_REQUEST_BYTES} byte limit.`);
    chunks.push(buffer);
  }
  const body = Buffer.concat(chunks).toString('utf8').trim();
  if (!body) return undefined;
  try {
    return JSON.parse(body);
  } catch {
    throw new Error('Request body must be valid JSON.');
  }
}

function methodNotAllowed(response: ServerResponse): void {
  json(response, 405, {
    jsonrpc: '2.0',
    error: { code: -32000, message: 'Method not allowed.' },
    id: null,
  });
}

function parseDate(value: string | null, name: string): string | undefined {
  if (value === null) return undefined;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value) || Number.isNaN(Date.parse(`${value}T00:00:00.000Z`))) {
    throw new Error(`${name} must use YYYY-MM-DD.`);
  }
  return value;
}

function dashboardOptions(url: URL): { endDate: string; days: number } {
  const endDate = parseDate(url.searchParams.get('endDate'), 'endDate') ?? new Date().toISOString().slice(0, 10);
  const daysValue = url.searchParams.get('days') ?? '28';
  if (!/^\d+$/.test(daysValue)) throw new Error('days must be an integer between 1 and 90.');
  const days = Number(daysValue);
  if (days < 1 || days > 90) throw new Error('days must be an integer between 1 and 90.');
  return { endDate, days };
}

async function dashboardSnapshot(paths: CatencePaths, url: URL): Promise<Record<string, unknown>> {
  const repository = await openReadOnlyRepository(paths);
  try {
    return await new DashboardSnapshotService(repository).snapshot(dashboardOptions(url));
  } finally {
    await repository.close();
  }
}

async function dashboardPaths(catalogPaths: CatalogPaths | null, staticPaths: CatencePaths | null, url: URL): Promise<CatencePaths> {
  if (catalogPaths) {
    const athleteId = url.searchParams.get('athleteId');
    if (!athleteId) throw new Error('athleteId is required. Call /api/v1/athletes to inspect the configured catalog.');
    return (await resolveAthlete(catalogPaths, athleteId)).paths;
  }
  if (staticPaths) return staticPaths;
  throw new Error('No Catence data store is configured.');
}

type SyncRequestBody = {
  athleteId?: string;
  provider?: string;
  from?: string;
  refresh?: boolean;
  refreshModels?: boolean;
};

function parseSyncBody(body: unknown): SyncRequestBody {
  if (body === undefined) return {};
  if (typeof body !== 'object' || body === null || Array.isArray(body)) throw new Error('Request body must be a JSON object.');
  const raw = body as Record<string, unknown>;
  for (const key of Object.keys(raw)) {
    if (!['athleteId', 'provider', 'from', 'refresh', 'refreshModels'].includes(key)) {
      throw new Error(`Unknown sync field: ${key}.`);
    }
  }
  if (raw.athleteId !== undefined && typeof raw.athleteId !== 'string') throw new Error('athleteId must be a string.');
  if (raw.provider !== undefined && (typeof raw.provider !== 'string' || !DETACHED_SYNC_PROVIDERS.includes(raw.provider as never))) {
    throw new Error('provider must be intervals, garmin, strava, or all.');
  }
  if (raw.from !== undefined && (typeof raw.from !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(raw.from))) {
    throw new Error('from must use YYYY-MM-DD.');
  }
  for (const flag of ['refresh', 'refreshModels'] as const) {
    if (raw[flag] !== undefined && typeof raw[flag] !== 'boolean') throw new Error(`${flag} must be a boolean.`);
  }
  return raw as SyncRequestBody;
}

type AthleteCreateBody = {
  id: string;
  label: string;
  setDefault: boolean;
};

function parseAthleteCreateBody(body: unknown): AthleteCreateBody {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) throw new Error('Request body must be a JSON object.');
  const raw = body as Record<string, unknown>;
  for (const key of Object.keys(raw)) {
    if (!['id', 'label', 'setDefault'].includes(key)) throw new Error(`Unknown athlete field: ${key}.`);
  }
  if (typeof raw.id !== 'string' || !raw.id.trim()) throw new Error('id is required.');
  if (typeof raw.label !== 'string' || !raw.label.trim()) throw new Error('label is required.');
  if (raw.setDefault !== undefined && typeof raw.setDefault !== 'boolean') throw new Error('setDefault must be a boolean.');
  return { id: raw.id.trim(), label: raw.label.trim(), setDefault: raw.setDefault === true };
}

type AthleteFileBody = {
  operation: AthleteFileOperation;
  section?: string;
  content: string;
  hasExpectedHash: boolean;
  expectedHash: string | null;
};

function parseAthleteFileBody(body: unknown): AthleteFileBody {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) throw new Error('Request body must be a JSON object.');
  const raw = body as Record<string, unknown>;
  for (const key of Object.keys(raw)) {
    if (!['operation', 'section', 'content', 'expectedHash'].includes(key)) throw new Error(`Unknown athlete-file field: ${key}.`);
  }
  if (typeof raw.content !== 'string') throw new Error('content must be a string.');
  const operation = raw.operation ?? 'replace';
  if (operation !== 'replace' && operation !== 'append' && operation !== 'replace_section') {
    throw new Error('operation must be replace, append, or replace_section.');
  }
  if (raw.section !== undefined && typeof raw.section !== 'string') throw new Error('section must be a string.');
  if (raw.expectedHash !== undefined && raw.expectedHash !== null && typeof raw.expectedHash !== 'string') {
    throw new Error('expectedHash must be a string or null.');
  }
  return {
    operation,
    section: raw.section as string | undefined,
    content: raw.content,
    hasExpectedHash: Object.prototype.hasOwnProperty.call(raw, 'expectedHash'),
    expectedHash: (raw.expectedHash ?? null) as string | null,
  };
}

type AthleteSecretBody = {
  athleteId?: string;
  provider: SecretProvider;
  field: string;
  value: string;
};

function parseAthleteSecretBody(body: unknown): AthleteSecretBody {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) throw new Error('Request body must be a JSON object.');
  const raw = body as Record<string, unknown>;
  for (const key of Object.keys(raw)) {
    if (!['athleteId', 'provider', 'field', 'value'].includes(key)) throw new Error(`Unknown athlete-secret field: ${key}.`);
  }
  if (raw.athleteId !== undefined && typeof raw.athleteId !== 'string') throw new Error('athleteId must be a string.');
  if (typeof raw.provider !== 'string' || !raw.provider.trim()) throw new Error('provider is required.');
  if (typeof raw.field !== 'string' || !raw.field.trim()) throw new Error('field is required.');
  if (typeof raw.value !== 'string' || !raw.value.trim()) throw new Error('value is required.');
  return { athleteId: raw.athleteId as string | undefined, provider: raw.provider.trim() as SecretProvider, field: raw.field.trim(), value: raw.value };
}

type AthleteSecretRemovalBody = {
  athleteId?: string;
  provider: SecretProvider;
  field: string;
};

function parseAthleteSecretRemovalBody(body: unknown): AthleteSecretRemovalBody {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) throw new Error('Request body must be a JSON object.');
  const raw = body as Record<string, unknown>;
  for (const key of Object.keys(raw)) {
    if (!['athleteId', 'provider', 'field'].includes(key)) throw new Error(`Unknown athlete-secret field: ${key}.`);
  }
  if (raw.athleteId !== undefined && typeof raw.athleteId !== 'string') throw new Error('athleteId must be a string.');
  if (typeof raw.provider !== 'string' || !raw.provider.trim()) throw new Error('provider is required.');
  if (typeof raw.field !== 'string' || !raw.field.trim()) throw new Error('field is required.');
  return { athleteId: raw.athleteId as string | undefined, provider: raw.provider.trim() as SecretProvider, field: raw.field.trim() };
}

async function resolveSyncPaths(catalogPaths: CatalogPaths | null, staticPaths: CatencePaths | null, body: SyncRequestBody): Promise<CatencePaths> {
  if (catalogPaths) {
    if (!body.athleteId) throw new Error('athleteId is required. Call /api/v1/athletes to inspect the configured catalog.');
    return (await resolveAthlete(catalogPaths, body.athleteId)).paths;
  }
  if (staticPaths) return staticPaths;
  throw new Error('No Catence data store is configured.');
}

type LastSyncSummary = {
  lastCompletedAt: string | null;
  providers: Record<string, string>;
  recentRuns: Array<Record<string, unknown>>;
};

/** Best-effort last-success timestamps; null while a run holds the write lock. */
async function lastSyncSummary(paths: CatencePaths): Promise<LastSyncSummary | null> {
  const completedAtIso = (value: unknown): string | null => {
    if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value.toISOString();
    if (typeof value === 'string' && value.trim()) return value;
    return null;
  };
  try {
    // Read-only repository on purpose: it exposes per-run history (`syncRuns`)
    // and degrades through the typed lock-conflict error while a detached
    // sync holds DuckDB's single-writer lock. The write-capable dataStatus()
    // would both block here and has no run history at all.
    const repository = await openReadOnlyRepository(paths);
    try {
      const status = await repository.status();
      const runs = Array.isArray(status.syncRuns) ? (status.syncRuns as Array<Record<string, unknown>>) : [];
      const completed = runs.filter((run) => String(run.status ?? '').startsWith('completed') && completedAtIso(run.completed_at));
      const providers: Record<string, string> = {};
      let lastCompletedAt: string | null = null;
      for (const run of completed) {
        const completedAt = completedAtIso(run.completed_at) as string;
        const provider = String(run.provider ?? 'unknown');
        if (!providers[provider] || providers[provider] < completedAt) providers[provider] = completedAt;
        if (!lastCompletedAt || lastCompletedAt < completedAt) lastCompletedAt = completedAt;
      }
      return { lastCompletedAt, providers, recentRuns: runs.slice(0, 5) };
    } finally {
      await repository.close();
    }
  } catch {
    // Best-effort by contract: while a detached sync holds the single-writer
    // DuckDB lock, even opening a snapshot fails cross-process. Progress (from
    // sidecar heartbeats) must still reach the dashboard, so any failure here
    // degrades to "no last-sync summary" instead of failing /sync/status.
    return null;
  }
}

async function handleMcpRequest(request: IncomingMessage, response: ServerResponse, paths: CatencePaths | CatalogPaths): Promise<void> {
  if (request.method !== 'POST') {
    methodNotAllowed(response);
    return;
  }

  let body: unknown;
  try {
    body = await readJsonBody(request);
  } catch (error) {
    json(response, 400, {
      jsonrpc: '2.0',
      error: { code: -32700, message: error instanceof Error ? error.message : String(error) },
      id: null,
    });
    return;
  }

  const server = createCatenceMcpServer(paths);
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
  let cleanedUp = false;
  const cleanup = async () => {
    if (cleanedUp) return;
    cleanedUp = true;
    await Promise.allSettled([transport.close(), server.close()]);
  };
  response.once('close', () => { void cleanup(); });
  try {
    await server.connect(transport);
    await transport.handleRequest(request, response, body);
  } catch (error) {
    if (!response.headersSent) {
      json(response, 500, {
        jsonrpc: '2.0',
        error: { code: -32603, message: error instanceof Error ? error.message : 'Internal server error.' },
        id: null,
      });
    }
  } finally {
    // The response may already have ended before handleRequest resolves, in
    // which case adding a close listener here would miss cleanup entirely.
    if (response.writableEnded || response.destroyed) void cleanup();
  }
}

/**
 * Create Catence's local Streamable HTTP server.
 *
 * Each MCP request gets an independent stateless transport and server instance.
 * This keeps the HTTP surface compatible with local clients without introducing
 * process-wide MCP session state or a second query implementation.
 */
export function createCatenceHttpServer(options: CatenceHttpServerOptions = {}): Server {
  const catalogPaths = options.catalogPaths ?? (options.paths ? null : resolveCatalogPaths());
  const staticPaths = options.paths ?? null;
  const allowedOrigins = options.allowedOrigins ?? [];
  const startSync = options.startSync ?? startDetachedSync;
  const mergeModels = options.mergeModels ?? mergeOpenCodeGoConsoleProfiles;

  return createServer((request, response) => {
    void (async () => {
      if (!addCorsHeaders(request, response, allowedOrigins)) {
        json(response, 403, { error: { code: 'origin_not_allowed', message: 'This browser origin is not allowed to access Catence.' } });
        return;
      }

      const pathname = new URL(request.url ?? '/', 'http://localhost').pathname;
      if (request.method === 'OPTIONS') {
        response.writeHead(204).end();
        return;
      }

      if (pathname === '/health' && request.method === 'GET') {
        json(response, 200, catenceRuntimeHealth());
        return;
      }

      if (pathname === '/api/v1/health' && request.method === 'GET') {
        json(response, 200, catenceRuntimeHealth());
        return;
      }

      if (pathname === '/api/v1/athletes' && request.method === 'GET') {
        if (!catalogPaths) {
          json(response, 200, { defaultAthleteId: 'local', athletes: [{ id: 'local', label: 'Local athlete' }] });
          return;
        }
        try {
          const catalog = await loadCatalog(catalogPaths);
          json(response, 200, { defaultAthleteId: catalog.defaultAthleteId, athletes: catalog.athletes });
        } catch (error) {
          json(response, 400, { error: { code: 'catalog_unavailable', message: error instanceof Error ? error.message : String(error) } });
        }
        return;
      }

      if (pathname === '/api/v1/athletes' && request.method === 'POST') {
        if (!catalogPaths) {
          json(response, 400, {
            error: {
              code: 'catalog_required',
              message: 'Adding athletes requires a Catence catalog; this server uses a single legacy data store.',
            },
          });
          return;
        }
        try {
          const body = parseAthleteCreateBody(await readJsonBody(request));
          const catalog = await loadCatalog(catalogPaths);
          if (catalog.athletes.some((athlete) => athlete.id === body.id)) {
            json(response, 409, { error: { code: 'athlete_exists', message: `Athlete ${body.id} already exists.` } });
            return;
          }
          const updated = await addAthlete(catalogPaths, body);
          json(response, 201, { defaultAthleteId: updated.defaultAthleteId, athletes: updated.athletes });
        } catch (error) {
          json(response, 400, {
            error: { code: 'athlete_create_failed', message: error instanceof Error ? error.message : String(error) },
          });
        }
        return;
      }

      if (pathname === '/api/v1/dashboard' && request.method === 'GET') {
        try {
          const url = new URL(request.url ?? '/', 'http://localhost');
          json(response, 200, await dashboardSnapshot(await dashboardPaths(catalogPaths, staticPaths, url), url));
        } catch (error) {
          json(response, 400, { error: { code: 'dashboard_unavailable', message: error instanceof Error ? error.message : String(error) } });
        }
        return;
      }

      if (pathname === '/api/v1/athlete-file' && request.method === 'GET') {
        try {
          const url = new URL(request.url ?? '/', 'http://localhost');
          const paths = await dashboardPaths(catalogPaths, staticPaths, url);
          const revisionId = url.searchParams.get('revision');
          if (revisionId) {
            let content: string | null;
            try {
              content = await readAthleteFileRevision(paths, revisionId);
            } catch (error) {
              if (!(error instanceof AthleteFileValidationError)) throw error;
              content = null;
            }
            if (content === null) {
              json(response, 404, { error: { code: 'athlete_file_revision_not_found', message: 'No athlete-file revision matches this identifier.' } });
              return;
            }
            json(response, 200, { revisionId, content });
            return;
          }
          const snapshot = await readAthleteFile(paths);
          json(response, 200, { ...snapshot, revisions: await listAthleteFileRevisions(paths) });
        } catch (error) {
          json(response, 400, { error: { code: 'athlete_file_unavailable', message: error instanceof Error ? error.message : String(error) } });
        }
        return;
      }

      if (pathname === '/api/v1/athlete-file' && request.method === 'PUT') {
        try {
          const url = new URL(request.url ?? '/', 'http://localhost');
          const paths = await dashboardPaths(catalogPaths, staticPaths, url);
          const parsed = parseAthleteFileBody(await readJsonBody(request));
          const header = request.headers['if-match'];
          const headerHash = typeof header === 'string' && header.trim() ? header.trim() : undefined;
          if (!headerHash && !parsed.hasExpectedHash) {
            throw new AthleteFileValidationError('expectedHash is required: send the If-Match header or the expectedHash body field (null to create the file).');
          }
          const snapshot = await updateAthleteFile(paths, {
            operation: parsed.operation,
            section: parsed.section,
            content: parsed.content,
            expectedHash: headerHash ?? parsed.expectedHash,
          });
          json(response, 200, snapshot);
        } catch (error) {
          if (error instanceof AthleteFileConflictError) {
            json(response, 409, {
              error: {
                code: 'athlete_file_conflict',
                message: error.message,
                currentHash: error.currentHash,
                currentContent: error.currentContent,
              },
            });
          } else if (error instanceof AthleteFileTooLargeError || error instanceof AthleteFileValidationError) {
            json(response, 400, { error: { code: 'invalid_request', message: error.message } });
          } else {
            json(response, 400, { error: { code: 'athlete_file_write_failed', message: error instanceof Error ? error.message : String(error) } });
          }
        }
        return;
      }

      if (pathname === '/api/v1/athlete-secrets' && request.method === 'GET') {
        try {
          const url = new URL(request.url ?? '/', 'http://localhost');
          const paths = await dashboardPaths(catalogPaths, staticPaths, url);
          json(response, 200, { athleteId: url.searchParams.get('athleteId') ?? 'local', providers: await describeAthleteSecrets(paths) });
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          json(response, 400, { error: { code: 'athlete_secrets_unavailable', message } });
        }
        return;
      }

      if (pathname === '/api/v1/athlete-secrets' && request.method === 'PUT') {
        try {
          const parsed = parseAthleteSecretBody(await readJsonBody(request));
          const url = new URL(request.url ?? '/', 'http://localhost');
          if (!url.searchParams.get('athleteId') && parsed.athleteId) url.searchParams.set('athleteId', parsed.athleteId);
          const paths = await dashboardPaths(catalogPaths, staticPaths, url);
          await setAthleteSecret(paths, parsed.provider, parsed.field, parsed.value);
          json(response, 200, { athleteId: url.searchParams.get('athleteId') ?? 'local', providers: await describeAthleteSecrets(paths) });
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          json(response, 400, { error: { code: 'athlete_secret_write_failed', message } });
        }
        return;
      }

      if (pathname === '/api/v1/athlete-secrets/remove' && request.method === 'POST') {
        try {
          const parsed = parseAthleteSecretRemovalBody(await readJsonBody(request));
          const url = new URL(request.url ?? '/', 'http://localhost');
          if (!url.searchParams.get('athleteId') && parsed.athleteId) url.searchParams.set('athleteId', parsed.athleteId);
          const paths = await dashboardPaths(catalogPaths, staticPaths, url);
          await deleteAthleteSecret(paths, parsed.provider, parsed.field);
          json(response, 200, { athleteId: url.searchParams.get('athleteId') ?? 'local', providers: await describeAthleteSecrets(paths) });
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          json(response, 400, { error: { code: 'athlete_secret_remove_failed', message } });
        }
        return;
      }

      if (pathname === '/api/v1/sync' && request.method === 'POST') {
        let body: SyncRequestBody;
        try {
          body = parseSyncBody(await readJsonBody(request));
          const paths = await resolveSyncPaths(catalogPaths, staticPaths, body);
          // Optional model self-discovery runs before the data sync so new
          // OpenCode Go models appear without a manual script run. Failure is
          // non-fatal: it must never block or fail a data sync. The Console
          // reads <CATENCE_HOME>/config.json, so catalog deployments merge
          // into the catalog root's config instead of the athlete store.
          const discoveryConfigPath = catalogPaths ? path.join(catalogPaths.root, 'config.json') : paths.config;
          let discoveryWarning: string | null = null;
          if (body.refreshModels) {
            try {
              await mergeModels({ configPath: discoveryConfigPath, setDefault: false });
            } catch (error) {
              discoveryWarning = `OpenCode Go model discovery failed; profiles were left unchanged (${error instanceof Error ? error.message : String(error)}).`;
            }
          }
          const handle = await startSync(
            {
              paths,
              athleteId: body.athleteId ?? 'local',
              provider: body.provider as never,
              from: body.from,
              refresh: body.refresh,
              // The child resolves the athlete within the catalog, not within
              // the athlete store this route resolved for locks and logs.
              cliHome: catalogPaths ? catalogPaths.root : undefined,
            },
            { spawnProcess: options.syncSpawnProcess },
          );
          json(response, 202, { ...handle, ...(discoveryWarning ? { warning: discoveryWarning } : {}), progressEndpoint: '/api/v1/sync/status' });
        } catch (error) {
          json(response, error instanceof DetachedSyncBusyError ? 409 : 400, {
            error: {
              code: error instanceof DetachedSyncBusyError ? 'sync_in_progress' : 'sync_start_failed',
              message: error instanceof Error ? error.message : String(error),
            },
          });
        }
        return;
      }

      if (pathname === '/api/v1/models/discover' && request.method === 'POST') {
        // Refresh the OpenCode Go profiles without starting a data sync. The
        // Console's Models page calls this behind its authenticated proxy.
        try {
          const body = await readJsonBody(request).catch(() => ({}) as Record<string, unknown>);
          const raw = (body ?? {}) as Record<string, unknown>;
          if (raw.setDefault !== undefined && typeof raw.setDefault !== 'boolean') throw new Error('setDefault must be a boolean.');
          const configPath = catalogPaths ? path.join(catalogPaths.root, 'config.json') : staticPaths?.config;
          if (!configPath) throw new Error('No Catence data store is configured.');
          json(response, 200, jsonSafe(await mergeModels({ configPath, setDefault: raw.setDefault === true })));
        } catch (error) {
          json(response, 400, { error: { code: 'model_discovery_failed', message: error instanceof Error ? error.message : String(error) } });
        }
        return;
      }

      if (pathname === '/api/v1/sync/status' && request.method === 'GET') {
        try {
          const url = new URL(request.url ?? '/', 'http://localhost');
          const paths = await dashboardPaths(catalogPaths, staticPaths, url);
          const athleteId = catalogPaths ? (await resolveAthlete(catalogPaths, url.searchParams.get('athleteId') ?? '')).athlete.id : 'local';
          json(response, 200, { athleteId, progress: await syncProgress(paths), lastSync: await lastSyncSummary(paths) });
        } catch (error) {
          json(response, 400, { error: { code: 'sync_status_unavailable', message: error instanceof Error ? error.message : String(error) } });
        }
        return;
      }

      if (
        pathname.startsWith('/api/v1/threads/') &&
        pathname.endsWith('/generation') &&
        request.method === 'GET'
      ) {
        try {
          const segments = pathname.split('/').filter(Boolean);
          const threadId = segments[segments.length - 2];
          if (!threadId) throw new Error('Missing threadId in request path.');
          const base = (catalogPaths ?? staticPaths ?? resolveCatalogPaths()) as {
            root?: string;
          } | null;
          const root = base?.root;
          if (!root || typeof root !== 'string') {
            throw new Error('No Catence data store is configured.');
          }
          json(response, 200, await generationStatus(root, threadId));
        } catch (error) {
          json(response, 400, {
            error: {
              code: 'generation_status_unavailable',
              message: error instanceof Error ? error.message : String(error)
            }
          });
        }
        return;
      }

      if (pathname === '/mcp') {
        await handleMcpRequest(request, response, catalogPaths ?? staticPaths ?? resolveCatalogPaths());
        return;
      }

      json(response, 404, { error: { code: 'not_found', message: 'No Catence endpoint matches this request.' } });
    })().catch((error: unknown) => {
      if (!response.headersSent) json(response, 500, { error: { code: 'internal_error', message: error instanceof Error ? error.message : String(error) } });
    });
  });
}
