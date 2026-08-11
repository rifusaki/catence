import { cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';

const root = process.cwd();
const stage = path.join(root, '.mcpb-stage');

async function readJson(relativePath) {
  return JSON.parse(await readFile(path.join(root, relativePath), 'utf8'));
}

async function checkVersions() {
  const packageJson = await readJson('package.json');
  const manifest = await readJson('mcpb/manifest.json');
  const apm = await readFile(path.join(root, 'apm.yml'), 'utf8');
  const version = packageJson.version;
  if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.test(version)) throw new Error(`package.json version is not valid semver: ${version}`);
  if (manifest.version !== version) throw new Error(`mcpb/manifest.json version ${manifest.version} must equal package.json version ${version}.`);
  if (!new RegExp(`^version:\\s*${version.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*$`, 'm').test(apm)) throw new Error(`apm.yml version must equal package.json version ${version}.`);
  if (!apm.includes(`catence@${version}`)) throw new Error(`apm.yml must pin its Catence MCP commands to catence@${version}.`);
  const tag = process.env.GITHUB_REF_NAME;
  if (tag && process.env.GITHUB_REF_TYPE === 'tag' && tag !== `v${version}`) throw new Error(`Release tag ${tag} must equal v${version}.`);
  return { packageJson, manifest, version };
}

function copyFilter(source) {
  return !source.includes('__pycache__') && !source.endsWith('.pyc') && !source.includes(`${path.sep}python${path.sep}tests${path.sep}`);
}

async function prepareMcpb() {
  const { packageJson, manifest, version } = await checkVersions();
  await rm(stage, { recursive: true, force: true });
  await mkdir(stage, { recursive: true });
  for (const relativePath of ['dist', 'python', 'README.md', 'LICENSE', 'package.json', 'package-lock.json', 'pyproject.toml', 'uv.lock']) {
    await cp(path.join(root, relativePath), path.join(stage, relativePath), { recursive: true, filter: copyFilter });
  }
  const platformManifest = {
    ...manifest,
    version,
    compatibility: { ...manifest.compatibility, platforms: [process.platform] },
  };
  await writeFile(path.join(stage, 'manifest.json'), `${JSON.stringify(platformManifest, null, 2)}\n`);
  return { stage, version, platform: process.platform, architecture: process.arch, packageName: packageJson.name };
}

const command = process.argv[2];
if (command === 'check') {
  const { version } = await checkVersions();
  process.stdout.write(`Release artifacts agree on version ${version}.\n`);
} else if (command === 'prepare-mcpb') {
  const result = await prepareMcpb();
  process.stdout.write(`${JSON.stringify(result)}\n`);
} else {
  throw new Error('Usage: node scripts/release-artifacts.mjs <check|prepare-mcpb>');
}
