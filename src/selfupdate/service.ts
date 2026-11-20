/**
 * Is this bridge a service that a restart will bring back on a new version?
 *
 * Self-update ends with the bridge pinning a version in its service's env file
 * and exiting. That is only safe when something WILL start it again, and will
 * start the version just written rather than whatever it ran before. So
 * instead of being told a path, the bridge asks systemd about its own unit and
 * acts only when all of this holds:
 *
 *  - it runs inside a systemd service (INVOCATION_ID, and a `.service` in its
 *    own cgroup), which is what tells a service from a person's terminal;
 *  - that unit restarts it after an exit (`Restart=always` or `on-failure`;
 *    the bridge exits non-zero, so both bring it back);
 *  - the unit's start command takes the version from the environment
 *    (`@tetrixdev/ai-bridge@${AI_BRIDGE_VERSION}`), so the pin is what runs;
 *  - exactly one of its env files sets AI_BRIDGE_VERSION, and it is writable.
 *
 * Anything else, and the bridge only logs that the server wants another
 * version. An unpinned unit in particular would come back on whatever npx
 * resolves, and the bridge would restart forever trying to change it.
 *
 * AI_BRIDGE_ENV_FILE names the env file explicitly, for a unit that loads
 * more than one; every other check still applies.
 */
import { execFile, execFileSync } from 'node:child_process';
import { accessSync, closeSync, constants, fchmodSync, fchownSync, fsyncSync, mkdirSync, openSync, readFileSync, realpathSync, renameSync, rmSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

export const PACKAGE = '@tetrixdev/ai-bridge';

/** A service this bridge can update itself through. */
export interface ManagedService {
  kind: 'systemd';
  scope: 'user' | 'system';
  unit: string;
  envFile: string;
}

export type Detection = { managed: ManagedService } | { reason: string };

/** What detect() reads from the machine, injectable for tests. */
export interface DetectDeps {
  env: NodeJS.ProcessEnv;
  platform: NodeJS.Platform;
  readCgroup: () => string;
  showUnit: (scope: 'user' | 'system', unit: string) => string;
  readFile: (path: string) => string;
  writable: (path: string) => boolean;
}

export const realDetectDeps: DetectDeps = {
  env: process.env,
  platform: process.platform,
  readCgroup: () => readFileSync('/proc/self/cgroup', 'utf8'),
  showUnit: (scope, unit) => execFileSync(
    'systemctl',
    [...(scope === 'user' ? ['--user'] : []), 'show', unit, '-p', 'Restart', '-p', 'ExecStart', '-p', 'EnvironmentFiles', '--no-pager'],
    { encoding: 'utf8', timeout: 5000, stdio: ['ignore', 'pipe', 'ignore'] },
  ),
  readFile: (path) => readFileSync(path, 'utf8'),
  writable: (path) => {
    try {
      accessSync(path, constants.W_OK);
      accessSync(dirname(realpathSync(path)), constants.W_OK);
      return true;
    } catch {
      return false;
    }
  },
};

const VERSION_LINE = /^\s*(?:export\s+)?AI_BRIDGE_VERSION\s*=/m;
const PINNED_EXEC = /@tetrixdev\/ai-bridge@(?:\$\{AI_BRIDGE_VERSION\}|\$AI_BRIDGE_VERSION)(?:\s|$|;)/;

/** The systemd unit this process runs in, with what `systemctl show` says about it. */
type OwnUnit = { scope: 'user' | 'system'; unit: string; props: Map<string, string> } | { reason: string };

function ownUnit(deps: DetectDeps): OwnUnit {
  if (deps.platform !== 'linux') {
    return { reason: `self-update needs systemd; on ${deps.platform} the version is updated by hand` };
  }
  if (!deps.env['INVOCATION_ID']) return { reason: 'not running as a systemd service' };

  let cgroup: string;
  try {
    cgroup = deps.readCgroup();
  } catch {
    return { reason: 'could not read this process\'s cgroup' };
  }
  // cgroup v2: one line, `0::/user.slice/.../app.slice/name.service`. Under
  // v1 the systemd hierarchy carries the same path.
  const line = cgroup.split('\n').find((l) => l.startsWith('0::')) ?? cgroup.split('\n').find((l) => l.includes(':name=systemd:'));
  const path = line?.slice(line.indexOf(':', line.indexOf(':') + 1) + 1) ?? '';
  const unit = path.split('/').reverse().find((seg) => seg.endsWith('.service'));
  if (!unit || unit.startsWith('user@')) return { reason: 'could not tell which systemd unit runs this bridge' };
  const scope: 'user' | 'system' = /\/user@\d+\.service\//.test(path) ? 'user' : 'system';

  let shown: string;
  try {
    shown = deps.showUnit(scope, unit);
  } catch {
    return { reason: `systemctl show ${unit} failed` };
  }
  return { scope, unit, props: parseShow(shown) };
}

/** The env files a unit loads, in the order systemd reads them. */
function environmentFiles(props: Map<string, string>): string[] {
  return (props.get('EnvironmentFiles') ?? '')
    .split('\n')
    .map((l) => l.replace(/\s*\(ignore_errors=\w+\)\s*$/, '').trim())
    .filter(Boolean);
}

export function detect(deps: DetectDeps = realDetectDeps): Detection {
  const own = ownUnit(deps);
  if ('reason' in own) return own;
  const { scope, unit, props } = own;

  const restart = props.get('Restart') ?? '';
  if (restart !== 'always' && restart !== 'on-failure') {
    return { reason: `${unit} has Restart=${restart || 'no'}; it would not come back after an update` };
  }
  if (!PINNED_EXEC.test(props.get('ExecStart') ?? '')) {
    return { reason: `${unit} does not start ${PACKAGE}@\${AI_BRIDGE_VERSION}, so a pinned version would not take effect` };
  }

  const explicit = deps.env['AI_BRIDGE_ENV_FILE'];
  const listed = environmentFiles(props);
  const candidates = explicit ? [explicit] : listed;
  const withVersion = candidates.filter((file) => {
    try {
      return VERSION_LINE.test(deps.readFile(file));
    } catch {
      return false;
    }
  });
  if (withVersion.length !== 1) {
    return {
      reason: withVersion.length === 0
        ? `no env file of ${unit} sets AI_BRIDGE_VERSION`
        : `more than one env file of ${unit} sets AI_BRIDGE_VERSION; name one with AI_BRIDGE_ENV_FILE`,
    };
  }
  const envFile = withVersion[0]!;
  if (!deps.writable(envFile)) return { reason: `${envFile} is not writable by this bridge` };

  return { managed: { kind: 'systemd', scope, unit, envFile } };
}

/**
 * `systemctl show` output as a map. A property can repeat (EnvironmentFiles
 * does, once per file); repeats are joined with newlines.
 */
export function parseShow(out: string): Map<string, string> {
  const props = new Map<string, string>();
  for (const line of out.split('\n')) {
    const eq = line.indexOf('=');
    if (eq <= 0) continue;
    const key = line.slice(0, eq);
    const value = line.slice(eq + 1);
    props.set(key, props.has(key) ? `${props.get(key)}\n${value}` : value);
  }
  return props;
}

/**
 * Pin a version in the env file, keeping every other line as it was.
 *
 * The previous version is kept beside it, as AI_BRIDGE_PREVIOUS_VERSION, so a
 * person rolling back by hand knows what to roll back to. Written to a
 * temporary file in the same directory and renamed over the original, so a
 * crash mid-write leaves the old file whole rather than a truncated one with
 * the token cut off.
 */
export function pinVersion(envFile: string, version: string, previous: string): void {
  const target = realpathSync(envFile);
  const lines = readFileSync(target, 'utf8').split('\n');
  const set = (key: string, value: string): void => {
    const re = new RegExp(`^\\s*(?:export\\s+)?${key}\\s*=`);
    const at = lines.findIndex((l) => re.test(l));
    if (at >= 0) lines[at] = `${key}=${value}`;
    else {
      // Before a trailing empty line, so the file keeps ending in a newline.
      const end = lines.length > 0 && lines[lines.length - 1] === '' ? lines.length - 1 : lines.length;
      lines.splice(end, 0, `${key}=${value}`);
    }
  };
  set('AI_BRIDGE_VERSION', version);
  set('AI_BRIDGE_PREVIOUS_VERSION', previous);
  replaceFile(target, lines.join('\n'));
}

/**
 * Write a file's new content to a temporary file beside it and rename it over
 * the original, keeping its mode (and, as root, its owner): a crash mid-write
 * leaves the old file whole rather than a truncated one with the token cut
 * off. The temporary file is flushed to disk before the rename and removed
 * when anything fails, so a failed write leaves no copy of the token behind.
 * `stillCurrent`, when given, is asked right before the rename; false drops
 * the new content and returns false.
 */
export function replaceFile(target: string, content: string, stillCurrent?: () => boolean): boolean {
  const st = statSync(target);
  const tmp = join(dirname(target), `.${Date.now()}-${process.pid}.ai-bridge-env.tmp`);
  let created = false;
  let renamed = false;
  try {
    const fd = openSync(tmp, 'wx', 0o600);
    created = true;
    try {
      // writeFileSync on a descriptor loops until all is written; a bare
      // writeSync may write part of it on a filling disk without an error.
      writeFileSync(fd, content);
      fchmodSync(fd, st.mode & 0o777);
      if (process.getuid?.() === 0) fchownSync(fd, st.uid, st.gid);
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    if (stillCurrent && !stillCurrent()) return false;
    renameSync(tmp, target);
    renamed = true;
    return true;
  } finally {
    if (created && !renamed) {
      try { unlinkSync(tmp); } catch { /* already gone */ }
    }
  }
}

// ---------------------------------------------------------------------------
// The connection token on disk
// ---------------------------------------------------------------------------
//
// A bridge token expires (the server's bridge_ttl, 30 days by default). While
// connected, the server tops it up: `welcome.refreshed_token` and
// `token_refresh`. The bridge used to keep the fresh token in memory only, so
// the file it started from still held the token it was installed with. A
// bridge that ran for more than the token's lifetime then came back from its
// next restart (a self-update, a reboot, a crash) with an expired token, was
// refused with token_invalid, and stayed refused until somebody installed it
// again. So the fresh token is written back to the file it came from.

// Group 1: everything up to the value (indent, `export`, spaces around `=`),
// kept when the line is rewritten; group 2: the value; group 3: a CR, so a
// file saved with Windows line endings is read and written as it was.
const TOKEN_LINE = /^(\s*(?:export\s+)?AI_BRIDGE_TOKEN\s*=\s*)(.*?)(\r?)$/;

/** The AI_BRIDGE_TOKEN a file sets (the last one, as systemd reads it), unquoted; null when none. */
export function tokenIn(text: string): string | null {
  let found: string | null = null;
  for (const line of text.split('\n')) {
    const m = TOKEN_LINE.exec(line);
    if (m) found = unquote(m[2]!.trim());
  }
  return found;
}

function unquote(value: string): string {
  const q = value[0];
  return (q === '"' || q === "'") && value.length >= 2 && value.endsWith(q) ? value.slice(1, -1) : value;
}

export type TokenFile = { file: string } | { reason: string };

/**
 * The file a refreshed token is saved to: the one this bridge's token came
 * from. That is `--env-file` when given, else AI_BRIDGE_ENV_FILE, else the env
 * files of the systemd unit running it. Only a file whose AI_BRIDGE_TOKEN is
 * exactly the token this bridge runs with qualifies, so a token given with
 * --token or set elsewhere never lands in a file it did not come from.
 */
export function locateTokenFile(token: string, envFileFlag: string | undefined, deps: DetectDeps = realDetectDeps): TokenFile {
  let candidates: string[];
  let where: string;
  if (envFileFlag) {
    candidates = [envFileFlag];
    where = envFileFlag;
  } else if (deps.env['AI_BRIDGE_ENV_FILE']) {
    candidates = [deps.env['AI_BRIDGE_ENV_FILE']];
    where = deps.env['AI_BRIDGE_ENV_FILE'];
  } else {
    const own = ownUnit(deps);
    if ('reason' in own) {
      return deps.platform === 'linux'
        ? { reason: `no --env-file or AI_BRIDGE_ENV_FILE, and ${own.reason}` }
        : { reason: 'no --env-file or AI_BRIDGE_ENV_FILE names the file the token came from' };
    }
    candidates = environmentFiles(own.props);
    where = `the env files of ${own.unit}`;
  }
  const matching = candidates.filter((file) => {
    try {
      return tokenIn(deps.readFile(file)) === token;
    } catch {
      return false;
    }
  });
  if (matching.length === 0) return { reason: `the token this bridge runs with is not the AI_BRIDGE_TOKEN in ${where}` };
  if (matching.length > 1) return { reason: `more than one env file holds this token; name one with AI_BRIDGE_ENV_FILE` };
  const file = matching[0]!;
  if (!deps.writable(file)) return { reason: `${file} is not writable by this bridge` };
  return { file };
}

/**
 * Replace the token in the file, only if it still holds the one this bridge
 * last knew. A different token there means somebody installed a new one since
 * this bridge started; theirs is newer than anything in memory, so it stays.
 */
export function saveToken(file: string, expected: string, next: string): 'saved' | 'changed' {
  if (!/^[A-Za-z0-9._~+/=-]+$/.test(next)) throw new Error('the refreshed token has characters an env file line cannot hold');
  const target = realpathSync(file);
  const lines = readFileSync(target, 'utf8').split('\n');
  let at = -1;
  lines.forEach((line, i) => { if (TOKEN_LINE.test(line)) at = i; });
  if (at < 0 || tokenIn(lines[at]!) !== expected) return 'changed';
  const [, prefix, value, cr] = TOKEN_LINE.exec(lines[at]!)!;
  const q = value!.trim()[0];
  const quote = (q === '"' || q === "'") ? q : '';
  lines[at] = `${prefix}${quote}${next}${quote}${cr}`;
  // Asked again right before the rename: an `ai-bridge install` that wrote a
  // new token while this one was being prepared keeps its token. (Not a lock:
  // a reinstall landing in the instant between this read and the rename
  // still loses, to a refreshed token that is itself valid.)
  const stillExpected = (): boolean => {
    try { return tokenIn(readFileSync(target, 'utf8')) === expected; } catch { return false; }
  };
  return replaceFile(target, lines.join('\n'), stillExpected) ? 'saved' : 'changed';
}

/**
 * Saves each refreshed token in turn: each save expects the token the last
 * one wrote (the one the bridge started with, at first). Once the file holds
 * a token this bridge did not write, it stays 'changed'. A save that threw
 * keeps the expected token, so the next refresh tries again.
 */
export function tokenSaver(file: string, initial: string): (next: string) => 'saved' | 'changed' {
  let expected = initial;
  let changed = false;
  return (next) => {
    if (changed) return 'changed';
    const result = saveToken(file, expected, next);
    if (result === 'saved') expected = next;
    else changed = true;
    return result;
  };
}

/** What prefetch() runs and touches, injectable for tests. */
export interface PrefetchDeps {
  /** Runs npx; resolves with what it printed, and the error when it failed. */
  run: (args: string[], timeoutMs: number) => Promise<{ error: Error | null; killed: boolean; stdout: string; stderr: string }>;
  lockDir: string;
  /** How long to wait for another bridge on this machine to finish fetching. */
  lockWaitMs: number;
  /** A lock older than this was left by a process that died. */
  lockStaleMs: number;
  sleep: (ms: number) => Promise<void>;
}

export const realPrefetchDeps: PrefetchDeps = {
  run: (args, timeoutMs) => new Promise((resolve) => {
    execFile('npx', args, { cwd: tmpdir(), timeout: timeoutMs, encoding: 'utf8', maxBuffer: 4 * 1024 * 1024 }, (err, stdout, stderr) => {
      resolve({
        error: err,
        killed: Boolean((err as { killed?: boolean } | null)?.killed),
        stdout: String(stdout ?? ''),
        stderr: String(stderr ?? ''),
      });
    });
  }),
  lockDir: join(homedir(), '.cache', 'ai-bridge', 'prefetch.lock'),
  lockWaitMs: 5 * 60_000,
  lockStaleMs: 10 * 60_000,
  sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
};

/**
 * Make sure a version exists and can be fetched, by fetching it into the npx
 * cache and running it once.
 *
 * `--prefer-online` so a cached copy of an older resolution cannot stand in
 * for it; `--version` so what comes back is the version itself saying its own
 * number, which proves the package installed and starts, not merely that a
 * tarball downloaded. Never throws: resolves with the reason it failed.
 *
 * One fetch at a time per machine. Two npx installs of the same version write
 * into the same cache directory, and when they overlap the result can be half
 * a package (seen 2026-10-03: @modelcontextprotocol/sdk without its
 * package.json), after which every later npx run of that version reuses the
 * broken directory and fails. Several bridges on one machine told to update at
 * once is exactly that overlap, so the fetch takes a lock first.
 *
 * And a directory broken anyway (by something else's npx, or a crash mid
 * install) is repaired: when the run fails because a module is missing from
 * an npx cache directory that holds THIS version, that directory is removed
 * and the fetch tried once more.
 */
export async function prefetch(
  version: string,
  timeoutMs = 180_000,
  deps: PrefetchDeps = realPrefetchDeps,
): Promise<{ ok: true } | { ok: false; reason: string }> {
  // "Never throws" is what the updater's retry depends on: it schedules the
  // next attempt only on a failure RESULT. A lock directory that cannot be
  // made, or a broken one that cannot be removed, must come back as one.
  try {
    return await prefetchLocked(version, timeoutMs, deps);
  } catch (err) {
    return { ok: false, reason: err instanceof Error ? err.message : String(err) };
  }
}

async function prefetchLocked(
  version: string,
  timeoutMs: number,
  deps: PrefetchDeps,
): Promise<{ ok: true } | { ok: false; reason: string }> {
  const token = await acquireLock(deps);
  if (token === null) return { ok: false, reason: 'another bridge on this machine has been fetching for too long' };
  try {
    const args = ['-y', '--prefer-online', '--ignore-scripts', `${PACKAGE}@${version}`, '--version'];
    let result = await deps.run(args, timeoutMs);
    if (result.error) {
      const broken = brokenNpxDir(`${result.stderr}\n${result.error.message}`, version);
      if (broken) {
        rmSync(broken, { recursive: true, force: true });
        result = await deps.run(args, timeoutMs);
      }
    }
    const said = result.stdout.trim().split('\n').pop()?.trim() ?? '';
    if (result.error) {
      return { ok: false, reason: result.killed ? 'timed out' : result.error.message.split('\n')[0] ?? 'failed' };
    }
    if (said !== version) return { ok: false, reason: `it reported version "${said}"` };
    return { ok: true };
  } finally {
    releaseLock(deps, token);
  }
}

/**
 * mkdir is atomic: whoever creates the directory holds the lock. The holder
 * writes a token of its own inside, so a release removes only ITS lock: a
 * fetch that ran past the stale age and was taken over must not then delete
 * the lock of the bridge that took over. A stale lock is taken over by
 * renaming it aside first, which only one process can do.
 *
 * Resolves with the token to release with, or null when the wait ran out.
 */
async function acquireLock(deps: PrefetchDeps): Promise<string | null> {
  mkdirSync(dirname(deps.lockDir), { recursive: true });
  const token = `${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const deadline = Date.now() + deps.lockWaitMs;
  for (;;) {
    try {
      mkdirSync(deps.lockDir);
      writeFileSync(join(deps.lockDir, 'owner'), token);
      return token;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
      try {
        if (Date.now() - statSync(deps.lockDir).mtimeMs > deps.lockStaleMs) {
          const aside = `${deps.lockDir}.stale-${token}`;
          renameSync(deps.lockDir, aside);
          rmSync(aside, { recursive: true, force: true });
          continue;
        }
      } catch {
        continue; // released, or taken over by someone else, in between
      }
    }
    if (Date.now() >= deadline) return null;
    await deps.sleep(2000);
  }
}

function releaseLock(deps: PrefetchDeps, token: string): void {
  try {
    if (readFileSync(join(deps.lockDir, 'owner'), 'utf8') !== token) return;
    const aside = `${deps.lockDir}.released-${token}`;
    renameSync(deps.lockDir, aside);
    rmSync(aside, { recursive: true, force: true });
  } catch { /* already gone, or not ours */ }
}

/**
 * The npx cache directory a "Cannot find module" error points into, when that
 * directory holds this very version of the bridge, so removing it is safe:
 * nothing runs from an install that cannot start. Null otherwise.
 */
export function brokenNpxDir(errorText: string, version: string): string | null {
  if (!/ERR_MODULE_NOT_FOUND|Cannot find (?:module|package)/.test(errorText)) return null;
  const m = /((?:\/|[A-Za-z]:\\)[^\s'"]*?[\/\\]_npx[\/\\][0-9a-f]+)[\/\\]node_modules[\/\\]/.exec(errorText);
  if (!m) return null;
  const dir = m[1]!;
  try {
    const pkg = JSON.parse(readFileSync(join(dir, 'node_modules', '@tetrixdev', 'ai-bridge', 'package.json'), 'utf8')) as { version?: string };
    return pkg.version === version ? dir : null;
  } catch {
    return null;
  }
}
