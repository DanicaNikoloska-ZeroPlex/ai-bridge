/**
 * The credentials an installed bridge runs with, and the rule about replacing
 * them.
 *
 * Kept in a file of their own rather than inside the unit, on every platform
 * that has somewhere to put one: unit files are world readable and
 * `systemctl cat` prints them, so a token in there is a token on screen the
 * next time somebody debugs the service.
 */
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { ATTACHMENT_ENV_KEYS } from '../attachments/options.js';

export interface BridgeConfig {
  server: string;
  token: string;
  /** Passed through to the bridge, so a reinstall does not quietly drop the
   *  folder somebody chose. */
  allowDir?: string | undefined;
  /**
   * The name the service was installed under. Written down so the running
   * bridge knows which install it is -- it keys the attachment store, which
   * must never be shared between two installs pointed at different servers.
   */
  name?: string | undefined;
  /**
   * Operator settings the bridge reads from its environment
   * (`AI_BRIDGE_ATTACHMENT_*`), keyed by variable name. In the file so that
   * systemd's EnvironmentFile hands them to the service on Linux and
   * `--env-file` reads them everywhere else.
   */
  settings?: Record<string, string> | undefined;
  /**
   * The bridge version the service runs, as AI_BRIDGE_VERSION. The unit
   * starts `@tetrixdev/ai-bridge@${AI_BRIDGE_VERSION}`, so this line is the
   * one thing to change to move it, and what self-update rewrites.
   */
  version?: string | undefined;
  /**
   * Engram's base address, as ENGRAM_URL: where a bridge started with
   * `--local-tools` enrols this machine's vault key and fetches space keys.
   * In the file rather than on the command line so the unit never carries a
   * value somebody typed (the flags there are a fixed short list).
   */
  engram?: string | undefined;
  /**
   * A file holding CLAUDE_CODE_OAUTH_TOKEN (a long-lived token from
   * `claude setup-token`), or several named ones and CLAUDE_TOKEN_ACTIVE, as
   * AI_BRIDGE_CLAUDE_ENV. A path, never a token: the tokens stay in one 0600
   * file of their own, read for every run, so renewing or switching is one
   * edit, and this file never holds a second copy.
   */
  claudeEnv?: string | undefined;
}

/** Keys this module writes. Anything else in the file belongs to somebody else. */
const OWN_KEYS = new Set([
  'AI_BRIDGE_SERVER', 'AI_BRIDGE_TOKEN', 'AI_BRIDGE_ALLOW_DIR', 'AI_BRIDGE_NAME', 'AI_BRIDGE_VERSION',
  'ENGRAM_URL', 'AI_BRIDGE_CLAUDE_ENV',
  ...ATTACHMENT_ENV_KEYS,
]);

function keyOf(line: string): string | null {
  const at = line.indexOf('=');
  if (at <= 0 || line.trimStart().startsWith('#')) return null;
  return line.slice(0, at).trim();
}

/** The device this pairing is for, read out of the server url rather than
 *  stored twice. It is what makes "the same install" answerable. */
export function deviceOf(server: string): string | null {
  try {
    return new URL(server).searchParams.get('device');
  } catch {
    return null;
  }
}

export function readConfig(path: string): BridgeConfig | null {
  if (!existsSync(path)) return null;
  const out: Record<string, string> = {};
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    const key = keyOf(line);
    if (key === null) continue;
    out[key] = line.slice(line.indexOf('=') + 1).trim();
  }
  if (!out['AI_BRIDGE_SERVER'] || !out['AI_BRIDGE_TOKEN']) return null;
  const settings: Record<string, string> = {};
  for (const key of ATTACHMENT_ENV_KEYS) {
    if (out[key]) settings[key] = out[key];
  }
  return {
    server: out['AI_BRIDGE_SERVER'],
    token: out['AI_BRIDGE_TOKEN'],
    allowDir: out['AI_BRIDGE_ALLOW_DIR'] || undefined,
    name: out['AI_BRIDGE_NAME'] || undefined,
    version: out['AI_BRIDGE_VERSION'] || undefined,
    ...(out['ENGRAM_URL'] ? { engram: out['ENGRAM_URL'] } : {}),
    ...(out['AI_BRIDGE_CLAUDE_ENV'] ? { claudeEnv: out['AI_BRIDGE_CLAUDE_ENV'] } : {}),
    ...(Object.keys(settings).length > 0 ? { settings } : {}),
  };
}

export function writeConfig(path: string, config: BridgeConfig): void {
  // One value per line is the file's whole grammar, so a line break inside a
  // value would write a second key of the caller's choosing.
  for (const [key, value] of Object.entries(config)) {
    if (typeof value === 'string' && /[\r\n]/.test(value)) throw new Error(`${key} must not contain a line break`);
  }
  for (const [key, value] of Object.entries(config.settings ?? {})) {
    if (/[\r\n]/.test(value)) throw new Error(`${key} must not contain a line break`);
  }
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  // Lines this module does not own are carried over as they were. A setup
  // script that added a variable of its own to this file would otherwise lose
  // it on every reinstall, silently, and the service would start without it.
  const foreign = existsSync(path)
    ? readFileSync(path, 'utf8').split('\n').filter((line) => {
      const key = keyOf(line);
      return key !== null && !OWN_KEYS.has(key);
    })
    : [];
  const settings = Object.entries(config.settings ?? {})
    .filter(([key, value]) => ATTACHMENT_ENV_KEYS.includes(key) && value !== '')
    .map(([key, value]) => `${key}=${value}`);
  const body = [
    `AI_BRIDGE_SERVER=${config.server}`,
    `AI_BRIDGE_TOKEN=${config.token}`,
    ...(config.allowDir ? [`AI_BRIDGE_ALLOW_DIR=${config.allowDir}`] : []),
    ...(config.name ? [`AI_BRIDGE_NAME=${config.name}`] : []),
    ...(config.version ? [`AI_BRIDGE_VERSION=${config.version}`] : []),
    ...(config.engram ? [`ENGRAM_URL=${config.engram}`] : []),
    ...(config.claudeEnv ? [`AI_BRIDGE_CLAUDE_ENV=${config.claudeEnv}`] : []),
    ...settings,
    ...foreign,
    '',
  ].join('\n');
  writeFileSync(path, body, { mode: 0o600 });
  // Set again explicitly: the mode above applies on CREATE, and a file that
  // already existed keeps whatever it had.
  chmodSync(path, 0o600);
}

/**
 * Whether an install under this name may overwrite what is already there.
 *
 * The same server and the same device is the same install -- somebody re-running
 * the setup to change a folder, or after an upgrade -- and replacing it is what
 * they asked for.
 *
 * Anything else is a different pairing wearing the same name, and replacing it
 * silently is the bug this module exists to prevent: the credentials are gone,
 * the machine keeps answering the old server until it restarts, and nothing
 * anywhere said so.
 */
export function replaceable(existing: BridgeConfig, next: BridgeConfig): true | string {
  const was = deviceOf(existing.server);
  const now = deviceOf(next.server);
  const sameHost = hostOf(existing.server) === hostOf(next.server);
  if (!sameHost) {
    return `it is paired to ${hostOf(existing.server)}, and this would point it at ${hostOf(next.server)}`;
  }
  if (was && now && was !== now) {
    return `it is paired as a different machine on ${hostOf(next.server)} (device ${was.slice(0, 8)}…)`;
  }
  return true;
}

function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}
