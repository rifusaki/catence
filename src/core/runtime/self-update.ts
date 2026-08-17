/**
 * Self-update support for the Catence runtime and its Console.
 *
 * The runtime tracks npm dist-tags on the `catence` package; the Console
 * tracks PEP 440 releases on PyPI (`catence-console`). A release is "newer"
 * only when it strictly dominates the installed version inside the tracked
 * channel: `stable` for non-prerelease installs, or the beta prerelease
 * channel for beta installs. Channel names match npm dist-tags, so a beta
 * runtime consults the `beta` tag and an explicit `--channel stable` moves a
 * beta install onto the `latest` tag.
 */
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

export type UpdateChannel = 'stable' | 'beta';

export type ParsedRelease = {
  major: number;
  minor: number;
  patch: number;
  /** Present only for prerelease builds; a stable release beats every beta of the same tuple. */
  beta?: number;
};

export type SelfUpdatePlan = {
  channel: UpdateChannel;
  runtime: { current: string; target?: string; updateAvailable: boolean };
  console: { installed?: string; target?: string; updateAvailable: boolean };
  /** True when neither component has anything to apply. */
  ok: boolean;
};

const NPM_VERSION = /^(\d+)\.(\d+)\.(\d+)(?:-beta\.(\d+))?$/;
const PEP440_BETA = /^(\d+)\.(\d+)\.(\d+)b(\d+)$/;

export function parseReleaseVersion(version: string): ParsedRelease | null {
  const npm = NPM_VERSION.exec(version.trim());
  if (npm) {
    return {
      major: Number(npm[1]),
      minor: Number(npm[2]),
      patch: Number(npm[3]),
      beta: npm[4] === undefined ? undefined : Number(npm[4]),
    };
  }
  const pep440 = PEP440_BETA.exec(version.trim());
  if (pep440) {
    return { major: Number(pep440[1]), minor: Number(pep440[2]), patch: Number(pep440[3]), beta: Number(pep440[4]) };
  }
  return null;
}

export function compareReleaseVersions(left: ParsedRelease, right: ParsedRelease): -1 | 0 | 1 {
  for (const field of ['major', 'minor', 'patch'] as const) {
    if (left[field] !== right[field]) return left[field] < right[field] ? -1 : 1;
  }
  const leftBeta = left.beta ?? Number.POSITIVE_INFINITY;
  const rightBeta = right.beta ?? Number.POSITIVE_INFINITY;
  if (leftBeta === rightBeta) return 0;
  return leftBeta < rightBeta ? -1 : 1;
}

export function channelForVersion(version: string): UpdateChannel {
  return parseReleaseVersion(version)?.beta !== undefined ? 'beta' : 'stable';
}

export function latestRelease(versions: string[], channel: UpdateChannel): string | undefined {
  let best: { version: string; parsed: ParsedRelease } | undefined;
  for (const version of versions) {
    const parsed = parseReleaseVersion(version);
    if (!parsed) continue;
    const isBeta = parsed.beta !== undefined;
    if (channel === 'beta' ? !isBeta : isBeta) continue;
    if (!best || compareReleaseVersions(parsed, best.parsed) > 0) best = { version, parsed };
  }
  return best?.version;
}

export function planSelfUpdate(options: {
  runtimeVersion: string;
  channel: UpdateChannel;
  npmDistTags: Record<string, string>;
  pypiReleases: string[];
  consoleInstalled?: string;
}): SelfUpdatePlan {
  const distTag = options.channel === 'beta' ? 'beta' : 'latest';
  const runtimeTarget = options.npmDistTags[distTag];
  const consoleTarget = latestRelease(options.pypiReleases, options.channel);
  const runtimeUpdateAvailable = isNewer(runtimeTarget, parseReleaseVersion(options.runtimeVersion));
  const consoleUpdateAvailable = options.consoleInstalled
    ? isNewer(consoleTarget, parseReleaseVersion(options.consoleInstalled))
    : consoleTarget !== undefined;
  return {
    channel: options.channel,
    runtime: { current: options.runtimeVersion, target: runtimeTarget, updateAvailable: runtimeUpdateAvailable },
    console: { installed: options.consoleInstalled, target: consoleTarget, updateAvailable: consoleUpdateAvailable },
    ok: !runtimeUpdateAvailable && !consoleUpdateAvailable,
  };
}

function isNewer(target: string | undefined, current: ParsedRelease | null): boolean {
  if (!target || !current) return false;
  const parsed = parseReleaseVersion(target);
  return parsed !== null && compareReleaseVersions(parsed, current) > 0;
}

export async function fetchNpmDistTags(packageName: string, fetchImpl: typeof fetch = fetch): Promise<Record<string, string>> {
  const response = await fetchImpl(`https://registry.npmjs.org/${packageName}`);
  if (!response.ok) throw new Error(`npm registry returned HTTP ${response.status} for ${packageName}.`);
  const payload = (await response.json()) as { 'dist-tags'?: Record<string, string> };
  return payload['dist-tags'] ?? {};
}

export async function fetchPypiReleases(packageName: string, fetchImpl: typeof fetch = fetch): Promise<string[]> {
  const response = await fetchImpl(`https://pypi.org/pypi/${packageName}/json`);
  if (!response.ok) throw new Error(`PyPI returned HTTP ${response.status} for ${packageName}.`);
  const payload = (await response.json()) as { releases?: Record<string, unknown> };
  return Object.keys(payload.releases ?? {});
}

/** Run an update command (npm or uv) with the user's terminal attached. */
export function runSelfUpdateCommand(command: string, args: string[]): Promise<number> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: 'inherit' });
    child.once('error', reject);
    child.once('close', (code) => resolve(code ?? 1));
  });
}

export function hasCommand(command: string): Promise<boolean> {
  return new Promise((resolve) => {
    const child = spawn(command, ['--version'], { stdio: 'ignore' });
    child.once('error', () => resolve(false));
    child.once('close', (code) => resolve(code === 0));
  });
}

/** Read `catence-console --version` from PATH; undefined when the Console is not installed. */
export function readInstalledConsoleVersion(): Promise<string | undefined> {
  return new Promise((resolve) => {
    const child = spawn('catence-console', ['--version'], { stdio: ['ignore', 'pipe', 'inherit'] });
    let stdout = '';
    child.stdout?.on('data', (chunk: Buffer) => (stdout += chunk.toString('utf8')));
    child.once('error', () => resolve(undefined));
    child.once('close', (code) => {
      const match = /^catence-console (\S+)/.exec(stdout.trim());
      resolve(code === 0 && match ? match[1] : undefined);
    });
  });
}

/** Global npm package root, used to decide whether `catence` can update itself in place. */
export function npmGlobalPrefix(): Promise<string | undefined> {
  return new Promise((resolve) => {
    const child = spawn('npm', ['prefix', '-g'], { stdio: ['ignore', 'pipe', 'inherit'] });
    let stdout = '';
    child.stdout?.on('data', (chunk: Buffer) => (stdout += chunk.toString('utf8')));
    child.once('error', () => resolve(undefined));
    child.once('close', (code) => resolve(code === 0 ? stdout.trim() : undefined));
  });
}

export function isGlobalNpmInstall(moduleUrl: string, npmPrefix: string | undefined): boolean {
  if (!npmPrefix) return false;
  return fileURLToPath(moduleUrl).startsWith(`${npmPrefix}/lib/node_modules/`);
}