import { readFileSync } from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import type { CatalogPaths } from './catalog.js';

const usernameSchema = z.string().regex(/^[A-Za-z0-9._-]{1,64}$/, 'must be 1-64 characters of letters, digits, dots, underscores, or hyphens');
const athleteIdSchema = z.string().regex(/^[a-z][a-z0-9-]{0,62}$/, 'must use lowercase letters, digits, and hyphens, starting with a letter');
const accountSchema = z.object({
  username: usernameSchema,
  passwordHash: z.string().startsWith('$2', "must be a bcrypt hash starting with '$2'"),
  role: z.enum(['admin', 'member']),
  athletes: z.union([z.literal('all'), z.array(athleteIdSchema)]),
  createdAt: z.string().min(1).refine((value) => !Number.isNaN(Date.parse(value)), 'must be an ISO timestamp'),
}).strict();
const accountsSchema = z.object({
  formatVersion: z.literal(1),
  accounts: z.array(accountSchema),
}).strict().superRefine((store, context) => {
  const usernames = store.accounts.map((account) => account.username);
  if (new Set(usernames).size !== usernames.length) context.addIssue({ code: 'custom', path: ['accounts'], message: 'account usernames must be unique' });
});

export type ConsoleAccount = z.infer<typeof accountSchema>;
export type ConsoleAccountRole = ConsoleAccount['role'];
export type ConsoleAccountScope = {
  role: ConsoleAccountRole;
  athleteIds: string[] | 'all';
};

export function consoleAccountsPath(paths: CatalogPaths): string {
  return path.join(paths.console, 'accounts.json');
}

/**
 * Read and strictly validate the Console accounts store. A missing file is an
 * empty store; any other read or validation problem throws so callers fail
 * closed instead of silently dropping accounts.
 */
export function loadConsoleAccounts(paths: CatalogPaths): ConsoleAccount[] {
  const filePath = consoleAccountsPath(paths);
  let contents: string;
  try {
    contents = readFileSync(filePath, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw new Error(`Cannot read Console accounts at ${filePath}: ${error instanceof Error ? error.message : String(error)}`);
  }
  try {
    return accountsSchema.parse(JSON.parse(contents)).accounts;
  } catch (error) {
    throw new Error(`Invalid Console accounts at ${filePath}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

/**
 * The athlete scope one account may act for, or null when the username is not
 * stored. An admin holding a grant list instead of "all" keeps the list (fail
 * safe); any account holding "all" sees every athlete.
 */
export function resolveAccountScope(paths: CatalogPaths, username: string): ConsoleAccountScope | null {
  const account = loadConsoleAccounts(paths).find((entry) => entry.username === username);
  if (!account) return null;
  return { role: account.role, athleteIds: account.athletes === 'all' ? 'all' : account.athletes };
}

/** True when the scope grants this athlete: "all", or the id is listed. */
export function scopeAllowsAthlete(athleteIds: string[] | 'all', athleteId: string): boolean {
  return athleteIds === 'all' || athleteIds.includes(athleteId);
}

/**
 * Verify a Console account password against its stored bcrypt hash (the
 * OAuth consent login). Fail closed: a missing account, a malformed store, or
 * a malformed hash all return false. bcryptjs is imported lazily so the stdio
 * path never loads it. The password is verified, never logged or stored.
 */
export async function verifyAccountPassword(paths: CatalogPaths, username: string, password: string): Promise<boolean> {
  if (!username || !password) return false;
  let account: ConsoleAccount | undefined;
  try {
    account = loadConsoleAccounts(paths).find((entry) => entry.username === username);
  } catch {
    return false;
  }
  if (!account) return false;
  const { default: bcrypt } = await import('bcryptjs');
  try {
    return await bcrypt.compare(password, account.passwordHash);
  } catch {
    return false;
  }
}

/**
 * Narrow an athlete roster to a scope, mirroring the Console's filter_roster:
 * "all" returns the roster unchanged; otherwise only granted athletes remain
 * and the default moves to the first visible athlete (or "" when none).
 */
export function filterRosterToScope<Athlete extends { id: string }>(athletes: Athlete[], defaultAthleteId: string, athleteIds: string[] | 'all'): { athletes: Athlete[]; defaultAthleteId: string } {
  if (athleteIds === 'all') return { athletes, defaultAthleteId };
  const visible = athletes.filter((athlete) => athleteIds.includes(athlete.id));
  const visibleIds = visible.map((athlete) => athlete.id);
  return {
    athletes: visible,
    defaultAthleteId: visibleIds.includes(defaultAthleteId) ? defaultAthleteId : (visibleIds[0] ?? ''),
  };
}
