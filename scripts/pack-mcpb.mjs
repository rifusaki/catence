import { spawnSync } from 'node:child_process';
import { mkdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';

const root = process.cwd();
const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
const cache = path.join(root, '.npm-cache');
const environment = { ...process.env, npm_config_cache: cache };

function run(arguments_) {
  const result = spawnSync(npm, arguments_, { cwd: root, env: environment, stdio: 'inherit' });
  if (result.status !== 0) throw new Error(`${npm} ${arguments_.join(' ')} failed with status ${result.status ?? 'unknown'}.`);
}

await mkdir(path.join(root, 'dist'), { recursive: true });
run(['run', 'mcpb:prepare']);
run(['ci', '--omit=dev', '--prefix', '.mcpb-stage']);
const packageJson = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));
const output = path.join('dist', `catence-demo-${packageJson.version}-${process.platform}-${process.arch}.mcpb`);
run(['exec', '--yes', '--package', '@anthropic-ai/mcpb', '--', 'mcpb', 'pack', '.mcpb-stage', output]);
process.stdout.write(`${output}\n`);
