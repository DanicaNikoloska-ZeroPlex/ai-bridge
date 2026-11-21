#!/usr/bin/env python3
"""Fail when a tracked file names something this repository must not name.

This project stands on its own: its files carry no names of other
organisations' products, their people, or their internal ticket numbers
(docs/decisions/NNNN-the-repository-names-no-downstream-project.md).

Every text file git tracks is checked, except .mailmap (which by its nature
lists old commit identities). Files with a NUL byte in their first 8 KB are
taken as binary and skipped. Before checking, a line is lower-cased and
escape sequences (\\n, \\r, \\t, \\b, \\f, \\uXXXX, %XX) become spaces, so a name
right after an escaped newline in JSON is still found.

1. Ticket numbers: the letter D, then 0 or 1, then four more digits, not
   inside a longer number or a hex string or colour. Lock files are skipped
   for this check only, because their base64 hashes match it by chance.
2. Blocked words, kept only as SHA-256 hashes so that this check does not
   itself spell out the names it keeps out:
   - WORDS: compared against every word (runs of letters and digits; CamelCase
     and `_` split like `-`), every part of a hyphenated word and every
     adjacent pair of parts ("a-b").
   - SUBSTRINGS: longer names, also found glued to other words, split by
     punctuation or in CamelCase: every substring of the line with all
     non-letters and non-digits removed is compared.

To block another word, add the output of
    printf %s 'word' | sha256sum
(lower-case) to WORDS, and for a name of 7 or more letters also to SUBSTRINGS.
Run from anywhere in the checkout: python3 scripts/check-names.py
"""
import hashlib
import re
import subprocess
import sys

WORDS = {
    "3f98bb80d3ba916151bfa3f8bd53f4a5b132952c45c5a8de2861453aa86e6a8d",
    "9148b1465b33fd3d3edc9c157768765b3530d0ffb7cc05d248a5c3af603ef2c7",
    "f04b4ee17c8e83f7576aaca1237024bea8d8fc5364b8a7fd3cf45fddcd011cd1",
    "4868c5b9904cccc2a8fcc5549cb41e0e8228bfdbce757132f0fbf4094602e1b4",
    "373e66194b05c55de45549b6a3d01cc4c3fd07b265cf43416c7eb86850a4a21d",
    "1ea0d42878c58dfcee771674e72f1ac30830c7473db0d2d3e8df363234cdd791",
    "73596ac74e82b8dff1c6089a77b86ff8ea6c1f21fbf1d975d591a716c5290ab6",
    "0b5068223c4c90b6b84445fb7d5422e92508d6aff6184a6b792f1982fbe634ed",
}

SUBSTRINGS = {
    "3f98bb80d3ba916151bfa3f8bd53f4a5b132952c45c5a8de2861453aa86e6a8d",
    "f04b4ee17c8e83f7576aaca1237024bea8d8fc5364b8a7fd3cf45fddcd011cd1",
    "373e66194b05c55de45549b6a3d01cc4c3fd07b265cf43416c7eb86850a4a21d",
    "73596ac74e82b8dff1c6089a77b86ff8ea6c1f21fbf1d975d591a716c5290ab6",
    "0b5068223c4c90b6b84445fb7d5422e92508d6aff6184a6b792f1982fbe634ed",
}
SUBSTRING_LENGTHS = (7, 8, 9)

EXCLUDED = {".mailmap"}
NO_TICKET_CHECK = {"package-lock.json", "composer.lock"}

ESCAPES = re.compile(r"\\u[0-9a-fA-F]{4}|\\[nrtbf]|%[0-9a-fA-F]{2}")
CAMEL = re.compile(r"(?<=[a-z0-9])(?=[A-Z])")
TICKET = re.compile(r"(?<![0-9a-f#])d[01][0-9]{4}(?![0-9])")
WORD = re.compile(r"[0-9a-z]+(?:-[0-9a-z]+)*")
NON_ALNUM = re.compile(r"[^0-9a-z]+")


def digest(word: str) -> str:
    return hashlib.sha256(word.encode()).hexdigest()


def candidates(word: str):
    yield word
    parts = word.split("-")
    if len(parts) > 1:
        yield from parts
        for a, b in zip(parts, parts[1:]):
            yield f"{a}-{b}"


def blocked_substring(squashed: str) -> bool:
    for n in SUBSTRING_LENGTHS:
        for i in range(len(squashed) - n + 1):
            if digest(squashed[i : i + n]) in SUBSTRINGS:
                return True
    return False


def check_line(line: str, ticket_check: bool):
    line = ESCAPES.sub(" ", line)
    low = line.lower()
    if ticket_check and TICKET.search(low):
        return "ticket number"
    words = CAMEL.sub("-", line).lower().replace("_", "-")
    for word in WORD.findall(words):
        if any(digest(c) in WORDS for c in candidates(word)):
            return "blocked word"
    if blocked_substring(NON_ALNUM.sub("", low)):
        return "blocked word"
    return None


def main() -> int:
    top = subprocess.run(
        ["git", "rev-parse", "--show-toplevel"], check=True, capture_output=True, text=True
    ).stdout.strip()
    files = subprocess.run(
        ["git", "ls-files", "-z"], cwd=top, check=True, capture_output=True
    ).stdout.decode().split("\0")
    hits = []
    for path in files:
        if not path or path in EXCLUDED:
            continue
        try:
            with open(f"{top}/{path}", "rb") as fh:
                data = fh.read()
        except (IsADirectoryError, FileNotFoundError, PermissionError):
            continue
        if b"\0" in data[:8192]:
            continue  # binary
        ticket_check = path.rsplit("/", 1)[-1] not in NO_TICKET_CHECK
        text = data.decode("utf-8", errors="replace")
        for n, line in enumerate(text.splitlines(), 1):
            what = check_line(line, ticket_check)
            if what:
                hits.append(f"{path}:{n}: {what}")
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
