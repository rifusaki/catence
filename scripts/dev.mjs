#!/usr/bin/env node
// Run the local Catence runtime (HTTP MCP server) and the Console together
// in one terminal session for local testing.
//
// Unlike `catence-console serve` on its own — which spawns the *installed*
// `catence` runtime (or `npx catence@<release>`) — this script serves the
// *working-tree* runtime via tsx, so uncommitted src/ changes are live.
// The Console is pointed at it with --mcp-url, which makes the Console skip
// spawning its own runtime and just wait for /health instead.
//
// Usage:
//   npm run dev [-- --home <dir> --mcp-port <port> --ui-port <port>]
//   npm run dev -- --help
//
// Ports/hosts mirror `catence-console serve` defaults (127.0.0.1:8787 for
// the runtime, 127.0.0.1:8000 for the UI). Ctrl-C stops both processes.

import { spawn } from 'node:child_process';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const USAGE = `Usage: npm run dev [-- --home <dir> --mcp-host <host> --mcp-port <port> --ui-host <host> --ui-port <port>]

Run the working-tree Catence runtime and the Console in one terminal.

Options:
  --home <directory>   Catence catalog home. Defaults to CATENCE_HOME or ~/.catence.
  --mcp-host <host>    Runtime listener host. Defaults to 127.0.0.1.
  --mcp-port <port>    Runtime listener port. Defaults to 8787.
  --ui-host <host>     Console listener host. Defaults to CATENCE_CONSOLE_HOST or 127.0.0.1.
  --ui-port <port>     Console listener port. Defaults to 8000.
  -h, --help           Show this help text.`;

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

function optionValue(args, index, option) {
  const value = args[index + 1];
  if (!value || value.startsWith('-')) throw new Error(`${option} requires a value.`);
  return value;
}

function parseArgs(args) {
  const options = {
    home: process.env.CATENCE_HOME,
    mcpHost: '127.0.0.1',
    mcpPort: '8787',
    uiHost: process.env.CATENCE_CONSOLE_HOST ?? '127.0.0.1',
    uiPort: '8000',
  };
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '-h' || arg === '--help') {
      process.stdout.write(`${USAGE}\n`);
      process.exit(0);
    } else if (arg === '--home') {
      options.home = optionValue(args, i, '--home');
      i++;
    } else if (arg.startsWith('--home=')) {
      options.home = arg.slice('--home='.length);
    } else if (arg === '--mcp-host') {
      options.mcpHost = optionValue(args, i, '--mcp-host');
      i++;
    } else if (arg.startsWith('--mcp-host=')) {
      options.mcpHost = arg.slice('--mcp-host='.length);
    } else if (arg === '--mcp-port') {
      options.mcpPort = optionValue(args, i, '--mcp-port');
      i++;
    } else if (arg.startsWith('--mcp-port=')) {
      options.mcpPort = arg.slice('--mcp-port='.length);
    } else if (arg === '--ui-host') {
      options.uiHost = optionValue(args, i, '--ui-host');
      i++;
    } else if (arg.startsWith('--ui-host=')) {
      options.uiHost = arg.slice('--ui-host='.length);
    } else if (arg === '--ui-port') {
      options.uiPort = optionValue(args, i, '--ui-port');
      i++;
    } else if (arg.startsWith('--ui-port=')) {
      options.uiPort = arg.slice('--ui-port='.length);
    } else {
      throw new Error(`Unknown option: ${arg}`);
    }
  }
  for (const port of [options.mcpPort, options.uiPort]) {
    if (!/^\d+$/.test(port) || Number(port) < 1 || Number(port) > 65535) {
      throw new Error(`Port must be an integer between 1 and 65535 (got ${port}).`);
    }
  }
  return options;
}

/** Prefix each output line so the two interleaved logs stay readable. */
function prefixStream(stream, label) {
  let pending = '';
  stream.on('data', (chunk) => {
    pending += chunk.toString('utf8');
    let newline;
    while ((newline = pending.indexOf('\n')) >= 0) {
      process.stdout.write(`${label} ${pending.slice(0, newline)}\n`);
      pending = pending.slice(newline + 1);
    }
  });
  stream.on('end', () => {
    if (pending.length > 0) process.stdout.write(`${label} ${pending}\n`);
  });
}

function waitForHealth(url, timeoutMs) {
  const started = Date.now();
  return new Promise((resolve, reject) => {
    const attempt = async () => {
      try {
        const response = await fetch(url);
        if (response.ok) {
          resolve();
          return;
        }
      } catch {
        // Server is not up yet; retry until the timeout.
      }
      if (Date.now() - started > timeoutMs) {
        reject(new Error(`Catence runtime did not pass ${url} within ${timeoutMs / 1000} seconds.`));
        return;
      }
      setTimeout(() => void attempt(), 250);
    };
    void attempt();
  });
}

let options;
try {
  options = parseArgs(process.argv.slice(2));
} catch (error) {
  process.stderr.write(`dev: ${error instanceof Error ? error.message : String(error)}\n\n${USAGE}\n`);
  process.exit(2);
}

const mcpUrl = `http://${options.mcpHost}:${options.mcpPort}/mcp`;
const children = new Set();
let shuttingDown = false;

function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  process.stderr.write(`\ndev: received ${signal}; stopping runtime and Console…\n`);
  for (const child of children) child.kill('SIGTERM');
  setTimeout(() => {
    for (const child of children) {
      if (child.exitCode === null) child.kill('SIGKILL');
    }
  }, 8000).unref();
}

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => shutdown(signal));
}

function launch(label, command, args, env) {
  const child = spawn(command, args, { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'] });
  children.add(child);
  if (child.stdout) prefixStream(child.stdout, label);
  if (child.stderr) prefixStream(child.stderr, label);
  child.on('error', (error) => {
    process.stderr.write(`dev: ${label} failed to start (${error.message}).\n`);
    process.exitCode = 1;
    shutdown('error');
  });
  child.on('exit', (code, signal) => {
    children.delete(child);
    if (shuttingDown) {
      if (children.size === 0) process.exit(process.exitCode ?? 0);
      return;
    }
    // One side exited first (crash or port conflict): stop the other so a
    // single Ctrl-C session never leaves an orphan behind.
    process.stderr.write(`dev: ${label} exited (${signal ?? `code ${code}`}); stopping the other process.\n`);
    process.exitCode = code ?? 1;
    shutdown('child exit');
  });
  return child;
}

const tsxBinary = path.join(root, 'node_modules', '.bin', 'tsx');
const runtimeArgs = [
  path.join(root, 'src', 'interfaces', 'mcp', 'main.ts'),
  'serve',
  '--host',
  options.mcpHost,
  '--port',
  options.mcpPort,
  '--allow-origin',
  `http://${options.uiHost === '0.0.0.0' ? '127.0.0.1' : options.uiHost}:${options.uiPort}`,
  '--allow-origin',
  `http://localhost:${options.uiPort}`,
];
if (options.home) runtimeArgs.push('--home', options.home);

launch('[mcp]', tsxBinary, runtimeArgs, process.env);

try {
  await waitForHealth(`http://${options.mcpHost}:${options.mcpPort}/health`, 30_000);
} catch (error) {
  process.stderr.write(`dev: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
  shutdown('health timeout');
  // Let the exit handler finish teardown; keep the event loop alive until then.
  await new Promise(() => undefined);
}

const consoleArgs = [
  'run',
  '--project',
  'console',
  'catence-console',
  'serve',
  '--mcp-url',
  mcpUrl,
  '--ui-host',
  options.uiHost,
  '--ui-port',
  options.uiPort,
];
if (options.home) consoleArgs.push('--home', options.home);

launch('[console]', 'uv', consoleArgs, process.env);
process.stdout.write(`dev: runtime healthy; Console starting (UI http://${options.uiHost}:${options.uiPort}, MCP ${mcpUrl}).\n`);
