import { randomBytes } from 'node:crypto';
import { existsSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';

export type ServeCliOptions = {
  home?: string;
  host: string;
  port: number;
  allowedOrigins: string[];
  authTokenFile?: string;
  help: boolean;
};

export const SERVE_USAGE = `Usage: catence serve [options]

Run Catence as a local Streamable HTTP MCP server.

Options:
  --home <directory>         Catence catalog home. Defaults to CATENCE_HOME or ~/.catence.
  --host <host>              Listener host. Defaults to 127.0.0.1.
  --port <port>              Listener port. Defaults to 8787.
  --allow-origin <origin>    Browser origin allowed to call Catence APIs. May be repeated.
  --auth-token-file <path>   Bearer-token file for the HTTP gate. Its presence switches authentication on;
                             generate/inspect it with 'catence-data mcp enable|token'.
                             Defaults to CATENCE_MCP_TOKEN_FILE or <catalog-home>/mcp-token.
  -h, --help                 Show this help text.`;

/** The canonical token location inside a catalog home. */
export function defaultBearerTokenPath(catalogRoot: string): string {
  return `${catalogRoot.replace(/[/\\]+$/, '')}/mcp-token`;
}

/** Read and validate a stored bearer token: trimmed, non-empty, or fail loudly. */
export function loadBearerToken(filePath: string): string {
  let token: string;
  try {
    token = readFileSync(filePath, 'utf8').trim();
  } catch (error) {
    throw new Error(`Cannot read the auth token file ${filePath}: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (!token) throw new Error(`The auth token file ${filePath} is empty.`);
  return token;
}

/**
 * The bearer token for the server: the stored one, or a freshly generated
 * token written to the file (mode 0600) when it does not exist yet. Users
 * never hand-craft tokens; they enable auth and read the result with
 * `catence-data mcp-token`.
 */
export function ensureBearerToken(filePath: string): string {
  if (existsSync(filePath)) return loadBearerToken(filePath);
  const token = randomBytes(32).toString('hex');
  writeFileSync(filePath, token, { mode: 0o600 });
  return token;
}

export function disableBearerToken(filePath: string): void {
  if (existsSync(filePath)) rmSync(filePath);
}

/** The bearer token when exposure is enabled, or null when no token file exists. */
export function readBearerToken(filePath: string): string | null {
  return existsSync(filePath) ? loadBearerToken(filePath) : null;
}

type CachedToken = { mtimeMs: number; token: string | null };
const tokenCache = new Map<string, CachedToken>();

/**
 * The currently active bearer token for the HTTP gate, cached by the token
 * file's mtime so enabling or disabling is picked up without a restart. A
 * missing file disables the gate; an existing but unreadable or empty file
 * fails closed (the gate rejects everything except health probes).
 */
export function activeBearerToken(filePath: string): string | null | 'invalid' {
  let mtimeMs = 0;
  try {
    mtimeMs = statSync(filePath).mtimeMs;
  } catch {
    tokenCache.set(filePath, { mtimeMs: 0, token: null });
    return null;
  }
  const cached = tokenCache.get(filePath);
  if (cached && cached.mtimeMs === mtimeMs) {
    return cached.token === null ? 'invalid' : cached.token;
  }
  try {
    const token = loadBearerToken(filePath);
    tokenCache.set(filePath, { mtimeMs, token });
    return token;
  } catch {
    tokenCache.set(filePath, { mtimeMs, token: null });
    return 'invalid';
  }
}

export type McpExposureStatus = {
  enabled: boolean;
  tokenFile: string;
  endpoint: string;
  healthEndpoint: string;
  token?: string;
};

export function mcpExposureStatus(filePath: string, endpointBase: string): McpExposureStatus {
  const token = readBearerToken(filePath);
  const base = endpointBase.replace(/\/+$/, '');
  return {
    enabled: token !== null,
    tokenFile: filePath,
    endpoint: `${base}/mcp`,
    healthEndpoint: `${base}/health`,
    ...(token !== null ? { token } : {}),
  };
}

function requiredValue(arguments_: readonly string[], index: number, option: string): string {
  const value = arguments_[index + 1];
  if (!value || value.startsWith('-')) throw new Error(`${option} requires a value.`);
  return value;
}

function parsePort(value: string): number {
  if (!/^\d+$/.test(value)) throw new Error('--port must be an integer between 1 and 65535.');
  const port = Number(value);
  if (port < 1 || port > 65_535) throw new Error('--port must be an integer between 1 and 65535.');
  return port;
}

export function parseServeCliOptions(arguments_: readonly string[]): ServeCliOptions {
  let home: string | undefined;
  let host = process.env.CATENCE_HTTP_HOST ?? '127.0.0.1';
  let port = process.env.CATENCE_HTTP_PORT ? parsePort(process.env.CATENCE_HTTP_PORT) : 8787;
  const allowedOrigins: string[] = [];
  let authTokenFile: string | undefined = process.env.CATENCE_MCP_TOKEN_FILE || undefined;

  for (let index = 0; index < arguments_.length; index++) {
    const argument = arguments_[index];
    if (argument === '-h' || argument === '--help') return { home, host, port, allowedOrigins, authTokenFile, help: true };
    if (argument === '--home') {
      home = requiredValue(arguments_, index, '--home');
      index++;
      continue;
    }
    if (argument.startsWith('--home=')) {
      home = argument.slice('--home='.length);
      if (!home) throw new Error('--home requires a value.');
      continue;
    }
    if (argument === '--auth-token-file') {
      authTokenFile = requiredValue(arguments_, index, '--auth-token-file');
      index++;
      continue;
    }
    if (argument.startsWith('--auth-token-file=')) {
      authTokenFile = argument.slice('--auth-token-file='.length);
      if (!authTokenFile) throw new Error('--auth-token-file requires a value.');
      continue;
    }
    if (argument === '--host') {
      host = requiredValue(arguments_, index, '--host');
      index++;
      continue;
    }
    if (argument.startsWith('--host=')) {
      host = argument.slice('--host='.length);
      if (!host) throw new Error('--host requires a value.');
      continue;
    }
    if (argument === '--port') {
      port = parsePort(requiredValue(arguments_, index, '--port'));
      index++;
      continue;
    }
    if (argument.startsWith('--port=')) {
      port = parsePort(argument.slice('--port='.length));
      continue;
    }
    if (argument === '--allow-origin') {
      allowedOrigins.push(requiredValue(arguments_, index, '--allow-origin'));
      index++;
      continue;
    }
    if (argument.startsWith('--allow-origin=')) {
      const origin = argument.slice('--allow-origin='.length);
      if (!origin) throw new Error('--allow-origin requires a value.');
      allowedOrigins.push(origin);
      continue;
    }
    throw new Error(`Unknown option: ${argument}`);
  }

  return { home, host, port, allowedOrigins, authTokenFile, help: false };
}
