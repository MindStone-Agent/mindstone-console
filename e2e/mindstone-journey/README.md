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
- every required row (S0, S1, S2, S3, S5, C0 to C4, J1 to J8, X1 to X5) appears exactly once, and each one is PASS;
- there are no unknown rows;
- Playwright exited 0;
- the harness itself didn't fail;
- **the harness is unmodified** (see Provenance);
- no self-test sabotage flag is set.

PENDING, MOCK, SKIPPED and missing rows all count as *not passed*. The summary names every reason. An interrupted run (Ctrl-C) exits 130.

Next to the gate line, **`DEMO SUBSET (J1–J6 + S/C/X): PASS/NOT PASSED`** applies the same rules without J7 and J8, the features still being built. A J3 or J5 regression therefore can't hide behind their standing PENDING.

With `UAT_EXPECT_FLOW=102`, J2 FAILs unless the Console has the #102 setup flow. Use it for demo gate runs.

## Provenance

`SUMMARY.md` records where the harness came from:
- the harness commit;
- `git status --porcelain -- e2e/mindstone-journey`;
- a sha256 over the harness files (`lib/harness-hash.mjs`: every file git would track there), taken at the start and again at the end;
- who ran it: `UAT_RAN_BY` (for example `UAT_RAN_BY=Cairn`), plus a sha256 fingerprint of `user@host`. The user and host names themselves are redacted.

**A dirty harness can't pass.** That means a status line, an untracked file, or a hash that changed during the run. Set `UAT_ALLOW_DIRTY_HARNESS=1` to run anyway, for example while developing the harness. The gate line then carries "(DIRTY HARNESS OVERRIDE)", and SUMMARY says in bold that the run used a modified harness and is not evidence for #106.

**`NODE_OPTIONS` must be empty.** It could preload code into every node process the harness starts, so the harness refuses to run with it set, and provenance records it as empty. SUMMARY also names any overridden repo (`UAT_MSA_REPO`, `UAT_MSA_RAW`, `UAT_CONSOLE_REPO`).

Needs: git, Node 22.19 or newer, npm, Docker with Compose v2, curl, openssl, and a C/C++ toolchain for MindStone-Agent's native modules. It runs without a TTY.

**How long it takes.** On the Mac it was built on (Docker Desktop with BuildKit), the first run took about 10 minutes. A rerun took about 2 minutes, because npm's download cache and Docker's build cache were warm; the built image itself is removed on every exit. The Playwright part takes about 1.5 minutes. **A cold Console image build with the classic builder (colima) takes about 23 minutes on its own.**

### colima (and other Dockers without Compose v2)

- **Compose v2.** C0 needs `docker compose`. If only the standalone `docker-compose` is installed:
  1. make a private Docker config whose `cli-plugins/docker-compose` links to that binary;
  2. point `DOCKER_CONFIG` at it;
  3. because a fresh `DOCKER_CONFIG` drops the docker context, also set `DOCKER_HOST` to the colima socket.

  ```bash
  mkdir -p ~/.uat-docker/cli-plugins && ln -sf "$(command -v docker-compose)" ~/.uat-docker/cli-plugins/docker-compose
  echo '{}' > ~/.uat-docker/config.json
  export DOCKER_CONFIG=~/.uat-docker DOCKER_HOST="unix://$HOME/.colima/default/docker.sock"
  ```
- **The scratch dir under `$HOME`.** colima shares only your home folder into its VM. With the default `UAT_SCRATCH_ROOT` (`$TMPDIR`, under `/var/folders`), C3's bind mounts fail with "error mounting /var/folders/…". Set `UAT_SCRATCH_ROOT=$HOME/uat-scratch`, or any folder under `$HOME`.

## What it does

### Install: the READMEs followed literally (steps `S*` and `C*`)

| ID | README step | Check |
|---|---|---|
| S0 | MSA 0: requirements | Node ≥ 22.19 |
| S1 | MSA 1: `install.sh` from `<msa-ref>`, with `--dir <scratch> --no-link --branch <msa-ref> --repo <repo>` | `mindstone status` exits 0 and shows `<checkout>/.runtime/` |
| S2 | MSA 2(b): skip onboarding for the Console (#108) | The README's step 2 offers a (b) Console-first path, and the config `install.sh` created says `routing.mode: placeholder` (not onboarded). PASS since MindStone-Agent #110. **Compatibility:** for older MSA refs, where `install.sh` makes no config, S2 FAILs (finding F-MSA-2), and the harness runs `scripts/init-runtime.sh`, labelled, so the rest of the journey can still run. |
| S3 | MSA 3: `mindstone gateway start` | `/health` answers |
| S5 | MSA 5: token file, admin credential outside `.runtime`, the `node -e` config merge, `doctor`, `gateway restart` | `/v1/models` gives 200 with the token and 401 without |
| C0 | Console 0: requirements | the gateway check prints 200 |
| C1 | Console 1: `git clone --branch <console-ref>` | only `mindstone/` is used |
| C2 | Console 2: `.env` from `.env.example`, secrets generated, gateway values from files, `UID`/`GID` | the README's grep prints 6 |
| C3 | Console 3: `docker compose up -d --build` | Before `up`, `lib/compose-guard.mjs` reads `docker compose config --format json`, because the compose file comes from the ref under test and `down -v` removes what it names. It refuses:<br>- a container name, or a *built* image tag, that isn't prefixed with the project;<br>- a volume or network that isn't the project's, or is `external`;<br>- a bind mount from outside the Console checkout.<br><br>Then both services must be running, and `/` must return 200. |
| C4 | Console 4: the non-interactive `create-user` line (`-T`, `--`, `--email-verified=true`, password on stdin) | the user is created. The admin credential file is then deleted, as the README says. |
| X2 | (harness) the image | A throwaway container from the built image (no network, labelled with the project) shows that `/app/mindstone` is absent, `/app/.env` is empty or absent, and there are no non-empty `.env*` files under `/app`. |
| X1 | (harness) the evidence | First, `lib/secret-check.selftest.mjs` plants a synthetic secret in every form the checker decodes, and each one must be found: plain text, base64 and base64url at every alignment, base64 wrapped across lines, hex, UTF-16LE/BE, `\u` escapes, a secret split by a newline, an escaped `\n` or ANSI codes, gzip (also after a prefix), a zlib stream, base64 of gzip, zips at and not at byte 0 (stored, and deflated with a data descriptor), a base64 zip in HTML, and a zip inside gzip. A clean dir and a near miss must stay clean, and `secrets.mjs` must read `export KEY=`, quoted values, subfolders and header files. Then no generated secret may appear anywhere in the evidence, in any of those forms. This is checked before the scrub, so a leak shows as a FAIL instead of being hidden. |
| X5 | (harness) the on-screen check | `lib/screen-check.selftest.mjs` runs the same in-page matcher J4 and J6 use (`lib/screen-match.js`) in a real Chromium page. A reply in its assistant row must be found. It must NOT be found when the text is only in the user's own bubble (J6's codeword and "Noted." are there), when the assistant body is hidden, or when it's in a different message's row. |
| X4 | (harness) cleanup | Nothing is left: no containers or volumes with the project label, no image (unless `UAT_KEEP_IMAGE=1`), no scratch dir (unless `UAT_KEEP_SCRATCH=1`), and nothing listening on the gateway port. |
| X3 | (harness) host details | Paths (home, scratch, the checkout, `$TMPDIR`), the user name and the host name are redacted from every text file in the evidence (`lib/redact-host.mjs`) as **plain substrings**, so a name inside a mangled path like `-Users-<name>-` is caught too. A plain-substring rescan must find none left. `node lib/redact-host.mjs --check <dir> <pairs>` audits an evidence dir without changing it. |

### The journey: UI only (steps `J*`, `journey.spec.ts`)

**Two setup flows.** J2 reads the Console's "Setup steps" list and picks the flow it knows by that exact list (`FLOWS` in `lib/journey.ts`). An unknown list FAILs J2. The flow is recorded in `SUMMARY.md` and in `run.env` (`setup_flow`).

| Flow | Setup steps | Consoles |
|---|---|---|
| `pre-102` | Access, Model provider, Model, Persona, Finish | mindstone-console `main` before #23 |
| `102` | adds **Memory**, **Connectors** and **About you** before Finish. **Start a chat** sends the first turn itself, and the agent answers with identity formation. | mindstone-console #23 with MindStone-Agent #111 |

| ID | Step | PASS means | Today |
|---|---|---|---|
| J1 | Sign in as admin | The `create-user` account is `ADMIN`, and the "MindStone isn't set up yet" banner with **Set up MindStone** is visible (console #18). | PASS |
| J2 | Guided setup | Click **Set up MindStone**. Access is off on a fresh install: one snapshot of the Access card must show the phrase box and no **Next**. Typing `Enable advanced settings ` (a capital and a trailing space) enables **Turn on**. The provider connects and lists models. Then the model, a base persona, and, in the `102` flow:
- **Memory:** Ollama (local), the already-pulled embedding model, sqlite-vec, and automatic recall left at its default. **Save and continue** must be disabled until **Test** shows "Embedding works: N dimensions". The harness never presses **Download model**.
- **Connectors:** press **Skip**.
- **About you:** enter the two optional texts.

Then Finish shows "MindStone is set up". After that, `GET /admin/status` (through the Console) reports `onboarded: true`. In a new tab, first the composer must be visible and the banner's own status call must say onboarded; only then must no banner show. | PASS |
| J3 | Memory in setup | **`102` flow:**<br>- the Memory step exists, and its live Test embedded text (N > 0 dimensions);<br>- the config saved `memory.vectorStore: sqlite-vec` and `memory.embeddingProvider: ollama:<model>`;<br>- `/admin/status` and the status panel mark memory done.<br><br>Writing a test memory and recalling it in a later chat isn't exercised: no Console path writes a memory, and automatic recall is off by default. The step's note says so. An embedding model must already be pulled in Ollama: with none, J3 **FAILs** with "pull nomic-embed-text first". | PASS (`102`); **PENDING** (`pre-102`) |
| J4 | Start a chat | Listen for chat requests, then click **Start a chat**. The URL may be `/c/new`, `/c/new?prompt=…&submit=true` or already `/c/<id>`. Watch for 15 s: this records whether the agent spoke first. If it did, its first exchange must be stored, finished, not an error, and visible on screen. Send a message. The Console stores a finished reply that isn't an error and has text, and **the same reply and your message are visible in the rendered message list** (not only in `/api/messages`). The reply must be in the assistant row with the stored reply's `messageId`; the user's own bubble never counts. The saved route is `pi-session` with the chosen model. The gateway transcript's entry for the reply points to its Pi session file, which must record the chosen provider *and* model as the ones called, with no model fallback. | PASS |
| J5 | Identity formation | **`102` flow:** the gateway's own record decides, not how the reply reads.<br>- J4's conversation's transcript (session key ending in its conversation id) has an `identity_formation_prompted` event before the first assistant entry, in the same run.<br>- `<dataDir>/identity-formation/default.json`'s `sessionKey` ends with that conversation id.<br>- The checklist's `identity` step is done, via the API and the status panel.<br>- **Secondary:** the first reply asks what to "call you" or for "your name", and it's visible in its assistant row after reopening the conversation.<br><br>Proven with a mutant gateway that claims formation but drops the prompt: J5 FAILs on the transcript check. | PASS (`102`); **PENDING** (`pre-102`) |
| J6 | Recall in the conversation | Reopen J4's conversation and wait until J4's reply is on screen before typing. Plant a codeword, ask an unrelated question, then ask for the codeword. Every reply must be stored and visible, and the last must contain the codeword. It works today, so a miss is a regression and **FAILs**. | PASS |
| J7 | Skill Builder | J4's **Start a chat** turns advanced settings off, so the Skills page must first say installing needs them; then J7 turns them on from the settings page with the typed phrase. The **Skills** link on `/mindstone` opens the Skills page, which lists the built-in Integration Builder. From the built-in: a draft with a goal, reviewed, then discarded. From scratch: a draft with an id, label, description, goal, when-to-use and instructions naming a codeword, reviewed (its SKILL.md holds the codeword), then installed: it moves to **Active** and the status panel's skills row says `1 installed`. In a new chat, the agent is asked to create a second skill with its own codeword and propose it for install. The reply is not an error and doesn't show the proposal block. Approvals has a pending `install skill <id>` whose detail holds that codeword; approving it installs it, and the Skills page lists it as **Active**. Then a fresh chat for each codeword: the reply must contain it. With the mock provider the message carries the proposal block itself (the mock echoes it), and the last check is MOCK. | PASS once #104 lands |
| J8 | Persona drafted by the agent | Proposed in chat, approved on Approvals, active in the next chat, and listed and switchable in the Console. | **PENDING** (#105) |

**How PENDING works.** A PENDING step first asserts today's *exact* state, not a guess from names:

| Step | State it asserts |
|---|---|
| J3 (`pre-102`) | The setup steps are exactly `[Access, Model provider, Model, Persona, Finish]`, and the `/admin/status` checklist keys are exactly `{connectors, memory, persona, provider}`. |
| J5 (`pre-102`) | The same checklist keys, and the agent didn't speak first. |
| J8 | The status section's own links on `/mindstone` (not the checklist's) are exactly `[Run guided setup again, Diagnostics, Approvals, Skills]`. `GET /admin/personas`, `/admin/personas/proposals` and `/admin/persona` each return 404. |

Only if that state is unchanged does the step call `test.fixme()` with the issue's "done when". **Any change FAILs the step** with "state changed: … review this PENDING test". A landed or half-landed feature therefore can't sit unnoticed as PENDING. Write the real assertions from the "done when" text in the step.

J7 and J8 need a finished setup. If J2 failed, they FAIL with "blocked by J2" instead of misreporting a changed state. The `102` flow's checklist links ("Set up memory", "Tell the agent about you") aren't part of the comparison.

The route probes are GET-only, sent with the harness's own admin headers. They never change anything.

## The model provider (J2 and J4)

`UAT_PROVIDER` picks the provider. The default is `auto`:

- **`ollama`**: an Ollama at `UAT_OLLAMA_URL` (default `http://127.0.0.1:11434`). The harness only reads `/api/tags`. It never pulls a model and never stops or reconfigures Ollama.
  - **`auto` picks the smallest `:cloud` model that Ollama already lists.** A cloud model runs remotely, so a shared Ollama doesn't have to load anything.
  - A **local** model is used only with `UAT_OLLAMA_ALLOW_LOCAL=1`, because chatting with it *loads it into that Ollama*. Then the smallest local model up to `UAT_OLLAMA_MAX_LOCAL_GB` (default 8) wins. Embedding models are always skipped.
  - With `UAT_PROVIDER=ollama` set explicitly, `UAT_PROVIDER_MODEL` is required, and it must already be listed, or the run stops at once.
  - **Embedding model**, for the coming #102 memory step:
    - An embedding model that is **already pulled** (`nomic-embed-text` first) is used without `UAT_OLLAMA_ALLOW_LOCAL`, because it's small and embedding is read-only use. Set `UAT_OLLAMA_EMBED_MODEL` to choose one.
    - Nothing is ever pulled unless `UAT_OLLAMA_ALLOW_PULL=1`.
    - With no embedding model, J3 FAILs: pull `nomic-embed-text` first.
  - If `UAT_OLLAMA_URL` isn't the default, the provider step's Server address is set to `<UAT_OLLAMA_URL>/v1`.
- **`ollama-cloud`**: set `UAT_PROVIDER_KEY_FILE` (a file holding the key) and `UAT_PROVIDER_MODEL`. The spec types the key with `fillSecret`, which records no value.
- **`mock`**: the fallback when no provider is available. `auto` announces it loudly.
  - The route is set through the Console's admin API, not the UI.
  - The model, persona and Finish screens are skipped.
  - J2, J4 and J6 report **MOCK**. **A mock run can never pass the gate.**

## Harness self-tests

- **`node lib/secret-check.selftest.mjs`**: the X1 controls on their own. X1 also runs them on every run.
- **`node lib/screen-check.selftest.mjs`**: the X5 controls on their own. It needs `@playwright/test` on `NODE_PATH` or in the repo.
- **`UAT_SELFTEST_BLANK_MESSAGES=1`** (or `all`): hides every rendered message body while the server still stores the replies. **`=assistant`** hides only the agent's replies and leaves the user's bubbles. Either way J4 must FAIL, which proves the on-screen checks fire and that a user bubble doesn't count. Such a run can't pass, and SUMMARY says so in bold.

## Secrets

The harness generates the gateway token, the admin credential, the admin password and the Console's `.env` secrets. You may also supply a provider key. None of them is ever printed or passed on a command line:
- each `.env` secret is generated straight into a 0600 file and written into `.env` by `lib/env-set.mjs`, which reads the value from that file. The README's `sed "s|…$(…)|"` would put it in sed's argv;
- curl reads its auth headers from 0600 files (`-H @file`);
- the password reaches `create-user` on stdin;
- secrets are typed in the browser with `fillSecret`, which sets the value in the page under a step titled "type a secret (value not recorded)". Playwright's `fill()` would put the value in the step title.

There is no html report, trace or video, because those record step titles and arguments. X1 fails the run if any secret shows up anyway. `logs/secret-check.log` lists the files, never the values.

## Environment

| Variable | Default | Purpose |
|---|---|---|
| `UAT_PROVIDER`, `UAT_PROVIDER_MODEL`, `UAT_PROVIDER_KEY_FILE` | `auto` | the model provider (above) |
| `UAT_OLLAMA_URL`, `UAT_OLLAMA_ALLOW_LOCAL`, `UAT_OLLAMA_MAX_LOCAL_GB` | `http://127.0.0.1:11434`, `0`, `8` | which Ollama to use, and whether a local chat model may be used |
| `UAT_OLLAMA_EMBED_MODEL`, `UAT_OLLAMA_ALLOW_PULL` | the pulled `nomic-embed-text`, `0` | the embedding model for the #102 memory step, and whether the harness may pull `nomic-embed-text` |
| `UAT_RAN_BY` | unset | who ran it, recorded in SUMMARY's provenance |
| `UAT_ALLOW_DIRTY_HARNESS` | `0` | run a modified harness anyway, flagged in bold. Such a run can't pass unless this is set. |
| `UAT_SELFTEST_BLANK_MESSAGES` | `0` | the J4/J6 self-test (above): `1`/`all` or `assistant` |
| `UAT_EXPECT_FLOW` | unset | `102` or `pre-102`: J2 FAILs if the Console's setup flow differs |
| `UAT_PERSONA` | the first one | the base persona to pick, matched against its label |
| `UAT_CHAT_MODEL` | `mindstone/default` | the agent to chat with |
| `UAT_RUN_ID` | a timestamp and the PID | names the compose project `uat-journey-<id>`, the scratch dir and the evidence dir |
| `UAT_SCRATCH_ROOT` | `$TMPDIR` | where the scratch dir `uat-journey-<id>/` is created. On colima it must be under `$HOME`. |
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
  5. It runs the X1 secret check (self-test first), then scrubs the text files as a second defence.
  6. It deletes the scratch dir.
  7. It records X4 (anything left fails the gate) and redacts host details (X3).

  `cleanup.txt` records what was left, which should be nothing.

### What it touches outside its sandbox

- **npm's download cache** (`~/.npm`, or `$npm_config_cache`). It's reused so installs are fast.
- **Docker's image store and build cache:**
  - it pulls `mongo:8.0.20` and the Console's base images (`node:24.16.0-alpine`, `ghcr.io/astral-sh/uv`), and leaves them;
  - it leaves the BuildKit layer cache from the Console build;
  - it removes the built `uat-journey-<id>-console:local` image unless `UAT_KEEP_IMAGE=1`.
- **Playwright's browser cache** (`~/Library/Caches/ms-playwright` on macOS, `~/.cache/ms-playwright` on Linux). Chromium is installed there if it's missing. On Linux with root or sudo, `--with-deps` also installs system packages.
- **`e2e/mindstone-journey/.pw/`:** a private `@playwright/test` install, used when the repo has no `node_modules` (gitignored).
- **`/tmp/mindstone-agent-install-status.txt`:** MindStone-Agent refs whose `install.sh` still writes this fixed path (finding F-MSA-1). As a labelled compatibility measure, the harness deletes it on exit, but only if it didn't exist before the run.
- **A throwaway container** for X2, from the built image, with no network and labelled with the project. `--rm` removes it, and teardown's label sweep catches it otherwise.
- **Your Ollama** (only for `ollama`): the harness reads `/api/tags`. The chat uses the chosen model, which is a `:cloud` model by default, so nothing is loaded locally. A local model would be loaded only with `UAT_OLLAMA_ALLOW_LOCAL=1`.
- **The network:** GitHub (clones and `install.sh`), the npm registry, container registries, and the model provider.

## Evidence

In `evidence/<id>/`:

- `SUMMARY.md`: the gate result and its reasons, provenance, every step's status, evidence and note, the README findings, the harness's deviations, and cleanup. Paths in it are relative to the evidence dir, and host details are redacted;
- `harness-steps.tsv`, `journey-results.tsv` and `journey-results.md`: the same results, machine-readable;
- `screens/`: screenshots from each journey step (`j2-access-typed.png`, `j2-banner-gone.png`, `j4-reply.png` and so on), plus `jN-failure.png` when a step fails;
- `logs/`:
  - the install, build and `create-user` logs;
  - `gateway.log` and `console.log`;
  - `secret-check.log` and `secret-check-selftest.log`;
  - `image-check.log` (X2) and `redact-host.log` (X3);
  - `msa-readme-step2.txt` and `msa-readme-step5.4.txt`: the README text S2 and F-MSA-4 judged;
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
