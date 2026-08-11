import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';

const root = process.cwd();
const interfaces = path.join(root, 'src', 'interfaces');
const forbidden = ["../../core/", "../../elt/", "../core/", "../elt/"];

async function files(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const nested = await Promise.all(entries.map(async (entry) => entry.isDirectory()
    ? files(path.join(directory, entry.name))
    : entry.name.endsWith('.ts') ? [path.join(directory, entry.name)] : []));
  return nested.flat();
}

const violations = [];
for (const file of await files(interfaces)) {
  const relative = path.relative(root, file);
  const source = await readFile(file, 'utf8');
  for (const value of forbidden) {
    if (source.includes(value)) violations.push(`${relative} imports implementation path ${value}; import through src/runtime/index.ts instead.`);
  }
}

if (violations.length) throw new Error(`Runtime boundary violations:\n${violations.join('\n')}`);
