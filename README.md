<p align="center">
  <img src="client/public/assets/logo.svg" height="160" alt="MindStone Console">
</p>

# MindStone Console

**The web interface for [MindStone-Agent](https://github.com/MindStone-Agent/MindStone-Agent):** chat with your MindStone agents and run the gateway from a browser.

> ⚠️ **Beta.** The Console and the gateway's admin API are under active development. They're meant for a machine you control, not for exposure to the internet.

> 🤖 **AI agents:** to install this, follow [Install guide for AI agents](#install-guide-for-ai-agents). It goes step by step, with a check after each step.

## What it does

- **Chat** with MindStone agents over the gateway's OpenAI-compatible API. Each agent appears as a model (`mindstone/<agentId>`), and each Console conversation gets its own MindStone session.
- **Admin settings** at `/mindstone`, for admins only:
  - **guided onboarding:** a checklist for model providers and first setup;
  - **settings:** edit config section by section, with secrets masked;
  - **stored secrets:** list and delete. Values are never shown, and the gateway's own credentials are protected;
  - **approvals:** approve or reject actions the agent proposes;
  - **diagnostics:** the gateway's doctor report and logs;
  - **restart** the gateway;
  - an **advanced-settings permission**, a short-lived confirmation for sensitive changes.
- **Credentials stay on the server.** The browser only ever talks to the Console's own server, which checks your session and admin role and then calls the gateway. The gateway token and the admin credential never reach the browser.

The goal is full admin control from the UI, matching everything the `mindstone` CLI can do. Progress is tracked in [#6](https://github.com/MindStone-Agent/mindstone-console/issues/6).

## Install guide for AI agents

This section is written so an AI coding agent (Claude Code, Codex and similar) can install the Console from start to finish; humans can follow it too. Every step ends with a check, and you should not move on until the check passes. **Never print a secret into your output.** Write secrets straight into files, as the commands below do.

### 0. Requirements

- **A working MindStone-Agent gateway, set up for the Console.** Follow [MindStone-Agent's install guide](https://github.com/MindStone-Agent/MindStone-Agent#install-guide-for-ai-agents) through step 5. Its step 5 also gives you the two values the Console needs: the **gateway token** and the **admin credential**.
- Docker with Compose v2 (`docker compose version`).
- `git` and `openssl`.

**Check:** on the gateway host, run:

```bash
curl -s -o /dev/null -w '%{http_code}\n' -H "Authorization: Bearer $(cat <gateway checkout>/.runtime/mindstone/secrets/gateway-token)" http://127.0.0.1:19789/v1/models
```

It prints `200`.

### 1. Get the code

```bash
git clone https://github.com/MindStone-Agent/mindstone-console.git
cd mindstone-console/mindstone
```

**Use only the files in `mindstone/`.** The `docker-compose.yml`, `deploy-compose.yml` and `.env.example` at the repository root are upstream LibreChat's. They publish on every network interface and allow open registration, where the first account to register becomes admin.

### 2. Configure

Create `.env`, readable only by you, and fill in the generated secrets without printing them:

```bash
cp .env.example .env
chmod 600 .env
for k in CREDS_KEY JWT_SECRET JWT_REFRESH_SECRET; do
  sed -i.bak "s|^$k=.*|$k=$(openssl rand -hex 32)|" .env
done
sed -i.bak "s|^CREDS_IV=.*|CREDS_IV=$(openssl rand -hex 16)|" .env
rm -f .env.bak
```

Then fill in the two gateway values from their files on the gateway host, again without printing them. `GW` is the gateway's secrets folder, and `ADMIN` is the admin credential file from MindStone-Agent's step 5.2:

```bash
GW=<gateway checkout>/.runtime/mindstone/secrets
ADMIN="$HOME/.mindstone-admin-credential"
sed -i.bak "s|^MINDSTONE_GATEWAY_TOKEN=.*|MINDSTONE_GATEWAY_TOKEN=$(cat "$GW/gateway-token")|" .env
sed -i.bak "s|^MINDSTONE_ADMIN_TOKEN=.*|MINDSTONE_ADMIN_TOKEN=$(cat "$ADMIN")|" .env
rm -f .env.bak
```

Once the Console is running (step 3), delete `$HOME/.mindstone-admin-credential`. The Console's `.env` is then the only copy, and the gateway keeps only its hash.

Then check these in `.env`:
1. **`MINDSTONE_GATEWAY_URL`:** the gateway as the container sees it, ending in `/v1`.
   - On the same machine, that's `http://host.docker.internal:19789/v1`, which is the default.
   - On Linux, use the address the gateway was bound to (MindStone-Agent step 5.5), for example `http://172.17.0.1:19789/v1`.
2. **Linux only:** add `UID=` and `GID=` lines with your own ids (`id -u` and `id -g`), so the containers can write their data folders.
3. **Leave `ALLOW_REGISTRATION=false`.**

**Check:** `grep -cE '^(CREDS_KEY|CREDS_IV|JWT_SECRET|JWT_REFRESH_SECRET|MINDSTONE_GATEWAY_TOKEN|MINDSTONE_ADMIN_TOKEN)=.+' .env` prints `6`. It counts lines and never shows a value.

### 3. Start it

```bash
mkdir -p data-node uploads logs
docker compose up -d --build
```

The first build takes several minutes. The image contains only code: `.env` and the data folders are mounted at runtime and are never copied into it.

**Check:** `docker compose ps` shows `mindstone-console` and `mindstone-console-mongo` running, and `curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:3080` prints `200`.

### 4. Create the admin account

Sign-up from the page is off. The first account you create is the admin; later ones are ordinary users.

- **A person at a terminal** runs this and answers the prompts:
  ```bash
  docker compose exec console npm run create-user <email> "<name>" <username>
  ```
- **An agent without a TTY** passes the password on stdin. It must use `-T`, the `--` and `--email-verified=true`, or it waits for input forever:
  ```bash
  printf '%s\n' "$ADMIN_PASSWORD" | docker compose exec -T console npm run create-user -- <email> "<name>" <username> --email-verified=true
  ```
  Get `ADMIN_PASSWORD` from the person, or generate one into a file for them. Don't print it.

**Check:** the command reports the user was created, and signing in at <http://localhost:3080> works.

### 5. Use it

- Open <http://localhost:3080> and sign in.
- Chat with the agent from the model menu. The gateway lists each agent as `mindstone/<agentId>`, plus its default model.
- Admin settings are at <http://localhost:3080/mindstone>: onboarding, settings, secrets, approvals, doctor and logs, and restarting the gateway.
- **First-time setup** is at <http://localhost:3080/mindstone/onboarding>. Nothing redirects you there yet ([#18](https://github.com/MindStone-Agent/mindstone-console/issues/18)), so open it directly. Its first step asks you to type `enable advanced settings`. It has to match exactly: all lowercase, and no space at the end.

**Check:** a chat message gets a real answer, and `/mindstone` shows the status panel without errors.

If chat fails:
- **`501` or `routing_error`:** the gateway's model route isn't set up. Run `mindstone doctor` on the gateway host.
- **`401`:** `MINDSTONE_GATEWAY_TOKEN` doesn't match the gateway.
- **A connection error:** `MINDSTONE_GATEWAY_URL` isn't reachable from the container (see step 2).

### Reaching it from another machine

The Console listens on `127.0.0.1:3080` only. For remote access, put it behind a reverse proxy with HTTPS, or use Tailscale. Set `DOMAIN_CLIENT` and `DOMAIN_SERVER` in `.env` to the public URL, so links and logins point there. Don't change the port binding to `0.0.0.0` on an untrusted network.

### Updating

```bash
cd mindstone-console && git pull --ff-only
cd mindstone && docker compose up -d --build
```

Update MindStone-Agent at the same time: the Console and the gateway's admin API move together.

## Built on LibreChat

MindStone Console is a fork of [LibreChat](https://github.com/danny-avila/LibreChat) (MIT), kept close to upstream so upstream fixes can be merged in. The chat experience comes from LibreChat:
- conversation history;
- editing and resubmitting messages, and branching and forking conversations;
- Markdown and code rendering;
- copying messages as rich text;
- a UI in more than 30 languages;
- light, dark and high-contrast themes.

The Console turns off the LibreChat features that MindStone handles itself, or that would bypass it: other model providers, LibreChat agents, presets, memories and model parameters. Some LibreChat menus (Skills, Prompts, MCP settings and Tools) are still visible; hiding them is tracked in [#6](https://github.com/MindStone-Agent/mindstone-console/issues/6). Conversation search needs Meilisearch, which this deployment doesn't include. The agent, its memory, tools and model routing all live in MindStone-Agent. [MINDSTONE.md](MINDSTONE.md) lists every MindStone change and explains how the fork is kept.

## License

MIT. See [LICENSE](LICENSE). LibreChat's copyright notice stays, and MindStone's changes are under the same license unless a file says otherwise.
