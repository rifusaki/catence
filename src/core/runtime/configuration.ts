import { config as loadDotenv } from 'dotenv';
import { mkdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import type { CatencePaths } from '../../contracts/runtime.js';

loadDotenv({ quiet: true });

export type { CatencePaths } from '../../contracts/runtime.js';

export function resolvePaths(root = process.env.CATENCE_DATA_DIR ?? '.catence'): CatencePaths {
  const absoluteRoot = path.resolve(root);
  return {
    root: absoluteRoot,
    database: path.join(absoluteRoot, 'catence.duckdb'),
    raw: path.join(absoluteRoot, 'raw'),
    lake: path.join(absoluteRoot, 'lake', 'activity_samples'),
    staging: path.join(absoluteRoot, 'staging'),
    config: path.join(absoluteRoot, 'config.json'),
    secrets: path.join(absoluteRoot, 'secrets'),
    lock: path.join(absoluteRoot, '.catence-write.lock'),
  };
}

export async function ensurePaths(paths: CatencePaths): Promise<void> {
  await Promise.all([mkdir(paths.raw, { recursive: true }), mkdir(paths.lake, { recursive: true }), mkdir(paths.staging, { recursive: true }), mkdir(paths.secrets, { recursive: true, mode: 0o700 })]);
}

export function defaultFromDate(now = new Date()): string {
  const date = new Date(Date.UTC(now.getUTCFullYear() - 1, now.getUTCMonth(), now.getUTCDate()));
  return date.toISOString().slice(0, 10);
}

export function requireIntervalsConfig(): { apiKey: string; athleteId: string } {
  const apiKey = process.env.INTERVALS_API_KEY;
  if (!apiKey) throw new Error('INTERVALS_API_KEY is required for an Intervals sync.');
  return { apiKey, athleteId: process.env.INTERVALS_ATHLETE_ID ?? '0' };
}

const rateLimitSchema = z.object({ requests: z.number().int().positive(), windowSeconds: z.number().int().positive() }).strict();
const nullableRateLimitSchema = rateLimitSchema.nullable();
const environmentVariableSchema = z.string().regex(/^[A-Z][A-Z0-9_]*$/, 'must be an uppercase environment-variable name');
const consoleModelSchema = z.object({
  label: z.string().min(1).optional(),
  model: z.string().min(1),
}).strict();
const consoleProfileSchema = z.object({
  label: z.string().min(1).optional(),
  model: z.string().min(1).optional(),
  models: z.record(z.string().min(1), consoleModelSchema).optional(),
  defaultModel: z.string().min(1).optional(),
  defaultReasoningEffort: z.enum(['minimal', 'low', 'medium', 'high', 'xhigh']).optional(),
  apiKeyEnv: environmentVariableSchema.optional(),
  apiBaseEnv: environmentVariableSchema.optional(),
  apiVersionEnv: environmentVariableSchema.optional(),
}).strict().superRefine((profile, context) => {
  if (Boolean(profile.model) === Boolean(profile.models)) {
    context.addIssue({ code: 'custom', message: 'must define exactly one of model or models' });
  }
  if (profile.defaultModel && !profile.models) {
    context.addIssue({ code: 'custom', path: ['defaultModel'], message: 'requires models' });
  }
  if (profile.models && profile.defaultModel && !Object.hasOwn(profile.models, profile.defaultModel)) {
    context.addIssue({ code: 'custom', path: ['defaultModel'], message: 'must name one of models' });
  }
});
const consoleLimitsSchema = z.object({
  toolRounds: z.number().int().min(1).max(32).optional(),
  toolResultCharacters: z.number().int().min(1_000).max(250_000).optional(),
}).strict();
const catenceConfigSchema = z.object({
  mcp: z.object({
    rateLimits: z.object({
      server: nullableRateLimitSchema.optional(),
      tools: z.record(z.string(), nullableRateLimitSchema).optional(),
      resources: z.record(z.string(), nullableRateLimitSchema).optional(),
    }).strict().optional(),
  }).strict().optional(),
  providers: z.object({
    strava: z.object({
      budget: z.object({
        maxConcurrentRequests: z.number().int().positive().nullable().optional(),
        readRequestsPer15Minutes: z.number().int().positive().nullable().optional(),
        readRequestsPerDay: z.number().int().positive().nullable().optional(),
      }).strict().optional(),
    }).strict().optional(),
  }).strict().optional(),
  console: z.object({
    defaultProfile: z.string().min(1).optional(),
    limits: consoleLimitsSchema.optional(),
    profiles: z.record(z.string().min(1), consoleProfileSchema).optional(),
  }).strict().optional(),
}).strict();

export type CatenceConfig = z.infer<typeof catenceConfigSchema>;
export type ConfigRateLimit = z.infer<typeof rateLimitSchema>;

export async function loadCatenceConfig(paths: CatencePaths): Promise<CatenceConfig> {
  const contents = await readFile(paths.config, 'utf8').catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return '';
    throw error;
  });
  if (!contents.trim()) return {};
  try {
    return catenceConfigSchema.parse(JSON.parse(contents));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Invalid Catence config at ${paths.config}: ${message}`);
  }
}

export function configuredMcpRateLimit(config: CatenceConfig, type: 'tools' | 'resources', name: string): ConfigRateLimit | null {
  const scoped = config.mcp?.rateLimits?.[type];
  return scoped?.[name] ?? scoped?.['*'] ?? config.mcp?.rateLimits?.server ?? null;
}
