import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  defaultBearerTokenPath,
  defaultMcpKeysPath,
  defaultOauthSettingsPath,
  disableBearerToken,
  ensureBearerToken,
  loadBearerToken,
  oauthEnabledFromEnv,
  oauthStatusFromEnv,
  oauthStatusFromSettings,
  parseServeCliOptions,
  readBearerToken,
  SERVE_USAGE,
} from '../src/interfaces/http/cli-options.js';

describe('parseServeCliOptions', () => {
  it('uses local-only defaults', () => {
    expect(parseServeCliOptions([])).toEqual({
      home: undefined, host: '127.0.0.1', port: 8787, allowedOrigins: [], authTokenFile: undefined, mcpKeysFile: undefined,
      oauth: false, publicUrl: undefined, help: false,
    });
  });

  it('accepts server and browser options', () => {
    expect(parseServeCliOptions([
      '--home', '/tmp/catence', '--host=0.0.0.0', '--port', '9000', '--allow-origin', 'http://127.0.0.1:8000', '--allow-origin=http://localhost:8000',
    ])).toEqual({
      home: '/tmp/catence', host: '0.0.0.0', port: 9000, allowedOrigins: ['http://127.0.0.1:8000', 'http://localhost:8000'],
      authTokenFile: undefined, mcpKeysFile: undefined, oauth: false, publicUrl: undefined, help: false,
    });
  });

  it('rejects invalid ports and unknown options', () => {
    expect(() => parseServeCliOptions(['--port', '0'])).toThrow('between 1 and 65535');
    expect(() => parseServeCliOptions(['--nope'])).toThrow('Unknown option: --nope');
  });

  it('parses the auth token file flag in both forms', () => {
    expect(parseServeCliOptions(['--auth-token-file', '/secrets/token'])).toMatchObject({ authTokenFile: '/secrets/token' });
    expect(parseServeCliOptions(['--auth-token-file=/secrets/token'])).toMatchObject({ authTokenFile: '/secrets/token' });
  });

  it('reads CATENCE_MCP_TOKEN_FILE by default and requires a value', () => {
    process.env.CATENCE_MCP_TOKEN_FILE = '/env/token';
    try {
      expect(parseServeCliOptions([])).toMatchObject({ authTokenFile: '/env/token' });
    } finally {
      delete process.env.CATENCE_MCP_TOKEN_FILE;
    }
    expect(() => parseServeCliOptions(['--auth-token-file'])).toThrow('requires a value');
  });

  it('parses the MCP keys file flag in both forms', () => {
    expect(parseServeCliOptions(['--mcp-keys-file', '/secrets/keys'])).toMatchObject({ mcpKeysFile: '/secrets/keys' });
    expect(parseServeCliOptions(['--mcp-keys-file=/secrets/keys'])).toMatchObject({ mcpKeysFile: '/secrets/keys' });
    expect(() => parseServeCliOptions(['--mcp-keys-file'])).toThrow('requires a value');
  });

  it('reads CATENCE_MCP_KEYS_FILE by default', () => {
    process.env.CATENCE_MCP_KEYS_FILE = '/env/keys';
    try {
      expect(parseServeCliOptions([])).toMatchObject({ mcpKeysFile: '/env/keys' });
    } finally {
      delete process.env.CATENCE_MCP_KEYS_FILE;
    }
  });

  it('parses the OAuth flags in both forms and requires https public URLs', () => {
    expect(parseServeCliOptions(['--oauth', '--public-url', 'https://catence.example.com'])).toMatchObject({
      oauth: true, publicUrl: 'https://catence.example.com',
    });
    expect(parseServeCliOptions(['--oauth', '--public-url=https://catence.example.com/tunnel/'])).toMatchObject({
      oauth: true, publicUrl: 'https://catence.example.com/tunnel',
    });
    // --public-url alone does not enable the OAuth server.
    expect(parseServeCliOptions(['--public-url', 'https://catence.example.com'])).toMatchObject({
      oauth: false, publicUrl: 'https://catence.example.com',
    });
    expect(() => parseServeCliOptions(['--public-url'])).toThrow('requires a value');
  });

  it('validates the public URL: https only, no query or fragment', () => {
    expect(() => parseServeCliOptions(['--oauth', '--public-url', 'http://catence.example.com'])).toThrow('must use https:');
    expect(() => parseServeCliOptions(['--oauth', '--public-url', 'https://catence.example.com/?x=1'])).toThrow('must not contain a query string or fragment');
    expect(() => parseServeCliOptions(['--oauth', '--public-url', 'https://catence.example.com/#frag'])).toThrow('must not contain a query string or fragment');
    expect(() => parseServeCliOptions(['--oauth', '--public-url', 'not-a-url'])).toThrow('must be a valid absolute URL');
  });

  it('refuses to enable OAuth without a public URL', () => {
    expect(() => parseServeCliOptions(['--oauth'])).toThrow('--oauth requires --public-url');
  });

  it('reads CATENCE_OAUTH_ENABLED and CATENCE_PUBLIC_URL by default', () => {
    process.env.CATENCE_OAUTH_ENABLED = 'true';
    process.env.CATENCE_PUBLIC_URL = 'https://catence.example.com';
    try {
      expect(parseServeCliOptions([])).toMatchObject({ oauth: true, publicUrl: 'https://catence.example.com' });
      // A CLI --public-url wins over the environment.
      expect(parseServeCliOptions(['--public-url', 'https://other.example.com'])).toMatchObject({ publicUrl: 'https://other.example.com' });
    } finally {
      delete process.env.CATENCE_OAUTH_ENABLED;
      delete process.env.CATENCE_PUBLIC_URL;
    }
    // CATENCE_OAUTH_ENABLED=0/false does not enable OAuth.
    process.env.CATENCE_OAUTH_ENABLED = '0';
    try {
      expect(parseServeCliOptions([])).toMatchObject({ oauth: false });
    } finally {
      delete process.env.CATENCE_OAUTH_ENABLED;
    }
  });

  it('parses the OAuth settings file flag in both forms', () => {
    expect(parseServeCliOptions(['--oauth-settings-file', '/secrets/oauth-settings.json'])).toMatchObject({ oauthSettingsFile: '/secrets/oauth-settings.json' });
    expect(parseServeCliOptions(['--oauth-settings-file=/secrets/oauth-settings.json'])).toMatchObject({ oauthSettingsFile: '/secrets/oauth-settings.json' });
    expect(() => parseServeCliOptions(['--oauth-settings-file'])).toThrow('requires a value');
  });

  it('reads CATENCE_OAUTH_SETTINGS_FILE by default', () => {
    process.env.CATENCE_OAUTH_SETTINGS_FILE = '/env/oauth-settings.json';
    try {
      expect(parseServeCliOptions([])).toMatchObject({ oauthSettingsFile: '/env/oauth-settings.json' });
    } finally {
      delete process.env.CATENCE_OAUTH_SETTINGS_FILE;
    }
  });

  it('shows serve-specific help', () => {
    expect(parseServeCliOptions(['--help']).help).toBe(true);
    expect(SERVE_USAGE).toContain('Streamable HTTP');
    expect(SERVE_USAGE).toContain('--auth-token-file');
    expect(SERVE_USAGE).toContain('--mcp-keys-file');
    expect(SERVE_USAGE).toContain('--oauth');
    expect(SERVE_USAGE).toContain('--public-url');
    expect(SERVE_USAGE).toContain('--oauth-settings-file');
  });
});

describe('oauth status helpers', () => {
  it('reads the OAuth exposure reported by mcp status from the environment', () => {
    expect(oauthEnabledFromEnv({})).toBe(false);
    expect(oauthEnabledFromEnv({ CATENCE_OAUTH_ENABLED: '1' })).toBe(true);
    expect(oauthEnabledFromEnv({ CATENCE_OAUTH_ENABLED: 'true' })).toBe(true);
    expect(oauthEnabledFromEnv({ CATENCE_OAUTH_ENABLED: 'yes' })).toBe(false);
    expect(oauthStatusFromEnv({})).toEqual({ enabled: false });
    expect(oauthStatusFromEnv({ CATENCE_OAUTH_ENABLED: '1', CATENCE_PUBLIC_URL: 'https://catence.example.com' })).toEqual({
      enabled: true, publicUrl: 'https://catence.example.com',
    });
  });

  it('resolves the effective OAuth exposure from the Console settings file over the environment', () => {
    const directory = mkdtempSync(path.join(tmpdir(), 'catence-oauth-status-'));
    const settingsFile = path.join(directory, 'settings.json');
    const env = { CATENCE_OAUTH_ENABLED: '1', CATENCE_PUBLIC_URL: 'https://env.example.com' };

    // No file: the environment governs.
    expect(oauthStatusFromSettings(settingsFile, env)).toEqual({ enabled: true, publicUrl: 'https://env.example.com', source: 'environment' });
    expect(oauthStatusFromSettings(settingsFile, {})).toEqual({ enabled: false, source: 'disabled' });

    // A valid file governs, even when it disables what the environment enabled.
    writeFileSync(settingsFile, JSON.stringify({ formatVersion: 1, enabled: false, publicUrl: 'https://console.example.com' }));
    expect(oauthStatusFromSettings(settingsFile, env)).toEqual({ enabled: false, publicUrl: 'https://console.example.com', source: 'console' });
    writeFileSync(settingsFile, JSON.stringify({ formatVersion: 1, enabled: true, publicUrl: 'https://console.example.com' }));
    expect(oauthStatusFromSettings(settingsFile, {})).toEqual({ enabled: true, publicUrl: 'https://console.example.com', source: 'console' });

    // A malformed file fails closed to disabled, overriding the environment.
    writeFileSync(settingsFile, '{');
    expect(oauthStatusFromSettings(settingsFile, env)).toEqual({ enabled: false, source: 'disabled' });

    // An enabled record without a public URL is semantically invalid.
    writeFileSync(settingsFile, JSON.stringify({ formatVersion: 1, enabled: true, publicUrl: '' }));
    expect(oauthStatusFromSettings(settingsFile, {})).toEqual({ enabled: false, source: 'disabled' });

    rmSync(directory, { recursive: true, force: true });
  });
});

describe('loadBearerToken', () => {
  it('trims the token and rejects empty or missing files', () => {
    const directory = mkdtempSync(path.join(tmpdir(), 'catence-token-'));
    const filePath = path.join(directory, 'token');
    writeFileSync(filePath, '  abc123  \n');
    expect(loadBearerToken(filePath)).toBe('abc123');
    writeFileSync(filePath, '   \n');
    expect(() => loadBearerToken(filePath)).toThrow('is empty');
    expect(() => loadBearerToken(path.join(directory, 'missing'))).toThrow('Cannot read the auth token file');
  });
});

describe('bearer-token lifecycle', () => {
  it('generates a 0600 token once, reuses it, and disable removes it', () => {
    const directory = mkdtempSync(path.join(tmpdir(), 'catence-exposure-'));
    const filePath = defaultBearerTokenPath(directory);
    expect(filePath).toBe(path.join(directory, 'mcp-token'));
    expect(readBearerToken(filePath)).toBeNull();

    const generated = ensureBearerToken(filePath);
    expect(generated).toMatch(/^[0-9a-f]{64}$/);
    expect(readBearerToken(filePath)).toBe(generated);
    expect(ensureBearerToken(filePath)).toBe(generated);

    disableBearerToken(filePath);
    expect(readBearerToken(filePath)).toBeNull();
    disableBearerToken(filePath); // idempotent
    rmSync(directory, { recursive: true, force: true });
  });
});

describe('defaultMcpKeysPath', () => {
  it('places the key registry next to the bearer token in the catalog home', () => {
    expect(defaultMcpKeysPath('/tmp/catence')).toBe('/tmp/catence/mcp-keys.json');
    expect(defaultMcpKeysPath('/tmp/catence/')).toBe('/tmp/catence/mcp-keys.json');
    expect(defaultMcpKeysPath('/tmp/catence')).not.toBe(defaultBearerTokenPath('/tmp/catence'));
  });
});

describe('defaultOauthSettingsPath', () => {
  it('places the OAuth settings under the catalog home oauth directory', () => {
    expect(defaultOauthSettingsPath('/tmp/catence')).toBe('/tmp/catence/oauth/settings.json');
    expect(defaultOauthSettingsPath('/tmp/catence/')).toBe('/tmp/catence/oauth/settings.json');
  });
});
