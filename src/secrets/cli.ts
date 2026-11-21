/**
 * `aib secret ...`: the machine's own commands for the secret store
 * (src/secrets/store.ts, decision 0020). They work whether or not a bridge
 * runs with --machine-secrets: that flag only decides whether a SERVER may
 * manage the store. No command here prints a value.
 */

import { lstat, readdir, readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import type { Command } from 'commander';
import { MAX_LOCAL_VALUE_BYTES, SecretRefusal, MachineSecretStore, checkValue, isValidName, printable } from './store.js';
import { checkEnvName, runWithSecret } from './run.js';
import { listBridges } from '../service/index.js';

/** One line on whether any installed bridge lets its server manage the store. */
function serverAccessLine(): string {
  let names: string[] = [];
  try {
    names = listBridges().filter((b) => b.machineSecrets).map((b) => b.name);
  } catch { /* no installed bridges to ask */ }
  return names.length
    ? `Machine secrets: on for ${names.join(', ')} (that server may list, add, replace, describe and remove; never read).`
    : 'Machine secrets: off (no installed bridge has --machine-secrets; only this machine manages the store).';
}

function fail(err: unknown): never {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(err instanceof SecretRefusal && err.code === 'not_found' ? 2 : 1);
}

/**
 * The value from stdin. Piped: everything, less ONE trailing newline (what
 * `echo` and most editors add). A terminal: one line, not echoed.
 */
async function readValueFromStdin(): Promise<Buffer> {
  const stdin = process.stdin;
  if (stdin.isTTY) return readHiddenLine();
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of stdin) {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
    size += buf.length;
    if (size > MAX_LOCAL_VALUE_BYTES + 2) throw new SecretRefusal('invalid_request', `A secret value is at most ${MAX_LOCAL_VALUE_BYTES / 1024} KiB.`);
    chunks.push(buf);
  }
  let value = Buffer.concat(chunks);
  if (value.length && value[value.length - 1] === 0x0a) {
    value = value.subarray(0, value.length - (value.length > 1 && value[value.length - 2] === 0x0d ? 2 : 1));
  }
  return value;
}

/**
 * A value from a file: a regular file (not a device or a FIFO, which could
 * be read without end), size checked before it is read.
 */
async function readValueFile(path: string): Promise<Buffer> {
  const st = await lstat(path).catch(() => null);
  if (!st) throw new Error(`${path} does not exist`);
  if (!st.isFile()) throw new Error(`${path} is not a regular file`);
  if (st.size > MAX_LOCAL_VALUE_BYTES) throw new SecretRefusal('invalid_request', `A secret value is at most ${MAX_LOCAL_VALUE_BYTES / 1024} KiB.`);
  return readFile(path);
}

/** One line for a terminal: control characters shown escaped, newlines as spaces. */
function oneLine(text: string): string {
  return printable(text).replace(/[\r\n\t]+/g, ' ');
}

function readHiddenLine(): Promise<Buffer> {
  return new Promise((resolvePromise, reject) => {
    const stdin = process.stdin;
    process.stderr.write('Value (not shown, Enter to finish): ');
    const bytes: number[] = [];
    stdin.setRawMode(true);
    stdin.resume();
    const finish = (err?: Error): void => {
      stdin.setRawMode(false);
      stdin.pause();
      stdin.off('data', onData);
      process.stderr.write('\n');
      if (err) reject(err);
      else resolvePromise(Buffer.from(bytes));
    };
    const onData = (chunk: Buffer): void => {
      for (const byte of chunk) {
        if (byte === 0x0d || byte === 0x0a) return finish();
        if (byte === 0x03 || byte === 0x04) return finish(new Error('Cancelled; nothing was saved.'));
        if (byte === 0x7f || byte === 0x08) {
          // One character, which in UTF-8 may be several bytes: its continuation bytes, then its lead.
          while (bytes.length && (bytes[bytes.length - 1]! & 0xc0) === 0x80) bytes.pop();
          bytes.pop();
          continue;
        }
        bytes.push(byte);
      }
    };
    stdin.on('data', onData);
  });
}

export interface ImportReport {
  imported: string[];
  skipped: Array<{ name: string; reason: string }>;
}

/**
 * Copy a folder of one-file-per-secret into the store, with descriptions from
 * an optional `.desc/<name>` folder beside them. Dot files are skipped, and
 * so is anything that is not a regular file. The folder is only read.
 */
export async function importFolder(store: MachineSecretStore, folder: string, options: { replace?: boolean } = {}): Promise<ImportReport> {
  const root = resolve(folder);
  const st = await lstat(root).catch(() => null);
  if (!st || !st.isDirectory()) throw new Error(`${root} is not a folder`);
  const report: ImportReport = { imported: [], skipped: [] };
  for (const name of (await readdir(root)).sort()) {
    if (name.startsWith('.')) continue;
    const path = join(root, name);
    const entry = await lstat(path);
    if (!entry.isFile()) {
      report.skipped.push({ name, reason: entry.isSymbolicLink() ? 'a symlink' : 'not a regular file' });
      continue;
    }
    if (!isValidName(name)) {
      report.skipped.push({ name, reason: 'not a valid secret name' });
      continue;
    }
    let description: string | undefined;
    const descPath = join(root, '.desc', name);
    const desc = await lstat(descPath).catch(() => null);
    if (desc?.isFile() && desc.size <= 64 * 1024) {
      description = (await readFile(descPath, 'utf8')).trim() || undefined;
    }
    try {
      const value = checkValue(await readValueFile(path), MAX_LOCAL_VALUE_BYTES);
      await store.put(name, value, { replace: !!options.replace, description, maxBytes: MAX_LOCAL_VALUE_BYTES });
      report.imported.push(name);
    } catch (err) {
      if (err instanceof SecretRefusal) {
        report.skipped.push({ name, reason: err.code === 'exists' ? 'exists (use --replace)' : err.message });
      } else {
        report.skipped.push({ name, reason: 'could not be read' });
      }
    }
  }
  return report;
}

export function registerSecretCommands(program: Command, storeFor: () => MachineSecretStore = () => new MachineSecretStore()): void {
  const secret = program
    .command('secret')
    .description('The secret store on this machine (~/.ai-bridge/secrets): add, describe, remove, run a command with one. Never prints a value.');

  secret
    .command('list')
    .description('Names, descriptions and when each was written (never a value)')
    .action(async () => {
      try {
        const store = storeFor();
        const rows = await store.list();
        if (!rows.length) {
          console.log(`No secrets in ${store.dir}. \`aib secret add <name>\` adds one (the value from stdin).`);
        } else {
          const width = Math.max(...rows.map((r) => r.name.length), 4);
          for (const r of rows) {
            console.log(`${r.name.padEnd(width)}  ${(r.updated_at ?? '').slice(0, 19).replace('T', ' ')}  ${oneLine(r.description ?? '')}`.trimEnd());
          }
        }
        console.error(serverAccessLine());
      } catch (err) { fail(err); }
    });

  secret
    .command('add')
    .description('Add a secret; the value is read from stdin (or --from-file), never from an argument')
    .argument('<name>', 'Letters, digits, ".", "_" and "-", starting with a letter or digit')
    .option('--description <text>', 'What it is for')
    .option('--replace', 'Overwrite a secret of the same name')
    .option('--from-file <path>', 'Read the value from this file, as it is')
    .action(async (name: string, opts: { description?: string; replace?: boolean; fromFile?: string }) => {
      try {
        const store = storeFor();
        // Refuse a taken name before asking for the value.
        if (!opts.replace && await store.has(name)) {
          throw new SecretRefusal('exists', `A secret called "${name}" already exists; add --replace to overwrite it.`);
        }
        const value = opts.fromFile !== undefined ? await readValueFile(resolve(opts.fromFile)) : await readValueFromStdin();
        const { replaced } = await store.put(name, value, {
          replace: !!opts.replace, description: opts.description, maxBytes: MAX_LOCAL_VALUE_BYTES,
        });
        console.log(`${replaced ? 'Replaced' : 'Added'} "${name}" (${value.length} bytes) in ${store.dir}.`);
      } catch (err) { fail(err); }
    });

  secret
    .command('describe')
    .description('Set what a secret is for ("" clears it)')
    .argument('<name>')
    .argument('<text>')
    .action(async (name: string, text: string) => {
      try {
        await storeFor().describe(name, text);
        console.log(`Described "${name}".`);
      } catch (err) { fail(err); }
    });

  secret
    .command('remove')
    .description('Delete a secret for good (needs --yes)')
    .argument('<name>')
    .option('--yes', 'Really delete it')
    .action(async (name: string, opts: { yes?: boolean }) => {
      try {
        const store = storeFor();
        if (!opts.yes) {
          await store.path(name); // not_found first, if it is
          throw new Error(`Removing "${name}" cannot be undone; run again with --yes.`);
        }
        await store.remove(name);
        console.log(`Removed "${name}".`);
      } catch (err) { fail(err); }
    });

  secret
    .command('path')
    .description("Print a secret's file path (for a program that reads a file)")
    .argument('<name>')
    .action(async (name: string) => {
      try {
        console.log(await storeFor().path(name));
      } catch (err) { fail(err); }
    });

  secret
    .command('run')
    .description('Run a command with a secret: SECRET_FILE and SECRET_NAME set, "{SECRET_FILE}" in arguments replaced, its values masked in the output')
    .argument('<name>')
    // Everything after `--` is the command, word for word: an option there is
    // the command's, never ours.
    .argument('<command...>', 'The command and its arguments, after --')
    .option('--env <VAR>', 'Also put the content (trimmed) in this environment variable')
    .option('--dotenv', 'Also set every KEY=VALUE line of the secret as a variable')
    .option('--no-mask', 'Let the output through unfiltered (and keep the terminal)')
    .action(async (name: string, command: string[], opts: { env?: string; dotenv?: boolean; mask: boolean }) => {
      try {
        if (opts.env !== undefined) checkEnvName(opts.env);
        const store = storeFor();
        const path = await store.path(name);
        // Not process.exit(): on macOS a write to a pipe is asynchronous, and
        // exiting at once could cut off the end of the command's output.
        process.exitCode = await runWithSecret({
          name, path, content: await store.read(name), envVar: opts.env, dotenv: !!opts.dotenv, mask: opts.mask, command,
        });
      } catch (err) { fail(err); }
    });

  secret
    .command('import')
    .description('Copy a folder of one file per secret (and .desc/<name> descriptions) into the store; the folder is left as it is')
    .argument('<folder>')
    .option('--replace', 'Overwrite secrets that already exist')
    .action(async (folder: string, opts: { replace?: boolean }) => {
      try {
        const store = storeFor();
        const report = await importFolder(store, folder, { replace: !!opts.replace });
        console.log(`Imported ${report.imported.length} into ${store.dir}${report.imported.length ? `: ${report.imported.join(', ')}` : ''}.`);
        for (const s of report.skipped) console.log(`Skipped ${oneLine(s.name)}: ${s.reason}`);
      } catch (err) { fail(err); }
    });
}
