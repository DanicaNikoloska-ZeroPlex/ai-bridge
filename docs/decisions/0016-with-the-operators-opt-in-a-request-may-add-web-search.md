---
status: accepted
date: 2026-11-14
supersedes:
superseded_by:
revisit_when: an operator finds opt-in a needless step for something this narrow (then weigh opt-out, a choice for Jasper), Claude Code's WebSearch starts reaching anything on the bridge's machine, a server needs WebFetch or another built-in, or Codex or Gemini get an equivalent lever
---
# With the operator's opt-in, a request may add Claude's built-in WebSearch, and only it, to an `isolated` turn

## Context
An `isolated` Claude turn allows only `mcp__bridge__*` (plus a read grant on its
own attachment directory), and `--permission-mode manual` in `-p` mode denies
everything else (0006). That denies Claude Code's built-in `WebSearch` too, as a
side effect: nobody decided against web search. Dungeon Maister's Workshop (the
human Dungeon Master's assistant) runs isolated, and on 2026-11-14 Jasper chose to
let it search the web when the DM allows it per campaign. 0012 says a request may
narrow its turn, never widen it; the non-negotiables say the server cannot widen
what the operator allowed.

## Decision
From 0.40.0 a bridge started with `--allow-web-search` (or `install
--allow-web-search`) announces `hello.web_search: true`, and an `ai_request` may
then carry `options.web_search: true`. On an `isolated` Claude turn (the
connection's posture, or one narrowed to it by `cli_isolation`, which amends
0012's "launched exactly as an isolated one" for this one tool) the bridge adds
exactly `WebSearch` to `--allowedTools`; nothing else changes. Only the JSON value
`true` asks. In `workspace` and `native` every built-in tool is already allowed,
so the field changes nothing there.

An `isolated` turn that asks is refused, never run without the tool: on a bridge
without the flag (`web_search_not_allowed`) and on Codex or Gemini, which cannot
be given exactly one built-in (`web_search_unsupported`). `resolveWebSearch()` in
`src/bridge.ts` decides.

Why the operator's opt-in, though a search reads no file and runs no command on
the machine: it runs on the operator's Claude account, and it sends words the
model takes from the turn to a search backend, a recipient the operator never
chose; with `--local-tools` those words can come from tools run on this machine,
whose sealed values are scrubbed, not contained (0004). The operator decides
what a server may do here; a server cannot switch it on by sending a field.

## Consequences
- Verified on Claude Code 2.1.325 with `--allowedTools "mcp__bridge__*,WebSearch"
  --permission-mode manual`: the turn searched; `WebFetch` and `Bash` were denied
  (`permission_denials` in the result). `tests/bridge/web-search.test.ts` and
  `tests/providers/isolation-posture.test.ts` assert the argv and the refusals.
- A server that relies on search checks `hello.web_search` (and the provider)
  before sending the option, and says when it is missing; a bridge older than
  0.40.0 ignores the option.
- Search results are untrusted text inside the turn: a page may carry
  instructions. The server's prompt must tell the model never to follow them;
  the bridge cannot.

## Rejected
- **On unless the operator says no (`--no-web-search`)**: no restart needed for a
  server that wants search, but every bridge that self-updates to 0.40.0 would
  give any server a tool on its operator's account without the operator choosing
  it, against the non-negotiable and 0006. Kept as the thing to revisit if opt-in
  proves a needless step.
- **`WebFetch` too**: it fetches any URL the model writes, so instructions on a
  searched page could send the turn's data to any host as a query string. Search
  results are enough for the facts a server asked for.
- **Running a refused turn without the tool, with a log line**: the turn would
  look exactly like one that could search.
- **A new posture**: it would mean "isolated plus one tool"; 0012 rejected a
  second name for one launch for the same reason.
