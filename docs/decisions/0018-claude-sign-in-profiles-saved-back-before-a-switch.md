---
status: accepted
date: 2026-11-15
supersedes:
superseded_by:
revisit_when: Claude Code stops keeping its sign-in in ~/.claude/.credentials.json on Linux and Windows (it already uses the Keychain on macOS, where this does not apply), its credentials file starts carrying an account id worth matching on, or switching the sign-in needs to happen per bridge rather than per machine user
---
# Claude sign-in profiles, saved back before every switch

## Context
0017 lets a bridge switch between long-lived tokens (`claude setup-token`). On
2026-11-15 Jasper, with two Claude subscriptions, found that Engram's usage
display does not show correctly for such a token, and does for the CLI's own
sign-in in `~/.claude/.credentials.json`. He asked to switch accounts by
swapping that sign-in instead, without touching the bridges.

That file holds an OAuth access token and a refresh token, and the CLI rewrites
it whenever it refreshes; the refresh token rotates, so a copy kept elsewhere
goes stale and may stop working. The file carries no account id (as of Claude
Code 2.1.325). The CLI reads it at start and re-reads it when its mtime changes;
the bridge's usage report reads it on every ask.

## Decision
`ai-bridge claude-login save|use|list` keep named copies of the file in
`~/.claude/credentials-profiles/<name>.json` (directory 0700, files 0600), with
the name last saved or used in `credentials-profiles/active`.

`use <name>` first copies the current file back into the profile it belongs to,
then puts the chosen copy in place through a 0600 temp file renamed over the
original (through a symlink to its target, keeping the owner). The profile the
current file belongs to is the one holding the same tokens (or account id, should
the file ever carry one), else the recorded active name. A sign-in that is
neither is never overwritten: `use` refuses until it is saved, or `--discard-current`
is given. `save` refuses to store an account already saved under another name,
which would make matching ambiguous.

Nothing in the running bridge changes: Claude runs and usage read the file
themselves. `list` and `use` say plainly when a long-lived token (this shell's
`CLAUDE_CODE_OAUTH_TOKEN`, `AI_BRIDGE_CLAUDE_ENV`, or an installed bridge's token
file with a filled active slot) overrides the sign-in, and `use` warns, without
blocking, while this user's Claude processes run. Files it makes are owned
like `~/.claude`, so a run under `sudo` leaves nothing to root.

## Consequences
- Switching is one command per machine user, from any bridge version via npx.
- A running Claude process may pick up the new sign-in at its next credential
  check, or, refreshing at the same moment, write the previous account back;
  `list` then shows it and `use` again fixes it.
- Copies of the sign-in exist beside it, as private as it is.
- Signing in to another account with `claude /login` and then calling `use`
  without `save` looks exactly like a token refresh (the file has no account id),
  so that sign-in is saved under the recorded profile's name. The copy it
  replaces is then kept as `<name>.json.<time>.prev` (each its own file, removed after 30 days), and `use` says so; the README says
  to `save` after every `/login`.
- `use` re-reads the file just before replacing it and saves whatever a Claude
  process refreshed meanwhile, so a rotated refresh token is not lost.
- Claude's cached account details in `~/.claude.json` are not swapped, so
  `claude /status` may show the previous account's email for a while.
- No protocol change.
