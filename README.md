# MailMaid (Chrome extension)

Automatically clean your Gmail using your own rules.

## Install from source (5 min)

1. Clone this repo.
2. Open `chrome://extensions`, enable **Developer mode**.
3. **Load unpacked** → select this folder.
4. Click the MailMaid icon → **Sign in with Google** → allow Gmail access.
5. Open the ⚙ options page to create rules, then press **Clean Now** or turn on
   **Auto Clean**.

No app passwords. Sign-in is plain Google OAuth.

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

## License

MIT – see `LICENSE`.
