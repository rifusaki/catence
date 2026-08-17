import { describe, expect, it } from 'vitest';
import {
  channelForVersion,
  compareReleaseVersions,
  isGlobalNpmInstall,
  latestRelease,
  parseReleaseVersion,
  planSelfUpdate,
} from '../../src/core/runtime/self-update.js';

describe('parseReleaseVersion', () => {
  it('parses npm and PEP 440 prerelease forms', () => {
    expect(parseReleaseVersion('0.2.0')).toEqual({ major: 0, minor: 2, patch: 0, beta: undefined });
    expect(parseReleaseVersion('0.2.0-beta.2')).toEqual({ major: 0, minor: 2, patch: 0, beta: 2 });
    expect(parseReleaseVersion('0.2.0b2')).toEqual({ major: 0, minor: 2, patch: 0, beta: 2 });
  });

  it('rejects unknown formats', () => {
    expect(parseReleaseVersion('latest')).toBeNull();
    expect(parseReleaseVersion('0.2.0-beta')).toBeNull();
    expect(parseReleaseVersion('v0.2.0')).toBeNull();
  });
});

describe('compareReleaseVersions', () => {
  const version = (value: string) => {
    const parsed = parseReleaseVersion(value);
    if (!parsed) throw new Error(`unexpected parse failure for ${value}`);
    return parsed;
  };

  it('orders a stable release after betas of the same tuple', () => {
    expect(compareReleaseVersions(version('0.2.0-beta.2'), version('0.2.0'))).toBe(-1);
    expect(compareReleaseVersions(version('0.2.0'), version('0.2.0-beta.2'))).toBe(1);
  });

  it('orders by major, minor, patch, then beta number', () => {
    expect(compareReleaseVersions(version('0.3.0b1'), version('0.2.0b9'))).toBe(1);
    expect(compareReleaseVersions(version('0.2.0-beta.3'), version('0.2.0-beta.2'))).toBe(1);
    expect(compareReleaseVersions(version('0.2.0b2'), version('0.2.0b2'))).toBe(0);
  });
});

describe('channelForVersion', () => {
  it('derives the beta channel from prerelease installs', () => {
    expect(channelForVersion('0.2.0-beta.2')).toBe('beta');
    expect(channelForVersion('0.2.0b2')).toBe('beta');
    expect(channelForVersion('0.2.0')).toBe('stable');
  });
});

describe('latestRelease', () => {
  const versions = ['0.1.0', '0.2.0b1', '0.2.0b2', '0.2.0'];

  it('picks the newest release of the matching channel', () => {
    expect(latestRelease(versions, 'stable')).toBe('0.2.0');
    expect(latestRelease(versions, 'beta')).toBe('0.2.0b2');
  });

  it('ignores unknown formats', () => {
    expect(latestRelease(['0.2.0b2', 'weird'], 'beta')).toBe('0.2.0b2');
  });

  it('returns undefined when the channel has no releases', () => {
    expect(latestRelease(['0.2.0'], 'beta')).toBeUndefined();
    expect(latestRelease(['0.2.0b2'], 'stable')).toBeUndefined();
  });
});

describe('planSelfUpdate', () => {
  it('reports updates when the channel has a newer runtime or Console', () => {
    const plan = planSelfUpdate({
      runtimeVersion: '0.2.0-beta.2',
      channel: 'beta',
      npmDistTags: { latest: '0.1.0', beta: '0.2.0-beta.3' },
      pypiReleases: ['0.2.0b2', '0.2.0b3'],
      consoleInstalled: '0.2.0b2',
    });
    expect(plan.runtime).toEqual({ current: '0.2.0-beta.2', target: '0.2.0-beta.3', updateAvailable: true });
    expect(plan.console).toEqual({ installed: '0.2.0b2', target: '0.2.0b3', updateAvailable: true });
    expect(plan.ok).toBe(false);
  });

  it('stays current when nothing newer is published', () => {
    const plan = planSelfUpdate({
      runtimeVersion: '0.2.0-beta.2',
      channel: 'beta',
      npmDistTags: { beta: '0.2.0-beta.2' },
      pypiReleases: ['0.2.0b2'],
      consoleInstalled: '0.2.0b2',
    });
    expect(plan.ok).toBe(true);
    expect(plan.runtime.updateAvailable).toBe(false);
    expect(plan.console.updateAvailable).toBe(false);
  });

  it('moves a beta install onto stable with an explicit stable channel', () => {
    const plan = planSelfUpdate({
      runtimeVersion: '0.2.0-beta.2',
      channel: 'stable',
      npmDistTags: { latest: '0.2.0', beta: '0.2.0-beta.3' },
      pypiReleases: ['0.2.0b3', '0.2.0'],
      consoleInstalled: '0.2.0b2',
    });
    expect(plan.runtime.target).toBe('0.2.0');
    expect(plan.console.target).toBe('0.2.0');
  });

  it('treats a missing Console install as needing the channel target', () => {
    const plan = planSelfUpdate({
      runtimeVersion: '0.2.0',
      channel: 'stable',
      npmDistTags: { latest: '0.2.0' },
      pypiReleases: ['0.1.0', '0.2.0'],
      consoleInstalled: undefined,
    });
    expect(plan.console.updateAvailable).toBe(true);
    expect(plan.runtime.updateAvailable).toBe(false);
    expect(plan.ok).toBe(false);
  });

  it('never downgrades within a channel', () => {
    const plan = planSelfUpdate({
      runtimeVersion: '0.2.0-beta.3',
      channel: 'beta',
      npmDistTags: { beta: '0.2.0-beta.2' },
      pypiReleases: ['0.2.0b2'],
      consoleInstalled: '0.2.0b3',
    });
    expect(plan.runtime.updateAvailable).toBe(false);
    expect(plan.console.updateAvailable).toBe(false);
    expect(plan.ok).toBe(true);
  });
});

describe('isGlobalNpmInstall', () => {
  it('accepts modules under the global npm lib directory', () => {
    expect(isGlobalNpmInstall('file:///usr/local/lib/node_modules/catence/dist/interfaces/cli/main.js', '/usr/local')).toBe(true);
  });

  it('rejects npx cache and checkout installs', () => {
    expect(isGlobalNpmInstall('file:///Users/me/.npm/_npx/a1b2/node_modules/catence/dist/interfaces/cli/main.js', '/usr/local')).toBe(false);
    expect(isGlobalNpmInstall('file:///Users/me/localRepos/catence/dist/interfaces/cli/main.js', '/usr/local')).toBe(false);
    expect(isGlobalNpmInstall('file:///usr/local/lib/node_modules/catence/dist/interfaces/cli/main.js', undefined)).toBe(false);
  });
});