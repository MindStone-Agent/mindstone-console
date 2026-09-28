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
- every required row (S0, S1, S2, S3, S5, C0 to C4, J1 to J9, X1 to X5, and J11 with `UAT_EXPECT_ENTERPRISE=1`) appears exactly once, and each one is PASS;
- there are no unknown rows (J11 is always a known row);
- Playwright exited 0, or every failed test is J11 while J11 isn't in the gate;
- the harness itself didn't fail;
- **the harness is unmodified** (see Provenance);
- no self-test sabotage flag is set;
- there was no stall.

PENDING, MOCK, SKIPPED and missing rows all count as *not passed*. The summary names every reason. An interrupted run (Ctrl-C) exits 130.

Next to the gate line, **`DEMO SUBSET (J1–J6, J9 + S/C/X): PASS/NOT PASSED`** applies the same rules without J7 and J8, the features still being built. A J3 or J5 regression therefore can't hide behind them. J9 (memory recall across chats) is on the demo path, so it's in the subset: while J9 is PENDING, the subset is NOT PASSED.

**J11** (an enterprise Azure OpenAI / AI Foundry endpoint, [MindStone-Agent #126](https://github.com/MindStone-Agent/MindStone-Agent/issues/126)) always runs and always has its row, and gets a line of its own under the gate lines (and in `SUMMARY.md`): `J11 enterprise endpoint (Azure OpenAI / Foundry): <status>; in the gate … / not in the gate …; never in the DEMO SUBSET`. It is **in the gate only with `UAT_EXPECT_ENTERPRISE=1`**, and **never in the DEMO SUBSET**, whose definition is unchanged. When it isn't counted, nothing of it counts: not its row, not Playwright's exit code when J11 is the only failed test (`lib/gate-rows.mjs` reads Playwright's json report), and not a stall in J11. (J10 is kept for the persona builder.)

**Stalls.** Every harness request (`consoleApi` and its token refresh, a `fetch` inside the page, and the gateway probes J7 and J8 send from node) times out after `UAT_API_TIMEOUT_MS` (30 s), and inside a reply-polling loop never later than the loop's own limit (240 s per reply). A poll that the limit cuts short ends as the reply timeout ("no finished reply … (last poll: …; the final poll got no answer before the limit …)"), not as a stall. Every page load (`navigate` in `lib/journey.ts`) keeps Playwright's navigation timeout (60 s). Either one running out is a **STALL**: "STALL: GET /api/messages/… no response in 30s" or "STALL: navigation to /c/new didn't load in 60s", in the step's note. The step is FAIL even if the stall was caught, and the summary's **stalls** line lists every stall of the run (SUMMARY.md too), so an environment stall (console #30: colima's port forwarding) reads differently from a product failure at a glance. A stall never passes: a stall in any step, J7 and J8 included, fails the gate **and the DEMO SUBSET**. The one exception is J11 where it isn't counted (above): a J11 stall is listed, and J11 is FAIL, but it fails the gate only with `UAT_EXPECT_ENTERPRISE=1`, and the DEMO SUBSET never.

With `UAT_EXPECT_FLOW=102`, J2 FAILs unless the Console has the #102 setup flow. Use it for demo gate runs.

With `UAT_EXPECT_ENTERPRISE=1`, J11 is in the gate, and it FAILs (instead of PENDING) when the Console has no enterprise form. Use it for runs against a #126 pair.

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
| X5 | (harness) the on-screen check, stall detection, and J11's pieces | `lib/screen-check.selftest.mjs` runs the same in-page matcher J4 and J6 use (`lib/screen-match.js`) in a real Chromium page. A reply in its assistant row must be found. It must NOT be found when the text is only in the user's own bubble (J6's codeword and "Noted." are there), when the assistant body is hidden, or when it's in a different message's row. `lib/stall.selftest.mjs` runs the harness's own request and page-load code (`lib/stall.js`) against a local server that never answers: no response, a body that never ends (from the page and from node), a page stuck in `evaluate`, and a page load that never finishes must each throw a named STALL within their timeout; an answered request must come back. In a polling loop, a call its deadline cut short (every poll slow, the last one out of time) must end as the loop's own limit, never as a stall, and a call with its full timeout left must still stall. A 60 s watchdog stops the self-test if it hangs itself. `lib/enterprise.selftest.mjs` checks J11's own pieces offline (below, under Harness self-tests). |
| X4 | (harness) cleanup | Nothing is left: no containers or volumes with the project label, no image (unless `UAT_KEEP_IMAGE=1`), no scratch dir (unless `UAT_KEEP_SCRATCH=1`), nothing listening on the gateway port, and J11's stub Azure endpoint is stopped (its process gone, nothing on its port). |
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
| J3 | Memory in setup | **`102` flow:**<br>- the Memory step exists, and its live Test embedded text (N > 0 dimensions);<br>- the config saved `memory.vectorStore: sqlite-vec` and `memory.embeddingProvider: ollama:<model>`;<br>- `/admin/status` and the status panel mark memory done.<br><br>Writing a test memory and recalling it in a later chat isn't exercised here: J9 does that. The step's note says so. An embedding model must already be pulled in Ollama: with none, J3 **FAILs** with "pull nomic-embed-text first". | PASS (`102`); **PENDING** (`pre-102`) |
| J4 | Start a chat | Listen for chat requests, then click **Start a chat**. The URL may be `/c/new`, `/c/new?prompt=…&submit=true` or already `/c/<id>`. Watch for 15 s: this records whether the agent spoke first. If it did, its first exchange must be stored, finished, not an error, and visible on screen. Send a message. The Console stores a finished reply that isn't an error and has text, and **the same reply and your message are visible in the rendered message list** (not only in `/api/messages`). The reply must be in the assistant row with the stored reply's `messageId`; the user's own bubble never counts. The saved route is `pi-session` with the chosen model. The gateway transcript's entry for the reply points to its Pi session file, which must record the chosen provider *and* model as the ones called, with no model fallback. | PASS |
| J5 | Identity formation | **`102` flow:** the gateway's own record decides, not how the reply reads.<br>- J4's conversation's transcript (session key ending in its conversation id) has an `identity_formation_prompted` event before the first assistant entry, in the same run.<br>- `<dataDir>/identity-formation/default.json`'s `sessionKey` ends with that conversation id.<br>- The checklist's `identity` step is done, via the API and the status panel.<br>- **Secondary:** the first reply asks what to "call you" or for "your name", and it's visible in its assistant row after reopening the conversation.<br><br>Proven with a mutant gateway that claims formation but drops the prompt: J5 FAILs on the transcript check. | PASS (`102`); **PENDING** (`pre-102`) |
| J6 | Recall in the conversation | Reopen J4's conversation and wait until J4's reply is on screen before typing. Plant a codeword, ask an unrelated question, then ask for the codeword. Every reply must be stored and visible, and the last must contain the codeword. It works today, so a miss is a regression and **FAILs**. | PASS |
| J7 | Skill Builder | J4's **Start a chat** turns advanced settings off, so the Skills page must first say installing needs them; then J7 turns them on from the settings page with the typed phrase. The **Skills** link on `/mindstone` (whose own links, less the checklist's, Personas and Model providers (#126, J11), are exactly `[Run guided setup again, Diagnostics, Approvals, Skills]`) opens the Skills page, which lists the built-in Integration Builder. From the built-in: a draft with a goal, reviewed, then discarded. From scratch: a draft with an id, label, description, goal, when-to-use and instructions naming a codeword, reviewed (its SKILL.md holds the codeword), then installed: it moves to **Active** and the status panel's skills row says `1 installed`. In a new chat, the agent is asked to create a second skill with its own codeword and propose it for install. The reply is not an error and doesn't show the proposal block. Approvals has a pending `install skill <id>` whose detail holds that codeword; approving it installs it, and the Skills page lists it as **Active**. Then a fresh chat for each codeword: the reply must contain it. With the mock provider the message carries the proposal block itself (the mock echoes it), and the last check is MOCK. | PASS once #104 lands |
| J8 | Persona drafted by the agent | The agent proposes a persona in chat (a real model is asked to use its instructed format; the mock gets the block in the message and is labelled MOCK). It waits on Approvals as a `persona_create` proposal; approving it saves it to the list without activating it (Clint's rule); **Make active** on the Personas page switches to it; the gateway transcript shows the next chat ran with it. PENDING while `GET /api/mindstone/admin/personas` is 404 on the pair. | Real check (#105: MindStone-Agent#112 + mindstone-console#24) |
| J9 | Memory recall across chats | Automatic recall is on by default (product decision, #106). The real test:<br>- the saved config has `memory.autoRecall: true` after the Console setup, and setup's "Recall memories automatically" was on by default (J2 never touches it); `/admin/status` says `autoRecall on`;<br>- in a new chat (chat 1), the owner says "My dog's name is `<word>-<stamp>`. Please remember it.": a fresh token each run, and a fact J6 (a project codename) doesn't share;<br>- the harness polls the recall index (`<dataDir>/vectors/memory.sqlite`, read by `lib/recall-index.js` in a child node process that opens it read-only with `node:sqlite`: Playwright's module loader can't load `node:sqlite` in the test process; an index that can't be read stays a FAIL) until a `memory_chunks` row holding the token has `embedding_json` set, for up to 3 minutes. No blind sleep: with no such row by then, J9 FAILs "not captured";<br>- the token must be in none of the files every prompt carries without recall: USER.md, IDENTITY.md, `memory/MEMORY.md` and the invariant files (a non-empty `invariant:` anywhere in the frontmatter, nested included). Checked before chat 2 and again after it;<br>- a **fresh** chat (chat 2, a new conversation id) asks "What is my dog's name?". The token must be in none of its stored user messages;<br>- **the gateway transcript for chat 2 decides** (`lib/recall-evidence.js`): a `role: "event"` `memory_recall_injected` entry before the reply, with the reply's run id (both must have one), listing hits; at least one hit's `chunk_id` in the recall index has text holding the token and, when the index has `updated_at`, was written no later than the event's `timestamp`; and the token is in no other chat 2 entry, whatever its role (the event's own hit list is exempt). With no event, J9 FAILs with "not observable": a reply that names the token is not proof. The reply's `metadata.memoryRecall.hitCount` is cross-checked when the entry carries it; today the gateway puts it only in the HTTP response, so the note says the check didn't run;<br>- the reply contains the token, stored and on screen in the assistant row with its `messageId`;<br>- **negative control:** `memory.autoRecall` is turned off through the Console's admin API (free), and a fresh chat 3 asks the same: its reply must be a real answer (text, not an error) that doesn't hold the token, and its transcript must have no recall event and no token. The setting is then put back on. | **PENDING** on main (recall off by default, no live index, nothing writes a memory) |
| J11 | Enterprise endpoint (Azure OpenAI / AI Foundry, MindStone-Agent #126), against the harness's **stub Azure endpoint** (below). In the gate only with `UAT_EXPECT_ENTERPRISE=1`; never in the DEMO SUBSET. The real test, UI only:<br>- **Run guided setup again** from `/mindstone`, through Access (**Next**, or the phrase if advanced settings are off), to the provider step. Its choices must render first; then **Azure OpenAI / AI Foundry** is picked and its form (`ms-ent-form-azure-openai`) must appear;<br>- **Endpoint** `http://127.0.0.1:<stub port>/openai/v1`, **Deployment names** `uat-gpt-4o`, **API key** the fake per-run key (typed with `fillSecret`), **Save endpoint**: the step shows `ms-onb-enterprise-done`;<br>- **Test**: `ms-ent-test-result` says "`enterprise-azure/uat-gpt-4o` answered in N ms: …" with the stub's per-run token. **UI text is not enough:** the stub's request log must have, after the click, a `POST /openai/v1/responses?api-version=v1` with the run's key in `api-key`, streamed and answered with the token;<br>- **the enterprise model for chat:** the chat's model menu lists agents, not provider models, so the deployment is chosen where the UI chooses the agent's model: **Save and continue**, then the Model step's list must offer `enterprise-azure/uat-gpt-4o`; choosing it and **Save and continue** saves it as `routing.defaultModel`. (If the list doesn't offer it, J11 is PENDING with that reason: nothing is faked.) A new chat's message carries a nonce; the reply must be a real answer holding the stub's token, stored and on screen in its assistant row, and the stub's log must have an authenticated, streamed Responses request after it whose last user message holds the nonce;<br>- in the whole stub log, no request may carry the gateway's own token or the admin credential (MindStone-Agent #80), and the key may appear nowhere but the `api-key` header;<br>- settings: the **Model providers** link on `/mindstone` opens a page listing `enterprise-azure`.<br><br>Evidence: `screens/j11-provider.png`, `j11-form.png`, `j11-saved.png`, `j11-test-result.png`, `j11-model.png`, `j11-chat-reply.png`, `j11-providers.png`; `logs/j11-stub-proof.json`, `logs/j11-reply.txt`, `logs/j11-model-options.txt`, `logs/j11-azure-stub-requests.jsonl` (every request, key redacted) and `logs/j11-azure-stub.log`. | **PENDING** on main (no enterprise form) |

**How PENDING works.** A PENDING step first asserts today's *exact* state, not a guess from names:

| Step | State it asserts |
|---|---|
| J3 (`pre-102`) | The setup steps are exactly `[Access, Model provider, Model, Persona, Finish]`, and the `/admin/status` checklist keys are exactly `{connectors, memory, persona, provider}`. |
| J5 (`pre-102`) | The same checklist keys, and the agent didn't speak first. |
| J8 | Without #105 (MindStone-Agent #112 and console #24): `GET /api/mindstone/admin/personas` returns 404, so J8 is PENDING. |
| J11 | Positive first: the provider step renders its choices. Then neither the **Azure OpenAI** choice nor `ms-ent-form-azure-openai` is there (the note also lists what the gateway's `GET /admin/models` offers as `enterprise`, for a pair where only one side has #126). With `UAT_EXPECT_ENTERPRISE=1` that is a FAIL, not PENDING. The Azure choice without its form is a changed state: FAIL. |
| J9 | While the saved `memory.autoRecall` isn't `true`: it is exactly `false`; setup's recall checkbox was off by default; the `/admin/status` memory detail is exactly `vector store sqlite-vec, embeddings ollama:<model>, autoRecall off`; there's no recall index (`<dataDir>/vectors/memory.sqlite`); and J6's codeword ("please remember this") is in no memory store: `memory/` (less `recall-usage.jsonl`), `vectors/`, `journals/` or `LOG.md`. If J6 recorded no codeword, J9 FAILs "blocked by J6". With `memory.autoRecall: true`, J9 runs the real test. (`pre-102`: `autoRecall` absent, no index, no codeword stored.) |

Only if that state is unchanged does the step call `test.fixme()` with the issue's "done when". **Any change FAILs the step** with "state changed: … review this PENDING test". A landed or half-landed feature therefore can't sit unnoticed as PENDING. Write the real assertions from the "done when" text in the step.

J7, J8 and J9 need a finished setup. If J2 failed, they FAIL with "blocked by J2" instead of misreporting a changed state. J11 decides PENDING first (that needs no setup) and only then requires a finished setup. The `102` flow's checklist links ("Set up memory", "Tell the agent about you") aren't part of the comparison.

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
- **`node lib/stall.selftest.mjs`**: X5's stall controls on their own (about 20 s). Its server listens on 127.0.0.1, on the first free port in `UAT_PORT_MIN` to `UAT_PORT_MAX` (default 26900 to 26949). It needs `@playwright/test` like the one above.
- **`node lib/recall-evidence.selftest.mjs`**: J9's recall checks (`lib/recall-evidence.js`) on synthetic gateway transcript lines and recall-index chunks. Recall is proven only by a `role: "event"` `memory_recall_injected` entry with hits in the reply's own run (both run ids present and equal), a hit whose chunk holds the token, and the token in no other entry. A missing, empty, run-less, earlier-run or later event, a non-event entry with that name, a session key that only contains the conversation id, only J6's chunk recalled, a chunk written after the event, unreadable chunks, and the token in a user, system, tool or event entry or in the query must not pass. It also covers the negative control (chat 3), which memory files count as invariants, and the out-of-process index reader (`lib/recall-index.js`) against a WAL-mode test database whose writer is still open. No dependencies beyond Node's `node:sqlite`.
- **`node lib/enterprise.selftest.mjs`**: J11's own pieces, offline (a second or two; X5 runs it too). The stub Azure endpoint (`lib/azure-stub.mjs`) must answer only the run's key in the `api-key` header: no key, a wrong key, and the right key as `Authorization: Bearer` all get 401 and no token. With the key, `POST …/responses?api-version=v1` must stream the Responses API (`response.created` … text deltas … `response.completed`, each with its `event:` line) spelling the token, and `stream: false` must get the JSON response; another path gets 404. Its request log must record every request with the key, the watched credentials and any `Authorization` value in no form (plain, hex, base64), and flag a watched credential or the key outside `api-key`. `stubProof` (`lib/enterprise-evidence.js`) must prove only an authenticated, streamed request at the expected path and api-version after the step's action (and with the chat's nonce), and fail on a leak. `j11Decision` must be PENDING only with neither the Azure choice nor its form and no `UAT_EXPECT_ENTERPRISE`. `lib/gate-rows.mjs` must excuse Playwright's exit only when every failed test is an excused step and nothing failed outside a test. Its port comes from `UAT_PORT_MIN` to `UAT_PORT_MAX`, like the stall self-test's.
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
| `UAT_EXPECT_ENTERPRISE` | `0` | `1`: J11 (enterprise endpoint) is in the gate, and FAILs instead of PENDING when the Console has no enterprise form |
| `UAT_PERSONA` | the first one | the base persona to pick, matched against its label |
| `UAT_CHAT_MODEL` | `mindstone/default` | the agent to chat with |
| `UAT_RUN_ID` | a timestamp and the PID | names the compose project `uat-journey-<id>`, the scratch dir and the evidence dir |
| `UAT_SCRATCH_ROOT` | `$TMPDIR` | where the scratch dir `uat-journey-<id>/` is created. On colima it must be under `$HOME`. |
| `UAT_EVIDENCE_DIR` | `e2e/mindstone-journey/evidence/<id>/` | where the evidence goes (gitignored). It must be new or empty: the harness refuses a non-empty one, and the spec refuses one that already holds a journey's state or results. |
| `UAT_API_TIMEOUT_MS` | `30000` | each harness request's timeout: no answer by then is a STALL (above) |
| `UAT_PORT_MIN`, `UAT_PORT_MAX` | 26900 to 26999 | the gateway, Console and J11 stub ports. Each is checked free first. Any range that touches 18000 to 18999 is refused. |
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
  4. It stops J11's stub Azure endpoint (its PID, while that is still `lib/azure-stub.mjs`, then anything from that file on its port; it is also stopped as soon as Playwright ends, and it exits by itself if the harness dies), then the gateway (`mindstone gateway stop`, then the PID file, then anything on its port that runs from the scratch dir).
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
- **J11's stub Azure endpoint:** a node process (`lib/azure-stub.mjs`) on 127.0.0.1, on a free port in the harness's range, for the length of the Playwright run. Its key is fake and generated per run into the harness's 0600 secrets dir, so X1 fails the run if it reaches the evidence. The gateway runs with `MINDSTONE_ENTERPRISE_PRIVATE_HOSTS=1` (the gateway host's own switch, MindStone-Agent #126), so a loopback endpoint may be registered; it's listed in the deviations.

## Evidence

In `evidence/<id>/`:

- `SUMMARY.md`: the gate result and its reasons, the stalls line, provenance, every step's status, evidence and note, the README findings, the harness's deviations, and cleanup. Paths in it are relative to the evidence dir, and host details are redacted;
- `harness-steps.tsv`, `journey-results.tsv` and `journey-results.md`: the same results, machine-readable;
- `stalls.tsv`: every stall, one `<step>\t<message>` line each (only when there was one);
- `screens/`: screenshots from each journey step (`j2-access-typed.png`, `j2-banner-gone.png`, `j4-reply.png` and so on), plus `jN-failure.png` when a step fails;
- `logs/`:
  - the install, build and `create-user` logs;
  - `gateway.log` and `console.log`;
  - `secret-check.log` and `secret-check-selftest.log`;
  - `screen-check-selftest.log` and `stall-selftest.log` (X5);
  - `image-check.log` (X2) and `redact-host.log` (X3);
  - `msa-readme-step2.txt` and `msa-readme-step5.4.txt`: the README text S2 and F-MSA-4 judged;
  - per-step excerpts: `j4-reply.txt`, `j4-answered-by.json`, `j6-recall.txt`, `j7-gateway-probes.txt`, `j9-memory-state.json`, `j9-recall.txt`, `j9-recall-transcript.json`, `j11-stub-proof.json`, `j11-reply.txt`, `jN-gateway-tail.log`;
  - `j11-azure-stub-requests.jsonl` (every request J11's stub endpoint got, key redacted) and `j11-azure-stub.log`, and `enterprise-selftest.log` (X5);
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
