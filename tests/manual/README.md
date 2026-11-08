# Manual end-to-end checks

The automated suite (`npm test`) runs against stub adapters and a fake server.
It cannot tell you whether a real provider CLI, driven by the real bridge, in a
real checkout, actually does the work — and for a feature whose whole point is
running code on someone's machine, that is the question worth answering.

These scripts do that. They are **not** part of `npm test`: they need a provider
CLI installed and logged in, and they spend real tokens.

## Running them

```bash
node tests/manual/e2e.mjs            # everything that needs no provider turn
node tests/manual/e2e.mjs --with-cli # also the turns that spend tokens
```

`--with-cli` requires `claude` on PATH and authenticated. Expect a handful of
short turns.

## What they cover

Each check maps to a line in the "How to prove it works" list the feature was
specified against:

- a bridge with no `--allow-dir` refuses a named directory, and does **not**
  fall back to the scratch directory;
- `~/.ssh`, a `..` traversal, and a symlink inside the allowed root that points
  outside it are all refused;
- a named directory that does not exist is refused rather than created;
- an attachment URL on another host is refused;
- the posture gate: `workspace` and `native` are each refused unless the
  operator opted in, and adopted when they did;
- with `--with-cli`: a real turn in a real checkout reads a file, edits it, runs
  the test, and the working tree shows the change;
- with `--with-cli`: an attachment larger than the server's 1 MB frame cap
  arrives on disk with a matching checksum, the model reads it, and the
  directory is gone afterwards.

- with `--with-cli`: a server tool that answers with an image (`tool_resolve.content`)
  has it seen by the model, and the image bytes are not echoed back to the server.

- with `--with-cli`: an `isolated` turn cannot read a file outside its working
  directory, **while server-declared tools still work** — the two halves of the
  isolation guarantee, checked on the machine you are running this on.

## Why the isolation checks are here rather than in the unit suite

`isolated` is enforced by the provider CLI's permission system, not by the
bridge, and that system reads the operator's own configuration
(`~/.claude/settings.json`, `~/.codex/config.toml`). The bridge therefore states
the posture explicitly — `--permission-mode manual` for Claude,
`sandbox_mode=read-only` for Codex — so a permissive local default cannot widen
what a server may do.

A unit test can only assert that the bridge *sends* those flags. Whether the CLI
then honours them, on this machine, with this configuration, is a question only a
real run can answer — and it is the question that matters if your server is
reachable by people you do not trust. That is what the two `isolated` checks do.

Gemini has no equivalent lever, so it is not covered: an `isolated` Gemini turn
is bounded by Gemini's own defaults. Do not offer Gemini to untrusted callers.
