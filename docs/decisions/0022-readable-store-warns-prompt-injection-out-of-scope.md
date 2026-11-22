---
status: accepted
date: 2026-11-22
supersedes:
superseded_by:
revisit_when: the bridge takes on defending a turn against what it reads (prompt injection), or it gains a way to keep a turn's tools out of a folder that does not depend on the CLI
---
# A store a turn could read is a startup warning; prompt injection is outside the threat model

## Context

With `--machine-secrets` the server may manage `~/.ai-bridge/secrets` but never
read a value back (decision 0020). That holds only while no turn can open the
folder: a `workspace` turn under an `--allow-dir` that contains it (the home
folder, say) can read the files with its tools, and so can any `native` turn
(`--allow-native`). Since 0.46.0 the bridge logs a warning at startup when that
is so. The question was whether it should refuse to start instead.

## Decision

- Starting with `--machine-secrets` while a turn could read the store stays a
  warning only (`secretsReachableByTurns()` in `src/cli.ts`). The bridge starts.
- The bridge does not defend against prompt injection; that is not its threat
  model. Its postures (decision 0006) bound which tools a turn has; what the
  model does with them, and what steers it (a web page, a file, a tool's
  result), is outside what the bridge protects against. It adds no hook,
  filter or check of its own inside a turn. The README ("Machine secrets") and
  docs/isolation.md say so plainly.

Decided by the repository owner on 2026-11-22.

## Consequences

- An operator who allows `workspace` on their home folder, or `native`, keeps a
  working bridge and a warning in the log; whether to trust the server with
  such turns on a machine with secrets is theirs.
- A refusal would not have closed the gap anyway: a `workspace` turn runs the
  CLI's shell as the user, so even an `--allow-dir` that does not contain the
  store does not make it unreadable (docs/isolation.md, "And `workspace` is not
  a sandbox at all").
- A host that needs more (a turn that must not reach the store at all) runs
  that turn `isolated` (decision 0012), or keeps the secrets on another
  account.

## Options considered

- Refuse to start when the store is reachable: rejected. It would stop only
  the case the bridge can detect (the store inside an allowed folder) and
  suggest a protection the bridge does not give, since a shell reaches any
  folder of the user.
- Insert a hook into the CLI that denies reads of the store: not taken. A
  hook that matches paths in tool calls is bypassed by any command that builds
  the path itself, and making it complete would be a sandbox, which the bridge
  is not.
