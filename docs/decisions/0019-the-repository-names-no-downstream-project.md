---
status: accepted
date: 2026-11-21
supersedes:
superseded_by:
revisit_when: a contributor's name or an outside product has to appear in a file for a reason a reader needs (a credit, a compatibility note)
---
# The repository names no downstream project; history is kept and mapped

## Context

ai-bridge is the owner's own open-source project and stands on its own. Its files had come
to name a downstream product, the organisation behind it, people working there, folders on a
developer's laptop and that organisation's internal ticket numbers: in examples, comments, test
names and recorded fixtures. Earlier commits carry those people's and that organisation's
addresses as author and committer.

## Decision

- Current files name no other organisation's product, its people or its internal ticket numbers.
  Examples use neutral names (`app.example.com`, `~/projects/acme-app`, "Acme").
- CI enforces it: `scripts/check-names.py` fails on a ticket number (D, then 0 or 1, then four
  digits) or a blocked word anywhere in the tracked files except `.mailmap`. Blocked words are
  kept as SHA-256 hashes, so the check does not itself spell out what it keeps out.
- Git history is not rewritten: no force-push, and tags, released versions and earlier pull
  requests stay as they are. `.mailmap` maps the earlier identities for `git log`,
  `git shortlog` and `git blame`: the owner's to `jfbauer <jasper@tetrix.dev>`, everyone
  else's to a neutral `Contributor`.

## Consequences

- A pull request that brings such a name or number back fails CI; the fix is a neutral example.
- `.mailmap` necessarily lists the earlier e-mail addresses; that is the one place they appear.
- `git log --no-mailmap`, GitHub's web view, and released artifacts still show the original
  identities.

## Options considered

- Rewrite history (filter-repo) and force-push: rejected, because it breaks every clone, fork and
  tag, and the commit links in released versions and pull requests.
- A readable pattern in CI: rejected, because the check would itself name what it keeps out.
