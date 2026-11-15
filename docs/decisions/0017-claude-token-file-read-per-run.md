---
status: accepted
date: 2026-11-15
supersedes:
superseded_by:
revisit_when: Claude Code reads its token from somewhere the bridge cannot set per run, the usage endpoint starts answering for long-lived tokens differently, or a server needs to choose the account (that would be a protocol field and an operator opt-in, not this file)
---
# The Claude token file may hold several named tokens and is read for every run

## Context
A bridge on a machine nobody signs into gets a long-lived Claude token
(`claude setup-token`) from a 0600 file named by `--claude-env` /
`AI_BRIDGE_CLAUDE_ENV`. Until 0.40 it held one `CLAUDE_CODE_OAUTH_TOKEN=` line,
read once at start into the bridge's own environment. On 2026-11-15 Jasper, with
two Claude subscriptions, hit one's weekly limit and asked to switch the bridge to
the other quickly, without editing units or restarting services.

## Decision
The file may hold named tokens, `CLAUDE_CODE_OAUTH_TOKEN_<NAME>=<token>`, and
`CLAUDE_TOKEN_ACTIVE=<name>`; the single `CLAUDE_CODE_OAUTH_TOKEN=` line is the
token named `default` and is what a file without an active line uses, so every
existing file means what it meant. Names are case-insensitive, `[a-z0-9_]`.

The bridge no longer copies the token into its own environment. It reads the file
again for every Claude run (`applyClaudeToken` in `src/providers/claude-token.ts`,
called where `claude.ts` builds the spawn env) and sets the active token in that
run's environment only, logging only when the outcome changes. A Claude process
already running (an input-open turn) keeps the token it started with. A token in
the bridge's own environment still wins. A file others can read is refused, as
before. An empty or unknown active slot means no token: Claude uses its own
sign-in, so a file with empty slots can be installed before anyone has a token.

`ai-bridge claude-token list` shows names, filled or empty, and which is active,
never a value; `ai-bridge claude-token use <name>` rewrites only the active line
through a 0600 temp file renamed over the original. Both find the file by
`--file`, else `AI_BRIDGE_CLAUDE_ENV`, else the one the installed bridges name.

Usage (`readClaudeUsage`) asks about the account runs actually use: the
long-lived token when one is in use, else the CLI's `~/.claude/.credentials.json`.
If the vendor will not answer for that token the answer is `no_credential`, never
the other account's figures.

## Consequences
- Switching accounts is one command and takes effect from the next run.
- One `stat` and one small file read per Claude run.
- `install --claude-env` now accepts a file without a usable token, with a warning,
  instead of refusing it.
- No protocol change: the server neither sees nor chooses the account.
