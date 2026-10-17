import { mkdir, mkdtemp, readFile, readdir, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  normalizeMcpOauthSettings,
  readMcpOauthSettings,
  validateOauthPublicUrl,
  writeMcpOauthSettings,
} from '../src/runtime/index.js';

async function temporarySettingsFile(): Promise<string> {
  const directory = await mkdtemp(path.join(tmpdir(), 'catence-oauth-settings-'));
  return path.join(directory, 'oauth', 'settings.json');
}

describe('validateOauthPublicUrl', () => {
  it('accepts an absolute https URL and strips trailing slashes', () => {
    expect(validateOauthPublicUrl('https://catence.example.com')).toBe('https://catence.example.com');
    expect(validateOauthPublicUrl('https://catence.example.com/')).toBe('https://catence.example.com');
    expect(validateOauthPublicUrl('https://catence.example.com/mcp/')).toBe('https://catence.example.com/mcp');
  });

  it('rejects non-https URLs, relative URLs, and query strings or fragments', () => {
    expect(() => validateOauthPublicUrl('http://catence.example.com')).toThrow('must use https:');
    expect(() => validateOauthPublicUrl('catence.example.com')).toThrow('must be a valid absolute URL.');
    expect(() => validateOauthPublicUrl('https://catence.example.com?x=1')).toThrow('must not contain a query string or fragment.');
    expect(() => validateOauthPublicUrl('https://catence.example.com#top')).toThrow('must not contain a query string or fragment.');
  });
});

describe('normalizeMcpOauthSettings', () => {
  it('requires a public URL when enabling and normalizes it', () => {
    expect(normalizeMcpOauthSettings({ enabled: true, publicUrl: 'https://catence.example.com/' })).toEqual({
      formatVersion: 1,
      enabled: true,
      publicUrl: 'https://catence.example.com',
    });
    expect(() => normalizeMcpOauthSettings({ enabled: true })).toThrow('publicUrl is required when OAuth is enabled');
    expect(() => normalizeMcpOauthSettings({ enabled: true, publicUrl: '  ' })).toThrow('publicUrl is required when OAuth is enabled');
  });

  it('keeps the URL when disabling but still validates a non-empty one', () => {
    expect(normalizeMcpOauthSettings({ enabled: false, publicUrl: 'https://catence.example.com' })).toEqual({
      formatVersion: 1,
      enabled: false,
      publicUrl: 'https://catence.example.com',
    });
    expect(normalizeMcpOauthSettings({ enabled: false })).toEqual({ formatVersion: 1, enabled: false, publicUrl: '' });
    expect(() => normalizeMcpOauthSettings({ enabled: false, publicUrl: 'http://catence.example.com' })).toThrow('must use https:');
  });
});

describe('MCP OAuth settings store', () => {
  it('writes validated settings atomically (0600, no tmp files) and reads them back', async () => {
    const settingsFile = await temporarySettingsFile();
    const written = await writeMcpOauthSettings(settingsFile, { enabled: true, publicUrl: 'https://catence.example.com/' });
    expect(written).toEqual({ formatVersion: 1, enabled: true, publicUrl: 'https://catence.example.com' });
    expect((await stat(settingsFile)).mode & 0o777).toBe(0o600);
    expect((await readdir(path.dirname(settingsFile))).filter((entry) => entry.endsWith('.tmp'))).toEqual([]);
    expect(readMcpOauthSettings(settingsFile)).toEqual({ state: 'ok', settings: written });
  });

  it('reports a missing file as missing', async () => {
    const settingsFile = await temporarySettingsFile();
    expect(readMcpOauthSettings(settingsFile)).toEqual({ state: 'missing', settings: null });
  });

  it('fails closed (invalid) for malformed, mistyped, or wrong-version files', async () => {
    const settingsFile = await temporarySettingsFile();
    await mkdir(path.dirname(settingsFile), { recursive: true });
    await writeFile(settingsFile, 'not json', 'utf8');
    expect(readMcpOauthSettings(settingsFile).state).toBe('invalid');

    await writeFile(settingsFile, JSON.stringify({ formatVersion: 1, enabled: 'yes', publicUrl: '' }), 'utf8');
    expect(readMcpOauthSettings(settingsFile).state).toBe('invalid');

    await writeFile(settingsFile, JSON.stringify({ formatVersion: 2, enabled: true, publicUrl: 'https://catence.example.com' }), 'utf8');
    expect(readMcpOauthSettings(settingsFile).state).toBe('invalid');

    // The strict schema rejects unknown fields too.
    await writeFile(settingsFile, JSON.stringify({ formatVersion: 1, enabled: true, publicUrl: 'https://catence.example.com', extra: 1 }), 'utf8');
    expect(readMcpOauthSettings(settingsFile).state).toBe('invalid');
  });

  it('picks up Console writes without a restart (mtime cache)', async () => {
    const settingsFile = await temporarySettingsFile();
    expect(readMcpOauthSettings(settingsFile).state).toBe('missing');
    await writeMcpOauthSettings(settingsFile, { enabled: true, publicUrl: 'https://catence.example.com' });
    expect(readMcpOauthSettings(settingsFile)).toEqual({
      state: 'ok',
      settings: { formatVersion: 1, enabled: true, publicUrl: 'https://catence.example.com' },
    });
    await writeMcpOauthSettings(settingsFile, { enabled: false, publicUrl: 'https://catence.example.com' });
    expect(readMcpOauthSettings(settingsFile)).toEqual({
      state: 'ok',
      settings: { formatVersion: 1, enabled: false, publicUrl: 'https://catence.example.com' },
    });
    // A tampered file flips to invalid and stays disabled downstream.
    await writeFile(settingsFile, '{', 'utf8');
    expect(readMcpOauthSettings(settingsFile).state).toBe('invalid');
  });

  it('stores the raw JSON shape the Console and runtime agree on', async () => {
    const settingsFile = await temporarySettingsFile();
    await writeMcpOauthSettings(settingsFile, { enabled: false });
    const stored = JSON.parse(await readFile(settingsFile, 'utf8')) as Record<string, unknown>;
    expect(stored).toEqual({ formatVersion: 1, enabled: false, publicUrl: '' });
  });
});
