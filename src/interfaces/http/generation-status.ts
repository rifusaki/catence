import { readFile } from 'node:fs/promises';
import path from 'node:path';

/**
 * Read + classify the generation progress sidecar written by the Catence
 * Console agent turn (see `catence_console/generation_sidecar.py`). Mirrors the
 * detached-sync sidecar logic: a run is "running" until it reaches a terminal
 * stage, and "stale" (i.e. likely stuck) when its heartbeat is older than the
 * threshold. This powers the chat UI's "still thinking vs stalled" signal.
 */

export interface GenerationStatus {
  threadId: string;
  stage?: string;
  running: boolean;
  stale: boolean;
  heartbeatAt?: string;
  startedAt?: string;
  updatedAt?: string;
  toolCallCount: number;
  lastTool?: string | null;
}

const TERMINAL_STAGES = new Set([
  'completed',
  'failed',
  'interrupted',
  'timed_out'
]);

const STALE_MS = 5 * 60 * 1000; // 5 minutes

function emptyStatus(threadId: string): GenerationStatus {
  return {
    threadId,
    running: false,
    stale: false,
    toolCallCount: 0
  };
}

export async function generationStatus(
  homeRoot: string,
  threadId: string
): Promise<GenerationStatus> {
  const safe = threadId.replace(/[^a-zA-Z0-9_-]/g, '');
  if (!safe) return emptyStatus(threadId);

  const file = path.join(homeRoot, 'generation', `${safe}.generation.json`);
  let raw: string;
  try {
    raw = await readFile(file, 'utf8');
  } catch {
    return emptyStatus(threadId);
  }

  let data: Record<string, unknown>;
  try {
    data = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return emptyStatus(threadId);
  }

  const base: Omit<GenerationStatus, 'running' | 'stale'> = {
    threadId,
    stage: typeof data.stage === 'string' ? data.stage : undefined,
    heartbeatAt: typeof data.heartbeatAt === 'string' ? data.heartbeatAt : undefined,
    startedAt: typeof data.startedAt === 'string' ? data.startedAt : undefined,
    updatedAt: typeof data.updatedAt === 'string' ? data.updatedAt : undefined,
    toolCallCount: typeof data.toolCallCount === 'number' ? data.toolCallCount : 0,
    lastTool:
      data.lastTool === null || typeof data.lastTool === 'string'
        ? (data.lastTool as string | null)
        : undefined
  };

  if (base.stage && TERMINAL_STAGES.has(base.stage)) {
    return { ...base, running: false, stale: false };
  }

  const hb = base.heartbeatAt ? Date.parse(base.heartbeatAt) : NaN;
  const stale = !Number.isFinite(hb) || Date.now() - hb > STALE_MS;
  return { ...base, running: true, stale };
}
