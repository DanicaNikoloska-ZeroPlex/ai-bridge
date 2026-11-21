#!/usr/bin/env python3
"""Fail when a tracked file names something this repository must not name.

This project stands on its own: its files carry no names of other
organisations' products, their people, or their internal ticket numbers
(docs/decisions/0019-the-repository-names-no-downstream-project.md).

Two checks, over every file git tracks except .mailmap (which by its nature
lists old commit identities):

1. Ticket numbers: a D followed by 0 or 1 and four digits (D01234, d10000),
   standing on its own, case-insensitive.
2. Blocked words: every word is lower-cased and compared by SHA-256 against
   BLOCKED below. Only hashes are kept so that this check does not itself
   spell out the names it keeps out. Words are runs of letters and digits;
   `_` counts as `-`, and for a hyphenated word the whole, each part and each
   adjacent pair ("a-b") are checked.

To block another word, add the output of
    printf %s 'word' | sha256sum
(lower-case word) to BLOCKED. Run: python3 scripts/check-names.py
"""
import hashlib
import re
import subprocess
import sys

BLOCKED = {
    "3f98bb80d3ba916151bfa3f8bd53f4a5b132952c45c5a8de2861453aa86e6a8d",
    "9148b1465b33fd3d3edc9c157768765b3530d0ffb7cc05d248a5c3af603ef2c7",
    "f04b4ee17c8e83f7576aaca1237024bea8d8fc5364b8a7fd3cf45fddcd011cd1",
    "4868c5b9904cccc2a8fcc5549cb41e0e8228bfdbce757132f0fbf4094602e1b4",
    "373e66194b05c55de45549b6a3d01cc4c3fd07b265cf43416c7eb86850a4a21d",
    "1ea0d42878c58dfcee771674e72f1ac30830c7473db0d2d3e8df363234cdd791",
    "73596ac74e82b8dff1c6089a77b86ff8ea6c1f21fbf1d975d591a716c5290ab6",
    "0b5068223c4c90b6b84445fb7d5422e92508d6aff6184a6b792f1982fbe634ed",
}

EXCLUDED = {".mailmap"}

TICKET = re.compile(r"(?<![0-9a-z])d[01][0-9]{4}(?![0-9a-z])")
WORD = re.compile(r"[0-9a-z]+(?:-[0-9a-z]+)*")


def digest(word: str) -> str:
    return hashlib.sha256(word.encode()).hexdigest()


def candidates(word: str):
    yield word
    parts = word.split("-")
    if len(parts) > 1:
        yield from parts
        for a, b in zip(parts, parts[1:]):
            yield f"{a}-{b}"


def main() -> int:
    files = subprocess.run(
        ["git", "ls-files", "-z"], check=True, capture_output=True
    ).stdout.decode().split("\0")
    hits = []
    for path in files:
        if not path or path in EXCLUDED:
            continue
        try:
            with open(path, "rb") as fh:
                data = fh.read()
        except (IsADirectoryError, FileNotFoundError):
            continue
        if b"\0" in data[:8192]:
            continue  # binary
        text = data.decode("utf-8", errors="replace")
        for n, line in enumerate(text.splitlines(), 1):
            low = line.lower().replace("_", "-")
            if TICKET.search(low):
                hits.append(f"{path}:{n}: ticket number")
                continue
            for word in WORD.findall(low):
                if any(digest(c) in BLOCKED for c in candidates(word)):
                    hits.append(f"{path}:{n}: blocked word")
                    break
    for hit in hits:
        print(hit)
    if hits:
        print(
            f"{len(hits)} line(s) name something this repository keeps out; "
            "see scripts/check-names.py.",
            file=sys.stderr,
        )
        return 1
    print("No blocked names or ticket numbers.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
