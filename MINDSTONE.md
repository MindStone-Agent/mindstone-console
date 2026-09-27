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

Planned, per the design: config and onboarding screens backed by the gateway's config API (P2), then visibility and approvals (P3).

## Run it locally

1. Start the MindStone-Agent gateway with chat completions enabled and token auth.
2. `cd mindstone && cp .env.example .env`, fill in the secrets and the gateway token.
3. `docker compose up -d --build`, then open http://localhost:3080. The first account registered is the admin.

## License

LibreChat is MIT licensed (see `LICENSE`); that notice stays. MindStone's changes are under the same license unless a file says otherwise.
