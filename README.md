# MailMaid (Chrome extension)

Automatically clean your Gmail using your own rules.

👉 **Install: https://frossdev.github.io/MailMaid/** — one click to download,
then 30 seconds in `chrome://extensions`. No git needed.

## Install on Windows (no manual unzip)

1. Download **`install-mailmaid.ps1`** from this repo
   (`Code → Download ZIP` works, or grab just the file).
2. Right-click it → **Run with PowerShell**.
   - SmartScreen may warn because the script isn't signed: click
     **More info → Run anyway** (you can read the script first — it's short).
3. The script downloads the newest release, unzips it for you into
   `%LOCALAPPDATA%\MailMaid`, and opens `chrome://extensions`.
4. In Chrome: turn ON **Developer mode** (top right) → **Load unpacked** →
   select the folder it shows you (already copied to your clipboard path).
5. Click the MailMaid icon → **Sign in with Google** → allow Gmail access.
6. Open the ⚙ options page to create rules, then press **Clean Now** or turn on
   **Auto Clean**.

No app passwords. Sign-in is plain Google OAuth. You never touch a zip.

> Why the script still exists: Chrome **requires** the "Load unpacked"
> click for anything outside the Web Store — there is no trusted way around
> it. The only true zero-click install is publishing on the Chrome Web Store
> ($5 one-time developer fee), which also still needs the Gmail verification
> for `gmail.modify` / `gmail.send`. This script removes every step *before*
> that click.
## Important: this OAuth client id is the developer's

`manifest.json` ships with an `oauth2.client_id` that belongs to this
repo's author. It works for trying the extension, but if you publish your own
copy (Chrome Web Store, or your own GitHub fork that other people install),
**replace it with your own** (and add your extension `key`):

1. https://console.cloud.google.com → new project.
2. APIs & Services → enable **Gmail API**.
3. Branding (consent screen) → External → app name, your email.
4. Clients → Create Client → **Chrome app** → paste your extension id
   (`chrome://extensions` → MailMaid → ID).
5. Put that client id + your extension `key` into a copy of `manifest.json`.

Why: Google ties a Chrome-extension OAuth client to one extension id. Anyone
who clones this repo gets a different id, so the shipped client id fails for
them with `bad client id`. Your own client id also lets you submit the
required Gmail-scope verification (Restricted scopes: `gmail.modify`,
`gmail.send`) if you distribute publicly.

## Files

- `manifest.json` – MV3 manifest (identity, storage, alarms, Gmail API).
- `background.js` – service worker: scan engine, quota bucket, retry/back-off.
- `popup.html` / `popup.js` / `style.css` – toolbar panel.
- `settings.html` / `settings.js` / `settings.css` – rules editor.
- `test-users/` – email list + validator for Testing-mode installs
  (there is no auto-add bot; Google exposes no API for test users).

## License

MIT – see `LICENSE`.
