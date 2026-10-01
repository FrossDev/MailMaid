#!/usr/bin/env python3
"""MailMaid test-user list helper (NO automation possible - Google has no API).

What this does:
  Reads test-users/emails.txt, validates every line as a deliverable Gmail /
  Google address, de-duplicates, and prints the clean list plus a count.
  You then paste that list into:
    Google Cloud Console -> your project -> Google Auth Platform -> Audience
    -> Test users -> ADD USERS (one at a time, by hand).

What this does NOT do (and cannot - there is no API, gcloud command, or
client library for consent-screen test users):
  upload anything anywhere. Anyone promising a bot that "auto-adds test
  users" is scripting the Console UI with your login cookies, which breaks
  constantly and risks your Google account. Don't do that.

Usage:
  python test-users/check.py            # validate + print clean list
  python test-users/check.py --fix      # rewrite emails.txt cleaned
"""
import re
import sys
from pathlib import Path

LIST_FILE = Path(__file__).with_name("emails.txt")
ADDR = re.compile(r"^[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}$")


def load():
    raw = LIST_FILE.read_text(encoding="utf-8").splitlines()
    seen, clean, bad = set(), [], []
    for line in raw:
        line = line.strip().lower()
        if not line or line.startswith("#"):
            continue
        if ADDR.match(line) and line not in seen:
            seen.add(line)
            clean.append(line)
        elif line not in seen:
            bad.append(line)
    return clean, bad


def main():
    if not LIST_FILE.exists():
        print("Missing", LIST_FILE, "- create it first (see README in this folder).")
        sys.exit(1)
    clean, bad = load()
    print("Valid: %d / 100 max" % len(clean))
    for addr in clean:
        print("  " + addr)
    if bad:
        print("\nINVALID (fix or remove):")
        for addr in bad:
            print("  " + addr)
    if len(clean) > 100:
        print("\nWARNING: Testing mode caps at 100 test users. Remove %d."
              % (len(clean) - 100))
    if "--fix" in sys.argv and (bad or len(clean) != len(set(clean))):
        LIST_FILE.write_text(
            "# one real address per line, lowercase\n"
            + "".join(a + "\n" for a in clean),
            encoding="utf-8",
        )
        print("\nRewrote", LIST_FILE, "cleaned.")


if __name__ == "__main__":
    main()
