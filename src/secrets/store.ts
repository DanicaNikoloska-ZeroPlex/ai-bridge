/**
 * Machine secrets: the bridge's own secret store on this machine (decision
 * 0020, README "Machine secrets", PROTOCOL.md "Secrets on the machine").
 *
 * `~/.ai-bridge/secrets/` (0700), one file per secret named exactly like the
 * secret (0600 from the moment it exists), and `index.json` (0600) holding
 * each secret's description and when it was last written. The folder is the
 * truth about which secrets exist; the index only adds words and dates.
 *
 * What this module promises about a value:
 *   - it is written with mode 0600 from creation: a temp file opened
 *     O_CREAT|O_EXCL with mode 0600 in the same folder, fsynced, renamed over
 *     the name, so a reader sees the old value or the new one, never half;
 *   - it never appears in an error message, a log line, a listing or an
 *     answer: only `read()` returns one, and only `aib secret run` calls it;
 *   - the folder is refused, never repaired, when it is a symlink, not a
 *     directory, not owned by this user, or open to the group or others.
 */

import { constants, type Stats } from 'node:fs';
import { lstat, mkdir, open, readdir, readFile, rename, rmdir, stat, unlink, type FileHandle } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { homedir } from 'node:os';
import { join } from 'node:path';

/**
 * The revision of the `secret_*` frames this bridge answers
 * (`hello.machine_secrets.revision`). 2: `secret_put` refuses an existing name
 * with `exists` unless it carries `replace: true`, and its answer says whether
 * a secret was `replaced`.
 */
export const MACHINE_SECRETS_REVISION = 2;

/** 1 to 64 characters, letter or digit first. JavaScript's `$` does not match before a trailing newline. */
const NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u;
/** The one name in the folder that is not a secret. */
export const INDEX_FILE = 'index.json';
const LOCK_DIR = '.lock';
export const MAX_DESCRIPTION = 1000;
/** The largest value the server may send (`secret_put`). */
export const MAX_FRAME_VALUE_BYTES = 64 * 1024;
/** The largest value `aib secret add` or `import` takes from this machine. */
export const MAX_LOCAL_VALUE_BYTES = 1024 * 1024;
/** A lock older than this was left by a process that died; it is taken over. */
const STALE_LOCK_MS = 30_000;
const LOCK_WAIT_MS = 5_000;

export type SecretCode =
  | 'machine_secrets_unsupported'
  | 'store_unavailable'
  | 'not_found'
  | 'invalid_name'
  | 'invalid_request'
  | 'exists'
  | 'timeout'
  | 'failed';

/** A refusal with a code the server and the CLI are told. Its message never holds a value. */
export class SecretRefusal extends Error {
  constructor(public readonly code: SecretCode, message: string) {
    super(message);
    this.name = 'SecretRefusal';
  }
}

export interface SecretRow {
  name: string;
  description: string | null;
  /** When the value was last written, ISO 8601 UTC. */
  updated_at: string | null;
}

interface IndexEntry {
  description?: string | null;
  updated_at?: string | null;
}

/** `~/.ai-bridge/secrets`, the folder `aib secret` and the bridge share. */
export function defaultSecretsDir(home: string = homedir()): string {
  return join(home, '.ai-bridge', 'secrets');
}

/** Whether `name` may be a secret's name. */
export function isValidName(name: unknown): name is string {
  return typeof name === 'string' && NAME.test(name) && !name.includes('..') && name !== INDEX_FILE;
}

/** A name the store may use, or the refusal. */
export function checkName(name: unknown): string {
  if (!isValidName(name)) {
    throw new SecretRefusal(
      'invalid_name',
      'A secret name is 1 to 64 characters: letters, digits, ".", "_" and "-", starting with a letter or digit, without ".." (and not "index.json").',
    );
  }
  return name;
}

/** A description the store may keep, or the refusal. */
export function checkDescription(description: unknown): string {
  if (typeof description !== 'string') throw new SecretRefusal('invalid_request', 'The description must be text.');
  if ([...description].length > MAX_DESCRIPTION) {
    throw new SecretRefusal('invalid_request', `A description is at most ${MAX_DESCRIPTION} characters.`);
  }
  if (description.includes('\0')) throw new SecretRefusal('invalid_request', 'A description may not contain a NUL character.');
  return description;
}

/** A value the store may write, as bytes, or the refusal. Never echoes the value. */
export function checkValue(value: unknown, maxBytes: number): Buffer {
  let bytes: Buffer;
  if (typeof value === 'string') bytes = Buffer.from(value, 'utf8');
  else if (Buffer.isBuffer(value)) bytes = value;
  else throw new SecretRefusal('invalid_request', 'A secret needs a value.');
  if (bytes.length === 0) throw new SecretRefusal('invalid_request', 'A secret needs a value; it is empty.');
  if (bytes.length > maxBytes) {
    throw new SecretRefusal('invalid_request', `A secret value is at most ${Math.floor(maxBytes / 1024)} KiB.`);
  }
  return bytes;
}

function errno(err: unknown): string | undefined {
  return (err as NodeJS.ErrnoException | null)?.code;
}

export class MachineSecretStore {
  readonly dir: string;

  constructor(dir: string = defaultSecretsDir()) {
    this.dir = dir;
  }

  /** The names, descriptions and dates; never a value. Sorted by name. */
  async list(): Promise<SecretRow[]> {
    if (!(await this.checkDir(false))) return [];
    let entries: string[];
    try {
      entries = await readdir(this.dir);
    } catch {
      throw new SecretRefusal('store_unavailable', `The secret folder ${this.dir} cannot be read.`);
    }
    const index = await this.readIndex();
    const rows: SecretRow[] = [];
    for (const name of entries.sort()) {
      if (!isValidName(name)) continue; // index.json, dot files, temp files
      let st: Stats;
      try { st = await lstat(join(this.dir, name)); } catch { continue; }
      if (!st.isFile()) continue;
      const entry = index[name] ?? {};
      rows.push({
        name,
        description: typeof entry.description === 'string' && entry.description !== '' ? entry.description : null,
        updated_at: typeof entry.updated_at === 'string' ? entry.updated_at : st.mtime.toISOString(),
      });
    }
    return rows;
  }

  /** Whether a secret by this name exists. */
  async has(name: unknown): Promise<boolean> {
    const checkedName = checkName(name);
    if (!(await this.checkDir(false))) return false;
    return this.existingFile(join(this.dir, checkedName));
  }

  /**
   * Add a secret, or replace one when `replace` is true. An existing name is
   * refused with `exists` before anything is written.
   */
  async put(
    name: unknown,
    value: unknown,
    options: { replace?: boolean; description?: string | null | undefined; maxBytes?: number } = {},
  ): Promise<{ replaced: boolean }> {
    const checkedName = checkName(name);
    const bytes = checkValue(value, options.maxBytes ?? MAX_FRAME_VALUE_BYTES);
    const description = options.description === undefined || options.description === null || options.description === ''
      ? undefined
      : checkDescription(options.description);
    await this.checkDir(true);
    return this.locked(async () => {
      const target = join(this.dir, checkedName);
      const existed = await this.existingFile(target);
      if (existed && options.replace !== true) {
        throw new SecretRefusal('exists', `A secret called "${checkedName}" already exists; replace it deliberately.`);
      }
      await this.writeAtomic(target, bytes);
      const index = await this.readIndex();
      const before = index[checkedName] ?? {};
      index[checkedName] = {
        // A replace without a description keeps the one it had.
        description: description ?? (existed ? before.description ?? null : null),
        updated_at: new Date().toISOString(),
      };
      await this.writeIndex(index);
      return { replaced: existed };
    });
  }

  /** Change a secret's description; an empty text clears it. */
  async describe(name: unknown, description: unknown): Promise<void> {
    const checkedName = checkName(name);
    const text = checkDescription(description);
    if (!(await this.checkDir(false))) throw this.notFound(checkedName);
    await this.locked(async () => {
      if (!(await this.existingFile(join(this.dir, checkedName)))) throw this.notFound(checkedName);
      const index = await this.readIndex();
      index[checkedName] = { ...(index[checkedName] ?? {}), description: text === '' ? null : text };
      await this.writeIndex(index);
    });
  }

  /** Remove a secret and its index entry. */
  async remove(name: unknown): Promise<void> {
    const checkedName = checkName(name);
    if (!(await this.checkDir(false))) throw this.notFound(checkedName);
    await this.locked(async () => {
      const target = join(this.dir, checkedName);
      if (!(await this.existingFile(target))) throw this.notFound(checkedName);
      await unlink(target);
      const index = await this.readIndex();
      if (checkedName in index) {
        delete index[checkedName];
        await this.writeIndex(index);
      }
    });
  }

  /** The path of a secret's file, after checking it exists. */
  async path(name: unknown): Promise<string> {
    const checkedName = checkName(name);
    if (!(await this.checkDir(false))) throw this.notFound(checkedName);
    const target = join(this.dir, checkedName);
    if (!(await this.existingFile(target))) throw this.notFound(checkedName);
    return target;
  }

  /**
   * A secret's value. For `aib secret run` only: nothing that answers the
   * server reads a value. Opened without following a symlink.
   */
  async read(name: unknown): Promise<Buffer> {
    const target = await this.path(name);
    let fh: FileHandle;
    try {
      fh = await open(target, constants.O_RDONLY | constants.O_NOFOLLOW);
    } catch {
      throw new SecretRefusal('store_unavailable', `The secret "${String(name)}" cannot be opened.`);
    }
    try {
      return await fh.readFile();
    } finally {
      await fh.close();
    }
  }

  /**
   * Refuse a folder that is not safe to keep secrets in. With `create`, make
   * `~/.ai-bridge` and the folder (0700) when they are missing. Returns
   * whether the folder exists.
   */
  private async checkDir(create: boolean): Promise<boolean> {
    let st: Stats;
    try {
      st = await lstat(this.dir);
    } catch (err) {
      if (errno(err) !== 'ENOENT') throw new SecretRefusal('store_unavailable', `The secret folder ${this.dir} cannot be read.`);
      if (!create) return false;
      try {
        await mkdir(this.dir, { recursive: true, mode: 0o700 });
        st = await lstat(this.dir);
      } catch {
        throw new SecretRefusal('store_unavailable', `The secret folder ${this.dir} cannot be created.`);
      }
    }
    if (st.isSymbolicLink()) {
      throw new SecretRefusal('store_unavailable', `The secret folder ${this.dir} is a symlink; refusing to use it.`);
    }
    if (!st.isDirectory()) throw new SecretRefusal('store_unavailable', `The secret folder ${this.dir} is not a directory.`);
    const uid = typeof process.getuid === 'function' ? process.getuid() : undefined;
    if (uid !== undefined && st.uid !== uid) {
      throw new SecretRefusal('store_unavailable', `The secret folder ${this.dir} is not owned by this user; refusing to use it.`);
    }
    if (process.platform !== 'win32' && (st.mode & 0o077) !== 0) {
      throw new SecretRefusal(
        'store_unavailable',
        `The secret folder ${this.dir} is open to other users (mode ${(st.mode & 0o777).toString(8)}); run chmod 700 on it.`,
      );
    }
    return true;
  }

  private async existingFile(target: string): Promise<boolean> {
    let st: Stats;
    try {
      st = await lstat(target);
    } catch {
      return false;
    }
    if (!st.isFile()) throw new SecretRefusal('store_unavailable', `${target} is not a regular file; remove it by hand.`);
    return true;
  }

  private notFound(name: string): SecretRefusal {
    return new SecretRefusal('not_found', `No secret called "${name}".`);
  }

  /** Temp file 0600 with O_EXCL in the same folder, fsync, rename. */
  private async writeAtomic(target: string, bytes: Buffer): Promise<void> {
    const tmp = join(this.dir, `.tmp-${process.pid}-${randomBytes(6).toString('hex')}`);
    let fh: FileHandle | undefined;
    try {
      fh = await open(tmp, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
      await fh.writeFile(bytes);
      await fh.sync();
      await fh.close();
      fh = undefined;
      await rename(tmp, target);
    } catch (err) {
      if (fh !== undefined) { try { await fh.close(); } catch { /* already closed */ } }
      try { await unlink(tmp); } catch { /* never created, or renamed */ }
      throw new SecretRefusal('failed', `Could not write to the secret folder ${this.dir} (${errno(err) ?? 'error'}).`);
    }
    try {
      const dir = await open(this.dir, constants.O_RDONLY);
      try { await dir.sync(); } finally { await dir.close(); }
    } catch { /* not every platform fsyncs a directory */ }
  }

  private async readIndex(): Promise<Record<string, IndexEntry>> {
    let text: string;
    try {
      text = await readFile(join(this.dir, INDEX_FILE), 'utf8');
    } catch {
      return {};
    }
    const out: Record<string, IndexEntry> = {};
    try {
      const secrets = (JSON.parse(text) as { secrets?: unknown })?.secrets;
      if (typeof secrets !== 'object' || secrets === null || Array.isArray(secrets)) return out;
      for (const [name, entry] of Object.entries(secrets as Record<string, unknown>)) {
        if (isValidName(name) && typeof entry === 'object' && entry !== null) out[name] = entry as IndexEntry;
      }
    } catch {
      // A damaged index loses descriptions, never secrets: the folder is the truth.
    }
    return out;
  }

  private async writeIndex(index: Record<string, IndexEntry>): Promise<void> {
    const sorted: Record<string, IndexEntry> = {};
    for (const name of Object.keys(index).sort()) sorted[name] = index[name]!;
    await this.writeAtomic(join(this.dir, INDEX_FILE), Buffer.from(`${JSON.stringify({ version: 1, secrets: sorted }, null, 2)}\n`));
  }

  /**
   * One writer at a time across processes (the bridge and `aib secret`): a
   * lock directory, taken over when it is older than STALE_LOCK_MS.
   */
  private async locked<T>(fn: () => Promise<T>): Promise<T> {
    const lock = join(this.dir, LOCK_DIR);
    const deadline = Date.now() + LOCK_WAIT_MS;
    for (;;) {
      try {
        await mkdir(lock, { mode: 0o700 });
        break;
      } catch (err) {
        if (errno(err) !== 'EEXIST') throw new SecretRefusal('failed', `Could not lock the secret folder ${this.dir}.`);
        try {
          if (Date.now() - (await stat(lock)).mtimeMs > STALE_LOCK_MS) { await rmdir(lock); continue; }
        } catch { continue; }
        if (Date.now() > deadline) {
          throw new SecretRefusal('failed', `The secret folder ${this.dir} is busy (${lock} is held); try again.`);
        }
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
    }
    try {
      return await fn();
    } finally {
      try { await rmdir(lock); } catch { /* taken over as stale */ }
    }
  }
}
