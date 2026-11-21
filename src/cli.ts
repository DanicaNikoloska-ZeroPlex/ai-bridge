/**
 * CLI Entry Point for @tetrixdev/ai-bridge
 *
 * Parses command-line arguments, detects local AI CLI providers,
 * creates a Bridge instance, and connects to the server.
 *
 * Usage:
 *   npx @tetrixdev/ai-bridge --server wss://example.com/api/ai-bridge/ws --token <token>
 *   AI_BRIDGE_TOKEN=xxx AI_BRIDGE_SERVER=wss://... npx @tetrixdev/ai-bridge
 *   npx @tetrixdev/ai-bridge --server wss://... --token <token> --test
 */

import { readUpstreamConfig } from './mcp/upstream.js';
import { realpathSync } from 'node:fs';
import { homedir, hostname } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Command } from 'commander';
import { Bridge, FatalBridgeError } from './bridge.js';
import { detectProviders } from './providers/detector.js';
import { CodexAdapter } from './providers/codex.js';
import { ClaudeAdapter } from './providers/claude.js';
import { GeminiAdapter } from './providers/gemini.js';
import type { ProviderAdapter } from './providers/base.js';
import { handleTestRequest } from './test-mode.js';
import { setDebug, setLogFile, closeLogFile, createLogger } from './utils/logger.js';
import { BRIDGE_VERSION, PROTOCOL_VERSION } from './protocol/version.js';
import { loadOrCreateIdentity, saveIdentity, fingerprint, type Identity } from './local/identity.js';
import { buildAllowedRoots, type AllowedRoot } from './workspace/allowlist.js';
import { resolveApiOrigin } from './attachments/origin.js';
import { enrol, type EngramConfig } from './local/engram.js';
import { listClaudeLogins, runningClaudeProcesses, saveClaudeLogin, useClaudeLogin } from './providers/claude-login.js';
import { CLAUDE_TOKEN_KEY, listClaudeTokens, loadClaudeToken, useClaudeToken, useClaudeTokenFile } from './providers/claude-token.js';
import { registerSecretCommands } from './secrets/cli.js';
import { defaultSecretsDir } from './secrets/store.js';
import { installBridge, listBridges, pathsFor, readEnvFile, uninstallBridge } from './service/index.js';
import { SelfUpdater } from './selfupdate/updater.js';
import { detect as detectService, locateTokenFile, pinVersion, prefetch, tokenSaver, type TokenFile } from './selfupdate/service.js';
import {
  ATTACHMENT_OPTIONS,
  resolveAttachmentSettings,
  validateAttachmentOptions,
  type AttachmentOptionValues,
  type ResolvedAttachmentSettings,
} from './attachments/options.js';

const log = createLogger('CLI');

/** The parts of BridgeOptions the operator's own flags decide. */
export interface OperatorPosture {
  allowedRoots: AllowedRoot[];
  apiOrigin: string;
  attachmentLimits: ResolvedAttachmentSettings['limits'];
  attachmentTimeouts: ResolvedAttachmentSettings['timeouts'];
  attachmentCache: ResolvedAttachmentSettings['cache'];
  allowNative: boolean;
  keepAttachments: boolean;
  servedFilesPath: string;
  /** Whether a request may ask for web search on an isolated Claude turn (--allow-web-search, decision 0016). */
  webSearch: boolean;
  /** Whether a server may manage this machine's secret store (--machine-secrets, decision 0020). */
  machineSecrets: boolean;
}

/** Just the option fields this mapping reads. */
export interface OperatorOptions extends AttachmentOptionValues {
  allowDir: string[];
  api?: string;
  allowNative: boolean;
  keepAttachments: boolean;
  /** true from `--allow-web-search`; absent or false means no request may ask for it. */
  allowWebSearch?: boolean;
  /** true from `--machine-secrets` (or AI_BRIDGE_MACHINE_SECRETS=1); absent or false means off. */
  machineSecrets?: boolean;
  /** The install this run is, when a service started it: from AI_BRIDGE_NAME
   *  or the env file. It keeps one install's attachment store from another's. */
  installName?: string | undefined;
}

/**
 * Turn the operator's flags into the options that decide what a server may do.
 *
 * A named, exported, pure function rather than five expressions inline in the
 * action handler — because this is the single most load-bearing wire in the
 * package and nothing could reach it otherwise. Hardcoding `allowNative: true`
 * in the handler used to leave the whole suite green: every test builds a
 * `Bridge` directly, so they prove `adoptIsolation` honours the field and
 * never that the flag reaches it. A rename on either side of that assignment
 * silently opens or closes the gate.
 *
 * @throws Error when an option is unusable. The caller reports and exits.
 */
export function resolveOperatorPosture(
  opts: OperatorOptions,
  serverUrl: string,
  env: NodeJS.ProcessEnv,
): OperatorPosture {
  const attachments = resolveAttachmentSettings(opts, serverUrl, opts.installName);
  return {
    allowedRoots: buildAllowedRoots(opts.allowDir, env['AI_BRIDGE_ALLOWED_DIRS']),
    apiOrigin: resolveApiOrigin(serverUrl, opts.api),
    attachmentLimits: attachments.limits,
    attachmentTimeouts: attachments.timeouts,
    attachmentCache: attachments.cache,
    allowNative: opts.allowNative,
    keepAttachments: opts.keepAttachments,
    servedFilesPath: attachments.servedFilesPath,
    // Off unless the operator passes the flag, like --allow-native: a flag on
    // the command line works the same under systemd, launchd and by hand.
    webSearch: opts.allowWebSearch === true,
    machineSecrets: opts.machineSecrets === true,
  };
}

/** Whether an environment value turns a switch on: 1, true or yes. */
function envSwitch(value: string | undefined): boolean {
  return value !== undefined && ['1', 'true', 'yes'].includes(value.trim().toLowerCase());
}

// ---------------------------------------------------------------------------
// CLI Definition
// ---------------------------------------------------------------------------

const program = new Command();

// Options after a subcommand name belong to that subcommand.
//
// Without this, the program's own `-s, --server` swallows `install --server`
// and the subcommand reports the option missing while it is plainly there --
// because the two share a flag, which they should: it is the same thing being
// named, once to connect now and once to record for later.
program.enablePositionalOptions();

program
  .name('ai-bridge')
  .description('Local CLI bridge for AI web apps — connects Codex, Claude, and Gemini to your web application via WebSocket')
  .version(BRIDGE_VERSION)
  .option(
    '-t, --token <token>',
    'Authentication token (or set AI_BRIDGE_TOKEN env var)',
    process.env['AI_BRIDGE_TOKEN'],
  )
  .option(
    '-s, --server <url>',
    'WebSocket server URL (or set AI_BRIDGE_SERVER env var)',
    process.env['AI_BRIDGE_SERVER'],
  )
  .option(
    '-d, --debug',
    'Enable verbose debug logging',
    false,
  )
  .option(
    '--test',
    'Test mode — respond to AI requests with mock streaming data (--server and --token still required for the WebSocket connection)',
    false,
  )
  .option(
    '--local-tools',
    'Allow this server to run tools on THIS MACHINE, as you. Off unless you pass it: without it a tool marked execute:"local" is refused, whatever the server sends. Needed for Engram secrets.',
    false,
  )
  .option(
    '--engram <url>',
    'Engram base URL, for resolving secrets into local tools (or set ENGRAM_URL). Only used with --local-tools.',
    process.env['ENGRAM_URL'],
  )
  .option(
    '--claude-env <file>',
    'A file holding CLAUDE_CODE_OAUTH_TOKEN=<token> from `claude setup-token` (or named CLAUDE_CODE_OAUTH_TOKEN_<NAME> tokens and CLAUDE_TOKEN_ACTIVE=<name>), for a machine nobody signs into interactively (or set AI_BRIDGE_CLAUDE_ENV). Read for every Claude run; switch with `ai-bridge claude-token use`. Must be readable only by you (chmod 600). A token already in the environment wins.',
    process.env['AI_BRIDGE_CLAUDE_ENV'] || undefined,
  )
  .option(
    '--engram-token <token>',
    'Bearer credential for Engram (or set ENGRAM_TOKEN). Defaults to --token.',
    process.env['ENGRAM_TOKEN'],
  )
  .option(
    '--device-label <label>',
    'How this machine appears when you approve it in the browser. Defaults to its hostname. ' +
      'Ignored when the bridge token is for a machine already paired for chat: the key goes onto ' +
      'that machine, under the name it was paired with.',
  )
  .option(
    '--device-mode <mode>',
    'transcript | isolated. Self-reported and recorded as such: no server can verify it. Say what is true.',
    'transcript',
  )
  .option(
    '--local-data-dir <path>',
    'Where the bridge installs the npm packages local tools live in, one directory per space (default ~/.ai-bridge).',
    process.env['AI_BRIDGE_DATA_DIR'] ?? join(homedir(), '.ai-bridge'),
  )
  .option(
    '--identity-file <path>',
    'Where this device keeps its keypair. The private half never leaves this machine.',
    process.env['ENGRAM_IDENTITY'] ?? join(homedir(), '.engram', 'device.json'),
  )
  .option(
    '--allow-dir <path>',
    'Permit the server to run turns in this directory (repeatable). Format: <path>[=<label>], '
    + 'where the label is what the workspace picker shows. Off unless you pass it: without it a '
    + 'request naming a working directory is refused, whatever the server sends. '
    + 'Read the security note in the README first — this bounds where the assistant STARTS, not what it can reach.',
    (value: string, previous: string[]) => previous.concat([value]),
    [] as string[],
  )
  .option(
    '--allow-native',
    'Permit the server to select `native` isolation — the CLI\'s full local environment, including '
    + 'your own MCP servers, hooks, plugins and a shell. Off unless you pass it. Only for a bridge '
    + 'you run against your own machine, never one reachable by end users.',
    false,
  )
  .option(
    '--api <url>',
    'Base URL of the server HTTP API for attachments, when it is not the same host as --server '
    + '(or set AI_BRIDGE_API). Defaults to the https:// origin of --server.',
    process.env['AI_BRIDGE_API'],
  )
  .option(
    '--no-self-update',
    'Do not follow the version the server asks this bridge to run (or set AI_BRIDGE_SELF_UPDATE=0). '
    + 'For pinning by hand. Self-update only ever acts when the bridge runs as a systemd service whose '
    + 'unit starts @tetrixdev/ai-bridge@${AI_BRIDGE_VERSION}; anywhere else it just logs.',
  )
  .option(
    '--allow-web-search',
    'Permit the server to give an isolated Claude turn Claude Code\'s built-in WebSearch tool (options.web_search), '
    + 'and no other built-in tool. Off unless you pass it. Searches run at Anthropic on your Claude account, with '
    + 'words the model takes from the turn; they reach no file or command on this machine.',
    false,
  )
  .option(
    '--machine-secrets',
    'Let the server manage the secret store on THIS MACHINE (~/.ai-bridge/secrets): list it, add or replace a '
    + 'secret, change a description, remove one; never read a value back. Off unless you pass it (or set '
    + 'AI_BRIDGE_MACHINE_SECRETS=1). `aib secret ...` works on the store either way.',
    envSwitch(process.env['AI_BRIDGE_MACHINE_SECRETS']),
  )
  .option(
    '--keep-attachments',
    'Keep downloaded attachments after a turn instead of deleting them. Debugging aid.',
    false,
  );

// Each attachment setting takes its flag, then its environment variable. No
// commander default: unset has to stay distinguishable from "set to the
// default", or the env file (lowest precedence) could never fill it in.
for (const option of ATTACHMENT_OPTIONS) {
  program.option(option.flag, `${option.description} Or set ${option.env}.`, process.env[option.env] || undefined);
}

program
  .option(
    '--env-file <path>',
    'Read AI_BRIDGE_SERVER, AI_BRIDGE_TOKEN, AI_BRIDGE_ALLOW_DIR and the AI_BRIDGE_ATTACHMENT_* settings from this file. What `ai-bridge install` points a service at, so a token lives in one file with one owner rather than inside a service definition anybody can print.',
  )
  .option(
    '--mcp-upstreams <file>',
    'A JSON file of MCP servers this bridge connects to and offers to the CLI beside the server\'s tools ({"mcpServers": {"name": {"command", "args", "env"} | {"url", "headers"} | {"url", "auth": "oauth"}}}; secrets as {"env": "VAR"} or {"vault": {...}}; "auth": "oauth" signs in through the web application, tokens kept in AI_BRIDGE_DATA_DIR/mcp-oauth; see docs/mcp-upstreams.md). Their MCP App views are passed on to the server. Or set AI_BRIDGE_MCP_UPSTREAMS.',
    process.env['AI_BRIDGE_MCP_UPSTREAMS'],
  )
  .option(
    '--log-file <path>',
    'Also append logs to this file (or set AI_BRIDGE_LOG_FILE env var). Rotates once past 5 MB, keeping one previous copy.',
    process.env['AI_BRIDGE_LOG_FILE'],
  )
  .action(async (opts: {
    token?: string; server?: string; debug: boolean; test: boolean; logFile?: string;
    localTools: boolean; engram?: string; engramToken?: string; claudeEnv?: string;
    deviceLabel?: string; deviceMode: string; identityFile: string; localDataDir: string;
    allowDir: string[]; api?: string; keepAttachments: boolean; allowNative: boolean;
    envFile?: string; installName?: string; selfUpdate: boolean; mcpUpstreams?: string;
    allowWebSearch: boolean; machineSecrets: boolean;
  } & AttachmentOptionValues) => {
    opts.installName = process.env['AI_BRIDGE_NAME'] || undefined;
    // Before anything reads server or token. The file is the lowest precedence
    // of the three sources -- a flag or an environment variable still wins --
    // so a service can be pointed at one and still be overridden by hand for a
    // one-off run.
    // Where the token came from decides where a refreshed one may be saved:
    // only to the source the next start reads it from again.
    const tokenFromFlag = program.getOptionValueSource('token') === 'cli';
    let tokenFromFile = false;
    if (opts.envFile) {
      const fromFile = readEnvFile(opts.envFile);
      opts.server ??= fromFile.server;
      tokenFromFile = opts.token === undefined && fromFile.token !== undefined;
      opts.token ??= fromFile.token;
      opts.installName ??= fromFile.name;
      opts.engram ??= fromFile.engram;
      opts.claudeEnv ??= fromFile.claudeEnv;
      if (fromFile.machineSecrets) opts.machineSecrets = true;
      if (fromFile.allowDir && (!opts.allowDir || opts.allowDir.length === 0)) {
        opts.allowDir = [fromFile.allowDir];
      }
      for (const option of ATTACHMENT_OPTIONS) {
        opts[option.key] ??= fromFile.settings?.[option.env];
      }
    }
    // Enable debug logging if requested
    if (opts.debug) {
      setDebug(true);
    }

    // Start file logging before anything else is logged, so the run is
    // captured from the first line.
    if (opts.logFile) {
      setLogFile(opts.logFile);
    }

    log.info(`AI Bridge v${BRIDGE_VERSION} (protocol v${PROTOCOL_VERSION})`);
    if (opts.logFile) {
      log.info(`Logging to file: ${opts.logFile}`);
    }

    if (opts.test) {
      log.info('Running in TEST MODE — AI requests will receive mock responses');
    }

    // Long-lived Claude tokens, before anything spawns a CLI. The file is read
    // again for every Claude run (so `ai-bridge claude-token use` switches
    // without a restart); what it yields is said out loud whenever it changes,
    // because a service that silently lost its token answers every question
    // with "Not logged in" and nothing on the machine says why.
    if (opts.claudeEnv) {
      if (process.env[CLAUDE_TOKEN_KEY]) {
        log.info('Claude signs in with CLAUDE_CODE_OAUTH_TOKEN from the environment; --claude-env not read');
      } else {
        useClaudeTokenFile(opts.claudeEnv, (outcome) => {
          if (outcome.status === 'loaded') log.info(`Claude signs in with the long-lived token "${outcome.name}"`, { file: outcome.path });
          else if (outcome.status === 'too_open') log.warn(`not using ${outcome.path}: others can read it (mode ${outcome.mode}). chmod 600 it; until then Claude uses its own sign-in, if any`);
          else if (outcome.status === 'unknown_active') log.warn(`${outcome.path} makes "${outcome.name}" active but has no line for it; Claude uses its own sign-in, if any`);
          else if (outcome.status === 'no_token') log.info(`${outcome.path} has no token${outcome.name ? ` in slot "${outcome.name}"` : ''}; Claude uses its own sign-in, if any`);
          else if (outcome.status === 'unreadable') log.warn(`could not read the Claude token file ${outcome.path}: ${outcome.reason}; Claude uses its own sign-in, if any`);
        });
      }
    }

    // Validate required options
    const token = opts.token;
    const serverUrl = opts.server;

    if (!token) {
      log.error('Authentication token is required. Use --token <token> or set AI_BRIDGE_TOKEN. Generate a token from your web application (see README for details).');
      process.exit(1);
    }

    if (!serverUrl) {
      log.error('Server URL is required. Use --server <url> or set AI_BRIDGE_SERVER. Use the wss:// address provided by your web application (e.g. wss://your-app.com/api/ai-bridge/ws).');
      process.exit(1);
    }

    // A bad upstreams file stops the bridge here, naming the server and the
    // field, rather than leaving a server silently missing later.
    let mcpUpstreams: ReturnType<typeof readUpstreamConfig> | undefined;
    if (opts.mcpUpstreams) {
      try {
        mcpUpstreams = readUpstreamConfig(opts.mcpUpstreams);
      } catch (err) {
        log.error(err instanceof Error ? err.message : String(err));
        process.exit(1);
      }
    }

    // Validate server URL format
    if (!serverUrl.startsWith('ws://') && !serverUrl.startsWith('wss://')) {
      log.error('Server URL must start with ws:// or wss://');
      process.exit(1);
    }

    // Warn about unencrypted connections
    if (serverUrl.startsWith('ws://')) {
      log.warn('Connecting over unencrypted ws://. Use wss:// in production.');
    }

    // Reject URLs with username/password components to prevent URL authority
    // confusion (e.g. wss://legit.com@attacker.com/ws)
    try {
      const parsedUrl = new URL(serverUrl);
      if (parsedUrl.username || parsedUrl.password) {
        log.error('Server URL must not contain username or password components');
        process.exit(1);
      }
      if (parsedUrl.searchParams.has('token')) {
        log.error('Server URL must not carry a token= parameter: pass the token with --token or AI_BRIDGE_TOKEN (it travels in the Authorization header; a URL ends up in access logs)');
        process.exit(1);
      }
    } catch {
      log.error('Server URL is not a valid URL');
      process.exit(1);
    }

    // -----------------------------------------------------------------------
    // Detect providers
    // -----------------------------------------------------------------------

    const providers = await detectProviders();
    const availableProviders = providers.filter((p) => p.available);

    if (availableProviders.length === 0 && !opts.test) {
      // Warn BEFORE connecting so the user knows the bridge is non-functional.
      log.warn('No AI CLI tools detected. The bridge will NOT be able to execute requests.');
      log.warn('Install one of: codex (https://github.com/openai/codex), claude (https://claude.ai/download), gemini (https://github.com/google-gemini/gemini-cli)');
      log.warn('Or use --test flag to run in test mode with mock responses.');
      log.warn('AI requests will fail until a provider CLI is installed. See install links above.');
      log.warn('Connecting anyway so the server knows a bridge is present...');
    } else if (availableProviders.length > 0) {
      log.info(`Available providers: ${availableProviders.map((p) => `${p.name} (${p.version ?? 'unknown version'})`).join(', ')}`);
    }

    // -----------------------------------------------------------------------
    // Initialize adapters and populate model lists
    // -----------------------------------------------------------------------

    const adapterInstances: ProviderAdapter[] = [
      new CodexAdapter(),
      new ClaudeAdapter(),
      new GeminiAdapter(),
    ];

    const adapters = new Map<string, ProviderAdapter>();
    // Run listModels() concurrently across all available providers.
    const availableAdapters = adapterInstances.filter((adapter) => {
      const capability = providers.find((p) => p.name === adapter.providerName);
      return capability?.available === true;
    });

    await Promise.all(
      availableAdapters.map(async (adapter) => {
        const capability = providers.find((p) => p.name === adapter.providerName)!;
        adapters.set(adapter.providerName, adapter);
        try {
          const models = await adapter.listModels();
          capability.models = models;
          log.info(`${adapter.providerName} models: ${models.map((m) => m.id).join(', ')}`);
        } catch (err) {
          log.warn(`Failed to list models for ${adapter.providerName}`, {
            error: err instanceof Error ? err.message : String(err),
          });
        }
        log.debug('Registered adapter', { name: adapter.providerName });
      }),
    );

    // -----------------------------------------------------------------------
    // Create and connect bridge
    // The token goes in the Authorization header only, never in the URL
    // (access logs keep URLs) nor in the hello body
    // -----------------------------------------------------------------------

    // -----------------------------------------------------------------------
    // Local tools, off unless asked for
    // -----------------------------------------------------------------------
    //
    // This is the one place the posture is decided. Nothing a server sends can
    // reach it, which is what keeps a bridge that never passed --local-tools
    // exactly as safe as it was before this feature existed.

    let identity: Identity | undefined;
    let engram: EngramConfig | undefined;

    if (opts.localTools) {
      log.warn('local tools are ENABLED: this server can run commands on this machine, as you');
      identity = await loadOrCreateIdentity(opts.identityFile);

      if (opts.engram) {
        engram = { baseUrl: opts.engram, token: opts.engramToken ?? token };
        if (!identity.deviceId) {
          const mode = opts.deviceMode === 'isolated' ? 'isolated' : 'transcript';
          // The hostname goes as a label of its own as well, so a server can
          // name the device after the machine even when a label was not given.
          const host = hostname();
          const result = await enrol(engram, identity, opts.deviceLabel?.trim() || host, mode, host);
          identity.deviceId = result.deviceId;
          await saveIdentity(opts.identityFile, identity);
          log.info('enrolled with Engram; approve this device in the browser');
          // Printed rather than logged: a person has to read this aloud and
          // compare it against what the browser shows, and a log line scrolls.
          process.stdout.write(
            `\n  This device is waiting to be approved.\n` +
            `  Open Engram, go to Vault, find "${result.label}", and check these five groups match:\n\n` +
            `      ${result.fingerprint}\n\n` +
            `  If they differ, do not approve it.\n\n`,
          );
        } else {
          log.info('device already enrolled', { fingerprint: await fingerprint(identity.publicKey) });
        }
      } else {
        log.warn('--local-tools without --engram: tools will run, but no secrets can be resolved');
      }
    }

    // -----------------------------------------------------------------------
    // Workspaces, off unless asked for
    // -----------------------------------------------------------------------
    //
    // The same posture as local tools above, and the same reason: this is the
    // one place it is decided, and nothing a server sends can reach it. A
    // bridge started without --allow-dir refuses every working directory a
    // server names, so it is exactly as constrained as it was before this
    // feature existed.

    if (opts.allowNative) {
      log.warn(
        'native isolation is PERMITTED: this server may run the CLI with your full local '
        + 'environment — your MCP servers, hooks, plugins and a shell, as you.',
      );
    }

    let operatorPosture: OperatorPosture;
    try {
      operatorPosture = resolveOperatorPosture(opts, serverUrl, process.env);
    } catch (err) {
      log.error(err instanceof Error ? err.message : String(err));
      process.exit(1);
    }
    const { allowedRoots, apiOrigin, attachmentLimits } = operatorPosture;
    if (operatorPosture.webSearch) {
      log.warn('web search is PERMITTED: this server may give an isolated Claude turn the built-in WebSearch tool, on your Claude account.');
    }
    if (operatorPosture.machineSecrets) {
      log.warn(`Machine secrets: ON (${defaultSecretsDir()}): this server may list, add, replace, describe and remove secrets on this machine (never read one back).`);
    } else {
      log.info('Machine secrets: off (no --machine-secrets)');
    }

    if (allowedRoots.length > 0) {
      log.warn(
        'workspaces are ENABLED: this server can ask the assistant to work inside '
        + `${allowedRoots.length} director${allowedRoots.length === 1 ? 'y' : 'ies'}, with the CLI's `
        + 'own file and shell tools, as you. This is not a sandbox — see the README.',
      );
      for (const root of allowedRoots) {
        log.info(`  workspace: ${root.label} → ${root.path}`);
      }
    }

    // Following the server's desired version (src/selfupdate/). Decided before
    // connecting, because hello says whether this bridge will.
    const selfUpdateOff = !opts.selfUpdate
      || /^(0|false|off|no)$/i.test(process.env['AI_BRIDGE_SELF_UPDATE'] ?? '');
    const detection = detectService();
    const unitName = 'managed' in detection ? detection.managed.unit : 'manual';
    let restartBridge: () => Promise<void> = async () => { /* replaced once the bridge exists */ };
    const updater = new SelfUpdater({
      currentVersion: BRIDGE_VERSION,
      optedOut: selfUpdateOff,
      detection,
      prefetch: (version) => prefetch(version),
      isIdle: (): boolean => bridge.isIdle(),
      pin: (version, previous) => {
        if (!('managed' in detection)) throw new Error('not a managed service');
        pinVersion(detection.managed.envFile, version, previous);
      },
      restart: () => { void restartBridge(); },
      statePath: join(homedir(), '.cache', 'ai-bridge', `self-update-${unitName.replace(/[^A-Za-z0-9_.@-]/g, '_')}.json`),
      log,
    });
    if ('managed' in detection && !selfUpdateOff) {
      log.info(`Self-update: on, through ${detection.managed.unit} (${detection.managed.envFile})`);
    } else {
      log.info(`Self-update: off (${selfUpdateOff ? 'turned off' : (detection as { reason: string }).reason})`);
    }
    updater.start();

    // Where a token the server tops up is saved, so the next start does not
    // come back with the one this bridge was installed with, long expired.
    // A --token flag wins over every file, so a token saved to one would not
    // be what the next start uses; --env-file counts only when the token came
    // from it (a flag or AI_BRIDGE_TOKEN in the environment wins over it).
    const tokenFile: TokenFile = tokenFromFlag
      ? { reason: 'the token was given with --token' }
      : locateTokenFile(token, tokenFromFile ? opts.envFile : undefined);
    if ('file' in tokenFile) {
      log.info(`Refreshed connection tokens are saved to ${tokenFile.file}`);
    } else {
      log.warn(`Refreshed connection tokens are NOT saved (${tokenFile.reason}); after a restart past the token's expiry this bridge needs a new token`);
    }
    const saveRefreshed = 'file' in tokenFile ? tokenSaver(tokenFile.file, token) : undefined;
    const onTokenRefreshed = (next: string): void => {
      if (!('file' in tokenFile)) return;
      try {
        if (saveRefreshed!(next) === 'saved') {
          log.info('Saved the refreshed connection token', { file: tokenFile.file });
        } else {
          log.warn('Did not save the refreshed connection token: the token in the file changed since this bridge started, and that newer one stays', { file: tokenFile.file });
        }
      } catch (err) {
        log.warn('Could not save the refreshed connection token; a restart past its expiry will be refused', {
          file: tokenFile.file,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    };

    const bridge: Bridge = new Bridge({
      onTokenRefreshed,
      selfUpdate: { enabled: updater.enabled, onDesired: (version) => updater.onDesired(version) },
      serverUrl,
      token,
      providers,
      adapters,
      testMode: opts.test,
      onTestRequest: opts.test ? handleTestRequest : undefined,
      localExecution: { enabled: opts.localTools, dataDir: opts.localDataDir },
      engram,
      identity,
      allowedRoots,
      apiOrigin,
      attachmentLimits,
      attachmentTimeouts: operatorPosture.attachmentTimeouts,
      attachmentCache: operatorPosture.attachmentCache,
      keepAttachments: operatorPosture.keepAttachments,
      servedFilesPath: operatorPosture.servedFilesPath,
      allowNative: operatorPosture.allowNative,
      webSearch: operatorPosture.webSearch,
      machineSecrets: operatorPosture.machineSecrets,
      ...(mcpUpstreams ? { mcpUpstreams } : {}),
    });

    // Lifecycle logging
    bridge.on('connected', () => {
      log.info('Connected to server');
    });

    bridge.on('welcome', (sessionId) => {
      log.info(`Session established: ${sessionId}`);
      if (opts.test) {
        log.info('Test mode active — waiting for ai_request messages...');
      }
    });

    bridge.on('disconnected', (code, reason) => {
      log.warn(`Disconnected from server (code=${code}, reason="${reason}")`);
    });

    bridge.on('error', (err) => {
      log.error('Bridge error', { error: err.message });

      if (err instanceof FatalBridgeError) {
        process.exit(1);
      }
    });

    bridge.on('request_start', (requestId, provider, model) => {
      const target = model ? `${provider}/${model}` : `${provider} (provider default model)`;
      log.info(`Processing request ${requestId} with ${target}${opts.test ? ' (test mode)' : ''}`);
    });

    bridge.on('request_end', (requestId) => {
      log.info(`Request ${requestId} completed`);
    });

    // -----------------------------------------------------------------------
    // Graceful shutdown
    // -----------------------------------------------------------------------

    const shutdown = async (signal: string) => {
      log.info(`Received ${signal} — shutting down gracefully`);
      await bridge.disconnect();
      closeLogFile();
      process.exit(0);
    };

    // Self-update's way out: a clean disconnect, then a non-zero exit, which
    // both Restart=always and Restart=on-failure answer by starting the unit
    // again, now on the version just pinned. 75 is EX_TEMPFAIL.
    restartBridge = async () => {
      updater.cancel();
      await bridge.disconnect();
      closeLogFile();
      process.exit(75);
    };

    process.on('SIGINT', () => shutdown('SIGINT'));
    process.on('SIGTERM', () => shutdown('SIGTERM'));

    // Unhandled rejections leave the bridge in an unknown state — log, attempt
    // a graceful disconnect, then exit so the operator restarts the process.
    process.on('unhandledRejection', (reason) => {
      log.error('Unhandled rejection — bridge is in an unknown state, exiting (restart the bridge to recover)', {
        error: reason instanceof Error ? reason.message : String(reason),
      });
      // Best-effort disconnect (notify server we're going away)
      bridge.disconnect().catch(() => { /* ignore */ }).finally(() => {
        process.exit(1);
      });
    });

    // -----------------------------------------------------------------------
    // Connect
    // -----------------------------------------------------------------------

    bridge.connect();
  });

// ---------------------------------------------------------------------------
// Run
// ---------------------------------------------------------------------------

/**
 * Determine whether this module is being executed directly as the CLI entry
 * point (as opposed to being imported by another module or a test).
 *
 * npm installs the package `bin` entry as a symlink
 * (`node_modules/.bin/ai-bridge` -> `.../dist/cli.js`). When executed,
 * `process.argv[1]` is the *symlink* path while `import.meta.url` resolves to
 * the *real* file path, so a plain string comparison fails and the CLI exits
 * silently without doing anything. Comparing the resolved real paths makes the
 * check symlink-safe. `realpathSync` is wrapped in try/catch because either
 * path may not exist on disk (e.g. argv1 from an unusual launcher).
 *
 * @param argv1     The script path Node was invoked with (`process.argv[1]`).
 * @param moduleUrl This module's URL (`import.meta.url`).
 */
/* ------------------------- running as a background service ------------------------- */

/**
 * Installing a bridge so it starts with the machine.
 *
 * Here rather than in each server's setup script, because every one of them was
 * writing the same two fixed paths -- which made a second server's install
 * overwrite the first's credentials, report success, and leave the machine
 * answering the old server until something restarted it.
 */
const installCommand = program
  .command('install')
  .description('Install this bridge as a background service that starts with the machine')
  .requiredOption('-s, --server <url>', 'WebSocket server URL, as the web application gave it to you')
  .requiredOption('-t, --token <token>', 'Pairing token, as the web application gave it to you')
  .option('--allow-dir <path>', 'The one folder the assistant may read, write and run things inside')
  .option('--name <name>', 'What to call this bridge. Defaults to the server\'s hostname, so one bridge per server.')
  .option('--force', 'Replace an install of this name even if it is paired to a different server or machine', false)
  .option('--allow-native', 'Pass --allow-native to the service (see the main options)', false)
  .option('--local-tools', 'Pass --local-tools to the service (see the main options)', false)
  .option('--engram <url>', 'Engram\'s address (https://...), recorded as ENGRAM_URL so the service enrols this machine for vault secrets. Needs --local-tools.')
  .option('--claude-env <file>', 'A 0600 file holding CLAUDE_CODE_OAUTH_TOKEN=<token> (from `claude setup-token`) for the service to sign Claude in with. Kept on a reinstall that does not name it; pass "" to drop it.')
  .option('--no-self-update', 'Do not follow the version the server asks for; stay on the installed one until you change AI_BRIDGE_VERSION by hand')
  .option('--allow-web-search', 'Pass --allow-web-search to the service (see the main options)', false)
  .option('--machine-secrets', 'Record AI_BRIDGE_MACHINE_SECRETS=1 for the service, so the server may manage the secret store on this machine (see the main options). Given again on every install, or machine secrets are off.', false);
// The same attachment settings as a direct run, recorded in the service's env
// file. Left out, a reinstall keeps whatever the install it replaces had.
for (const option of ATTACHMENT_OPTIONS) {
  installCommand.option(option.flag, option.description);
}
installCommand
  .action((opts: {
    server: string; token: string; allowDir?: string; name?: string; force: boolean;
    allowNative: boolean; localTools: boolean; selfUpdate: boolean; engram?: string; claudeEnv?: string;
    allowWebSearch: boolean; machineSecrets: boolean;
  } & AttachmentOptionValues) => {
    try {
      validateAttachmentOptions(opts);
      const engram = opts.engram === undefined ? undefined : checkEngramUrl(opts.engram, opts.localTools, opts.server);
      const claudeEnv = opts.claudeEnv === undefined || opts.claudeEnv === '' ? opts.claudeEnv : checkClaudeEnv(opts.claudeEnv);
      const settings: Record<string, string> = {};
      for (const option of ATTACHMENT_OPTIONS) {
        const value = opts[option.key];
        if (value !== undefined) settings[option.env] = value;
      }
      const { name, replaced } = installBridge({
        server: opts.server, token: opts.token, allowDir: opts.allowDir,
        name: opts.name, force: opts.force, settings, engram, claudeEnv, machineSecrets: opts.machineSecrets,
        flags: [
          ...(opts.allowNative ? ['--allow-native'] : []),
          ...(opts.localTools ? ['--local-tools'] : []),
          ...(opts.selfUpdate ? [] : ['--no-self-update']),
          ...(opts.allowWebSearch ? ['--allow-web-search'] : []),
        ],
      });
      const paths = pathsFor(name);
      console.log(`${replaced ? 'Replaced' : 'Installed'} "${name}", running in the background.`);
      if (process.platform === 'darwin') {
        console.log(`  logs:  tail -f ${paths.log}`);
        console.log(`  stop:  ai-bridge uninstall ${name}`);
      } else {
        console.log(`  status:  systemctl --user status ${paths.label}`);
        console.log(`  logs:    journalctl --user -u ${paths.label} -f`);
        console.log(`  stop:    ai-bridge uninstall ${name}`);
      }
      if (engram) {
        console.log(`\nVault: this machine enrols with ${engram} when the service starts.`);
        console.log(`  Its log shows five groups of letters. In Engram, open Vault, find this machine,`);
        console.log(`  check the groups match, and give it the keys of the spaces it should use.`);
      }
      if (claudeEnv) console.log(`\nClaude signs in with the long-lived token in ${claudeEnv}.`);
      console.log(opts.machineSecrets
        ? `\nMachine secrets: on (${defaultSecretsDir()}). The server may list, add, replace, describe and remove secrets there, never read one.`
        : '\nMachine secrets: off (no --machine-secrets).');
      // A user service stops when you log out, which on a machine reached over
      // SSH means it stops the moment you disconnect.
      if (process.platform === 'linux') {
        console.log(`\nIf this machine is one you reach over SSH, keep it running after you log out:`);
        console.log(`  sudo loginctl enable-linger ${process.env['USER'] ?? 'you'}`);
      }
    } catch (err) {
      console.error(err instanceof Error ? err.message : String(err));
      process.exit(1);
    }
  });

/** An Engram address an install may record: http(s), nothing else. */
function checkEngramUrl(raw: string, localTools: boolean, server: string): string {
  if (!localTools) throw new Error('--engram needs --local-tools: without it the service never opens the vault, so the address would do nothing.');
  let url: URL;
  try { url = new URL(raw); } catch { throw new Error(`--engram must be Engram's address, such as https://engram.example.com, not "${raw}"`); }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') throw new Error(`--engram must start with https://, not ${url.protocol}`);
  // The bridge token is the Engram credential too, so plain http is accepted
  // only where the server connection is plain already (a local test server),
  // never as a downgrade from wss://.
  if (url.protocol === 'http:' && !server.startsWith('ws://')) {
    throw new Error(`--engram must be https:// when the server is ${server.split(':')[0]}://; http:// is only for a test server reached over ws://`);
  }
  return url.origin;
}

/** A Claude token file an install may point the service at: absolute, there,
 *  holding a token, and readable by its owner only. Refused here rather than
 *  found out by a service that answers "Not logged in". */
function checkClaudeEnv(raw: string): string {
  const path = resolve(raw);
  const probe: NodeJS.ProcessEnv = {};
  const outcome = loadClaudeToken(path, probe);
  if (outcome.status === 'too_open') throw new Error(`${path} can be read by others (mode ${outcome.mode}). Run: chmod 600 ${path}`);
  if (outcome.status === 'unreadable') throw new Error(`cannot read ${path}: ${outcome.reason}`);
  // A file whose slots are still empty is accepted: Claude keeps its own
  // sign-in until a token is added, and runs pick it up without a restart.
  if (outcome.status === 'no_token' || outcome.status === 'unknown_active') {
    console.warn(`${path} holds no usable token yet; Claude uses its own sign-in until you add one (see \`ai-bridge claude-token list\`).`);
  }
  return path;
}

/**
 * The token file `claude-token` works on: --file, else AI_BRIDGE_CLAUDE_ENV,
 * else the one the installed bridges name, when they all name the same one.
 */
function claudeTokenFile(file: string | undefined): string {
  if (file) return resolve(file);
  if (process.env['AI_BRIDGE_CLAUDE_ENV']) return resolve(process.env['AI_BRIDGE_CLAUDE_ENV']);
  const named = new Set(listBridges().map((b) => readEnvFile(pathsFor(b.name).env).claudeEnv).filter((p): p is string => !!p));
  if (named.size === 1) return [...named][0]!;
  throw new Error(named.size
    ? `the installed bridges name different token files (${[...named].join(', ')}); say which with --file`
    : 'no token file: say which with --file <path> (or set AI_BRIDGE_CLAUDE_ENV)');
}

const claudeTokenCommand = program
  .command('claude-token')
  .description('List the long-lived Claude tokens in the token file, or choose which one Claude runs use');
claudeTokenCommand
  .command('list')
  .description('The token names in the file and which one is active (never a value)')
  .option('--file <path>', 'The token file (default: AI_BRIDGE_CLAUDE_ENV, else the one the installed bridges use)')
  .action((opts: { file?: string }) => {
    try {
      const listing = listClaudeTokens(claudeTokenFile(opts.file));
      console.log(listing.path);
      if (!listing.slots.length) console.log('  (no token lines yet)');
      for (const slot of listing.slots) {
        console.log(`  ${slot.active ? '*' : ' '} ${slot.name}${slot.filled ? '' : '  (empty)'}`);
      }
      console.log(listing.inUse
        ? `Claude runs use "${listing.inUse}".`
        : listing.active && !listing.slots.some((s) => s.name === listing.active)
          ? `Active is "${listing.active}", which has no line; Claude runs use Claude's own sign-in.`
          : "No token in use; Claude runs use Claude's own sign-in.");
    } catch (err) {
      console.error(err instanceof Error ? err.message : String(err));
      process.exit(1);
    }
  });
claudeTokenCommand
  .command('use')
  .description('Make <name> the token Claude runs use, from the next run on; no restart needed')
  .argument('<name>', 'A token name, as `ai-bridge claude-token list` shows it')
  .option('--file <path>', 'The token file (default: AI_BRIDGE_CLAUDE_ENV, else the one the installed bridges use)')
  .action((name: string, opts: { file?: string }) => {
    try {
      const path = claudeTokenFile(opts.file);
      const result = useClaudeToken(path, name);
      console.log(result.filled
        ? `Claude runs now use "${result.name}" (${path}), from the next run on.`
        : `"${result.name}" is active but its line is empty: Claude runs use Claude's own sign-in until you fill it in ${path}.`);
    } catch (err) {
      console.error(err instanceof Error ? err.message : String(err));
      process.exit(1);
    }
  });

/**
 * Where a long-lived token would override the CLI's own sign-in: this shell's
 * environment, or a token file a bridge reads with a filled active token. One
 * line each, for `claude-login` to say plainly. Never a value.
 */
function claudeTokenOverrides(): string[] {
  const lines: string[] = [];
  if (process.env['ANTHROPIC_API_KEY']) lines.push("ANTHROPIC_API_KEY is set in this shell's environment: Claude started from here may use that key, not the sign-in.");
  if (process.env[CLAUDE_TOKEN_KEY]) lines.push(`${CLAUDE_TOKEN_KEY} is set in this shell's environment: Claude started from here uses that token, not the sign-in.`);
  const files = new Map<string, string[]>();
  const fromEnv = process.env['AI_BRIDGE_CLAUDE_ENV'];
  if (fromEnv) files.set(resolve(fromEnv), ['AI_BRIDGE_CLAUDE_ENV']);
  let bridges: ReturnType<typeof listBridges> = [];
  try { bridges = listBridges(); } catch { /* no installed bridges to ask */ }
  for (const b of bridges) {
    const file = readEnvFile(pathsFor(b.name).env).claudeEnv;
    if (file) files.set(file, [...(files.get(file) ?? []), `bridge "${b.name}"`]);
  }
  for (const [file, who] of files) {
    const outcome = loadClaudeToken(file, {});
    if (outcome.status === 'loaded') {
      lines.push(`${who.join(', ')}: Claude runs and usage use the long-lived token "${outcome.name}" from ${file}, which overrides this sign-in. To use the sign-in instead, make an empty slot active there (\`ai-bridge claude-token use <name> --file ${file}\`) or drop the file (\`install --claude-env ""\`).`);
    }
  }
  return lines;
}

function warnClaudeTokenOverrides(): void {
  for (const line of claudeTokenOverrides()) console.warn(`Note: ${line}`);
}

const claudeLoginCommand = program
  .command('claude-login')
  .description("Named profiles of the Claude CLI's own sign-in (~/.claude/.credentials.json): save one per account, switch between them");
claudeLoginCommand
  .command('list')
  .description('The saved profiles and which one is signed in now (never a value)')
  .action(() => {
    try {
      const listing = listClaudeLogins();
      if (!listing.profiles.length) console.log('No profiles yet. Sign in with `claude /login`, then `ai-bridge claude-login save <name>`; repeat per account.');
      for (const name of listing.profiles) console.log(`  ${listing.active?.name === name ? '*' : ' '} ${name}`);
      if (!listing.signedIn) console.log(`No Claude sign-in at ${listing.credentials}.${process.platform === 'darwin' ? ' On macOS Claude keeps its sign-in in the Keychain, which claude-login does not switch.' : ''}`);
      else if (!listing.active) console.log(`The current sign-in (${listing.credentials}) is not saved as any profile.`);
      else console.log(`Signed in as "${listing.active.name}"${listing.active.how === 'recorded' ? ' (by the profile last saved or used: its tokens changed since, by a refresh or by a `claude /login`; after a /login, run `save` first)' : ''}.`);
      warnClaudeTokenOverrides();
    } catch (err) {
      console.error(err instanceof Error ? err.message : String(err));
      process.exit(1);
    }
  });
claudeLoginCommand
  .command('save')
  .description('Store the current Claude sign-in as profile <name>')
  .argument('<name>', 'A name for this account, e.g. work or home')
  .action((name: string) => {
    try {
      const result = saveClaudeLogin(name);
      console.log(`${result.replaced ? 'Replaced' : 'Saved'} profile "${result.name}" from the current sign-in.`);
    } catch (err) {
      console.error(err instanceof Error ? err.message : String(err));
      process.exit(1);
    }
  });
claudeLoginCommand
  .command('use')
  .description('Make profile <name> the Claude sign-in, from the next Claude start on; no bridge restart needed')
  .argument('<name>', 'A profile name, as `ai-bridge claude-login list` shows it')
  .option('--discard-current', 'Replace a current sign-in that is saved as no profile (it is lost)')
  .action((name: string, opts: { discardCurrent?: boolean }) => {
    try {
      const running = runningClaudeProcesses();
      const result = useClaudeLogin(name, { discardCurrent: !!opts.discardCurrent });
      if (result.savedBack && !result.already) console.log(`Saved the current sign-in back into "${result.savedBack}".`);
      if (result.kept) console.log(`The copy it replaced is kept as ${result.kept}; if you had signed in to another account with \`claude /login\` without saving it, move that file back over the profile (copies like it are removed after 30 days).`);
      console.log(result.already
        ? `"${result.name}" is already the sign-in in place (its latest tokens are saved).`
        : `Claude now signs in as "${result.name}", from the next start on.`);
      if (running) {
        console.warn(`Warning: ${running} Claude process${running === 1 ? ' is' : 'es are'} running. One may switch to the new sign-in at its next token check, or, refreshing at that moment, write the previous account back; if \`ai-bridge claude-login list\` later shows the wrong profile, run this again once they have finished.`);
      }
      warnClaudeTokenOverrides();
    } catch (err) {
      console.error(err instanceof Error ? err.message : String(err));
      process.exit(1);
    }
  });

program
  .command('uninstall')
  .description('Stop an installed bridge and remove it')
  .argument('<name>', 'Which one, as `ai-bridge list` shows it')
  .action((name: string) => {
    try {
      uninstallBridge(name);
      console.log(`Removed "${name}".`);
    } catch (err) {
      console.error(err instanceof Error ? err.message : String(err));
      process.exit(1);
    }
  });

program
  .command('list')
  .description('Every bridge installed on this machine, and what it is doing')
  .action(() => {
    const rows = listBridges();
    if (!rows.length) {
      console.log('No bridges are installed here. `ai-bridge install --server ... --token ...` adds one.');
      return;
    }
    for (const r of rows) {
      const where = r.device ? `${hostOnly(r.server)} (device ${r.device.slice(0, 8)}…)` : hostOnly(r.server);
      console.log(`${r.name.padEnd(24)} ${r.state.padEnd(12)} ${where}`);
      if (r.allowDir) console.log(`${' '.repeat(24)} ${' '.repeat(12)} may work in ${r.allowDir}`);
      console.log(`${' '.repeat(24)} ${' '.repeat(12)} machine secrets: ${r.machineSecrets ? 'on' : 'off'}`);
    }
  });

registerSecretCommands(program);

function hostOnly(url: string): string {
  try { return new URL(url).host; } catch { return url; }
}

export function isMainModule(argv1: string | undefined, moduleUrl: string): boolean {
  if (!argv1) return false;
  try {
    return realpathSync(argv1) === realpathSync(fileURLToPath(moduleUrl));
  } catch {
    return false;
  }
}

// Guard execution so importing this module does not invoke the CLI.
if (isMainModule(process.argv[1], import.meta.url)) {
  program.parseAsync(process.argv).catch((err: unknown) => {
    log.error('Fatal error', { error: err instanceof Error ? err.message : String(err) });
    process.exit(1);
  });
}
