/**
 * Long-lived Claude tokens for a bridge that runs as a service.
 *
 * `claude setup-token` prints a token (CLAUDE_CODE_OAUTH_TOKEN) meant for
 * exactly this: a machine nobody signs into interactively, such as a server
 * reached over SSH. Claude Code reads it from its environment, so the bridge
 * puts it into the environment of every Claude run it spawns.
 *
 * The tokens live in a file of their own (0600), named by AI_BRIDGE_CLAUDE_ENV
 * or `--claude-env`, rather than in the bridge's env file or the unit. The file
 * may hold one token or several named ones, one of which is active:
 *
 *   CLAUDE_CODE_OAUTH_TOKEN=<token>          the single token (name "default")
 *   CLAUDE_CODE_OAUTH_TOKEN_<NAME>=<token>   a named token, e.g. _WORK
 *   CLAUDE_TOKEN_ACTIVE=<name>               which one runs use
 *
 * Without CLAUDE_TOKEN_ACTIVE the single token is used, so a file from before
 * named tokens means what it always meant. An active name whose line is empty
 * means no token: Claude uses its own sign-in. The file is read again for
 * every Claude run, so `ai-bridge claude-token use <name>` switches accounts
 * without a restart. A token already in the bridge's own environment wins, so
 * a person can still override the file for one run.
 */
import { chmodSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';

export const CLAUDE_TOKEN_KEY = 'CLAUDE_CODE_OAUTH_TOKEN';
export const CLAUDE_TOKEN_ACTIVE_KEY = 'CLAUDE_TOKEN_ACTIVE';
/** The name the single, unnamed CLAUDE_CODE_OAUTH_TOKEN line goes by. */
export const DEFAULT_TOKEN_NAME = 'default';

export type ClaudeTokenOutcome =
  | { status: 'loaded'; path: string; name: string }
  | { status: 'already_set' }
  | { status: 'unreadable'; path: string; reason: string }
  | { status: 'no_token'; path: string; name?: string }
  | { status: 'unknown_active'; path: string; name: string }
  | { status: 'too_open'; path: string; mode: string };

export interface ClaudeTokenFile {
  /** Name (lowercase) to token value; '' for a slot left empty. In file order. */
  tokens: Map<string, string>;
  /** CLAUDE_TOKEN_ACTIVE, lowercased; null when the file has no such line. */
  active: string | null;
}

const NAME = /^[a-z0-9_]+$/;

/** One KEY=value line, or null. `export ` and one pair of quotes are accepted,
 *  since that is how people write a file they also `source`. */
function pairOf(raw: string): [string, string] | null {
  const line = raw.trim().replace(/^export\s+/, '');
  if (line.startsWith('#')) return null;
  const eq = line.indexOf('=');
  if (eq <= 0) return null;
  const key = line.slice(0, eq).trim();
  let value = line.slice(eq + 1).trim();
  if (value.length >= 2 && (value[0] === '"' || value[0] === "'") && value.at(-1) === value[0]) {
    value = value.slice(1, -1);
  }
  return [key, value];
}

/** Every token slot in the file and which one is active. The first line for a
 *  name wins, as it always did for the single token. */
export function parseClaudeTokenFile(text: string): ClaudeTokenFile {
  const tokens = new Map<string, string>();
  let active: string | null = null;
  for (const raw of text.split('\n')) {
    const pair = pairOf(raw);
    if (!pair) continue;
    const [key, value] = pair;
    if (key === CLAUDE_TOKEN_ACTIVE_KEY) {
      if (active === null) active = value.toLowerCase();
      continue;
    }
    let name: string;
    if (key === CLAUDE_TOKEN_KEY) name = DEFAULT_TOKEN_NAME;
    else if (key.startsWith(`${CLAUDE_TOKEN_KEY}_`)) name = key.slice(CLAUDE_TOKEN_KEY.length + 1).toLowerCase();
    else continue;
    if (!NAME.test(name) || tokens.has(name)) continue;
    tokens.set(name, value);
  }
  return { tokens, active };
}

/** The active token's name and value: the named one when CLAUDE_TOKEN_ACTIVE
 *  says which, else the single token. */
export function selectClaudeToken(file: ClaudeTokenFile):
  | { name: string; token: string }
  | { name: string | undefined; token: null; unknown: boolean } {
  const name = file.active || DEFAULT_TOKEN_NAME;
  const token = file.tokens.get(name);
  if (token) return { name, token };
  return { name: file.active || (file.tokens.has(DEFAULT_TOKEN_NAME) ? DEFAULT_TOKEN_NAME : undefined), token: null, unknown: !!file.active && token === undefined };
}

/** The single token in a KEY=value file, or null. Kept for callers that only
 *  want "is there a usable token": it answers with the active one. */
export function parseClaudeEnv(text: string): string | null {
  return selectClaudeToken(parseClaudeTokenFile(text)).token;
}

/** The file's text, refusing one others can read. */
function readPrivate(path: string): { text: string } | { status: 'too_open'; mode: string } | { status: 'unreadable'; reason: string } {
  try {
    const mode = statSync(path).mode & 0o777;
    if (process.platform !== 'win32' && (mode & 0o077) !== 0) {
      return { status: 'too_open', mode: mode.toString(8).padStart(3, '0') };
    }
    return { text: readFileSync(path, 'utf8') };
  } catch (err) {
    return { status: 'unreadable', reason: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * Put the active token from `path` into `env`, unless one is already there.
 *
 * Refuses a file others can read rather than using it: a token anybody on the
 * machine could copy is a sign-in anybody on the machine has. Every refusal is
 * returned with its reason, for the caller to log; none of them is fatal,
 * because a bridge with other CLIs still has work to do without Claude, and
 * Claude may still have a sign-in of its own.
 */
export function loadClaudeToken(path: string, env: NodeJS.ProcessEnv = process.env): ClaudeTokenOutcome {
  if (env[CLAUDE_TOKEN_KEY]) return { status: 'already_set' };
  const read = readPrivate(path);
  if ('status' in read) return read.status === 'too_open' ? { status: 'too_open', path, mode: read.mode } : { status: 'unreadable', path, reason: read.reason };
  const chosen = selectClaudeToken(parseClaudeTokenFile(read.text));
  if (chosen.token === null) {
    if (chosen.unknown && chosen.name) return { status: 'unknown_active', path, name: chosen.name };
    return chosen.name ? { status: 'no_token', path, name: chosen.name } : { status: 'no_token', path };
  }
  env[CLAUDE_TOKEN_KEY] = chosen.token;
  return { status: 'loaded', path, name: chosen.name };
}

/* ------------------------- per-run selection ------------------------- */

/** The file set at start, or null when there is none or the environment
 *  carried a token of its own (which then wins for every run). */
let configuredFile: string | null = null;
let lastReported: string | null = null;
let reporter: ((outcome: ClaudeTokenOutcome) => void) | null = null;

/**
 * Name the token file every Claude run reads. Called once at start, when the
 * bridge's own environment has no CLAUDE_CODE_OAUTH_TOKEN. `report` hears an
 * outcome whenever it differs from the last one (a switch, a file gone bad),
 * so the log says which account runs use without a line per turn.
 */
export function useClaudeTokenFile(path: string | null, report?: (outcome: ClaudeTokenOutcome) => void): ClaudeTokenOutcome | null {
  configuredFile = path;
  lastReported = null;
  reporter = report ?? null;
  return path ? applyClaudeToken({}) : null;
}

/**
 * Give one Claude run's environment the active token, read from the file now.
 * Leaves `env` alone when it already carries a token (the bridge's own
 * environment wins) or no file is configured. With no usable token the key is
 * left unset, so Claude falls back to its own sign-in.
 */
export function applyClaudeToken(env: NodeJS.ProcessEnv): ClaudeTokenOutcome | null {
  if (!configuredFile) return null;
  const outcome = loadClaudeToken(configuredFile, env);
  const key = outcome.status === 'loaded' ? `loaded:${outcome.name}` : outcome.status === 'already_set' ? null : `${outcome.status}:${'name' in outcome ? outcome.name ?? '' : ''}`;
  if (key !== null && key !== lastReported) {
    lastReported = key;
    reporter?.(outcome);
  }
  return outcome;
}

/** The token the next Claude run would get, or null: the environment's, else
 *  the file's active one. For asking about that account (usage), never logged. */
export function currentClaudeToken(): string | null {
  const fromEnv = process.env[CLAUDE_TOKEN_KEY];
  if (fromEnv) return fromEnv;
  const probe: NodeJS.ProcessEnv = {};
  applyClaudeToken(probe);
  return probe[CLAUDE_TOKEN_KEY] || null;
}

/* ------------------------- the claude-token command ------------------------- */

export interface ClaudeTokenListing {
  path: string;
  active: string | null;
  /** The name runs actually use, or null when they use Claude's own sign-in. */
  inUse: string | null;
  slots: { name: string; filled: boolean; active: boolean }[];
}

/** What the file holds, by name and filled-or-empty only. Never a value. */
export function listClaudeTokens(path: string): ClaudeTokenListing {
  const read = readPrivate(path);
  if ('status' in read) throw new Error(read.status === 'too_open' ? `${path} can be read by others (mode ${read.mode}). Run: chmod 600 ${path}` : `cannot read ${path}: ${read.reason}`);
  const file = parseClaudeTokenFile(read.text);
  const chosen = selectClaudeToken(file);
  const activeName = file.active || DEFAULT_TOKEN_NAME;
  return {
    path,
    active: file.active,
    inUse: chosen.token ? chosen.name : null,
    slots: [...file.tokens].map(([name, value]) => ({ name, filled: value !== '', active: name === activeName })),
  };
}

/**
 * Make `name` the active token: rewrite only the CLAUDE_TOKEN_ACTIVE line (or
 * add one), atomically, keeping the file 0600. Refuses a name with no line in
 * the file, listing the ones there are. An empty slot may be chosen: runs then
 * use Claude's own sign-in until it is filled, which the caller says.
 */
export function useClaudeToken(path: string, rawName: string): { name: string; filled: boolean } {
  const name = rawName.trim().toLowerCase();
  const read = readPrivate(path);
  if ('status' in read) throw new Error(read.status === 'too_open' ? `${path} can be read by others (mode ${read.mode}). Run: chmod 600 ${path}` : `cannot read ${path}: ${read.reason}`);
  const file = parseClaudeTokenFile(read.text);
  if (!file.tokens.has(name)) {
    const names = [...file.tokens.keys()];
    throw new Error(names.length
      ? `${path} has no token named "${rawName}". Names there: ${names.join(', ')}`
      : `${path} has no token lines yet. Add one, e.g. ${CLAUDE_TOKEN_KEY}_${rawName.toUpperCase()}=<token from \`claude setup-token\`>`);
  }
  const lines = read.text.split('\n');
  let replaced = false;
  const out = lines.map((raw) => {
    const pair = pairOf(raw);
    if (replaced || !pair || pair[0] !== CLAUDE_TOKEN_ACTIVE_KEY) return raw;
    replaced = true;
    return `${CLAUDE_TOKEN_ACTIVE_KEY}=${name}`;
  });
  if (!replaced) {
    if (out.length && out.at(-1) === '') out.splice(out.length - 1, 0, `${CLAUDE_TOKEN_ACTIVE_KEY}=${name}`);
    else out.push(`${CLAUDE_TOKEN_ACTIVE_KEY}=${name}`);
  }
  // Written beside the file and renamed over it: a run reading it meanwhile
  // sees the old file or the new one, never half of one. Created 0600 so the
  // tokens are never readable by others, not even for a moment.
  const tmp = join(dirname(path), `.${basename(path)}.${process.pid}.tmp`);
  try {
    writeFileSync(tmp, out.join('\n'), { mode: 0o600 });
    chmodSync(tmp, 0o600);
    renameSync(tmp, path);
  } catch (err) {
    rmSync(tmp, { force: true });
    throw err;
  }
  return { name, filled: (file.tokens.get(name) ?? '') !== '' };
}
