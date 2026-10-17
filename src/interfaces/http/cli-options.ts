import { randomBytes } from 'node:crypto';
import { existsSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { readMcpOauthSettings } from '../../runtime/index.js';

export type ServeCliOptions = {
  home?: string;
  host: string;
  port: number;
  allowedOrigins: string[];
  authTokenFile?: string;
  mcpKeysFile?: string;
  oauthSettingsFile?: string;
  oauth: boolean;
  publicUrl?: string;
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
  --mcp-keys-file <path>     Per-account MCP key registry for the HTTP gate. Any active key in it
                             switches authentication on; manage keys with 'catence-data mcp key'.
                             Defaults to CATENCE_MCP_KEYS_FILE or <catalog-home>/mcp-keys.json.
  --oauth                    Run the OAuth 2.1 authorization server (issuer = --public-url) so
                             ChatGPT/Codex-style MCP clients connect with a per-account consent
                             login. Requires --public-url. Defaults to CATENCE_OAUTH_ENABLED=1/true.
                             The Console settings file overrides this at runtime.
  --public-url <url>         Public https URL of this server (no query string or fragment), e.g.
                             the tunnel URL. Required when --oauth is enabled.
                             Defaults to CATENCE_PUBLIC_URL.
  --oauth-settings-file <path>
                             Console-managed OAuth settings that override --oauth/--public-url
                             at runtime. Defaults to CATENCE_OAUTH_SETTINGS_FILE or
                             <catalog-home>/oauth/settings.json.
  -h, --help                 Show this help text.`;

/** The canonical token location inside a catalog home. */
export function defaultBearerTokenPath(catalogRoot: string): string {
  return `${catalogRoot.replace(/[/\\]+$/, '')}/mcp-token`;
}

/** The canonical per-account MCP key registry location inside a catalog home. */
export function defaultMcpKeysPath(catalogRoot: string): string {
  return `${catalogRoot.replace(/[/\\]+$/, '')}/mcp-keys.json`;
}

/** The canonical Console-managed OAuth settings location inside a catalog home. */
export function defaultOauthSettingsPath(catalogRoot: string): string {
  return `${catalogRoot.replace(/[/\\]+$/, '')}/oauth/settings.json`;
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
  oauth?: { enabled: boolean; publicUrl?: string };
};

export function mcpExposureStatus(filePath: string, endpointBase: string, oauth?: { enabled: boolean; publicUrl?: string }): McpExposureStatus {
  const token = readBearerToken(filePath);
  const base = endpointBase.replace(/\/+$/, '');
  return {
    enabled: token !== null,
    tokenFile: filePath,
    endpoint: `${base}/mcp`,
    healthEndpoint: `${base}/health`,
    ...(token !== null ? { token } : {}),
    ...(oauth !== undefined ? { oauth } : {}),
  };
}

/** True when CATENCE_OAUTH_ENABLED is 1/true. */
export function oauthEnabledFromEnv(env: NodeJS.ProcessEnv = process.env): boolean {
  const value = env.CATENCE_OAUTH_ENABLED;
  return value === '1' || value === 'true';
}

/** The OAuth exposure reported by `catence-data mcp status`, read from the environment. */
export function oauthStatusFromEnv(env: NodeJS.ProcessEnv = process.env): { enabled: boolean; publicUrl?: string } {
  const publicUrl = env.CATENCE_PUBLIC_URL || undefined;
  return { enabled: oauthEnabledFromEnv(env), ...(publicUrl !== undefined ? { publicUrl } : {}) };
}

export type McpOauthStatusSource = 'console' | 'environment' | 'disabled';

/**
 * The effective OAuth exposure: the Console settings file when a valid one
 * exists (a malformed one fails closed to disabled), else the environment.
 * `source` records where the effective values come from.
 */
export function oauthStatusFromSettings(
  settingsFile: string,
  env: NodeJS.ProcessEnv = process.env,
): { enabled: boolean; publicUrl?: string; source: McpOauthStatusSource } {
  const { state, settings } = readMcpOauthSettings(settingsFile);
  if (state === 'ok' && settings !== null) {
    return { enabled: settings.enabled, ...(settings.publicUrl ? { publicUrl: settings.publicUrl } : {}), source: 'console' };
  }
  if (state === 'invalid') return { enabled: false, source: 'disabled' };
  const fromEnv = oauthStatusFromEnv(env);
  return { ...fromEnv, source: fromEnv.enabled ? 'environment' : 'disabled' };
}

/**
 * Validate the public URL: an absolute https URL with no query string or
 * fragment (it becomes the advertised OAuth issuer), trailing slashes stripped.
 */
function parsePublicUrl(value: string, option: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`${option} must be a valid absolute URL.`);
  }
  if (url.protocol !== 'https:') throw new Error(`${option} must use https: the OAuth issuer is advertised publicly.`);
  if (url.search || url.hash) throw new Error(`${option} must not contain a query string or fragment.`);
  return value.replace(/\/+$/, '');
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
  let mcpKeysFile: string | undefined = process.env.CATENCE_MCP_KEYS_FILE || undefined;
  let oauthSettingsFile: string | undefined = process.env.CATENCE_OAUTH_SETTINGS_FILE || undefined;
  let oauth = oauthEnabledFromEnv();
  let publicUrl: string | undefined = process.env.CATENCE_PUBLIC_URL || undefined;
  let publicUrlSource = 'CATENCE_PUBLIC_URL';

  for (let index = 0; index < arguments_.length; index++) {
    const argument = arguments_[index];
    if (argument === '-h' || argument === '--help') return { home, host, port, allowedOrigins, authTokenFile, mcpKeysFile, oauthSettingsFile, oauth, publicUrl, help: true };
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
    if (argument === '--mcp-keys-file') {
      mcpKeysFile = requiredValue(arguments_, index, '--mcp-keys-file');
      index++;
      continue;
    }
    if (argument.startsWith('--mcp-keys-file=')) {
      mcpKeysFile = argument.slice('--mcp-keys-file='.length);
      if (!mcpKeysFile) throw new Error('--mcp-keys-file requires a value.');
      continue;
    }
    if (argument === '--oauth-settings-file') {
      oauthSettingsFile = requiredValue(arguments_, index, '--oauth-settings-file');
      index++;
      continue;
    }
    if (argument.startsWith('--oauth-settings-file=')) {
      oauthSettingsFile = argument.slice('--oauth-settings-file='.length);
      if (!oauthSettingsFile) throw new Error('--oauth-settings-file requires a value.');
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
    if (argument === '--oauth') {
      oauth = true;
      continue;
    }
    if (argument === '--public-url') {
      publicUrl = requiredValue(arguments_, index, '--public-url');
      publicUrlSource = '--public-url';
      index++;
      continue;
    }
    if (argument.startsWith('--public-url=')) {
      publicUrl = argument.slice('--public-url='.length);
      if (!publicUrl) throw new Error('--public-url requires a value.');
      publicUrlSource = '--public-url';
      continue;
    }
    throw new Error(`Unknown option: ${argument}`);
  }

  if (publicUrl !== undefined) publicUrl = parsePublicUrl(publicUrl, publicUrlSource);
  if (oauth && publicUrl === undefined) {
    throw new Error('--oauth requires --public-url (or CATENCE_PUBLIC_URL): the OAuth issuer is the public URL of this server.');
  }

  return { home, host, port, allowedOrigins, authTokenFile, mcpKeysFile, oauthSettingsFile, oauth, publicUrl, help: false };
}
