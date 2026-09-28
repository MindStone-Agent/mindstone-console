# MindStone journey UAT

The acceptance gate for the MindStone Console demo ([MindStone-Agent #106](https://github.com/MindStone-Agent/MindStone-Agent/issues/106)). The rule: nothing counts as done until a **fresh install** passes. The install follows both READMEs' "Install guide for AI agents", and everything after that uses **only the Console UI**.

`run-journey.sh` does exactly what a new user does, against any pair of branches:

```bash
e2e/mindstone-journey/run-journey.sh <msa-ref> <console-ref>
# for example
e2e/mindstone-journey/run-journey.sh main fix/18-setup-reachable
```

Every step prints **PASS**, **FAIL** or **PENDING**, with an evidence path. The run exits 0 only when every step passes. A PENDING step counts as not passed.

Needs: git, Node 22.19 or newer, npm, Docker with Compose v2, curl, openssl, and a C/C++ toolchain for MindStone-Agent's native modules. It runs without a TTY. **How long it takes:** on the Mac it was built on, a first run took about 10 minutes, and a rerun about 2 minutes, because the npm download cache and Docker's build cache were warm (the image itself is removed on every exit). The Playwright part takes about 1.5 minutes. On a machine with no caches, the Console image build (`npm ci` plus the frontend build) and MindStone-Agent's `npm install` add their full cold time.

## What it does

### Install: the READMEs followed literally (steps `S*` and `C*`)

| ID | README step | Check |
|---|---|---|
| S0 | MSA 0: requirements | Node ≥ 22.19 |
| S1 | MSA 1: `install.sh` from `<msa-ref>`, with `--dir <scratch> --no-link --branch <msa-ref>` | `mindstone status` exits 0 and shows `<checkout>/.runtime/` |
| S2 | MSA 2: onboarding | A config exists **without** `mindstone onboard`. Today this **FAILs**: see "Findings" below. The harness then runs `scripts/init-runtime.sh`, so the gateway starts *not onboarded*, and says so. |
| S3 | MSA 3: `mindstone gateway start` | `/health` answers |
| S5 | MSA 5: token file, admin credential outside `.runtime`, the `node -e` config merge, `doctor`, `gateway restart` | `/v1/models` gives 200 with the token and 401 without |
| C0 | Console 0: requirements | the gateway check prints 200 |
| C1 | Console 1: `git clone --branch <console-ref>` | only `mindstone/` is used |
| C2 | Console 2: `.env` from `.env.example`, secrets generated, gateway values from files, `UID`/`GID` | the README's grep prints 6 |
| C3 | Console 3: `docker compose up -d --build` | both services are running, and `/` returns 200 |
| C4 | Console 4: the non-interactive `create-user` line (`-T`, `--`, `--email-verified=true`, password on stdin) | the user is created. The admin credential file is then deleted, as the README says. |

### The journey: UI only (steps `J*`, `journey.spec.ts`)

| ID | Step | PASS means | Today |
|---|---|---|---|
| J1 | Sign in as admin | The `create-user` account is `ADMIN`, and the "MindStone isn't set up yet" banner with **Set up MindStone** is visible (console #18, PR #20). | needs PR #20 |
| J2 | Guided setup | Click **Set up MindStone**. Access: typing `Enable advanced settings ` (a capital and a trailing space) enables **Turn on**. Provider: connects and lists models. Then the model, a base persona, and Finish shows "MindStone is set up". | |
| J3 | Memory in setup | The vector store, the embedding provider and model, a live embed check, and autoRecall, all in guided setup. | **PENDING** (#102/#106). It asserts what exists today: no memory step, and the status panel's memory row. |
| J4 | Start a chat | **Start a chat**, then send a message. The Console stores a finished reply that isn't an error and has real text. It also records whether the agent spoke first. | |
| J5 | Identity formation | The agent speaks first with the identity-formation conversation, and the status checklist has an identity step. | **PENDING** (#102) |
| J6 | Recall in the conversation | Plant a codeword, ask an unrelated question, then ask for the codeword. The reply must contain it. | PASS if it works. An error or an empty reply FAILs; a real reply without the codeword is PENDING. |
| J7 | Skill Builder | Built from the Console and from chat, approved, installed and used. | **PENDING** (#104). It checks that `/mindstone` and Approvals load. |
| J8 | Persona drafted by the agent | Proposed in chat, approved on Approvals, active in the next chat, and listed and switchable in the Console. | **PENDING** (#105) |

**How PENDING works.** A PENDING step first checks for its feature: the memory step in the setup list, the identity row on the status panel, or a Skill Builder or Personas link on `/mindstone`. If the feature isn't there, it asserts today's state and calls `test.fixme()` with the issue's "done when". Once the feature lands, the check trips and the step **FAILs** with "replace this PENDING check with the real test". A landed feature can't sit unnoticed as PENDING. Write its assertions from the "done when" text in the step.

## The model provider (J2 and J4)

`UAT_PROVIDER` picks it. The default is `auto`:

- **`ollama`**: a local Ollama on `127.0.0.1:11434`. The harness only reads `/api/tags`. It never pulls a model, and never loads, stops or reconfigures Ollama. `auto` picks the smallest local chat model up to `UAT_OLLAMA_MAX_LOCAL_GB` (default 8; embedding models are skipped). If there isn't one, it picks the smallest `:cloud` model Ollama already lists, which runs remotely, so nothing is loaded on this machine. Set `UAT_PROVIDER_MODEL` to choose one yourself.
- **`ollama-cloud`**: set `UAT_PROVIDER_KEY_FILE` (a file holding the key) and `UAT_PROVIDER_MODEL`. The spec types the key into the provider step's password field. Traces and videos are off, so the key isn't recorded, and it's scrubbed from the evidence.
- **`mock`**: the fallback when neither is available. The route is set through the Console's admin API instead of the UI, and the model, persona and Finish screens are skipped. J2 and J4 are labelled `mock` in the output. A mock run can't pass the gate in a meaningful way.

## Environment

| Variable | Default | Purpose |
|---|---|---|
| `UAT_PROVIDER`, `UAT_PROVIDER_MODEL`, `UAT_PROVIDER_KEY_FILE`, `UAT_OLLAMA_MAX_LOCAL_GB` | `auto` | the model provider (above) |
| `UAT_PERSONA` | the first one | the base persona to pick, matched against its label |
| `UAT_CHAT_MODEL` | `mindstone/default` | the agent to chat with |
| `UAT_RUN_ID` | a timestamp and the PID | names the compose project `uat-journey-<id>`, the scratch dir and the evidence dir |
| `UAT_SCRATCH_ROOT` | `$TMPDIR` | where the scratch dir `uat-journey-<id>/` is created |
| `UAT_EVIDENCE_DIR` | `e2e/mindstone-journey/evidence/<id>/` | where the evidence goes (gitignored) |
| `UAT_PORT_MIN`, `UAT_PORT_MAX` | 26900 to 26999 | the gateway and Console ports. Each is checked free first. Any range that touches 18000 to 18999 is refused. |
| `UAT_MSA_REPO`, `UAT_MSA_RAW`, `UAT_CONSOLE_REPO` | the MindStone-Agent GitHub repos | for testing forks |
| `UAT_KEEP_SCRATCH=1`, `UAT_KEEP_IMAGE=1` | off | keep the scratch dir, or the built Console image, for debugging |
| `DOCKER_HOST`, `DOCKER_CONFIG` | Docker's own | passed through to `docker`. On a Mac where pulls hang in Docker Desktop's credential helper, point `DOCKER_CONFIG` at a config with no `credsStore`, and set `DOCKER_HOST=unix://$HOME/.docker/run/docker.sock`. |

Refs are passed to `git clone --branch`, so use branch or tag names, not SHAs.

## Isolation and teardown

- **MindStone-Agent** installs into `<scratch>/MindStone-Agent`. Every MindStone command runs with `HOME=<scratch>/home` and no inherited `MINDSTONE_*` or `PI_*` variables, so nothing reaches `~/.mindstone*`, `~/.pi`, `~/.openclaw` or a live gateway. The README's `$HOME/.mindstone-admin-credential` lands in the scratch home. npm keeps using your real download cache.
- **The Console** runs as compose project `uat-journey-<id>`. It uses an override file outside the checkout, with its own container names, image tag (`uat-journey-<id>-console:local`) and loopback port. No tracked file is edited, and nothing else on the Docker host is touched.
- **On exit** (including a failure or Ctrl-C), a trap:
  - saves the logs;
  - runs `compose down -v`, then removes anything still labelled with the project;
  - removes the built image;
  - stops the gateway (`mindstone gateway stop`, then the PID file, then anything on its port that runs from the scratch dir);
  - scrubs every generated secret from the evidence;
  - deletes the scratch dir.

  `cleanup.txt` in the evidence dir records what was left, which should be nothing.
- The harness never prints a secret.
- **Playwright:** the harness uses the repo's `node_modules` if it exists. Otherwise it installs the repo's pinned `@playwright/test` once into `e2e/mindstone-journey/.pw/` (gitignored), and never touches the repo's `node_modules`.

## Evidence

In `evidence/<id>/`:

- `SUMMARY.md`: every step's status, evidence and note, the README findings, the harness's deviations from the READMEs, and cleanup;
- `harness-steps.tsv`, `journey-results.tsv` and `journey-results.md`: the same results, machine-readable;
- `screens/`: screenshots from each journey step (`j2-access-typed.png`, `j4-reply.png` and so on), plus `jN-failure.png` when a step fails;
- `logs/`:
  - the install, build and `create-user` logs;
  - `gateway.log` and `console.log`;
  - per-step excerpts such as `j4-reply.txt`, `j6-recall.txt` and `jN-gateway-tail.log`;
  - `playwright.log`;
- `playwright/report/`: the Playwright HTML report (`npx playwright show-report <dir>`);
- `findings.md` and `deviations.md`: where the READMEs were wrong or incomplete when followed literally, and what the harness did differently;
- `run.env`: the refs, commit SHAs, ports, provider and duration;
- `msa-README.md` and `console-README.md`: the READMEs as they were at the refs under test.

## Running only the journey spec

If you already have a Console and gateway set up, and you know the admin's email and password file, run the spec against them:

```bash
cd e2e/mindstone-journey
UAT_CONSOLE_URL=http://localhost:3080 UAT_ADMIN_EMAIL=you@example.com \
UAT_ADMIN_PASSWORD_FILE=/path/to/password UAT_PROVIDER=ollama UAT_PROVIDER_MODEL=<model> \
UAT_EVIDENCE_DIR=/tmp/journey-evidence \
npx playwright test --config playwright.config.ts
```

The spec expects a gateway that isn't set up yet (J1 looks for the banner), and it changes that gateway's config. Don't point it at a gateway you care about.
