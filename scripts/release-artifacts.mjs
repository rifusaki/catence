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
  const release = await readJson('release/manifest.json');
  const manifest = await readJson('mcpb/manifest.json');
  const glama = await readJson('release/registries/glama.json');
  const apm = await readFile(path.join(root, 'apm.yml'), 'utf8');
  const consoleProject = await readFile(path.join(root, 'console/pyproject.toml'), 'utf8');
  const consoleRelease = await readFile(path.join(root, 'console/catence_console/release.py'), 'utf8');
  const runtimeContract = await readFile(path.join(root, 'src/contracts/release.ts'), 'utf8');
  const version = packageJson.version;
  if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.test(version)) throw new Error(`package.json version is not valid semver: ${version}`);
  if (release.version !== version) throw new Error(`release/manifest.json version ${release.version} must equal package.json version ${version}.`);
  if (!Number.isInteger(release.protocolVersion) || release.protocolVersion < 1) throw new Error('release/manifest.json protocolVersion must be a positive integer.');
  if (release.packages?.npm !== packageJson.name) throw new Error(`release/manifest.json npm package must equal ${packageJson.name}.`);
  if (packageJson.engines?.node !== release.node) throw new Error(`package.json Node engine must equal release/manifest.json (${release.node}).`);
  const consoleVersion = consoleProject.match(/^version\s*=\s*"([^"]+)"$/m)?.[1];
  const consolePython = consoleProject.match(/^requires-python\s*=\s*"([^"]+)"$/m)?.[1];
  if (release.packages?.console !== 'catence-console' || consoleVersion !== version) throw new Error(`console/pyproject.toml version must equal ${version}.`);
  if (consolePython !== release.python) throw new Error(`console/pyproject.toml Python range must equal release/manifest.json (${release.python}).`);
  if (!consoleProject.includes(`${release.packages.chainlit}==${version}`)) throw new Error(`console/pyproject.toml must pin ${release.packages.chainlit}==${version}.`);
  if (!consoleRelease.includes(`CATENCE_RELEASE_VERSION = "${version}"`)) throw new Error(`console runtime version must equal ${version}.`);
  if (!consoleRelease.includes(`CATENCE_PROTOCOL_VERSION = ${release.protocolVersion}`)) throw new Error('console protocol version must equal release/manifest.json.');
  if (manifest.version !== version) throw new Error(`mcpb/manifest.json version ${manifest.version} must equal package.json version ${version}.`);
  if (!new RegExp(`^version:\\s*${version.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*$`, 'm').test(apm)) throw new Error(`apm.yml version must equal package.json version ${version}.`);
  if (!apm.includes(`catence@${version}`)) throw new Error(`apm.yml must pin its Catence MCP commands to catence@${version}.`);
  if (glama.install?.args?.[1] !== `catence@${version}` || glama.demo?.args?.[1] !== `catence@${version}`) throw new Error(`release/registries/glama.json must pin Catence commands to ${version}.`);
  if (!runtimeContract.includes(`CATENCE_RUNTIME_VERSION = '${version}'`)) throw new Error(`src/contracts/release.ts runtime version must equal ${version}.`);
  if (!runtimeContract.includes(`CATENCE_PROTOCOL_VERSION = ${release.protocolVersion}`)) throw new Error(`src/contracts/release.ts protocol version must equal release/manifest.json.`);
  const tag = process.env.GITHUB_REF_NAME;
  if (tag && process.env.GITHUB_REF_TYPE === 'tag' && tag !== `v${version}`) throw new Error(`Release tag ${tag} must equal v${version}.`);
  return { packageJson, manifest, release, version };
}

function copyFilter(source) {
  return !source.includes('__pycache__') && !source.endsWith('.pyc') && !source.includes(`${path.sep}python${path.sep}tests${path.sep}`);
}

async function prepareMcpb() {
  const { packageJson, manifest, version } = await checkVersions();
  await rm(stage, { recursive: true, force: true });
  await mkdir(stage, { recursive: true });
  // MCPB is deliberately a credential-free generated-data experience. Live
  // provider workers remain in the npm runtime, not in this desktop bundle.
  for (const relativePath of ['dist', 'README.md', 'LICENSE', 'package.json', 'package-lock.json']) {
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
