import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  defaultBearerTokenPath,
  disableBearerToken,
  ensureBearerToken,
  loadBearerToken,
  parseServeCliOptions,
  readBearerToken,
  SERVE_USAGE,
} from '../src/interfaces/http/cli-options.js';

describe('parseServeCliOptions', () => {
  it('uses local-only defaults', () => {
    expect(parseServeCliOptions([])).toEqual({
      home: undefined, host: '127.0.0.1', port: 8787, allowedOrigins: [], authTokenFile: undefined, help: false,
    });
  });

  it('accepts server and browser options', () => {
    expect(parseServeCliOptions([
      '--home', '/tmp/catence', '--host=0.0.0.0', '--port', '9000', '--allow-origin', 'http://127.0.0.1:8000', '--allow-origin=http://localhost:8000',
    ])).toEqual({
      home: '/tmp/catence', host: '0.0.0.0', port: 9000, allowedOrigins: ['http://127.0.0.1:8000', 'http://localhost:8000'],
      authTokenFile: undefined, help: false,
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

  it('shows serve-specific help', () => {
    expect(parseServeCliOptions(['--help']).help).toBe(true);
    expect(SERVE_USAGE).toContain('Streamable HTTP');
    expect(SERVE_USAGE).toContain('--auth-token-file');
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
