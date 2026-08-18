export const STALE_RUN_TIMEOUT_MS = 15 * 60 * 1000;

export const SYNC_STAGES = [
  'starting',
  'login',
  'singletons',
  'daily',
  'range',
  'ftp_history',
  'max_metrics',
  'hrv_history',
  'scores',
  'activities',
  'collections',
  'importing',
  'completed',
  'interrupted',
  'failed',
  'timed_out',
] as const;

export type SyncStage = (typeof SYNC_STAGES)[number];

export interface SyncProgressState {
  runId: string;
  provider: string;
  stage: SyncStage;
  currentStep: string | null;
  completedUnits: number;
  totalUnits: number | null;
  percentComplete: number;
  elapsedSeconds: number;
  estimatedRemainingSeconds: number | null;
  heartbeatAt: string;
}

export interface SyncProgressSnapshot {
  running: SyncProgressState[];
  recent: SyncProgressState[];
}

export interface InterruptedRuns {
  runIds: string[];
}

export function normalizeProgress(value: unknown): SyncProgressState | null {
  if (typeof value !== 'object' || value === null) {
    return null;
  }
  const record = value as Record<string, unknown>;
  const runId = typeof record.runId === 'string' ? record.runId : '';
  const provider = typeof record.provider === 'string' ? record.provider : '';
  if (!runId || !provider) {
    return null;
  }
  const stage = SYNC_STAGES.includes(record.stage as SyncStage)
    ? (record.stage as SyncStage)
    : 'starting';
  const numberOr = (value: unknown, fallback: number): number =>
    typeof value === 'number' && Number.isFinite(value) ? value : fallback;
  const roundOrNull = (value: unknown): number | null =>
    typeof value === 'number' && Number.isFinite(value) ? Math.max(0, Math.round(value)) : null;
  return {
    runId,
    provider,
    stage,
    currentStep: typeof record.currentStep === 'string' ? record.currentStep : null,
    completedUnits: Math.max(0, Math.round(numberOr(record.completedUnits, 0))),
    totalUnits: roundOrNull(record.totalUnits),
    percentComplete: Math.min(100, Math.max(0, numberOr(record.percentComplete, 0))),
    elapsedSeconds: Math.max(0, numberOr(record.elapsedSeconds, 0)),
    estimatedRemainingSeconds: roundOrNull(record.estimatedRemainingSeconds),
    heartbeatAt: typeof record.heartbeatAt === 'string' ? record.heartbeatAt : new Date().toISOString(),
  };
}
