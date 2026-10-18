import { spawn } from 'node:child_process';
import { timingSafeEqual } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import path from 'node:path';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { LATEST_PROTOCOL_VERSION, SUPPORTED_PROTOCOL_VERSIONS } from '@modelcontextprotocol/sdk/types.js';
import {
  addAthlete,
  addMcpKey,
  AthleteFileConflictError,
  AthleteFileTooLargeError,
  AthleteFileValidationError,
  catenceRuntimeHealth,
  countActiveMcpKeys,
  DashboardSnapshotService,
  deleteAthleteSecret,
  describeAthleteSecrets,
  DetachedSyncBusyError,
  type DetachedSyncSpawner,
  DETACHED_SYNC_PROVIDERS,
  filterRosterToScope,
  jsonSafe,
  listAthleteFileRevisions,
  listMcpKeys,
  loadCatalog,
  McpKeyNotFoundError,
  mergeOpenCodeGoConsoleProfiles,
  openReadOnlyRepository,
  parseAutoSyncInterval,
  readAutoSyncSchedule,
  readAthleteFile,
  readAthleteFileRevision,
  readMcpOauthSettings,
  resolveAccountScope,
  resolveAthlete,
  resolveCatalogPaths,
  resolveKeyPrincipal,
  revokeMcpKey,
  rollMcpKey,
  scopeAllowsAthlete,
  setAthleteSecret,
  startDetachedSync,
  syncProgress,
  updateAthleteFile,
  updateAutoSyncSchedule,
  writeMcpOauthSettings,
  type AthleteFileOperation,
  type AutoSyncIntervalMinutes,
  type CatalogPaths,
  type CatencePaths,
  type ConsoleAccountRole,
  type ConsoleAccountScope,
  type SecretProvider,
} from '../../runtime/index.js';
import { activeBearerToken, ensureBearerToken, disableBearerToken, mcpExposureStatus } from './cli-options.js';
import type { OAuthAppHandle } from './oauth.js';
import { CATENCE_MCP_SERVER_INFO, createCatenceMcpServer, MCP_INSTRUCTIONS } from '../mcp/server.js';
import { generationStatus } from './generation-status.js';

const MAX_REQUEST_BYTES = 1_000_000;

export type CatenceHttpServerOptions = {
  /** A shared catalog for public servers. All data APIs then require athleteId. */
  catalogPaths?: CatalogPaths;
  /** Internal compatibility hook for tests and embedded single-store callers. */
  paths?: CatencePaths;
  allowedOrigins?: readonly string[];
  /**
   * Static bearer token for the gate (tests and embedded single-store callers).
   * Mutually exclusive with bearerTokenFile.
   */
  bearerToken?: string;
  /**
   * Token file whose presence switches the gate on: every request except the
   * health endpoints and CORS preflights must present
   * `Authorization: Bearer <token>`. The file is re-read on mtime change, so
   * `catence-data mcp enable|disable` (and the /api/v1/mcp-exposure route)
   * take effect without a restart. The MCP server has no other
   * authentication; this gates it (and the JSON APIs) for non-loopback
   * exposure such as a Cloudflare Tunnel to an MCP client.
   */
  bearerTokenFile?: string;
  /**
   * Per-account MCP key registry for the gate. Any active key in it arms
   * authentication and resolves to that account's athlete scope; keys are
   * managed with `catence-data mcp key` and the /api/v1/mcp-keys routes.
   */
  mcpKeysFile?: string;
  /**
   * OAuth bearer-token verifier (Task B plugs in the MCP OAuth server). Its
   * presence arms the gate when oauthEnabled() is unset or true; verified
   * usernames resolve through the same Console accounts as MCP keys.
   */
  oauthVerifier?: (token: string) => Promise<{ username: string } | null>;
  /**
   * Live check whether the OAuth 2.1 server is effectively enabled. Wired by
   * the server itself when OAuth is configurable (the `oauth` startup option
   * or an oauthSettingsFile); its truth arms the gate together with the
   * oauthVerifier.
   */
  oauthEnabled?: () => boolean;
  /**
   * Run the OAuth 2.1 authorization server (issuer = publicUrl) for
   * ChatGPT/Codex-style clients. The Express sub-app is built lazily on first
   * effective use and serves /.well-known/oauth-* and /oauth/* ahead of the
   * gate; its verifyAccessToken is wired in as the oauthVerifier. The
   * oauthSettingsFile overrides this at runtime.
   */
  oauth?: { publicUrl: string };
  /**
   * Console-managed OAuth settings file for the gate and the
   * /api/v1/mcp-oauth-settings routes. A valid file overrides the `oauth`
   * startup option at runtime; a malformed one fails closed to disabled.
   */
  oauthSettingsFile?: string;
  /** Internal compatibility hook for tests: override the detached sync spawner. */
  startSync?: typeof startDetachedSync;
  /** Internal compatibility hook for tests: passed into the default startDetachedSync. */
  syncSpawnProcess?: DetachedSyncSpawner;
  /** Internal compatibility hook for tests: override OpenCode Go model discovery. */
  mergeModels?: typeof mergeOpenCodeGoConsoleProfiles;
};

/** Endpoints that stay open when bearer authentication is enabled: they carry
 * no personal data and must answer unauthenticated readiness probes. */
const UNAUTHENTICATED_PATHS = new Set(['/health', '/api/v1/health']);

/** The authenticated identity behind one request and the athletes it may touch. */
export type CatencePrincipal = {
  kind: 'admin-token' | 'key' | 'oauth';
  username?: string;
  role: ConsoleAccountRole;
  athleteIds: string[] | 'all';
};

/** Thrown when a principal resolves an athlete outside its scope; routes map it to 403 athlete_forbidden. */
class AthleteForbiddenError extends Error {}

/** Full-access principal: unarmed loopback dev mode and the legacy shared token both mean "local admin". */
const FULL_ACCESS_PRINCIPAL: CatencePrincipal = { kind: 'admin-token', role: 'admin', athleteIds: 'all' };

function bearerTokenFrom(request: IncomingMessage): string | null {
  const header = request.headers.authorization;
  if (typeof header !== 'string' || !header.startsWith('Bearer ')) return null;
  return header.slice('Bearer '.length);
}

function matchesLegacyToken(rawToken: string, expected: string): boolean {
  const received = Buffer.from(rawToken);
  const expectedBuffer = Buffer.from(expected);
  // timingSafeEqual throws on length mismatch, so compare sizes first.
  return received.length === expectedBuffer.length && timingSafeEqual(received, expectedBuffer);
}

function scopeAllows(principal: CatencePrincipal, athleteId: string): boolean {
  return scopeAllowsAthlete(principal.athleteIds, athleteId);
}

function requireAdmin(principal: CatencePrincipal, response: ServerResponse): boolean {
  if (principal.role === 'admin') return true;
  json(response, 403, { error: { code: 'admin_required', message: 'An admin account is required for this action.' } });
  return false;
}

/**
 * True when the principal may manage API keys bound to `account`: admins manage
 * every account's keys; a key or OAuth principal manages only its own
 * account's keys (self-service from the Console's account settings).
 */
function canManageKeysFor(principal: CatencePrincipal, account: string): boolean {
  return principal.role === 'admin' || principal.username === account;
}

function requireKeyManagementFor(principal: CatencePrincipal, account: string, response: ServerResponse): boolean {
  if (canManageKeysFor(principal, account)) return true;
  json(response, 403, { error: { code: 'admin_required', message: 'An admin account is required to manage API keys for another account.' } });
  return false;
}

/**
 * Resolve the request's principal: the legacy shared token first, then a
 * per-account MCP key, then an OAuth bearer token. The gate is armed when the
 * legacy token is active, the key registry holds at least one active key, or
 * the OAuth 2.1 server is effectively enabled; an unarmed server stays open
 * for loopback dev. Resolution fails closed: a malformed registry or accounts
 * store, a revoked key, or an unknown account never yields a principal.
 */
async function resolvePrincipal(request: IncomingMessage, options: CatenceHttpServerOptions, accountPaths: CatalogPaths): Promise<CatencePrincipal | null> {
  const legacyToken =
    options.bearerToken !== undefined ? options.bearerToken : options.bearerTokenFile !== undefined ? activeBearerToken(options.bearerTokenFile) : undefined;
  const keysArmed = options.mcpKeysFile !== undefined && countActiveMcpKeys(options.mcpKeysFile) > 0;
  const oauthArmed = options.oauthVerifier !== undefined && (options.oauthEnabled === undefined || options.oauthEnabled());
  const armed = (legacyToken !== undefined && legacyToken !== null) || keysArmed || oauthArmed;
  if (!armed) return FULL_ACCESS_PRINCIPAL;
  const rawToken = bearerTokenFrom(request);
  if (rawToken === null) return null;
  if (typeof legacyToken === 'string' && matchesLegacyToken(rawToken, legacyToken)) return FULL_ACCESS_PRINCIPAL;
  if (options.mcpKeysFile !== undefined) {
    // A malformed accounts store fails closed: the key resolves to no principal.
    const keyPrincipal = resolveKeyPrincipal(options.mcpKeysFile, rawToken, (username) => {
      try {
        return resolveAccountScope(accountPaths, username);
      } catch {
        return null;
      }
    });
    if (keyPrincipal) return { kind: 'key', username: keyPrincipal.account, role: keyPrincipal.role, athleteIds: keyPrincipal.athleteIds };
  }
  if (options.oauthVerifier !== undefined) {
    const verified = await options.oauthVerifier(rawToken).catch(() => null);
    if (verified) {
      let scope: ConsoleAccountScope | null = null;
      try {
        scope = resolveAccountScope(accountPaths, verified.username);
      } catch {
        scope = null;
      }
      if (scope) return { kind: 'oauth', username: verified.username, role: scope.role, athleteIds: scope.athleteIds };
    }
  }
  return null;
}

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

type McpKeyCreateBody = {
  account: string;
  label?: string;
};

function parseMcpKeyCreateBody(body: unknown): McpKeyCreateBody {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) throw new Error('Request body must be a JSON object.');
  const raw = body as Record<string, unknown>;
  for (const key of Object.keys(raw)) {
    if (!['account', 'label'].includes(key)) throw new Error(`Unknown MCP key field: ${key}.`);
  }
  if (typeof raw.account !== 'string' || !raw.account.trim()) throw new Error('account is required.');
  if (raw.label !== undefined && (typeof raw.label !== 'string' || raw.label.trim().length > 120)) {
    throw new Error('label must be a string of at most 120 characters.');
  }
  return { account: raw.account.trim(), label: raw.label as string | undefined };
}

function parseMcpKeyRollBody(body: unknown): { id: string } {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) throw new Error('Request body must be a JSON object.');
  const raw = body as Record<string, unknown>;
  for (const key of Object.keys(raw)) {
    if (key !== 'id') throw new Error(`Unknown MCP key field: ${key}.`);
  }
  if (typeof raw.id !== 'string' || !raw.id.trim()) throw new Error('id is required.');
  return { id: raw.id.trim() };
}

type McpOauthSettingsBody = {
  enabled: boolean;
  publicUrl?: string;
};

function parseMcpOauthSettingsBody(body: unknown): McpOauthSettingsBody {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) throw new Error('Request body must be a JSON object.');
  const raw = body as Record<string, unknown>;
  for (const key of Object.keys(raw)) {
    if (!['enabled', 'publicUrl'].includes(key)) throw new Error(`Unknown OAuth settings field: ${key}.`);
  }
  if (typeof raw.enabled !== 'boolean') throw new Error('enabled is required and must be a boolean.');
  if (raw.publicUrl !== undefined && typeof raw.publicUrl !== 'string') throw new Error('publicUrl must be a string.');
  return { enabled: raw.enabled, publicUrl: raw.publicUrl };
}

async function dashboardPaths(catalogPaths: CatalogPaths | null, staticPaths: CatencePaths | null, url: URL, principal: CatencePrincipal): Promise<CatencePaths> {
  if (catalogPaths) {
    const athleteId = url.searchParams.get('athleteId');
    if (!athleteId) throw new Error('athleteId is required. Call /api/v1/athletes to inspect the configured catalog.');
    if (!scopeAllows(principal, athleteId)) throw new AthleteForbiddenError(`This credential is not allowed to access athlete ${athleteId}.`);
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
  backfill?: boolean;
};

type SyncScheduleBody = {
  athleteId?: string;
  enabled?: boolean;
  intervalMinutes?: AutoSyncIntervalMinutes;
};

function parseSyncScheduleBody(body: unknown): SyncScheduleBody {
  if (body === undefined) return {};
  if (typeof body !== 'object' || body === null || Array.isArray(body)) throw new Error('Request body must be a JSON object.');
  const raw = body as Record<string, unknown>;
  for (const key of Object.keys(raw)) {
    if (!['athleteId', 'enabled', 'intervalMinutes'].includes(key)) {
      throw new Error(`Unknown auto-sync field: ${key}.`);
    }
  }
  if (raw.athleteId !== undefined && typeof raw.athleteId !== 'string') throw new Error('athleteId must be a string.');
  if (raw.enabled !== undefined && typeof raw.enabled !== 'boolean') throw new Error('enabled must be a boolean.');
  if (raw.intervalMinutes !== undefined) {
    if (typeof raw.intervalMinutes === 'string') {
      raw.intervalMinutes = parseAutoSyncInterval(raw.intervalMinutes);
    } else if (typeof raw.intervalMinutes !== 'number') {
      throw new Error('intervalMinutes must be a number or a label like 15m, 2h, 24h.');
    }
  }
  if (raw.enabled === undefined && raw.intervalMinutes === undefined) {
    throw new Error('Provide enabled, intervalMinutes, or both.');
  }
  return raw as SyncScheduleBody;
}

function parseSyncBody(body: unknown): SyncRequestBody {
  if (body === undefined) return {};
  if (typeof body !== 'object' || body === null || Array.isArray(body)) throw new Error('Request body must be a JSON object.');
  const raw = body as Record<string, unknown>;
  for (const key of Object.keys(raw)) {
    if (!['athleteId', 'provider', 'from', 'refresh', 'refreshModels', 'backfill'].includes(key)) {
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
  for (const flag of ['refresh', 'refreshModels', 'backfill'] as const) {
    if (raw[flag] !== undefined && typeof raw[flag] !== 'boolean') throw new Error(`${flag} must be a boolean.`);
  }
  // A backfill extends history backwards from an explicit date; the CLI's
  // backfill subcommand requires --from, so the API does the same.
  if (raw.backfill === true && raw.from === undefined) {
    throw new Error('from is required for a backfill.');
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

async function resolveSyncPaths(catalogPaths: CatalogPaths | null, staticPaths: CatencePaths | null, body: SyncRequestBody, principal: CatencePrincipal): Promise<CatencePaths> {
  if (catalogPaths) {
    if (!body.athleteId) throw new Error('athleteId is required. Call /api/v1/athletes to inspect the configured catalog.');
    if (!scopeAllows(principal, body.athleteId)) throw new AthleteForbiddenError(`This credential is not allowed to access athlete ${body.athleteId}.`);
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

/**
 * The MCP revision ChatGPT's hosted connector speaks during setup. The bundled
 * SDK predates it, but the request shapes the revision uses — server/discover,
 * then stateless tools/list and tools/call without initialize — are already
 * handled. Only the protocol header value is rejected, so it is bridged down
 * and server/discover is answered from the same descriptor initialize reports.
 */
const MODERN_MCP_PROTOCOL_VERSION = '2026-07-28';

/** A single JSON-RPC request (batches are left to the transport). */
function singleJsonRpcRequest(body: unknown): { id?: unknown; method: string } | null {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) return null;
  const method = (body as { method?: unknown }).method;
  return typeof method === 'string' ? (body as { id?: unknown; method: string }) : null;
}

/**
 * Server capabilities exactly as the SDK's initialize response reports them.
 * getCapabilities() is the runtime accessor that builds that response; the
 * typings mark it private.
 */
function mcpServerCapabilities(server: ReturnType<typeof createCatenceMcpServer>): Record<string, unknown> {
  return (server.server as unknown as { getCapabilities(): Record<string, unknown> }).getCapabilities();
}

async function handleMcpRequest(request: IncomingMessage, response: ServerResponse, paths: CatencePaths | CatalogPaths, principal: CatencePrincipal): Promise<void> {
  if (request.method !== 'POST') {
    methodNotAllowed(response);
    return;
  }

  // ChatGPT's discovery probe and the requests that follow it carry the
  // 2026-07-28 revision; the transport understands only the older list. The
  // Node adapter rebuilds the web-standard headers from rawHeaders (not the
  // parsed headers object), so both views are rewritten.
  if (request.headers['mcp-protocol-version'] === MODERN_MCP_PROTOCOL_VERSION) {
    request.headers['mcp-protocol-version'] = LATEST_PROTOCOL_VERSION;
    const rawHeaders = request.rawHeaders;
    for (let index = 0; index < rawHeaders.length; index += 2) {
      if (rawHeaders[index]?.toLowerCase() === 'mcp-protocol-version') rawHeaders[index + 1] = LATEST_PROTOCOL_VERSION;
    }
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

  const jsonRpc = singleJsonRpcRequest(body);
  if (jsonRpc?.method === 'server/discover') {
    // Modern clients probe discovery before anything else; answer from the
    // same descriptor the initialize response reports so the two never drift.
    const server = createCatenceMcpServer(paths, {}, { scope: { athleteIds: principal.athleteIds } });
    try {
      json(response, 200, {
        jsonrpc: '2.0',
        id: jsonRpc.id ?? null,
        result: {
          resultType: 'complete',
          supportedVersions: [MODERN_MCP_PROTOCOL_VERSION, ...SUPPORTED_PROTOCOL_VERSIONS],
          capabilities: mcpServerCapabilities(server),
          _meta: { 'io.modelcontextprotocol/serverInfo': CATENCE_MCP_SERVER_INFO },
          instructions: MCP_INSTRUCTIONS,
          ttlMs: 3_600_000,
          cacheScope: 'public',
        },
      });
    } finally {
      await server.close();
    }
    return;
  }

  // The HTTP gate has already authenticated this request; the MCP server
  // re-enforces the principal's athlete scope on every tool and roster.
  const server = createCatenceMcpServer(paths, {}, { scope: { athleteIds: principal.athleteIds } });
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
  // Key and OAuth principals resolve their athlete scope through the Console
  // accounts that live next to the catalog.
  const accountPaths = catalogPaths ?? resolveCatalogPaths();
  const allowedOrigins = options.allowedOrigins ?? [];
  const startSync = options.startSync ?? startDetachedSync;
  const mergeModels = options.mergeModels ?? mergeOpenCodeGoConsoleProfiles;

  // OAuth 2.1 is configured by a Console-managed settings file
  // (--oauth-settings-file / <catalog-home>/oauth/settings.json), which
  // overrides the startup `oauth` option (env/flags) at runtime; a malformed
  // file fails closed to disabled. The Express sub-app (express,
  // mcp-oauth-server) builds lazily on first effective use, keyed by the
  // public URL (the issuer), so the stdio path and a never-enabled serve never
  // import express. Its verifier is wired into the gate as oauthVerifier;
  // resolvePrincipal then maps the verified username to the live account scope.
  const oauthSettingsFile = options.oauthSettingsFile;
  const bootstrapOauth = options.oauth !== undefined ? { publicUrl: options.oauth.publicUrl.replace(/\/+$/, '') } : null;
  const oauthConfigurable = options.oauth !== undefined || oauthSettingsFile !== undefined;
  const effectiveOauth = (): { enabled: boolean; publicUrl?: string; source: 'console' | 'environment' | 'disabled'; settingsState: 'ok' | 'missing' | 'invalid' } => {
    if (oauthSettingsFile !== undefined) {
      const { state, settings } = readMcpOauthSettings(oauthSettingsFile);
      if (state === 'ok' && settings !== null) {
        return { enabled: settings.enabled, ...(settings.publicUrl ? { publicUrl: settings.publicUrl } : {}), source: 'console', settingsState: state };
      }
      if (state === 'invalid') return { enabled: false, source: 'disabled', settingsState: state };
    }
    if (bootstrapOauth !== null) return { enabled: true, publicUrl: bootstrapOauth.publicUrl, source: 'environment', settingsState: 'missing' };
    return { enabled: false, source: 'disabled', settingsState: 'missing' };
  };
  let oauthApp: { publicUrl: string; ready: Promise<OAuthAppHandle> } | null = null;
  const getOauthApp = (publicUrl: string): Promise<OAuthAppHandle> => {
    if (oauthApp === null || oauthApp.publicUrl !== publicUrl) {
      const ready = import('./oauth.js').then(({ createOAuthApp }) => createOAuthApp({ catalogRoot: accountPaths.root, publicUrl }));
      // Surface a build failure per request (the outer catch answers 500); this
      // no-op branch only marks the rejection handled when no request ever comes.
      void ready.catch(() => {});
      oauthApp = { publicUrl, ready };
    }
    return oauthApp.ready;
  };
  let effectiveOptions = options;
  if (oauthConfigurable) {
    const verifier: NonNullable<CatenceHttpServerOptions['oauthVerifier']> = async (token) => {
      const config = effectiveOauth();
      if (!config.enabled || config.publicUrl === undefined) return null;
      const verified = await (await getOauthApp(config.publicUrl)).verifyAccessToken(token);
      if (!verified?.userId) return null;
      return { username: verified.userId };
    };
    effectiveOptions = { ...options, oauthVerifier: verifier, oauthEnabled: () => effectiveOauth().enabled };
  }
  // The status shape mcpExposureStatus reports; present whenever OAuth is
  // configurable so the Console can read and change it.
  const oauthStatus = (): { enabled: boolean; publicUrl?: string } | undefined => {
    if (!oauthConfigurable) return undefined;
    const config = effectiveOauth();
    return { enabled: config.enabled, ...(config.publicUrl ? { publicUrl: config.publicUrl } : {}) };
  };

  return createServer((request, response) => {
    void (async () => {
      const pathname = new URL(request.url ?? '/', 'http://localhost').pathname;

      // The OAuth endpoints are the auth surface itself: they bypass the gate
      // and CORS entirely and are delegated to the Express sub-app. When OAuth
      // is effectively disabled they answer 404 — no metadata is advertised.
      if (pathname.startsWith('/.well-known/oauth-') || pathname.startsWith('/oauth/')) {
        const config = effectiveOauth();
        if (config.enabled && config.publicUrl !== undefined) {
          const handle = await getOauthApp(config.publicUrl);
          handle.app(request, response);
          return;
        }
        json(response, 404, { error: { code: 'not_found', message: 'No Catence endpoint matches this request.' } });
        return;
      }

      if (!addCorsHeaders(request, response, allowedOrigins)) {
        json(response, 403, { error: { code: 'origin_not_allowed', message: 'This browser origin is not allowed to access Catence.' } });
        return;
      }

      if (request.method === 'OPTIONS') {
        response.writeHead(204).end();
        return;
      }

      // Health probes stay open even when the gate is armed; they resolve no
      // principal because nothing downstream consumes one.
      const principal = UNAUTHENTICATED_PATHS.has(pathname)
        ? FULL_ACCESS_PRINCIPAL
        : await resolvePrincipal(request, effectiveOptions, accountPaths);
      if (principal === null) {
        // A presented-but-rejected token is a bearer problem, not an OAuth
        // discovery problem: answer RFC 6750 invalid_token without
        // resource_metadata, so static-key clients get a clear "your token is
        // wrong" instead of being steered into the OAuth flow. With no token,
        // RFC 9728 points OAuth clients at the protected-resource metadata so
        // they discover the authorization server; without OAuth the 401 stays
        // plain on purpose: MCP connector auto-detection treats it as a
        // bearer gate rather than an OAuth server.
        if (bearerTokenFrom(request) !== null) {
          response.setHeader('www-authenticate', 'Bearer error="invalid_token", error_description="The access token is invalid or expired."');
        } else {
          const config = effectiveOauth();
          if (config.enabled && config.publicUrl !== undefined) {
            const handle = await getOauthApp(config.publicUrl).catch(() => null);
            if (handle !== null) response.setHeader('www-authenticate', `Bearer resource_metadata="${handle.protectedResourceMetadataUrl}"`);
          }
        }
        json(response, 401, { error: { code: 'unauthorized', message: 'A valid Authorization: Bearer token is required.' } });
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
          // The roster is narrowed to the principal's athlete scope.
          const roster = filterRosterToScope(catalog.athletes, catalog.defaultAthleteId, principal.athleteIds);
          json(response, 200, { defaultAthleteId: roster.defaultAthleteId, athletes: roster.athletes });
        } catch (error) {
          json(response, 400, { error: { code: 'catalog_unavailable', message: error instanceof Error ? error.message : String(error) } });
        }
        return;
      }

      if (pathname === '/api/v1/athletes' && request.method === 'POST') {
        if (!requireAdmin(principal, response)) return;
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
          json(response, 200, await dashboardSnapshot(await dashboardPaths(catalogPaths, staticPaths, url, principal), url));
        } catch (error) {
          if (error instanceof AthleteForbiddenError) {
            json(response, 403, { error: { code: 'athlete_forbidden', message: error.message } });
            return;
          }
          json(response, 400, { error: { code: 'dashboard_unavailable', message: error instanceof Error ? error.message : String(error) } });
        }
        return;
      }

      if (pathname === '/api/v1/athlete-file' && request.method === 'GET') {
        try {
          const url = new URL(request.url ?? '/', 'http://localhost');
          const paths = await dashboardPaths(catalogPaths, staticPaths, url, principal);
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
          if (error instanceof AthleteForbiddenError) {
            json(response, 403, { error: { code: 'athlete_forbidden', message: error.message } });
            return;
          }
          json(response, 400, { error: { code: 'athlete_file_unavailable', message: error instanceof Error ? error.message : String(error) } });
        }
        return;
      }

      if (pathname === '/api/v1/athlete-file' && request.method === 'PUT') {
        try {
          const url = new URL(request.url ?? '/', 'http://localhost');
          const paths = await dashboardPaths(catalogPaths, staticPaths, url, principal);
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
          if (error instanceof AthleteForbiddenError) {
            json(response, 403, { error: { code: 'athlete_forbidden', message: error.message } });
            return;
          }
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
          const paths = await dashboardPaths(catalogPaths, staticPaths, url, principal);
          json(response, 200, { athleteId: url.searchParams.get('athleteId') ?? 'local', providers: await describeAthleteSecrets(paths) });
        } catch (error) {
          if (error instanceof AthleteForbiddenError) {
            json(response, 403, { error: { code: 'athlete_forbidden', message: error.message } });
            return;
          }
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
          const paths = await dashboardPaths(catalogPaths, staticPaths, url, principal);
          await setAthleteSecret(paths, parsed.provider, parsed.field, parsed.value);
          json(response, 200, { athleteId: url.searchParams.get('athleteId') ?? 'local', providers: await describeAthleteSecrets(paths) });
        } catch (error) {
          if (error instanceof AthleteForbiddenError) {
            json(response, 403, { error: { code: 'athlete_forbidden', message: error.message } });
            return;
          }
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
          const paths = await dashboardPaths(catalogPaths, staticPaths, url, principal);
          await deleteAthleteSecret(paths, parsed.provider, parsed.field);
          json(response, 200, { athleteId: url.searchParams.get('athleteId') ?? 'local', providers: await describeAthleteSecrets(paths) });
        } catch (error) {
          if (error instanceof AthleteForbiddenError) {
            json(response, 403, { error: { code: 'athlete_forbidden', message: error.message } });
            return;
          }
          const message = error instanceof Error ? error.message : String(error);
          json(response, 400, { error: { code: 'athlete_secret_remove_failed', message } });
        }
        return;
      }

      if (pathname === '/api/v1/sync' && request.method === 'POST') {
        let body: SyncRequestBody;
        try {
          body = parseSyncBody(await readJsonBody(request));
          const paths = await resolveSyncPaths(catalogPaths, staticPaths, body, principal);
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
              backfill: body.backfill,
              // The child resolves the athlete within the catalog, not within
              // the athlete store this route resolved for locks and logs.
              cliHome: catalogPaths ? catalogPaths.root : undefined,
            },
            { spawnProcess: options.syncSpawnProcess },
          );
          json(response, 202, { ...handle, ...(discoveryWarning ? { warning: discoveryWarning } : {}), progressEndpoint: '/api/v1/sync/status' });
        } catch (error) {
          if (error instanceof AthleteForbiddenError) {
            json(response, 403, { error: { code: 'athlete_forbidden', message: error.message } });
            return;
          }
          json(response, error instanceof DetachedSyncBusyError ? 409 : 400, {
            error: {
              code: error instanceof DetachedSyncBusyError ? 'sync_in_progress' : 'sync_start_failed',
              message: error instanceof Error ? error.message : String(error),
            },
          });
        }
        return;
      }

      if (pathname === '/api/v1/sync/schedule' && request.method === 'GET') {
        try {
          const url = new URL(request.url ?? '/', 'http://localhost');
          const paths = await dashboardPaths(catalogPaths, staticPaths, url, principal);
          const athleteId = catalogPaths ? (url.searchParams.get('athleteId') ?? '') : 'local';
          json(response, 200, await readAutoSyncSchedule(paths, athleteId));
        } catch (error) {
          if (error instanceof AthleteForbiddenError) {
            json(response, 403, { error: { code: 'athlete_forbidden', message: error.message } });
            return;
          }
          json(response, 400, { error: { code: 'schedule_unavailable', message: error instanceof Error ? error.message : String(error) } });
        }
        return;
      }

      if (pathname === '/api/v1/sync/schedule' && request.method === 'PUT') {
        try {
          const body = parseSyncScheduleBody(await readJsonBody(request));
          const url = new URL(request.url ?? '/', 'http://localhost');
          const paths = await resolveSyncPaths(catalogPaths, staticPaths, { athleteId: body.athleteId }, principal);
          const athleteId = catalogPaths ? (body.athleteId ?? '') : 'local';
          json(response, 200, await updateAutoSyncSchedule(paths, athleteId, {
            enabled: body.enabled,
            ...(body.intervalMinutes === undefined ? {} : { intervalMinutes: parseAutoSyncInterval(String(body.intervalMinutes)) }),
          }));
        } catch (error) {
          if (error instanceof AthleteForbiddenError) {
            json(response, 403, { error: { code: 'athlete_forbidden', message: error.message } });
            return;
          }
          json(response, 400, { error: { code: 'schedule_update_failed', message: error instanceof Error ? error.message : String(error) } });
        }
        return;
      }

      if (pathname === '/api/v1/models/discover' && request.method === 'POST') {
        if (!requireAdmin(principal, response)) return;
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
          const paths = await dashboardPaths(catalogPaths, staticPaths, url, principal);
          const athleteId = catalogPaths ? (await resolveAthlete(catalogPaths, url.searchParams.get('athleteId') ?? '')).athlete.id : 'local';
          json(response, 200, { athleteId, progress: await syncProgress(paths), lastSync: await lastSyncSummary(paths) });
        } catch (error) {
          if (error instanceof AthleteForbiddenError) {
            json(response, 403, { error: { code: 'athlete_forbidden', message: error.message } });
            return;
          }
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

      if (pathname === '/api/v1/mcp-exposure' && request.method === 'GET') {
        if (!requireAdmin(principal, response)) return;
        if (!options.bearerTokenFile) {
          json(response, 400, { error: { code: 'exposure_not_configured', message: 'This server was started without a bearer-token file; restart it with --auth-token-file to manage MCP exposure.' } });
          return;
        }
        json(response, 200, mcpExposureStatus(options.bearerTokenFile, `http://${request.headers.host ?? '127.0.0.1:8787'}`, oauthStatus()));
        return;
      }

      if (pathname === '/api/v1/mcp-exposure' && request.method === 'POST') {
        if (!requireAdmin(principal, response)) return;
        if (!options.bearerTokenFile) {
          json(response, 400, { error: { code: 'exposure_not_configured', message: 'This server was started without a bearer-token file; restart it with --auth-token-file to manage MCP exposure.' } });
          return;
        }
        try {
          const body = await readJsonBody(request);
          if (typeof body !== 'object' || body === null || Array.isArray(body) || !('enabled' in body) || typeof (body as Record<string, unknown>).enabled !== 'boolean') {
            throw new Error('Request body must be a JSON object with a boolean "enabled" field.');
          }
          if ((body as Record<string, unknown>).enabled) ensureBearerToken(options.bearerTokenFile);
          else disableBearerToken(options.bearerTokenFile);
          json(response, 200, mcpExposureStatus(options.bearerTokenFile, `http://${request.headers.host ?? '127.0.0.1:8787'}`, oauthStatus()));
        } catch (error) {
          json(response, 400, { error: { code: 'exposure_update_failed', message: error instanceof Error ? error.message : String(error) } });
        }
        return;
      }

      if (pathname === '/api/v1/mcp-keys' && request.method === 'GET') {
        if (!options.mcpKeysFile) {
          json(response, 400, { error: { code: 'mcp_keys_not_configured', message: 'This server was started without an MCP keys file; restart it with --mcp-keys-file to manage per-account keys.' } });
          return;
        }
        try {
          // Listing never exposes token hashes. Admins see the whole registry;
          // a key or OAuth principal sees only its own account's keys.
          const keys = await listMcpKeys(options.mcpKeysFile);
          json(response, 200, { keys: principal.role === 'admin' ? keys : keys.filter((key) => key.account === principal.username) });
        } catch (error) {
          json(response, 400, { error: { code: 'mcp_keys_unavailable', message: error instanceof Error ? error.message : String(error) } });
        }
        return;
      }

      if (pathname === '/api/v1/mcp-keys' && request.method === 'POST') {
        if (!options.mcpKeysFile) {
          json(response, 400, { error: { code: 'mcp_keys_not_configured', message: 'This server was started without an MCP keys file; restart it with --mcp-keys-file to manage per-account keys.' } });
          return;
        }
        try {
          const body = parseMcpKeyCreateBody(await readJsonBody(request));
          // Admins may key any account; a key or OAuth principal only its own.
          if (!requireKeyManagementFor(principal, body.account, response)) return;
          const { record, token } = await addMcpKey(options.mcpKeysFile, body);
          // The raw token is returned exactly once; only its hash is stored.
          json(response, 201, { id: record.id, label: record.label, account: record.account, createdAt: record.createdAt, token });
        } catch (error) {
          json(response, 400, { error: { code: 'mcp_key_create_failed', message: error instanceof Error ? error.message : String(error) } });
        }
        return;
      }

      if (pathname === '/api/v1/mcp-keys' && request.method === 'DELETE') {
        if (!options.mcpKeysFile) {
          json(response, 400, { error: { code: 'mcp_keys_not_configured', message: 'This server was started without an MCP keys file; restart it with --mcp-keys-file to manage per-account keys.' } });
          return;
        }
        const id = new URL(request.url ?? '/', 'http://localhost').searchParams.get('id');
        if (!id) {
          json(response, 400, { error: { code: 'invalid_request', message: 'id is required.' } });
          return;
        }
        try {
          // Admins may revoke any key; a key or OAuth principal only its own.
          // An unknown id falls through to the same 404 as the admin path.
          if (principal.role !== 'admin') {
            const keys = await listMcpKeys(options.mcpKeysFile);
            const target = keys.find((key) => key.id === id);
            if (target && !requireKeyManagementFor(principal, target.account, response)) return;
          }
          await revokeMcpKey(options.mcpKeysFile, id);
          json(response, 200, { revoked: id });
        } catch (error) {
          if (error instanceof McpKeyNotFoundError) {
            json(response, 404, { error: { code: 'mcp_key_not_found', message: error.message } });
            return;
          }
          json(response, 400, { error: { code: 'mcp_key_revoke_failed', message: error instanceof Error ? error.message : String(error) } });
        }
        return;
      }

      if (pathname === '/api/v1/mcp-keys/roll' && request.method === 'POST') {
        if (!options.mcpKeysFile) {
          json(response, 400, { error: { code: 'mcp_keys_not_configured', message: 'This server was started without an MCP keys file; restart it with --mcp-keys-file to manage per-account keys.' } });
          return;
        }
        try {
          const body = parseMcpKeyRollBody(await readJsonBody(request));
          // Admins may roll any key; a key or OAuth principal only its own.
          // An unknown id falls through to the same 404 as the admin path.
          if (principal.role !== 'admin') {
            const keys = await listMcpKeys(options.mcpKeysFile);
            const target = keys.find((key) => key.id === body.id);
            if (target && !requireKeyManagementFor(principal, target.account, response)) return;
          }
          const { record, token } = await rollMcpKey(options.mcpKeysFile, body.id);
          // The new raw token is returned exactly once; only its hash is stored.
          json(response, 200, { id: record.id, label: record.label, account: record.account, createdAt: record.createdAt, token });
        } catch (error) {
          if (error instanceof McpKeyNotFoundError) {
            json(response, 404, { error: { code: 'mcp_key_not_found', message: error.message } });
            return;
          }
          json(response, 400, { error: { code: 'mcp_key_roll_failed', message: error instanceof Error ? error.message : String(error) } });
        }
        return;
      }

      if (pathname === '/api/v1/mcp-oauth-settings' && request.method === 'GET') {
        if (!requireAdmin(principal, response)) return;
        if (!oauthSettingsFile) {
          json(response, 400, { error: { code: 'mcp_oauth_not_configured', message: 'This server was started without an OAuth settings file; restart it with --oauth-settings-file to manage OAuth from the Console.' } });
          return;
        }
        const status = effectiveOauth();
        json(response, 200, {
          enabled: status.enabled,
          publicUrl: status.publicUrl ?? null,
          source: status.source,
          settingsFile: oauthSettingsFile,
          settingsState: status.settingsState,
        });
        return;
      }

      if (pathname === '/api/v1/mcp-oauth-settings' && request.method === 'POST') {
        if (!requireAdmin(principal, response)) return;
        if (!oauthSettingsFile) {
          json(response, 400, { error: { code: 'mcp_oauth_not_configured', message: 'This server was started without an OAuth settings file; restart it with --oauth-settings-file to manage OAuth from the Console.' } });
          return;
        }
        try {
          const body = parseMcpOauthSettingsBody(await readJsonBody(request));
          await writeMcpOauthSettings(oauthSettingsFile, body);
          const status = effectiveOauth();
          json(response, 200, {
            enabled: status.enabled,
            publicUrl: status.publicUrl ?? null,
            source: status.source,
            settingsFile: oauthSettingsFile,
            settingsState: status.settingsState,
          });
        } catch (error) {
          json(response, 400, { error: { code: 'mcp_oauth_settings_update_failed', message: error instanceof Error ? error.message : String(error) } });
        }
        return;
      }

      if (pathname === '/mcp') {
        await handleMcpRequest(request, response, catalogPaths ?? staticPaths ?? resolveCatalogPaths(), principal);
        return;
      }

      json(response, 404, { error: { code: 'not_found', message: 'No Catence endpoint matches this request.' } });
    })().catch((error: unknown) => {
      if (!response.headersSent) json(response, 500, { error: { code: 'internal_error', message: error instanceof Error ? error.message : String(error) } });
    });
  });
}
