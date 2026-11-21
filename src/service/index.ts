/**
 * Installing, removing and listing the bridges on this machine.
 *
 * The rule this module exists for: a second install JOINS unless it is plainly
 * the same install again. Before, every install wrote the same two paths, so
 * pointing a machine at a test server took its production pairing with it --
 * and said "ok" while doing it, because nothing restarts a running service on
 * `enable --now`, so the machine went on answering the old server until the next
 * reboot and then answered the new one instead.
 */
import { readdirSync, existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { BridgeConfig } from './config.js';
import { deviceOf, readConfig, replaceable, writeConfig } from './config.js';
import { nameFromServer, normaliseName, pathsFor } from './naming.js';
import { install as installService, status, supported, uninstall as removeService } from './platform.js';
import { BRIDGE_VERSION } from '../protocol/version.js';

export { nameFromServer, normaliseName, pathsFor } from './naming.js';
export { deviceOf, readConfig } from './config.js';

/** The credentials a service was installed with, for the bridge that service
 *  starts. Absent or unreadable is not an error here: the flags and the
 *  environment are still there to supply them, and saying so twice would make a
 *  perfectly ordinary run look broken. */
export function readEnvFile(path: string): {
  server?: string; token?: string; allowDir?: string; name?: string; settings?: Record<string, string>;
  engram?: string; claudeEnv?: string; machineSecrets?: boolean;
} {
  const config = readConfig(path);
  if (!config) return {};
  return {
    server: config.server, token: config.token, allowDir: config.allowDir,
    name: config.name, settings: config.settings ?? {},
    ...(config.engram ? { engram: config.engram } : {}),
    ...(config.claudeEnv ? { claudeEnv: config.claudeEnv } : {}),
    ...(config.machineSecrets ? { machineSecrets: true } : {}),
  };
}

export interface InstallRequest extends BridgeConfig {
  /** Left out, this is derived from the server's address: one bridge per
   *  Engram, which is what people actually run. */
  name?: string | undefined;
  /** Replace a pairing that is NOT obviously the same one. Never the default:
   *  the whole point is that overwriting somebody's other server is a decision,
   *  not a side effect. */
  force?: boolean | undefined;
  /**
   * Switches the service passes to the bridge on every start, such as
   * `--allow-native` or `--local-tools`. Written into the unit, not the env
   * file: they are what the bridge is allowed to do, decided by whoever
   * installs it, and a reinstall without them takes them away.
   */
  flags?: string[] | undefined;
}

export interface Installed {
  name: string;
  server: string;
  device: string | null;
  allowDir: string | undefined;
  /** Whether this install lets the server manage the machine's secret store. */
  machineSecrets: boolean;
  state: string;
}

/**
 * What an install writes, given what it replaces.
 *
 * Settings carry over from the install being replaced unless given again.
 * Rotating a token is a reinstall, and it must not quietly put the size caps
 * somebody chose back to their defaults.
 */
export function configForInstall(req: InstallRequest, name: string, existing: BridgeConfig | null): BridgeConfig {
  return {
    server: req.server,
    token: req.token,
    allowDir: req.allowDir,
    name,
    settings: { ...existing?.settings, ...req.settings },
    // Engram's address goes with --local-tools, which is given again on every
    // install or taken away; so is this. The Claude token file is carried
    // over: a reinstall to change a folder must not sign the service out.
    // An empty string given on purpose removes it.
    engram: req.engram || undefined,
    claudeEnv: (req.claudeEnv ?? existing?.claudeEnv) || undefined,
    // An operator opt-in like --local-tools: given again on every install,
    // or machine secrets are off. Never carried over.
    machineSecrets: req.machineSecrets === true,
    // The version doing the install is the version installed. From here on
    // the server's desired version moves it (src/selfupdate/), or a person
    // edits this one line.
    version: BRIDGE_VERSION,
  };
}

export function installBridge(req: InstallRequest): { name: string; replaced: boolean } {
  if (!supported()) {
    throw new Error(
      'installing a background service is supported on Linux and macOS. On Windows, run the bridge in a window, '
      + 'or use a scheduled task pointing at the same command.',
    );
  }
  const name = req.name ? normaliseName(req.name) : nameFromServer(req.server);
  const paths = pathsFor(name);
  const existing = readConfig(paths.env);
  const next = configForInstall(req, name, existing);

  let replaced = false;
  if (existing) {
    const verdict = replaceable(existing, next);
    if (verdict !== true && !req.force) {
      throw new Error(
        `"${name}" is already installed and ${verdict}.\n`
        + `Give this one a name of its own with --name, or pass --force to replace what is there.`,
      );
    }
    replaced = true;
  }

  writeConfig(paths.env, next);
  installService(paths, next, req.flags ?? []);
  return { name, replaced };
}

export function uninstallBridge(rawName: string): void {
  const name = normaliseName(rawName);
  const paths = pathsFor(name);
  if (!existsSync(paths.env) && !existsSync(paths.unit)) {
    throw new Error(`no bridge called "${name}" is installed here.`);
  }
  removeService(paths);
}

/** Every bridge installed for this user, whatever it is currently doing. */
export function listBridges(): Installed[] {
  const dir = join(homedir(), '.config', 'ai-bridge');
  if (!existsSync(dir)) return [];
  const out: Installed[] = [];
  for (const file of readdirSync(dir)) {
    if (!file.endsWith('.env')) continue;
    const name = file.slice(0, -'.env'.length);
    const config = readConfig(join(dir, file));
    if (!config) continue;
    out.push({
      name,
      server: config.server,
      device: deviceOf(config.server),
      allowDir: config.allowDir,
      machineSecrets: config.machineSecrets === true,
      state: status(pathsFor(name)),
    });
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}
