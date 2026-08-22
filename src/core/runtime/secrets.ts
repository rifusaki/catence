import { chmod } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import type { CatencePaths } from '../../contracts/runtime.js';
import { ensurePaths } from './configuration.js';

const secretSchema = z.object({
  garmin: z.object({ email: z.string().min(1).optional(), password: z.string().min(1).optional() }).strict().optional(),
  intervals: z.object({ apiKey: z.string().min(1).optional(), athleteId: z.string().min(1).optional() }).strict().optional(),
  strava: z.object({ clientId: z.string().min(1).optional(), clientSecret: z.string().min(1).optional() }).strict().optional(),
}).strict();

export type AthleteSecrets = z.infer<typeof secretSchema>;
export type SecretProvider = keyof AthleteSecrets;

const secretFields = {
  garmin: ['email', 'password'],
  intervals: ['apiKey', 'athleteId'],
  strava: ['clientId', 'clientSecret'],
} as const;

export function providerSecretPath(paths: CatencePaths): string {
  return path.join(paths.secrets, 'providers.json');
}

export async function readAthleteSecrets(paths: CatencePaths): Promise<AthleteSecrets> {
  const { readFile } = await import('node:fs/promises');
  const contents = await readFile(providerSecretPath(paths), 'utf8').catch((error: NodeJS.ErrnoException) => error.code === 'ENOENT' ? '{}' : Promise.reject(error));
  try {
    return secretSchema.parse(JSON.parse(contents));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Invalid provider secrets at ${providerSecretPath(paths)}: ${message}`);
  }
}

export async function setAthleteSecret(paths: CatencePaths, provider: SecretProvider, field: string, value: string): Promise<void> {
  if (!(secretFields[provider] as readonly string[]).includes(field)) throw new Error(`${field} is not a supported ${provider} secret field.`);
  if (!value.trim()) throw new Error('Secret values cannot be empty.');
  await ensurePaths(paths);
  const secrets = await readAthleteSecrets(paths);
  const next = { ...secrets, [provider]: { ...(secrets[provider] ?? {}), [field]: value } };
  const { writeFile, rename } = await import('node:fs/promises');
  const destination = providerSecretPath(paths);
  const temporary = `${destination}.tmp`;
  await writeFile(temporary, `${JSON.stringify(next, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
  await chmod(temporary, 0o600);
  await rename(temporary, destination);
  await chmod(destination, 0o600);
}

function isTruthyEnvValue(value: string | undefined): boolean {
  if (!value) return false;
  return ['1', 'true', 'yes', 'on'].includes(value.trim().toLowerCase());
}

function isGenericEnvFallbackAllowed(base: NodeJS.ProcessEnv): boolean {
  const direct = base.CATENCE_ALLOW_ENV_SECRETS ?? base.CATENCE_SECRETS_FROM_ENV ?? process.env.CATENCE_ALLOW_ENV_SECRETS ?? process.env.CATENCE_SECRETS_FROM_ENV;
  return isTruthyEnvValue(direct);
}

function athleteEnvPrefix(paths: CatencePaths): string {
  const athleteId = path.basename(path.dirname(paths.secrets));
  const normalized = athleteId.replace(/[^a-zA-Z0-9]/g, '_').toUpperCase();
  return `CATENCE_ATHLETE_${normalized}_`;
}

function resolveWithEnvFallback(
  fileValue: string | undefined,
  envName: string,
  perAthletePrefix: string,
  base: NodeJS.ProcessEnv,
  allowGeneric: boolean,
): string | undefined {
  if (fileValue) return fileValue;
  const perAthleteName = `${perAthletePrefix}${envName}`;
  const perAthleteValue = base[perAthleteName] ?? process.env[perAthleteName];
  if (perAthleteValue) return perAthleteValue;
  if (!allowGeneric) return undefined;
  const genericValue = base[envName] ?? process.env[envName];
  if (genericValue) return genericValue;
  return undefined;
}

/** Build only the provider environment needed by a selected athlete worker. */
export async function athleteProviderEnvironment(paths: CatencePaths, base: NodeJS.ProcessEnv = process.env): Promise<NodeJS.ProcessEnv> {
  const secrets = await readAthleteSecrets(paths);
  const environment = { ...base };
  const allowGenericEnv = isGenericEnvFallbackAllowed(base);
  const perAthletePrefix = athleteEnvPrefix(paths);
  // Never let credentials inherited by the shared process leak into an
  // athlete store that has not explicitly configured that provider, unless
  // the operator has opted in via CATENCE_ALLOW_ENV_SECRETS or is using a
  // per-athlete scoped variable (CATENCE_ATHLETE_<ID>_GARMIN_EMAIL etc.).
  for (const name of ['GARMIN_EMAIL', 'GARMIN_PASSWORD', 'INTERVALS_API_KEY', 'INTERVALS_ATHLETE_ID', 'STRAVA_CLIENT_ID', 'STRAVA_CLIENT_SECRET']) {
    delete environment[name];
  }
  const garminEmail = resolveWithEnvFallback(secrets.garmin?.email, 'GARMIN_EMAIL', perAthletePrefix, base, allowGenericEnv);
  const garminPassword = resolveWithEnvFallback(secrets.garmin?.password, 'GARMIN_PASSWORD', perAthletePrefix, base, allowGenericEnv);
  const intervalsApiKey = resolveWithEnvFallback(secrets.intervals?.apiKey, 'INTERVALS_API_KEY', perAthletePrefix, base, allowGenericEnv);
  const intervalsAthleteId = resolveWithEnvFallback(secrets.intervals?.athleteId, 'INTERVALS_ATHLETE_ID', perAthletePrefix, base, allowGenericEnv);
  const stravaClientId = resolveWithEnvFallback(secrets.strava?.clientId, 'STRAVA_CLIENT_ID', perAthletePrefix, base, allowGenericEnv);
  const stravaClientSecret = resolveWithEnvFallback(secrets.strava?.clientSecret, 'STRAVA_CLIENT_SECRET', perAthletePrefix, base, allowGenericEnv);
  if (garminEmail) environment.GARMIN_EMAIL = garminEmail;
  if (garminPassword) environment.GARMIN_PASSWORD = garminPassword;
  if (intervalsApiKey) environment.INTERVALS_API_KEY = intervalsApiKey;
  if (intervalsAthleteId) environment.INTERVALS_ATHLETE_ID = intervalsAthleteId;
  if (stravaClientId) environment.STRAVA_CLIENT_ID = stravaClientId;
  if (stravaClientSecret) environment.STRAVA_CLIENT_SECRET = stravaClientSecret;
  return environment;
}
