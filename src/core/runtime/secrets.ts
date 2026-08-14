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

/** Build only the provider environment needed by a selected athlete worker. */
export async function athleteProviderEnvironment(paths: CatencePaths, base: NodeJS.ProcessEnv = process.env): Promise<NodeJS.ProcessEnv> {
  const secrets = await readAthleteSecrets(paths);
  const environment = { ...base };
  // Never let credentials inherited by the shared process leak into an
  // athlete store that has not explicitly configured that provider.
  for (const name of ['GARMIN_EMAIL', 'GARMIN_PASSWORD', 'INTERVALS_API_KEY', 'INTERVALS_ATHLETE_ID', 'STRAVA_CLIENT_ID', 'STRAVA_CLIENT_SECRET']) {
    delete environment[name];
  }
  if (secrets.garmin?.email) environment.GARMIN_EMAIL = secrets.garmin.email;
  if (secrets.garmin?.password) environment.GARMIN_PASSWORD = secrets.garmin.password;
  if (secrets.intervals?.apiKey) environment.INTERVALS_API_KEY = secrets.intervals.apiKey;
  if (secrets.intervals?.athleteId) environment.INTERVALS_ATHLETE_ID = secrets.intervals.athleteId;
  if (secrets.strava?.clientId) environment.STRAVA_CLIENT_ID = secrets.strava.clientId;
  if (secrets.strava?.clientSecret) environment.STRAVA_CLIENT_SECRET = secrets.strava.clientSecret;
  return environment;
}
