import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { catenceRuntimeHealth, DashboardSnapshotService, jsonSafe, openReadOnlyRepository, resolvePaths, type CatencePaths } from '../../runtime/index.js';
import { createCatenceMcpServer } from '../mcp/server.js';

const MAX_REQUEST_BYTES = 1_000_000;

export type CatenceHttpServerOptions = {
  paths?: CatencePaths;
  allowedOrigins?: readonly string[];
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
  response.setHeader('access-control-allow-methods', 'GET, POST, DELETE, OPTIONS');
  response.setHeader('access-control-allow-headers', 'content-type, mcp-session-id');
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

async function handleMcpRequest(request: IncomingMessage, response: ServerResponse, paths: CatencePaths): Promise<void> {
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
  const paths = options.paths ?? resolvePaths();
  const allowedOrigins = options.allowedOrigins ?? [];

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

      if (pathname === '/api/v1/dashboard' && request.method === 'GET') {
        try {
          json(response, 200, await dashboardSnapshot(paths, new URL(request.url ?? '/', 'http://localhost')));
        } catch (error) {
          json(response, 400, { error: { code: 'dashboard_unavailable', message: error instanceof Error ? error.message : String(error) } });
        }
        return;
      }

      if (pathname === '/mcp') {
        await handleMcpRequest(request, response, paths);
        return;
      }

      json(response, 404, { error: { code: 'not_found', message: 'No Catence endpoint matches this request.' } });
    })().catch((error: unknown) => {
      if (!response.headersSent) json(response, 500, { error: { code: 'internal_error', message: error instanceof Error ? error.message : String(error) } });
    });
  });
}
