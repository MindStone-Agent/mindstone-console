# MindStone Console

This repository is **MindStone Console**, the web interface for [MindStone-Agent](https://github.com/MindStone-Agent/MindStone-Agent). It is a fork of [LibreChat](https://github.com/danny-avila/LibreChat) (MIT), kept close to upstream so upstream fixes can be merged in.

## How the fork is kept

- `upstream` is LibreChat. The fork started at **v0.8.8-rc3**, the version the P0 spike proved against the gateway.
- To take an upstream release: `git fetch upstream tag <tag> --no-tags`, then merge the tag into a branch, resolve, and run the checks in `mindstone/`.
- MindStone changes stay small and listed below, so merges stay cheap. When rebasing costs more than it returns, the fork is severed on purpose, not by drift.
- The design lives in MindStone-Agent `docs/refactor/CONSOLE_DESIGN.md` (#38).

## What MindStone changes

| Area | Change |
|---|---|
| Branding | MindStone diamond as the logo and every icon; page title, PWA name and default `APP_TITLE` are "MindStone Console" |
| Deployment | `mindstone/`: compose file (Console built from this repo plus MongoDB), `librechat.yaml` with the MindStone gateway as the only endpoint, `.env.example` |
| Settings (P2) | `/mindstone` page for admins: onboarding checklist, per-section config editing with secrets masked, secret storage, and the advanced-settings permission. The browser talks only to `api/server/routes/mindstone.js`, which checks the LibreChat session and admin capability and calls the gateway's admin API with the service token and the admin credential. Neither credential reaches the browser. |

Planned, per the design: visibility and approvals (P3).

## Run it locally

Use the files in `mindstone/` only. The repo root's `docker-compose.yml`, `deploy-compose.yml` and `.env.example` are upstream LibreChat's: they publish on every interface and allow open registration.


1. Start the MindStone-Agent gateway with chat completions enabled and token auth.
2. `cd mindstone && cp .env.example .env`, fill in the secrets and the gateway token. For the settings page, also set `MINDSTONE_ADMIN_TOKEN`, and on the gateway set `gateway.admin.tokenSha256` to its SHA-256 (`printf %s "<token>" | shasum -a 256`), so the gateway never holds the credential itself. The settings page needs an admin with `read:configs` (to view) and `manage:configs` (to change), platform-wide; the default ADMIN role has both.
3. `docker compose up -d --build`. The page is published on 127.0.0.1:3080 only.
4. Create the admin: `docker compose exec console npm run create-user <email> "<name>" <username>` (it asks for the password). The first account created is the admin, and later ones are users. Registration from the page is off (`ALLOW_REGISTRATION=false`); turn it on only on a network you trust, since the first account to register becomes the admin.
5. Open http://localhost:3080 and sign in.

## License

LibreChat is MIT licensed (see `LICENSE`); that notice stays. MindStone's changes are under the same license unless a file says otherwise.
