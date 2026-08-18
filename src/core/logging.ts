import { appendFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import type { CatencePaths } from '../contracts/runtime.js';

export type SyncLogger = {
  info: (message: string, context?: Record<string, unknown>) => void;
  warn: (message: string, context?: Record<string, unknown>) => void;
  error: (message: string, context?: Record<string, unknown>) => void;
  debug: (message: string, context?: Record<string, unknown>) => void;
};

type Level = 'info' | 'warn' | 'error' | 'debug';

const LEVEL_WEIGHT: Record<Level, number> = { debug: 10, info: 20, warn: 30, error: 40 };

function configuredLevel(environment: NodeJS.ProcessEnv = process.env): number {
  const raw = (environment.CATENCE_LOG_LEVEL ?? 'info').toLowerCase();
  if (raw === 'debug') return LEVEL_WEIGHT.debug;
  if (raw === 'warn') return LEVEL_WEIGHT.warn;
  if (raw === 'error') return LEVEL_WEIGHT.error;
  return LEVEL_WEIGHT.info;
}

/**
 * Resolve the sync log file path.
 *
 * `CATENCE_LOG` may be an absolute path or a path relative to the catalog home.
 * When unset (the default), logs go to stderr only so the console stays clean
 * and stdout remains machine-readable for callers like sync.sh.
 */
export function resolveLogFile(paths: CatencePaths, environment: NodeJS.ProcessEnv = process.env): string | null {
  const configured = environment.CATENCE_LOG;
  if (!configured) return null;
  return path.isAbsolute(configured) ? configured : path.join(paths.root, configured);
}

export function createSyncLogger(paths: CatencePaths, environment: NodeJS.ProcessEnv = process.env): SyncLogger {
  const threshold = configuredLevel(environment);
  const logFile = resolveLogFile(paths, environment);

  const write = (level: Level, message: string, context?: Record<string, unknown>): void => {
    if (LEVEL_WEIGHT[level] < threshold) return;
    const line = formatLogLine(level, message, context);
    process.stderr.write(`${line}\n`);
    if (logFile) {
      // Fire-and-forget: never block a sync run on log persistence.
      appendLogLine(logFile, `${line}\n`).catch(() => {});
    }
  };

  return {
    info: (message, context) => write('info', message, context),
    warn: (message, context) => write('warn', message, context),
    error: (message, context) => write('error', message, context),
    debug: (message, context) => write('debug', message, context),
  };
}

function formatLogLine(level: Level, message: string, context?: Record<string, unknown>): string {
  const timestamp = new Date().toISOString();
  const tag = level.toUpperCase().padEnd(5);
  let line = `[${timestamp}] [${tag}] ${message}`;
  if (context && Object.keys(context).length > 0) {
    line += ` ${serializeContext(context)}`;
  }
  return line;
}

function serializeContext(context: Record<string, unknown>): string {
  try {
    return JSON.stringify(context);
  } catch {
    return '';
  }
}

let appendLogLine = async (file: string, line: string): Promise<void> => {
  await mkdir(path.dirname(file), { recursive: true });
  await appendFile(file, line, 'utf8');
};
