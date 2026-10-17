import { mkdir, rename, writeFile } from 'node:fs/promises';
import { readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { z } from 'zod';

/**
 * Console-managed OAuth 2.1 exposure settings, stored at
 * <catalogHome>/oauth/settings.json (directory 0700, file 0600, atomic
 * tmp+rename writes, mirroring mcp-keys.ts).
 *
 * The file is the runtime override for the startup --oauth/--public-url
 * (CATENCE_OAUTH_ENABLED/CATENCE_PUBLIC_URL) values: once a valid file exists
 * it alone decides whether the OAuth 2.1 authorization server is enabled, so
 * the Console can switch OAuth on and off without a restart. A malformed file
 * fails closed (disabled) until the Console writes a valid one.
 */

const MCP_OAUTH_SETTINGS_FORMAT_VERSION = 1;

const settingsSchema = z.object({
  formatVersion: z.literal(MCP_OAUTH_SETTINGS_FORMAT_VERSION),
  enabled: z.boolean(),
  // Normalized at write time: absolute https URL, no query/fragment, trailing
  // slashes stripped; empty when never set.
  publicUrl: z.string().max(2048),
}).strict()
  // An enabled record without a public URL is semantically invalid (the URL is
  // the advertised issuer); the read fails closed for it like any malformed file.
  .refine((value) => !value.enabled || value.publicUrl.length > 0, { message: 'enabled requires a publicUrl' });

export type McpOauthSettings = z.infer<typeof settingsSchema>;
export type McpOauthSettingsState = 'ok' | 'missing' | 'invalid';
export type McpOauthSettingsRead = { state: McpOauthSettingsState; settings: McpOauthSettings | null };
export type McpOauthSettingsInput = { enabled: boolean; publicUrl?: string };

/**
 * Validate the public URL: an absolute https URL with no query string or
 * fragment (it becomes the advertised OAuth issuer), trailing slashes stripped.
 * Mirrors the CLI's --public-url rule (cli-options.ts) at the write boundary.
 */
export function validateOauthPublicUrl(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error('publicUrl must be a valid absolute URL.');
  }
  if (url.protocol !== 'https:') throw new Error('publicUrl must use https: the OAuth issuer is advertised publicly.');
  if (url.search || url.hash) throw new Error('publicUrl must not contain a query string or fragment.');
  return value.replace(/\/+$/, '');
}

/** Validate and normalize a settings write; throws on invalid input (fail loud). */
export function normalizeMcpOauthSettings(input: McpOauthSettingsInput): McpOauthSettings {
  const publicUrl = (input.publicUrl ?? '').trim();
  if (input.enabled && !publicUrl) {
    throw new Error('publicUrl is required when OAuth is enabled: the OAuth issuer is the public URL of this server.');
  }
  return {
    formatVersion: MCP_OAUTH_SETTINGS_FORMAT_VERSION,
    enabled: input.enabled,
    publicUrl: publicUrl ? validateOauthPublicUrl(publicUrl) : '',
  };
}

type CachedSettings = { mtimeMs: number; read: McpOauthSettingsRead };
const settingsCache = new Map<string, CachedSettings>();

/**
 * The settings read for resolution, cached by file mtime so Console writes are
 * picked up without a restart. A missing file is 'missing'; an unreadable or
 * malformed one is 'invalid' and fails closed downstream.
 */
export function readMcpOauthSettings(settingsFile: string): McpOauthSettingsRead {
  let mtimeMs = 0;
  try {
    mtimeMs = statSync(settingsFile).mtimeMs;
  } catch {
    const read: McpOauthSettingsRead = { state: 'missing', settings: null };
    settingsCache.set(settingsFile, { mtimeMs: 0, read });
    return read;
  }
  const cached = settingsCache.get(settingsFile);
  if (cached && cached.mtimeMs === mtimeMs) return cached.read;
  let read: McpOauthSettingsRead;
  try {
    read = { state: 'ok', settings: settingsSchema.parse(JSON.parse(readFileSync(settingsFile, 'utf8'))) };
  } catch {
    read = { state: 'invalid', settings: null };
  }
  settingsCache.set(settingsFile, { mtimeMs, read });
  return read;
}

/** Atomically write validated settings; the write is the only mutation. */
export async function writeMcpOauthSettings(settingsFile: string, input: McpOauthSettingsInput): Promise<McpOauthSettings> {
  const settings = normalizeMcpOauthSettings(input);
  await mkdir(path.dirname(settingsFile), { recursive: true, mode: 0o700 });
  const temporary = `${settingsFile}.tmp`;
  await writeFile(temporary, `${JSON.stringify(settings, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
  await rename(temporary, settingsFile);
  return settings;
}
