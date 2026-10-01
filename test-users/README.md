# Test users (Testing-mode installs)

While the OAuth consent screen stays in **Testing**, each user installs your
fork as their *own* private copy (see main README). Test users only matter on
**your** Cloud project, and only up to 100 of them, and only to silence the
"unverified" block — tokens still expire after 7 days.

## There is no bot. There cannot be one.

Google provides **no API, no gcloud command, no library** to add consent-screen
test users. The only supported path is the Console UI, one address at a time:

`Google Cloud Console -> your project -> Google Auth Platform -> Audience -> Test users -> ADD USERS`

Anyone offering a bot that "auto-adds" them is screen-scraping the Console
with your Google login — it breaks on every UI change and risks your account.

## What this folder is for

`emails.txt` holds the addresses, one per line. `check.py` validates them:

```powershell
python test-users/check.py          # validate + print clean list
python test-users/check.py --fix    # rewrite emails.txt de-duplicated
```

Then paste the clean addresses into the Console by hand. Yes, by hand —
that's Google's design, not ours.

## Limits (Testing mode)

- 100 test users max per project, lifetime-ish quota.
- Authorizations expire after 7 days (refresh tokens die too).
- "Unverified app" warning on every fresh consent.
- Real distribution (Marketplace listing, no warnings) requires Production +
  verification + yearly CASA for `gmail.modify` / `gmail.send`.
