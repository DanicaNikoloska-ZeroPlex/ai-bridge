# What the bridge does and does not stop

The bridge runs a coding CLI on somebody's machine, on behalf of a server that
is somewhere else. Everything in this document is about one question: **when the
server and the machine's owner disagree, who wins?**

There are two people in this system and it is worth naming them, because almost
every misunderstanding here comes from conflating them:

- the **server operator** — runs the web app, sets `AI_BRIDGE_CLI_ISOLATION`;
- the **bridge operator** — the developer whose laptop runs the CLI and holds
  the files.

## The postures

The server picks one and sends it as `cli_isolation` on the handshake.

| Posture | The CLI may… | Needs from the bridge operator |
|---|---|---|
| `isolated` (default) | reach server-declared tools, and nothing else (Claude: plus `WebSearch` on a turn that asks, when the operator allowed it) | nothing (`--allow-web-search` for the search) |
| `workspace` | also use its own file and shell tools, inside the named directory | `--allow-dir` |
| `native` | do anything the CLI can do, with the operator's own environment | `--allow-native` |

**Both permissive postures need the bridge operator to have opted in.** A server
asking for `workspace` or `native` from a bridge that was started without the
matching flag gets `isolated`, and a line in the log saying so. An unrecognised
value gets `isolated` too.

This is not a formality. `workspace` is what enables the shell, and a shell in
an empty scratch directory is still a shell — so if the allow-list bounded only
the *directory*, a server could switch the capability on by sending a field.
And gating `workspace` alone would have been theatre, because `native` is
strictly broader: a server refused the shell one way would ask for it the other
way and get the operator's MCP servers, hooks and plugins along with it.

## One turn narrower than the connection

A server may hold a single turn to `isolated` with `ai_request.cli_isolation:
"isolated"` (advertised as `hello.turn_isolation`), whatever posture the
connection adopted: for work nobody watches, such as a scheduled job that
should reach the server's tools and nothing on this machine. It can only
narrow; the turn is launched with exactly the `isolated` flags below, its MCP
token lists only the server-declared tools (the bridge's uploader and any
upstream server are withheld and refused by name), and it is **refused, never
run wider**, on a provider that cannot be held to it (Codex keeps a read-only
shell, Gemini has no lever) or when it also names a working folder. The
decision is `turnPosture()` in `src/bridge.ts`.

## Web search on an `isolated` turn

A request may add one built-in tool to an `isolated` Claude turn, and only on a
bridge whose operator passed `--allow-web-search`: `options.web_search: true`
puts exactly `WebSearch` into `--allowedTools` (advertised as `hello.web_search`;
`resolveWebSearch()` in `src/bridge.ts`, the adapter in
`src/providers/claude.ts`). A search reads no file and runs no command here, but
it runs on the operator's Claude account and sends words from the turn to a
search backend, and with `--local-tools` a turn can hold what tools on this
machine returned; so, like the postures above, it is the operator's to allow
(decision 0016). Without the flag, or on Codex or Gemini, an isolated turn that
asks is refused, never run without the tool. From 0.40.1 an isolated Claude turn
also passes `--disallowedTools` for the web tools it may not use, so they are not
listed at all (a denied but listed tool was still called, and its permission
error read to the person as something to grant). `WebFetch` is never added: it
fetches any URL the model writes, so a page's instructions could carry the
turn's data to any host.

## How `isolated` is actually enforced

This is the part that is easy to get wrong, and was wrong here until it was
measured.

`isolated` is not enforced by the bridge. The bridge cannot enforce it — it
spawns a CLI as a subprocess and has no way to intercept what that CLI does. It
can only pass flags and rely on the CLI's own permission system.

For Claude that system is three things acting together:

1. **`--allowedTools mcp__bridge__*`** — the server's declared tools are
   *pre-approved*. They run without asking anyone.
2. **`--permission-mode manual`** — anything *not* pre-approved would prompt.
3. **Headless `-p` mode** — from Claude's own help: *"nobody: anything that
   would prompt is denied automatically."*

Net effect: **declared tools run autonomously; everything else is denied
instantly.** No human is in the loop and nothing waits for approval. The flag is
badly named for this use — `manual` does not mean "a human approves", it means
"do not treat unlisted tools as pre-approved".

### Why step 2 had to be added

Step 3 has always been the mechanism `isolated` relied on. What was missing was
that step 2 has a *default*, and that default is read from the bridge
operator's own `~/.claude/settings.json`.

A developer who sets `permissions.defaultMode: "auto"` — an ordinary thing to
do to stop being prompted during your own work — changes that default from
"prompt" to "auto-approve". Nothing prompts, so nothing is denied, and
`isolated` quietly stops meaning anything. The server still believes the turn is
isolated. So do the logs.

Measured against Claude 2.1.260, with that setting present, an `isolated` turn:

- read an arbitrary file outside its working directory, and
- ran an arbitrary shell command.

With `--permission-mode manual` passed explicitly, both are denied, while the
server's MCP tools still resolve and the turn still reads its attachments.

The same reasoning applies to Codex, which is why `isolated` now states
`-c sandbox_mode=read-only` rather than inheriting whatever the operator's
`~/.codex/config.toml` happens to default to.

### Alternatives that were tried and rejected

| Approach | Why not |
|---|---|
| `--safe-mode` | Disables CLAUDE.md, skills, plugins, hooks, MCP servers — but its own help says "permissions work normally", and measured: the leak remained. |
| `--setting-sources` excluding `user` | Works, but drops the entire user settings file, including `apiKeyHelper` — so an operator who authenticates that way loses their credentials. |
| `--bare` | Same trap, worse: it suppresses keychain reads, so subscription/OAuth login breaks entirely. This is why the Claude adapter cannot use it. |

## What `isolated` still does not stop

Stated plainly, because the gap between "isolated" and "sandboxed" is where
people get hurt.

- **Gemini has no equivalent lever.** `--yolo` is on or off, and there is no way
  to force the deny-on-prompt path. An `isolated` Gemini turn is bounded only by
  Gemini's own defaults and by `~/.gemini/settings.json`. **Do not offer Gemini
  when the server is reachable by people you do not trust.**
- **User-level configuration still loads on every provider** — instruction
  files, skills, hooks, plugins. Suppressing them needs `--bare` or HOME
  redirection, and `--bare` breaks auth. This is the operator's own
  configuration rather than something a server chooses, but it does shape the
  turn.
- **Codex's posture is reasoned, not measured.** Codex was not installed on the
  machine where this was developed, so unlike the Claude flags it has not been
  checked against the real CLI.

## And `workspace` is not a sandbox at all

Once a server may name a working directory and the CLI has shell, the bridge
runs code chosen by the server, on this machine, as you. The allow-list bounds
where the assistant **starts**, not what it can **reach**: `cd ..` and `~/.ssh`
are one command away, and no flag changes that.

What carries the weight is that `--allow-dir` is opt-in and empty by default, so
a bridge started without it cannot be pointed anywhere; that the connection
token is per person and revocable; and that you should only connect a bridge to
a server you would give a shell to.

## Checking it on your own machine

Flags are not behaviour. A unit test can assert what the bridge *sends*; only a
real run says what the CLI does with it, on your machine, with your
configuration.

```bash
npm run build
node tests/manual/e2e.mjs --with-cli
```

Two of those checks are the isolation guarantee itself: an `isolated` turn
cannot read a file outside its working directory, and server-declared tools
still work. If the first fails, something in your local configuration is
overriding the posture — start with `cat ~/.claude/settings.json`.
