# MindStone journey UAT

The acceptance gate for the MindStone Console demo ([MindStone-Agent #106](https://github.com/MindStone-Agent/MindStone-Agent/issues/106)). The rule: nothing counts as done until a **fresh install** passes. The install follows both READMEs' "Install guide for AI agents", and everything after that uses **only the Console UI**.

`run-journey.sh` does exactly what a new user does, against any pair of branches:

```bash
e2e/mindstone-journey/run-journey.sh <msa-ref> <console-ref>
# for example
e2e/mindstone-journey/run-journey.sh main main
```

Every step prints **PASS**, **FAIL**, **PENDING** or **MOCK**, with an evidence path.

**The gate** passes, and the script exits 0, only when all of these hold:
- every required row (S0, S1, S2, S3, S5, C0 to C4, J1 to J8, X1) appears exactly once, and each one is PASS;
- there are no unknown rows;
- Playwright exited 0;
- the harness itself didn't fail.

PENDING, MOCK, SKIPPED and missing rows all count as *not passed*. The summary names every reason.

Needs: git, Node 22.19 or newer, npm, Docker with Compose v2, curl, openssl, and a C/C++ toolchain for MindStone-Agent's native modules. It runs without a TTY.

**How long it takes.** On the Mac it was built on, the first run took about 10 minutes. A rerun took about 2 minutes, because npm's download cache and Docker's build cache were warm. The built image itself is removed on every exit. The Playwright part takes about 1.5 minutes. On a machine with no caches, the Console image build (`npm ci` plus the frontend build) and MindStone-Agent's `npm install` add their full cold time.

## What it does

### Install: the READMEs followed literally (steps `S*` and `C*`)

| ID | README step | Check |
|---|---|---|
| S0 | MSA 0: requirements | Node ≥ 22.19 |
| S1 | MSA 1: `install.sh` from `<msa-ref>`, with `--dir <scratch> --no-link --branch <msa-ref> --repo <repo>` | `mindstone status` exits 0 and shows `<checkout>/.runtime/` |
| S2 | MSA 2: onboarding | A config exists **without** `mindstone onboard`. Today this **FAILs** (finding F-MSA-2). The harness then runs `scripts/init-runtime.sh`, so the gateway starts *not onboarded*, and says so. |
| S3 | MSA 3: `mindstone gateway start` | `/health` answers |
| S5 | MSA 5: token file, admin credential outside `.runtime`, the `node -e` config merge, `doctor`, `gateway restart` | `/v1/models` gives 200 with the token and 401 without |
| C0 | Console 0: requirements | the gateway check prints 200 |
| C1 | Console 1: `git clone --branch <console-ref>` | only `mindstone/` is used |
| C2 | Console 2: `.env` from `.env.example`, secrets generated, gateway values from files, `UID`/`GID` | the README's grep prints 6 |
| C3 | Console 3: `docker compose up -d --build` | both services are running, and `/` returns 200 |
| C4 | Console 4: the non-interactive `create-user` line (`-T`, `--`, `--email-verified=true`, password on stdin) | the user is created. The admin credential file is then deleted, as the README says. |
| X1 | (harness) the evidence | No generated secret appears anywhere in the evidence dir: in plain text, base64-encoded, inside a zip, or inside a base64 zip embedded in a file. This is checked before the scrub, so a leak shows as a FAIL instead of being hidden. |

### The journey: UI only (steps `J*`, `journey.spec.ts`)

| ID | Step | PASS means | Today |
|---|---|---|---|
| J1 | Sign in as admin | The `create-user` account is `ADMIN`, and the "MindStone isn't set up yet" banner with **Set up MindStone** is visible (console #18). | PASS |
| J2 | Guided setup | Click **Set up MindStone**. Access is off on a fresh install, so already-on is a FAIL. Typing `Enable advanced settings ` (a capital and a trailing space) enables **Turn on**. The provider connects and lists models. Then the model, a base persona, and Finish shows "MindStone is set up". After that, `GET /admin/status` (through the Console) reports `onboarded: true`, and a new tab shows no banner. | PASS |
| J3 | Memory in setup | The vector store, the embedding provider and model, a live embed check, and autoRecall, all in guided setup. | **PENDING** (#102/#106) |
| J4 | Start a chat | Listen for chat requests, then click **Start a chat** and watch for 15 s: this records whether the agent spoke first. Send a message. The Console stores a finished reply that isn't an error and has text. The saved route is `pi-session` with the chosen model. The gateway transcript's entry for the reply points to its Pi session file, which must record the chosen provider and model as the one called, with no model fallback. | PASS |
| J5 | Identity formation | The agent speaks first with the identity-formation conversation, and the checklist has an identity step. | **PENDING** (#102) |
| J6 | Recall in the conversation | Plant a codeword, ask an unrelated question, then ask for the codeword. The reply must contain it. It works today, so a miss is a regression and **FAILs**. | PASS |
| J7 | Skill Builder | Advanced settings are on (J2). The **Skills** link on `/mindstone` opens the Skills page, which lists the built-in Integration Builder. From the built-in: a draft with a goal, reviewed, then discarded. From scratch: a draft with an id, label, description, goal, when-to-use and instructions naming a codeword, reviewed (its SKILL.md holds the codeword), then installed: it moves to **Active** and the status panel's skills row says `1 installed`. In a new chat, the agent is asked to create a second skill with its own codeword and propose it for install. The reply is not an error and doesn't show the proposal block. Approvals has a pending `install skill <id>` whose detail holds that codeword; approving it installs it, and the Skills page lists it as **Active**. Then a fresh chat for each codeword: the reply must contain it. With the mock provider the message carries the proposal block itself (the mock echoes it), and the last check is MOCK. | PASS once #104 lands |
| J8 | Persona drafted by the agent | Proposed in chat, approved on Approvals, active in the next chat, and listed and switchable in the Console. | **PENDING** (#105) |

**How PENDING works.** A PENDING step first asserts today's *exact* state, not a guess from names:

| Step | State it asserts |
|---|---|
| J3 | The setup steps are exactly `[Access, Model provider, Model, Persona, Finish]`, and the `/admin/status` checklist keys are exactly `{connectors, memory, persona, provider}`. |
| J5 | The same checklist keys, and the agent didn't speak first. |
| J8 | The links on `/mindstone`'s status section are exactly `[Run guided setup again, Diagnostics, Approvals, Skills]`. `GET /admin/personas`, `/admin/personas/proposals` and `/admin/persona` each return 404. |

Only if that state is unchanged does the step call `test.fixme()` with the issue's "done when". **Any change FAILs the step** with "state changed: … review this PENDING test". A landed or half-landed feature therefore can't sit unnoticed as PENDING. Write the real assertions from the "done when" text in the step.

The route probes are GET-only, sent with the harness's own admin headers. They never change anything.

## The model provider (J2 and J4)

`UAT_PROVIDER` picks the provider. The default is `auto`:

- **`ollama`**: an Ollama at `UAT_OLLAMA_URL` (default `http://127.0.0.1:11434`). The harness only reads `/api/tags`. It never pulls a model and never stops or reconfigures Ollama.
  - **`auto` picks the smallest `:cloud` model that Ollama already lists.** A cloud model runs remotely, so a shared Ollama doesn't have to load anything.
  - A **local** model is used only with `UAT_OLLAMA_ALLOW_LOCAL=1`, because chatting with it *loads it into that Ollama*. Then the smallest local model up to `UAT_OLLAMA_MAX_LOCAL_GB` (default 8) wins. Embedding models are always skipped.
  - With `UAT_PROVIDER=ollama` set explicitly, `UAT_PROVIDER_MODEL` is required, and it must already be listed, or the run stops at once.
  - If `UAT_OLLAMA_URL` isn't the default, the provider step's Server address is set to `<UAT_OLLAMA_URL>/v1`.
- **`ollama-cloud`**: set `UAT_PROVIDER_KEY_FILE` (a file holding the key) and `UAT_PROVIDER_MODEL`. The spec types the key with `fillSecret`, which records no value.
- **`mock`**: the fallback when no provider is available. `auto` announces it loudly.
  - The route is set through the Console's admin API, not the UI.
  - The model, persona and Finish screens are skipped.
  - J2, J4 and J6 report **MOCK**. **A mock run can never pass the gate.**

## Secrets

The harness generates the gateway token, the admin credential, the admin password and the Console's `.env` secrets. You may also supply a provider key. None of them is ever printed or passed on a command line:
- curl reads its auth headers from 0600 files (`-H @file`);
- the password reaches `create-user` on stdin;
- secrets are typed in the browser with `fillSecret`, which sets the value in the page under a step titled "type a secret (value not recorded)". Playwright's `fill()` would put the value in the step title.

There is no html report, trace or video, because those record step titles and arguments. X1 fails the run if any secret shows up anyway. `logs/secret-check.log` lists the files, never the values.

## Environment

| Variable | Default | Purpose |
|---|---|---|
| `UAT_PROVIDER`, `UAT_PROVIDER_MODEL`, `UAT_PROVIDER_KEY_FILE` | `auto` | the model provider (above) |
| `UAT_OLLAMA_URL`, `UAT_OLLAMA_ALLOW_LOCAL`, `UAT_OLLAMA_MAX_LOCAL_GB` | `http://127.0.0.1:11434`, `0`, `8` | which Ollama to use, and whether a local model may be used |
| `UAT_PERSONA` | the first one | the base persona to pick, matched against its label |
| `UAT_CHAT_MODEL` | `mindstone/default` | the agent to chat with |
| `UAT_RUN_ID` | a timestamp and the PID | names the compose project `uat-journey-<id>`, the scratch dir and the evidence dir |
| `UAT_SCRATCH_ROOT` | `$TMPDIR` | where the scratch dir `uat-journey-<id>/` is created |
| `UAT_EVIDENCE_DIR` | `e2e/mindstone-journey/evidence/<id>/` | where the evidence goes (gitignored). It must be new or empty: the harness refuses a non-empty one, and the spec refuses one that already holds a journey's state or results. |
| `UAT_PORT_MIN`, `UAT_PORT_MAX` | 26900 to 26999 | the gateway and Console ports. Each is checked free first. Any range that touches 18000 to 18999 is refused. |
| `UAT_GATEWAY_BRIDGE_HOST` | `172.17.0.1` | **Linux only.** The address the gateway binds, so the Console's container can reach it (MindStone-Agent README 5.5). |
| `UAT_MSA_REPO`, `UAT_MSA_RAW`, `UAT_CONSOLE_REPO` | the MindStone-Agent GitHub repos | for testing forks |
| `UAT_KEEP_SCRATCH=1`, `UAT_KEEP_IMAGE=1` | off | keep the scratch dir, or the built Console image, for debugging |
| `DOCKER_HOST`, `DOCKER_CONFIG` | Docker's own | passed through to `docker`. On a Mac where pulls hang in Docker Desktop's credential helper, point `DOCKER_CONFIG` at a config with no `credsStore`, and set `DOCKER_HOST=unix://$HOME/.docker/run/docker.sock`. |

Refs are passed to `git clone --branch`, so use branch or tag names, not SHAs.

**On Linux or in CI**, the harness runs `playwright install --with-deps chromium` when it's root or has passwordless sudo, and `playwright install chromium` otherwise. Either way, a failed install stops the run.

## Isolation and teardown

- **MindStone-Agent** installs into `<scratch>/MindStone-Agent`. Every MindStone command runs with `HOME=<scratch>/home` and no inherited `MINDSTONE_*` or `PI_*` variables, so nothing reaches `~/.mindstone*`, `~/.pi`, `~/.openclaw` or a live gateway. The README's `$HOME/.mindstone-admin-credential` lands in the scratch home.
- **The Console** runs as compose project `uat-journey-<id>`. It uses an override file outside the checkout, with its own container names, image tag (`uat-journey-<id>-console:local`) and loopback port. No tracked file is edited, and no other container, volume or project on the Docker host is touched.
- **On exit** (including a failure or Ctrl-C), a trap runs these steps:
  1. It prints "cleaning up, please wait" and ignores further Ctrl-C, TERM and HUP until it's done.
  2. It saves the logs.
  3. It runs `compose down -v`, then removes anything still labelled with the project, and removes the built image.
  4. It stops the gateway (`mindstone gateway stop`, then the PID file, then anything on its port that runs from the scratch dir).
  5. It runs the X1 secret check, then scrubs the text files as a second defence.
  6. It deletes the scratch dir.

  `cleanup.txt` records what was left, which should be nothing.

### What it touches outside its sandbox

- **npm's download cache** (`~/.npm`, or `$npm_config_cache`). It's reused so installs are fast.
- **Docker's image store and build cache:**
  - it pulls `mongo:8.0.20` and the Console's base images (`node:24.16.0-alpine`, `ghcr.io/astral-sh/uv`), and leaves them;
  - it leaves the BuildKit layer cache from the Console build;
  - it removes the built `uat-journey-<id>-console:local` image unless `UAT_KEEP_IMAGE=1`.
- **Playwright's browser cache** (`~/Library/Caches/ms-playwright` on macOS, `~/.cache/ms-playwright` on Linux). Chromium is installed there if it's missing. On Linux with root or sudo, `--with-deps` also installs system packages.
- **`e2e/mindstone-journey/.pw/`:** a private `@playwright/test` install, used when the repo has no `node_modules` (gitignored).
- **`/tmp/mindstone-agent-install-status.txt`:** MindStone-Agent's `install.sh` always writes this fixed path (finding F-MSA-1). The harness deletes it on exit, but only if it didn't exist before the run.
- **Your Ollama** (only for `ollama`): the harness reads `/api/tags`. The chat uses the chosen model, which is a `:cloud` model by default, so nothing is loaded locally. A local model would be loaded only with `UAT_OLLAMA_ALLOW_LOCAL=1`.
- **The network:** GitHub (clones and `install.sh`), the npm registry, container registries, and the model provider.

## Evidence

In `evidence/<id>/`:

- `SUMMARY.md`: the gate result and its reasons, every step's status, evidence and note, the README findings, the harness's deviations, and cleanup;
- `harness-steps.tsv`, `journey-results.tsv` and `journey-results.md`: the same results, machine-readable;
- `screens/`: screenshots from each journey step (`j2-access-typed.png`, `j2-banner-gone.png`, `j4-reply.png` and so on), plus `jN-failure.png` when a step fails;
- `logs/`:
  - the install, build and `create-user` logs;
  - `gateway.log` and `console.log`;
  - `secret-check.log`;
  - per-step excerpts: `j4-reply.txt`, `j4-answered-by.json`, `j6-recall.txt`, `j7-gateway-probes.txt`, `jN-gateway-tail.log`;
  - `playwright.log`;
- `playwright/results.json`: Playwright's json report;
- `findings.md` and `deviations.md`: where the READMEs were wrong or incomplete when followed literally, and every place the harness did something the READMEs don't say;
- `run.env`: the refs, commit SHAs, ports, provider, Playwright's exit code and the duration;
- `msa-README.md` and `console-README.md`: the READMEs as they were at the refs under test.

## Running only the journey spec

If you already have a fresh Console and gateway set up, run the spec against them. It expects a gateway that isn't set up yet, and it changes that gateway's config, so don't point it at one you care about. You need:
- the admin's email and password file;
- the gateway URL;
- header files for the gateway's probes: `Authorization: Bearer …` and `x-mindstone-admin-token: …`.

```bash
cd e2e/mindstone-journey
UAT_CONSOLE_URL=http://localhost:3080 UAT_ADMIN_EMAIL=you@example.com \
UAT_ADMIN_PASSWORD_FILE=/path/to/password UAT_PROVIDER=ollama UAT_PROVIDER_MODEL=<model> \
UAT_GATEWAY_URL=http://127.0.0.1:19789 UAT_GATEWAY_AUTH_HEADER_FILE=/path/h-auth \
UAT_GATEWAY_ADMIN_HEADER_FILE=/path/h-admin UAT_TRANSCRIPT_DIR=<checkout>/.runtime/mindstone/transcripts \
UAT_EVIDENCE_DIR=/tmp/journey-evidence-$(date +%s) \
npx playwright test --config playwright.config.ts
```
