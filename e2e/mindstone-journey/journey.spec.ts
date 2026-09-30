/**
 * The MindStone demo journey (MindStone-Agent #106), in the Console UI only,
 * against a fresh install made by run-journey.sh. Each step is its own test
 * and reports PASS, FAIL, PENDING or MOCK.
 *
 * Two guided-setup flows are known (lib/journey.ts FLOWS): `pre-102` (Access,
 * Model provider, Model, Persona, Finish) and `102` (adds Memory, Connectors
 * and About you; Start a chat sends the first turn and the agent answers with
 * identity formation). J2 detects the flow from the Console's step list and
 * drives it; an unknown list FAILs. J3 and J5 are real tests in the `102`
 * flow and PENDING in `pre-102`. J9 (recall across chats) is PENDING while
 * setup leaves automatic recall off, and real once it's on by default.
 * J10 (the persona builder, MindStone-Agent #125) is PENDING while the
 * Personas page has no "Build a persona"; it is in the gate only with
 * UAT_EXPECT_PERSONA_BUILDER=1, and never in the DEMO SUBSET.
 * J11 (an enterprise Azure OpenAI endpoint, against the harness's stub) is
 * PENDING while the Console has no enterprise form; it is in the gate only
 * with UAT_EXPECT_ENTERPRISE=1, and never in the DEMO SUBSET.
 * J12 (settings parity, MindStone-Agent #140) runs after J9 and before J10: it
 * is PENDING while Settings has no "Your setup" section, in the gate only with
 * UAT_EXPECT_SETTINGS_PARITY=1, and never in the DEMO SUBSET. It changes the
 * default model, the memory setting and USER.md from Settings, and puts them
 * back in a finally, so J10 and J11 start from the setup J2 made.
 *
 * PENDING steps first assert the flow's exact state: the setup step list, the
 * gateway's onboarding checklist keys, the links on /mindstone, and 404 from
 * the admin routes the feature will add. Only if all of that is unchanged do
 * they call test.fixme() with the issue's "done when". Any change fails the
 * step with "state changed: review this PENDING test", so a landed (or half
 * landed) feature can't sit unnoticed as PENDING.
 */
import fs from 'node:fs';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import type { BrowserContext, Page, Request, TestInfo } from '@playwright/test';
import {
  ENDPOINT_LABEL,
  ERROR_REPLY,
  FLOWS,
  PROVIDER,
  PROVIDER_MODEL,
  adminStatus,
  answeredBy,
  appears,
  attachText,
  consoleApi,
  detectFlow,
  ensureMindStoneModel,
  ensureSignedIn,
  enterpriseStub,
  expectedStatusLinks,
  expectOnScreen,
  fillSecret,
  formationEvidence,
  gatewayDataDir,
  gatewayExcerpt,
  controlForConversation,
  memoryStoreFilesWith,
  messageText,
  navigate,
  note,
  probeGatewayAdmin,
  readSecretFile,
  readState,
  recallForConversation,
  recallIndexExists,
  sendAndWaitForReply,
  shot,
  signIn,
  promptFilesWith,
  waitForEmbeddedChunk,
  waitForReplyTo,
  writeState,
  personaForConversation,
  j11Decision,
  stubHealth,
  stubLeakReasons,
  waitForStubProof,
  j10Decision,
  personaRestore,
  builtPersonaReasons,
  isolationReasons,
  skillsVerdict,
  personaTurnForConversation,
  uiResponse,
  answeredInConversation,
  j12Decision,
  parityReasons,
  pickAlternateModel,
  modelMatchReasons,
  memoryChangeVerdict,
  recallIndexDims,
  recallHitsForConversation,
  recallIndexVectors,
  settledIndexVectors,
  warmOllamaEmbedModel,
  otherModelCount,
  recordFinding,
  COLD_MODEL_FINDING,
  restoreOutcome,
  removeAgentUserFile,
  recordRestoreFailure,
  restoredIndexReasons,
  EMBEDDING_WARNING,
  SETUP_STEPS,
  CHANGE_STEPS,
  IN_PLACE_STEPS,
} from './lib/journey';
import type { FlowName, IndexVector, ParityRow, PersonaTurnEvidence, Reply, StoredMessage } from './lib/journey';

const ISSUES = {
  banner: 'mindstone-console#18 (PR #20)',
  memory: 'MindStone-Agent#102 / #106 (memory in guided setup)',
  identity: 'MindStone-Agent#102',
  skills: 'MindStone-Agent#104',
  persona: 'MindStone-Agent#105',
  recall: 'MindStone-Agent#106 (automatic memory recall, on by default)',
  enterprise: 'MindStone-Agent#126 (enterprise model endpoints)',
  personaBuilder: 'MindStone-Agent#125 (persona builder: admin API #142, Console #36)',
  settingsParity: 'MindStone-Agent#140 (settings parity: every setup choice has a Settings equivalent)',
};

/** The phrase as a phone or autocomplete types it: a capital and a trailing space (#18). */
const TYPED_PHRASE = 'Enable advanced settings ';

/** The links in /mindstone's status section today (the setup link reads "Run guided setup again" once set up). */
const TODAY_STATUS_LINKS = ['Run guided setup again', 'Diagnostics', 'Approvals', 'Skills'];

/**
 * Left out of the comparison: links inside the #102 checklist items (a step's
 * own "set it up" link), and the #105 Personas link, which J8 checks.
 */
const IGNORED_STATUS_LINKS = ['Set up memory', 'Tell the agent about you', 'Personas'];

/** Steps that judge the state after setup: when J2 failed they report "blocked by J2", not "state changed". */
const NEEDS_SETUP = /^J([789]|13) /;

/** How long J9 polls the recall index for an embedded chunk holding the fact chat 1 told (capture and indexing); then it FAILs "not captured". */
const RECALL_CAPTURE_WAIT_MS = 180_000;

/** What the About you step tells the agent (#102 flow). Not secret. */
const ABOUT_PURPOSE = 'Get the MindStone demo ready.';
const ABOUT_CONTEXT = "I'm running the fresh-install journey test.";

/**
 * A secondary check only (the transcript's identity_formation_prompted event is the real one):
 * the formation greeting asks what to call you. Generic greetings rarely do.
 */
const FORMATION_QUESTION = /\b(call you|your name)\b/i;

let context: BrowserContext;
let page: Page;

test.beforeAll(async ({ browser }) => {
  // A fresh context, like a first-time visitor: no seeded localStorage or UI state.
  context = await browser.newContext();
  const blank = process.env.UAT_SELFTEST_BLANK_MESSAGES ?? '';
  if (blank && blank !== '0') {
    // HARNESS SELF-TEST ONLY (run-journey.sh refuses to pass a run with this set): blank what the
    // message list renders, while the server still stores every reply, to prove the on-screen
    // assertions in J4/J6 fire. `assistant` hides only the agent's turns, so the user's own
    // bubble (which holds J6's codeword) is still there and must not count.
    const selector =
      blank === 'assistant' ? '.agent-turn [data-testid="message-body"] *' : '[data-testid="message-body"] *';
    await context.addInitScript((css) => {
      const style = document.createElement('style');
      style.textContent = `${css} { display: none !important; }`;
      document.addEventListener('DOMContentLoaded', () => document.head.appendChild(style));
    }, selector);
  }
  page = await context.newPage();
});

// GUARD: Playwright charges an error in this hook to the worker's LAST test, which is J11 (checked: the
// json report puts it in J11's result, located at this hook's line). Where J11 isn't counted (no
// UAT_EXPECT_ENTERPRISE, and always for the DEMO SUBSET), J11's excuse must not cover it: lib/gate-rows.mjs
// excuses a failure only when every error is located inside the test's own lines, so an error from here (or
// from afterEach, which is charged to each test, J10 included) still fails the verdicts. Keep hooks above the
// tests, and J11 last. Never swallow an error here.
test.afterAll(async () => {
  await context?.close();
});

test.beforeEach(async ({}, testInfo) => {
  if (NEEDS_SETUP.test(testInfo.title)) requireSetupDone();
});

test.afterEach(async ({}, testInfo) => {
  if (testInfo.status !== testInfo.expectedStatus && testInfo.status !== 'skipped') {
    await shot(page, testInfo, 'failure');
    await gatewayExcerpt(testInfo);
  }
});

/** A step that needs finished setup can't be judged when J2 failed: say so, not "state changed". */
function requireSetupDone() {
  if (readState().j2Passed !== true) throw new Error('blocked by J2: guided setup did not finish, so this step was not judged');
}

/** The flow J2 detected; steps that depend on it are blocked without it. */
function requireFlow(): FlowName {
  const flow = readState().flow;
  if (!flow) throw new Error('blocked by J2: the setup flow was not detected, so this step was not judged');
  return flow;
}

/** Fails unless the state still matches what the PENDING test was written against. */
function requireUnchanged(what: string, actual: unknown, expected: unknown) {
  const same = JSON.stringify(actual) === JSON.stringify(expected);
  if (!same) {
    throw new Error(
      `state changed: ${what} is ${JSON.stringify(actual)}, was ${JSON.stringify(expected)}. ` +
        'A feature may have landed: review this PENDING test and replace it with the real assertions (README).',
    );
  }
}

async function statusLinks(p: Page): Promise<string[]> {
  const section = p.locator('section[aria-labelledby="ms-onboarding"]');
  await expect(section).toBeVisible();
  return (await section.getByRole('link').allTextContents())
    .map((s) => s.trim())
    .filter((s) => !IGNORED_STATUS_LINKS.includes(s));
}

async function probeAll(testInfo: TestInfo, routes: string[]) {
  const results = [];
  for (const route of routes) results.push(await probeGatewayAdmin(route));
  await attachText(testInfo, 'gateway-probes.txt', results.map((r) => `GET ${r.route} -> ${r.status} ${r.error}`).join('\n'));
  return results.map((r) => `${r.route}:${r.status}`);
}

function replyLog(reply: Reply): string {
  return `> ${reply.userText}\n\n${reply.text}\n\n[content parts: ${reply.contentTypes.join(', ') || 'none'}]${reply.errorText ? `\n[error: ${reply.errorText}]` : ''}\n`;
}

function expectAnswer(reply: Reply, what: string) {
  expect(reply.error, `${what}: the Console stored an error, not an answer: ${(reply.errorText ?? '').slice(0, 300)}`).toBe(false);
  expect(reply.text.length, `${what}: the reply has text`).toBeGreaterThan(0);
  expect(reply.text, `${what}: the reply is an answer, not an error message`).not.toMatch(ERROR_REPLY);
}

test('J1 sign in as admin; the setup banner is visible', async ({}, testInfo) => {
  await navigate(page, '/login');
  await shot(page, testInfo, 'login');
  await signIn(page);
  const me = await consoleApi<{ role?: string }>(page, 'GET', '/api/user');
  expect(me.json.role, 'the create-user account is the admin').toBe('ADMIN');
  const banner = page.getByTestId('mindstone-setup-banner');
  const visible = await appears(banner, 30_000);
  await shot(page, testInfo, visible ? 'banner' : 'no-banner');
  expect(visible, `the "MindStone isn't set up yet" banner (${ISSUES.banner})`).toBe(true);
  await expect(banner).toContainText("MindStone isn't set up yet");
  await expect(banner.getByRole('button', { name: 'Set up MindStone' })).toBeVisible();
});

test('J2 guided setup in the UI: access, provider, model, persona, (memory, connectors, about you,) finish', async ({}, testInfo) => {
  testInfo.setTimeout(12 * 60_000);
  if (PROVIDER === 'mock') testInfo.annotations.push({ type: 'mock', description: 'mock provider' });
  await ensureSignedIn(page, { stayIfSignedIn: true });
  const bannerButton = page.getByTestId('mindstone-setup-banner').getByRole('button', { name: 'Set up MindStone' });
  if (await appears(bannerButton, 15_000)) {
    await bannerButton.click();
    writeState({ enteredSetupVia: 'banner' });
  } else {
    note(testInfo, 'no setup banner: opened /mindstone/onboarding directly, as the README says');
    writeState({ enteredSetupVia: 'direct-url' });
    await navigate(page, '/mindstone/onboarding');
  }
  await expect(page).toHaveURL(/\/mindstone\/onboarding/);
  await expect(page.getByRole('heading', { name: 'Set up MindStone', level: 1 })).toBeVisible();
  const setupSteps = (await page.getByRole('list', { name: 'Setup steps' }).locator('li').allTextContents()).map(
    (s) => s.replace(/^\d+\.\s*/, '').trim(),
  );
  const flow = detectFlow(setupSteps);
  writeState({ setupSteps, flow });
  note(testInfo, `setup steps: ${setupSteps.join(' > ')}`);
  expect(flow, `a known setup flow (${Object.keys(FLOWS).join(', ')}); got ${setupSteps.join(' > ')}`).toBeTruthy();
  const expectFlow = process.env.UAT_EXPECT_FLOW;
  if (expectFlow) expect(flow, `UAT_EXPECT_FLOW=${expectFlow}: the Console's setup flow`).toBe(expectFlow);
  testInfo.annotations.push({ type: 'label', description: `flow ${flow}` });
  fs.writeFileSync(path.join(process.env.UAT_EVIDENCE_DIR ?? '.', 'journey-flow.txt'), `${flow}\t${FLOWS[flow!].label}\n`);

  // Access, on a fresh install: always off, so the phrase is always typed (capital + trailing space).
  await test.step('access', async () => {
    const confirm = page.getByRole('textbox', { name: 'Confirmation' });
    // One snapshot of the access card, taken once it has rendered either control, so the
    // "phrase box shown, Next not shown" check can't straddle a re-render.
    const access = await page.waitForFunction(
      () => {
        const card = document.querySelector('section[aria-labelledby="ms-onb-access"]');
        if (!card) return undefined;
        const hasInput = Boolean(card.querySelector('input[aria-label="Confirmation"]'));
        const hasNext = Array.from(card.querySelectorAll('button')).some((b) => b.textContent?.trim() === 'Next');
        return hasInput || hasNext ? { hasInput, hasNext } : undefined;
      },
      undefined,
      { timeout: 30_000 },
    );
    const state = (await access.jsonValue()) as { hasInput: boolean; hasNext: boolean };
    expect(state, 'advanced settings are off on a fresh install: the access step asks for the phrase').toEqual({
      hasInput: true,
      hasNext: false,
    });
    await confirm.fill(TYPED_PHRASE);
    await shot(page, testInfo, 'access-typed');
    const turnOn = page.getByRole('button', { name: 'Turn on' });
    await expect(turnOn, `"${TYPED_PHRASE}" enables Turn on (${ISSUES.banner})`).toBeEnabled({ timeout: 5_000 });
    await turnOn.click();
    await expect(page.getByRole('heading', { name: 'Connect a model provider' })).toBeVisible();
  });

  // Provider.
  await test.step(`provider (${PROVIDER})`, async () => {
    if (PROVIDER === 'mock') {
      // No provider to connect: the gateway's mock route, set through the Console's admin API
      // (not a UI path). The model, persona and finish screens need a real provider's models.
      testInfo.annotations.push({ type: 'label', description: 'MOCK: route set via the Console admin API, not the UI' });
      const current = await consoleApi<{ etag?: string; config?: { routing?: { defaultAgentId?: string } } }>(
        page,
        'GET',
        '/api/mindstone/admin/config',
      );
      const query = current.json.etag ? `?ifMatch=${encodeURIComponent(current.json.etag)}` : '';
      const patched = await consoleApi(page, 'PATCH', `/api/mindstone/admin/config/routing${query}`, {
        mode: 'mock',
        defaultAgentId: current.json.config?.routing?.defaultAgentId ?? 'default',
        defaultModel: 'mindstone/mock',
      });
      expect(patched.status, 'mock route saved').toBeLessThan(300);
      return;
    }
    const presetName = PROVIDER === 'ollama' ? 'Ollama (local)' : 'Ollama Cloud';
    await page.getByRole('radio', { name: presetName }).check();
    if (PROVIDER === 'ollama') {
      const wantedBase = process.env.UAT_OLLAMA_BASE_URL;
      const address = page.getByRole('textbox', { name: 'Server address' });
      if (process.env.UAT_INSTALL === 'stack') {
        // The stack's gateway reaches Ollama on the host as its OLLAMA_BASE_URL, and the Ollama choice comes filled in
        // with it (MindStone-Agent #171, README A4): checked, never typed.
        // The page fills it in just after the choice renders (an effect), so this waits for it.
        await expect(address, `the Ollama choice comes filled in with the stack's Ollama address (${wantedBase})`).toHaveValue(wantedBase ?? '', {
          timeout: 10_000,
        });
        note(testInfo, `stack: the Ollama Server address came filled in as ${await address.inputValue()}`);
      } else if (wantedBase && (await address.inputValue()) !== wantedBase && !/\/\/(127\.0\.0\.1|localhost):11434\/v1$/.test(wantedBase)) {
        await address.fill(wantedBase);
        note(testInfo, `server address set to ${wantedBase}`);
      }
    }
    if (PROVIDER === 'ollama-cloud') {
      await fillSecret(page.getByRole('textbox', { name: 'API key' }), readSecretFile('UAT_PROVIDER_KEY_FILE'));
    }
    await shot(page, testInfo, 'provider');
    await page.getByRole('button', { name: 'Connect' }).click();
    const connected = page.getByText(/Connected\. \d+ models found/);
    await expect(connected, "the gateway listed the provider's models").toBeVisible({ timeout: 90_000 });
    note(testInfo, ((await connected.textContent()) ?? '').trim());
  });

  if (PROVIDER === 'mock') {
    note(testInfo, 'MOCK run: model, persona and later screens skipped (they need a real provider)');
    return;
  }

  // Model.
  await test.step('model', async () => {
    await expect(page.getByRole('heading', { name: 'Choose the model' })).toBeVisible();
    const select = page.getByRole('combobox', { name: 'Choose the model' });
    await expect(select).toBeVisible();
    const values = await select.locator('option').evaluateAll((options) =>
      options.map((o) => (o as HTMLOptionElement).value).filter(Boolean),
    );
    await attachText(testInfo, 'model-options.txt', values.join('\n'));
    const wanted = values.find((v) => v === PROVIDER_MODEL || v.endsWith(`/${PROVIDER_MODEL}`)) ?? '';
    expect(wanted, `the model list offers ${PROVIDER_MODEL}`).not.toBe('');
    await select.selectOption(wanted);
    writeState({ chosenModel: wanted });
    note(testInfo, `model ${wanted}`);
    await shot(page, testInfo, 'model');
    await page.getByRole('button', { name: 'Save and continue' }).click();
  });

  // Persona.
  await test.step('persona', async () => {
    await expect(page.getByRole('heading', { name: 'Choose a base persona' })).toBeVisible();
    const wanted = process.env.UAT_PERSONA;
    const radios = page.locator('input[name="ms-onb-profile"]');
    expect(await radios.count(), 'the gateway offers base personas').toBeGreaterThan(0);
    if (wanted) await page.getByRole('radio', { name: new RegExp(wanted, 'i') }).check();
    else await radios.first().check();
    await shot(page, testInfo, 'persona');
    await page.getByRole('button', { name: 'Save and continue' }).click();
  });

  if (flow === '102') {
    // Memory: Ollama (local), an already-pulled embedding model, sqlite-vec; Test must pass.
    await test.step('memory', async () => {
      const section = page.locator('section[aria-labelledby="ms-onb-memory"]');
      await expect(page.getByRole('heading', { name: 'Set up memory' })).toBeVisible();
      const embed = process.env.UAT_OLLAMA_EMBED_MODEL ?? '';
      if (!embed) {
        throw new Error(
          'no embedding model in Ollama: pull nomic-embed-text first (`ollama pull nomic-embed-text`), ' +
            'or rerun with UAT_OLLAMA_ALLOW_PULL=1 to let the harness pull it',
        );
      }
      await section.getByRole('radio', { name: 'Ollama (local)' }).check();
      const select = section.locator('select');
      const options = await select.locator('option').evaluateAll((o) => o.map((x) => (x as HTMLOptionElement).value));
      const base = embed.replace(/:latest$/, '');
      if (options.includes(base)) {
        await select.selectOption(base);
      } else {
        await select.selectOption('custom');
        await section.getByRole('textbox', { name: 'Model name' }).fill(embed);
      }
      await expect(section.getByText(/Vector store: sqlite-vec/)).toBeVisible();
      const recall = section.getByRole('checkbox', { name: 'Recall memories automatically' });
      // Left at its default: J9 judges what the default is.
      const recallOn = await recall.isChecked();
      writeState({ recallDefaultOn: recallOn });
      note(testInfo, `embedding model ${base}; sqlite-vec; automatic recall ${recallOn ? 'on' : 'off'} (default)`);
      await expect(section.getByRole('button', { name: 'Save and continue' }), 'Save stays disabled until Test passes').toBeDisabled();
      await section.getByRole('button', { name: 'Test' }).click();
      const check = page.getByTestId('ms-onb-memory-check');
      await expect(check).toHaveText(/Embedding works: \d+ dimensions|failed|couldn't|missing|not found/i, { timeout: 90_000 });
      const text = ((await check.textContent()) ?? '').trim();
      await shot(page, testInfo, 'memory-test');
      if (!/Embedding works: \d+ dimensions/.test(text)) {
        const download = section.getByRole('button', { name: 'Download model' });
        if (await download.isVisible()) {
          throw new Error(`the embedding model isn't in Ollama ("${text}"): pull nomic-embed-text first; the harness never presses Download model`);
        }
        throw new Error(`the memory Test failed: "${text}"`);
      }
      writeState({ memoryCheck: text, embedModel: base });
      note(testInfo, text);
      await section.getByRole('button', { name: 'Save and continue' }).click();
    });

    // Connectors: optional, skipped.
    await test.step('connectors', async () => {
      await expect(page.getByRole('heading', { name: 'Connect a chat app (optional)' })).toBeVisible();
      await shot(page, testInfo, 'connectors');
      await page.getByRole('button', { name: 'Skip' }).click();
    });

    // About you: optional text, then Save and continue (this writes the identity scaffold).
    await test.step('about you', async () => {
      await expect(page.getByRole('heading', { name: 'Tell the agent about you' })).toBeVisible();
      await page.getByRole('textbox', { name: /first thing you want help with/i }).fill(ABOUT_PURPOSE);
      await page.getByRole('textbox', { name: /know before the first chat/i }).fill(ABOUT_CONTEXT);
      await shot(page, testInfo, 'about-you');
      await page.getByRole('button', { name: 'Save and continue' }).click();
    });
  }

  // Finish: the gateway reports set up, and the banner is gone.
  await test.step('finish', async () => {
    await expect(page.getByRole('heading', { name: 'MindStone is set up' })).toBeVisible({ timeout: 30_000 });
    await expect(page.getByRole('button', { name: 'Start a chat' })).toBeEnabled();
    const hint = (await page.locator('section[aria-labelledby="ms-onb-finish"] p').first().textContent()) ?? '';
    writeState({ finishReached: true, finishHint: hint.trim() });
    await shot(page, testInfo, 'finish');
    const status = await adminStatus(page);
    expect(status.onboarded, 'GET /admin/status reports onboarded after Finish').toBe(true);
    note(testInfo, 'admin status: onboarded=true');
    // A second tab (its own sessionStorage), so the main one stays on Finish for J4's "Start a chat".
    const tab = await context.newPage();
    try {
      const statusCall = tab.waitForResponse((r) => r.url().includes('/api/mindstone/admin/status'), { timeout: 30_000 });
      await navigate(tab, '/c/new');
      // Positive first: the chat page has rendered (the composer is there) and the banner's own
      // status call came back saying "onboarded"; only then does "no banner" mean something.
      await expect(tab.getByRole('textbox', { name: 'Message input' })).toBeVisible({ timeout: 30_000 });
      const seen = (await (await statusCall).json().catch(() => ({}))) as { onboarded?: unknown };
      expect(seen.onboarded, "the banner's status call reports onboarded").toBe(true);
      await tab.waitForTimeout(1_500);
      await expect(tab.getByTestId('mindstone-setup-banner'), 'the setup banner is gone once set up').toHaveCount(0);
      await shot(tab, testInfo, 'banner-gone');
    } finally {
      await tab.close();
    }
  });
  writeState({ j2Passed: true });
});

test('J3 memory in guided setup: vector store, embedding provider and model, live embed check', async ({}, testInfo) => {
  // The memory step (#102) embeds with a local Ollama model that must already be pulled; the
  // harness never pulls one unless UAT_OLLAMA_ALLOW_PULL=1.
  const embedModel = process.env.UAT_OLLAMA_EMBED_MODEL ?? '';
  if (!embedModel) {
    throw new Error(
      'no embedding model in Ollama: pull nomic-embed-text first (`ollama pull nomic-embed-text`), ' +
        'or rerun with UAT_OLLAMA_ALLOW_PULL=1 to let the harness pull it',
    );
  }
  note(testInfo, `embedding model available: ${embedModel}`);
  const flow = requireFlow();
  const state = readState();
  const steps = state.setupSteps ?? [];
  // Checked in a second tab so the main one stays on Finish for J4.
  await ensureSignedIn(page, { stayIfSignedIn: true });
  const tab = await context.newPage();
  let status: Awaited<ReturnType<typeof adminStatus>>;
  let memoryConfig: { vectorStore?: string; embeddingProvider?: string; autoRecall?: boolean } = {};
  try {
    await navigate(tab, '/mindstone');
    await expect(tab.getByRole('heading', { name: 'MindStone settings' })).toBeVisible();
    const memoryRow = tab.getByTestId('ms-step-memory');
    await expect(memoryRow, 'the status panel reports memory').toBeVisible();
    note(testInfo, `status panel: ${((await memoryRow.textContent()) ?? '').trim()}`);
    await shot(tab, testInfo, 'status-panel');
    status = await adminStatus(tab);
    const config = await consoleApi<{ config?: { memory?: typeof memoryConfig } }>(tab, 'GET', '/api/mindstone/admin/config');
    memoryConfig = config.json.config?.memory ?? {};
    if (flow === '102') {
      // The real test: the memory step exists, its Test passed, and the saved settings are live.
      await expect(memoryRow, 'the status panel marks memory done').toContainText('✓');
    }
  } finally {
    await tab.close();
  }
  await attachText(testInfo, 'memory-config.json', JSON.stringify({ memory: memoryConfig, steps: status!.steps }, null, 2));

  if (flow === 'pre-102') {
    requireUnchanged('the guided setup steps', steps, FLOWS['pre-102'].setupSteps);
    requireUnchanged('the /admin/status checklist keys', status!.stepKeys, FLOWS['pre-102'].statusSteps);
    if (state.finishHint) note(testInfo, `finish page: "${state.finishHint}"`);
    test.fixme(
      true,
      `PENDING ${ISSUES.memory}: guided setup has no memory step (steps: ${steps.join(' > ')}). ` +
        'Done when: setup includes a memory step that picks the vector store, the embedding provider and the embedding model, ' +
        'runs a live embed check that must succeed, and setup is not finished until a test memory is ' +
        'written, embedded and recalled in chat.',
    );
    return;
  }
  requireSetupDone();
  expect(steps, 'the setup has a Memory step').toContain('Memory');
  const dims = Number(state.memoryCheck?.match(/Embedding works: (\d+) dimensions/)?.[1] ?? 0);
  expect(dims, `the memory step's live Test embedded text ("${state.memoryCheck ?? 'no result'}")`).toBeGreaterThan(0);
  expect(memoryConfig.vectorStore, 'memory.vectorStore saved').toBe('sqlite-vec');
  expect(memoryConfig.embeddingProvider, 'memory.embeddingProvider saved').toBe(`ollama:${state.embedModel}`);
  const memoryStep = status!.steps.memory as { done?: boolean; detail?: string } | undefined;
  expect(memoryStep?.done, `/admin/status memory step done (${memoryStep?.detail ?? ''})`).toBe(true);
  note(testInfo, `${state.memoryCheck}; saved: ${memoryConfig.vectorStore}, ${memoryConfig.embeddingProvider}, autoRecall ${memoryConfig.autoRecall === true ? 'on' : 'off'}`);
  note(
    testInfo,
    'not exercised: writing a test memory and recalling it in a later chat (no Console path writes a memory, and automatic recall is off by default); J6 covers recall within a conversation',
  );
});

test('J4 start a chat; the agent answers', async ({}, testInfo) => {
  testInfo.setTimeout(10 * 60_000);
  const state = readState();
  if (PROVIDER === 'mock') testInfo.annotations.push({ type: 'mock', description: 'mock provider' });
  testInfo.annotations.push({
    type: 'label',
    description: PROVIDER === 'mock' ? 'MOCK' : `${PROVIDER} ${state.chosenModel ?? PROVIDER_MODEL}`,
  });
  // Does the agent speak first (#102)? Listen before "Start a chat" navigates, so nothing is missed.
  const chatPosts: string[] = [];
  const onRequest = (request: Request) => {
    const url = new URL(request.url());
    if (request.method() === 'POST' && /^\/api\/(agents\/)?chat/.test(url.pathname)) chatPosts.push(url.pathname);
  };
  page.on('request', onRequest);
  const startChat = page.getByRole('button', { name: 'Start a chat' });
  if (state.finishReached && (await appears(startChat, 3_000))) {
    await startChat.click();
    note(testInfo, 'clicked Start a chat on the Finish page');
  } else {
    note(testInfo, 'not on the Finish page: opened /c/new');
    await ensureSignedIn(page);
    await navigate(page, '/c/new');
  }
  // /c/new (maybe with ?prompt=…&submit=true), or already /c/<id>: the #102 flow's Start a chat
  // sends the first turn itself and redirects. Any of them is fine; the conversation is what counts.
  await expect(page).toHaveURL(/\/c\/[^/?#]+/, { timeout: 30_000 });
  await page.waitForTimeout(15_000);
  page.off('request', onRequest);
  const spoke = chatPosts.length > 0;
  writeState({ agentSpokeFirst: spoke });
  note(testInfo, spoke ? `a first turn was sent by Start a chat (${chatPosts.join(', ')})` : 'the chat opened empty; the agent did not speak first');
  await shot(page, testInfo, 'new-chat');

  if (spoke) {
    // The first exchange Start a chat began: stored, finished, and on screen.
    const first = await waitForReplyTo(page, undefined);
    writeState({
      firstUserText: first.userText,
      firstReply: first.text.slice(0, 2000),
      firstReplyId: first.messageId,
      conversationId: first.conversationId,
      conversationUrl: page.url(),
    });
    await attachText(testInfo, 'first-reply.txt', replyLog(first));
    await shot(page, testInfo, 'first-reply');
    expectAnswer(first, 'the first turn');
    note(testInfo, `first reply (on screen ${first.shownBy}): "${first.text.slice(0, 160)}"`);
  }
  await ensureMindStoneModel(page, testInfo);
  const prompt = 'Please say hello back in one short sentence.';
  const reply = await sendAndWaitForReply(page, prompt);
  const current = readState();
  writeState({
    conversationUrl: page.url(),
    conversationId: reply.conversationId,
    lastReply: reply.text.slice(0, 2000),
    lastReplyId: reply.messageId,
    ...(current.firstReply
      ? {}
      : { firstReply: reply.text.slice(0, 2000), firstReplyId: reply.messageId, firstUserText: reply.userText }),
  });
  await attachText(testInfo, 'reply.txt', replyLog(reply));
  await shot(page, testInfo, 'reply');
  await gatewayExcerpt(testInfo, 40);
  expectAnswer(reply, 'the hello');
  note(testInfo, `reply (on screen ${reply.shownBy}): "${reply.text.slice(0, 160)}"`);

  // Which model answered: the route the setup saved, and the gateway's transcript metadata.
  const config = await consoleApi<{ config?: { routing?: { mode?: string; defaultModel?: string } } }>(
    page,
    'GET',
    '/api/mindstone/admin/config',
  );
  const routing = config.json.config?.routing ?? {};
  note(testInfo, `routing: ${routing.mode} ${routing.defaultModel}`);
  if (PROVIDER === 'mock') {
    expect(routing.mode, 'the mock route').toBe('mock');
    return;
  }
  expect(routing.mode, 'routing.mode after setup').toBe('pi-session');
  expect(routing.defaultModel, 'the model chosen in setup is the default route').toBe(state.chosenModel);
  const answered = answeredBy(reply.text);
  await attachText(testInfo, 'answered-by.json', JSON.stringify(answered ?? { found: false }, null, 2));
  expect(answered, 'the gateway transcript has the reply').toBeTruthy();
  expect(answered?.modelFallbackMessage, 'no model fallback in the Pi session').toBeFalsy();
  const [wantProvider, ...rest] = (state.chosenModel ?? '').split('/');
  const wantModel = rest.join('/');
  note(testInfo, `answered by: ${answered?.provider ?? '?'} / ${answered?.model ?? '?'} (gateway: ${answered?.gatewayProvider} ${answered?.gatewayModel})`);
  expect(answered?.provider, `the Pi session called provider ${wantProvider}`).toBe(wantProvider);
  expect(answered?.model, `the Pi session called model ${wantModel}`).toBe(wantModel);
});

test('J5 identity formation on the first chat', async ({}, testInfo) => {
  const flow = requireFlow();
  await ensureSignedIn(page);
  const state = readState();
  expect(state.agentSpokeFirst, 'J4 recorded whether the agent spoke first').not.toBeUndefined();
  await navigate(page, '/mindstone');
  await expect(page.getByRole('heading', { name: 'MindStone settings' })).toBeVisible();
  await shot(page, testInfo, 'status-panel');
  const status = await adminStatus(page);
  note(testInfo, `agent spoke first: ${state.agentSpokeFirst === true ? 'yes' : 'no'}; checklist: ${status.stepKeys.join(', ')}`);
  if (state.firstReply) note(testInfo, `first reply: "${state.firstReply.slice(0, 200)}"`);

  if (flow === 'pre-102') {
    requireUnchanged('the /admin/status checklist keys (no identity step yet)', status.stepKeys, FLOWS['pre-102'].statusSteps);
    requireUnchanged('whether the agent speaks first after "Start a chat"', state.agentSpokeFirst, false);
    test.fixme(
      true,
      `PENDING ${ISSUES.identity}: Console setup doesn't start identity formation, and the chat opens empty. ` +
        'Done when: after Finish, "Start a chat" opens a chat where the agent speaks first with the identity-formation ' +
        '("who are you, how do you want to work") conversation; the admin API onboarding writes the onboarding record and ' +
        'the identity/user scaffold; and the status checklist (GET /admin/status or /admin/onboarding) reports an identity step as done.',
    );
    return;
  }

  // #102 flow: the real test. The gateway's own record decides, not how the reply reads:
  // the identity-formation prompt was injected into THIS conversation's first turn.
  requireSetupDone();
  expect(state.agentSpokeFirst, 'Start a chat sent the first turn, so the agent answers first').toBe(true);
  expect(state.conversationId, 'J4 recorded its conversation').toBeTruthy();
  const conversation = state.conversationId!;
  const formation = formationEvidence(conversation);
  await attachText(testInfo, 'formation-transcript.txt', JSON.stringify(formation ?? { found: false }, null, 2));
  expect(formation, `the gateway transcript has a session for conversation ${conversation}`).toBeTruthy();
  expect(
    formation!.promptedAt,
    'the transcript records identity_formation_prompted for this conversation (the gateway injected the formation prompt)',
  ).toBeGreaterThanOrEqual(0);
  expect(formation!.firstAssistantAt, 'the transcript has the first assistant reply').toBeGreaterThanOrEqual(0);
  expect(formation!.promptedAt, 'identity_formation_prompted comes before the first assistant reply').toBeLessThan(
    formation!.firstAssistantAt,
  );
  if (formation!.promptedRunId && formation!.firstAssistantRunId) {
    expect(formation!.promptedRunId, 'the formation prompt belongs to the first reply\'s run').toBe(formation!.firstAssistantRunId);
  }
  note(testInfo, `transcript: identity_formation_prompted (mode ${formation!.mode ?? '?'}) at entry ${formation!.promptedAt}, first reply at ${formation!.firstAssistantAt}`);
  // The gateway's per-agent claim is this conversation's.
  const dataDir = gatewayDataDir();
  const record = path.join(dataDir, 'identity-formation', 'default.json');
  expect(dataDir && fs.existsSync(record), '<dataDir>/identity-formation/default.json exists').toBeTruthy();
  const claim = JSON.parse(fs.readFileSync(record, 'utf8')) as { sessionKey?: string };
  await attachText(testInfo, 'identity-formation.json', JSON.stringify(claim, null, 2));
  expect(claim.sessionKey?.endsWith(`:${conversation}`), `the formation claim (${claim.sessionKey}) is for J4's conversation`).toBe(true);
  // The checklist, via the API and the status panel.
  expect(status.stepKeys, 'the checklist has an identity step').toContain('identity');
  const identity = status.steps.identity as { done?: boolean; detail?: string } | undefined;
  expect(identity?.done, `the identity step is done (${identity?.detail ?? ''})`).toBe(true);
  await expect(page.getByTestId('ms-step-identity'), 'the status panel marks identity done').toContainText('✓');
  // Secondary: the reply reads like formation, and it's on screen in its assistant row.
  expect(state.firstReply, 'J4 stored the first reply').toBeTruthy();
  const first = state.firstReply!;
  expect(first, 'the first reply asks what to call you (secondary check)').toMatch(FORMATION_QUESTION);
  await navigate(page, state.conversationUrl!);
  await expectOnScreen(page, first, 'the identity-formation reply', { role: 'assistant', messageId: state.firstReplyId });
  await shot(page, testInfo, 'formation-on-screen');
});

test('J6 memory recall within the conversation', async ({}, testInfo) => {
  testInfo.setTimeout(12 * 60_000);
  await ensureSignedIn(page);
  const state = readState();
  expect(state.conversationUrl, 'J4 left a conversation to continue').toBeTruthy();
  await navigate(page, state.conversationUrl!);
  // Don't type into a conversation that hasn't loaded: J4's last reply must be on screen first.
  const shown = state.lastReply ?? state.firstReply;
  if (shown) {
    await expectOnScreen(page, shown, "J4's reply, after reopening the conversation", {
      role: 'assistant',
      messageId: state.lastReplyId ?? state.firstReplyId,
    });
  }
  await ensureMindStoneModel(page, testInfo);
  const codeword = `${['amber', 'cobalt', 'violet', 'saffron'][Date.now() % 4]}-heron-${1000 + (Date.now() % 9000)}`;
  writeState({ j6Codeword: codeword });
  const plant = `Please remember this for later in our chat: my project codename is ${codeword}. Just reply "Noted."`;
  const filler = 'Unrelated question: what is 17 plus 25? Answer with just the number.';
  const ask = 'What is my project codename? Answer with just the codename.';
  const r1 = await sendAndWaitForReply(page, plant);
  const r2 = await sendAndWaitForReply(page, filler);
  const r3 = await sendAndWaitForReply(page, ask);
  await attachText(
    testInfo,
    'recall.txt',
    [plant, r1.text, filler, r2.text, ask, r3.text].map((t, i) => `${i % 2 ? '<' : '>'} ${t}`).join('\n\n'),
  );
  await shot(page, testInfo, 'recall');
  await gatewayExcerpt(testInfo, 40);
  note(testInfo, `asked for ${codeword}; reply: "${r3.text.slice(0, 120)}"`);
  expect(r3.error, `the recall reply is not an error: ${(r3.errorText ?? '').slice(0, 300)}`).toBe(false);
  if (PROVIDER === 'mock') {
    // The mock route echoes; recall can't be judged. MOCK, which the gate counts as not passed.
    testInfo.annotations.push({ type: 'mock', description: 'mock provider' }, { type: 'label', description: 'MOCK' });
    return;
  }
  // This works today, so a miss is a regression: FAIL, not PENDING.
  expect(r3.text.toLowerCase(), `the agent recalls ${codeword} from earlier in the conversation`).toContain(codeword.toLowerCase());
  note(testInfo, 'in-conversation recall only (the context window); durable, embedded recall is part of J3');
});

test('J7 Skill Builder from the Console and from chat', async ({}, testInfo) => {
  testInfo.setTimeout(15 * 60_000);
  if (PROVIDER === 'mock')
    testInfo.annotations.push({ type: 'mock', description: 'mock provider' });
  await ensureSignedIn(page);
  const tag = `${1000 + (Date.now() % 9000)}`;
  const consoleSkill = `journey-console-${tag}`;
  const chatSkill = `journey-chat-${tag}`;
  const consoleWord = `${['amber', 'cobalt', 'violet', 'saffron'][Date.now() % 4]}-kestrel-${tag}`;
  const chatWord = `${['teal', 'coral', 'umber', 'jade'][Date.now() % 4]}-plover-${tag}`;
  const skills = page.getByRole('heading', { name: 'Skills', exact: true });

  await test.step('advanced settings, turned on from the settings page', async () => {
    // "Start a chat" (J4) turned them off; installing a skill needs them.
    await navigate(page, '/mindstone');
    const state = page.getByTestId('ms-advanced-state');
    await expect(state).toBeVisible();
    if ((await state.textContent())?.trim() === 'Off.') {
      await navigate(page, '/mindstone/skills');
      await expect(page.getByText('Installing a skill needs advanced settings')).toBeVisible();
      await navigate(page, '/mindstone');
      await page.getByLabel('Confirmation').fill(TYPED_PHRASE);
      await page.getByRole('button', { name: 'Turn on' }).click();
    }
    await expect(state).toHaveText(/^On\b/);
    note(testInfo, 'advanced settings on');
  });

  await test.step('the Skills page, from the settings page', async () => {
    await navigate(page, '/mindstone');
    await expect(page.getByRole('heading', { name: 'MindStone settings' })).toBeVisible();
    const links = await statusLinks(page);
    note(testInfo, `links: ${links.join(', ')}`);
    // #126 adds "Model providers" right after Skills: required with UAT_EXPECT_ENTERPRISE=1, accepted there (only
    // there) without it; every other link stays strict (lib/enterprise-evidence.js, self-tested).
    const rule = expectedStatusLinks({ links, today: TODAY_STATUS_LINKS, expectEnterprise: process.env.UAT_EXPECT_ENTERPRISE === '1' });
    if (rule.note) note(testInfo, rule.note);
    expect(links, 'the links on /mindstone').toEqual(rule.expected);
    await page
      .locator('section[aria-labelledby="ms-onboarding"]')
      .getByRole('link', { name: 'Skills' })
      .click();
    await expect(page).toHaveURL(/\/mindstone\/skills$/);
    await expect(skills).toBeVisible();
    await expect(page.getByTestId('ms-skill-builtin-integration-builder')).toBeVisible();
    await shot(page, testInfo, 'skills');
  });

  await test.step('from a built-in: draft, review, discard', async () => {
    const builtin = page.getByTestId('ms-skill-builtin-integration-builder');
    await builtin.getByRole('button', { name: 'Build a skill from this' }).click();
    await page.getByLabel(/^Id/).fill(`journey-builtin-${tag}`);
    await page.getByLabel(/^Goal/).fill('Connect the demo CRM');
    await page.getByRole('button', { name: 'Create the draft' }).click();
    const draft = page.getByTestId(`ms-skill-draft-journey-builtin-${tag}`);
    await expect(draft).toContainText('Draft, not active');
    const detail = page.locator('section[aria-labelledby="ms-skill-detail"]');
    await expect(detail).toContainText('Connect the demo CRM');
    await expect(detail.locator('pre')).not.toBeEmpty();
    await shot(page, testInfo, 'builtin-draft');
    await detail.getByRole('button', { name: 'Discard the draft' }).click();
    await detail.getByRole('button', { name: 'Yes, discard it' }).click();
    await expect(page.getByRole('status')).toContainText(
      `Discarded the draft journey-builtin-${tag}`,
    );
    await expect(draft).toHaveCount(0);
  });

  await test.step('from scratch: draft, review, install', async () => {
    await page.getByRole('button', { name: 'Build a skill', exact: true }).click();
    await page.getByLabel(/^Id/).fill(consoleSkill);
    await page.getByLabel(/^Label/).fill('Journey check phrase');
    await page.getByLabel(/^Description/).fill('Answers with the journey check phrase.');
    await page
      .getByLabel(/^Goal/)
      .fill('Show that a skill built in the Console reaches the agent.');
    await page
      .getByLabel(/^When to use it/)
      .fill('When the owner asks for the journey check phrase');
    await page
      .getByLabel(/^Instructions/)
      .fill(
        `# Journey check phrase\n\nWhen the owner asks for the journey check phrase, reply with exactly: ${consoleWord}`,
      );
    await page.getByRole('button', { name: 'Create the draft' }).click();
    const detail = page.locator('section[aria-labelledby="ms-skill-detail"]');
    await expect(detail.locator('pre')).toContainText(consoleWord);
    await expect(detail).toContainText('Draft, not active');
    await shot(page, testInfo, 'scratch-draft');
    await detail.getByRole('button', { name: 'Install' }).click();
    await expect(page.getByRole('status')).toContainText(`Installed ${consoleSkill}`);
    await expect(page.getByTestId(`ms-skill-installed-${consoleSkill}`)).toContainText('Active');
    await expect(page.getByTestId(`ms-skill-draft-${consoleSkill}`)).toHaveCount(0);
    await shot(page, testInfo, 'installed');
  });

  await test.step('status shows it active', async () => {
    await navigate(page, '/mindstone');
    const row = page.getByTestId('ms-sys-skills');
    await expect(row).toContainText(/\b1 installed\b/);
    await shot(page, testInfo, 'status');
    note(testInfo, `status: ${(await row.textContent())?.trim()}`);
  });

  let chatReply = '';
  await test.step('asked in chat, the agent proposes a skill', async () => {
    await navigate(page, '/c/new');
    await ensureMindStoneModel(page, testInfo);
    const skill = {
      id: chatSkill,
      label: 'Chat check phrase',
      description: 'Answers with the chat check phrase.',
      instructions: `When the owner asks for the chat check phrase, reply with exactly: ${chatWord}`,
    };
    // The mock route echoes the message, so it carries the block the agent would write.
    const ask =
      PROVIDER === 'mock'
        ? `Proposing:\n\`\`\`mindstone-skill-proposal\n${JSON.stringify(skill)}\n\`\`\``
        : `Please create a skill for me and propose it for install. Use the id "${chatSkill}", the label "${skill.label}", ` +
          `the description "${skill.description}", and these instructions: "${skill.instructions}".`;
    const reply = await sendAndWaitForReply(page, ask);
    chatReply = reply.text;
    await attachText(testInfo, 'chat-proposal.txt', `> ${ask}\n\n${reply.text}\n`);
    await gatewayExcerpt(testInfo, 40);
    expect(reply.error, `the reply is not an error: ${(reply.errorText ?? '').slice(0, 200)}`).toBe(
      false,
    );
    expect(reply.text, 'the proposal block is not shown in the chat').not.toContain(
      'mindstone-skill-proposal',
    );
    note(testInfo, `proposal reply: "${reply.text.slice(0, 160)}"`);
  });

  await test.step('approved on Approvals, it is installed and active', async () => {
    await navigate(page, '/mindstone/approvals');
    const item = page.getByRole('button', { name: new RegExp(`install skill ${chatSkill}`) });
    const proposed = await appears(item, 10_000);
    await shot(page, testInfo, 'approvals');
    expect(
      proposed,
      `a pending skill_install for ${chatSkill} on Approvals (reply: "${chatReply.slice(0, 200)}")`,
    ).toBe(true);
    await item.click();
    const detail = page.locator('section[aria-labelledby="ms-appr-detail"]');
    await expect(detail.getByTestId('ms-appr-skill-instructions')).toContainText(chatWord);
    await detail.getByRole('button', { name: 'Approve' }).click();
    await expect(detail).toContainText('Approving installs this skill');
    await detail.getByRole('button', { name: 'Yes, approve' }).click();
    await expect(page.getByRole('status')).toContainText('Approved.');
    await navigate(page, '/mindstone/skills');
    await expect(skills).toBeVisible();
    await expect(page.getByTestId(`ms-skill-installed-${chatSkill}`)).toContainText('Active');
    await shot(page, testInfo, 'chat-skill-installed');
  });

  await test.step('the agent uses both skills', async () => {
    if (PROVIDER === 'mock') {
      // The mock route echoes; whether the agent follows a skill can't be judged. MOCK counts as not passed.
      testInfo.annotations.push({ type: 'label', description: 'MOCK' });
      return;
    }
    const answers: string[] = [];
    for (const [ask, word] of [
      ['What is the journey check phrase? Answer with just the phrase.', consoleWord],
      ['What is the chat check phrase? Answer with just the phrase.', chatWord],
    ]) {
      await navigate(page, '/c/new');
      await ensureMindStoneModel(page, testInfo);
      const reply = await sendAndWaitForReply(page, ask);
      answers.push(`> ${ask}\n${reply.text}`);
      expect(
        reply.error,
        `the reply is not an error: ${(reply.errorText ?? '').slice(0, 200)}`,
      ).toBe(false);
      expect(
        reply.text.toLowerCase(),
        `a fresh chat follows the installed skill (${word})`,
      ).toContain(word.toLowerCase());
    }
    await attachText(testInfo, 'skills-used.txt', answers.join('\n\n'));
    await shot(page, testInfo, 'skill-used');
  });
});

test('J8 the agent drafts its persona; approved in the Console', async ({}, testInfo) => {
  await ensureSignedIn(page);
  // Not built on this pair yet (no personas route through the Console): PENDING, not a pass.
  const personasRoute = await consoleApi<unknown>(page, 'GET', '/api/mindstone/admin/personas');
  if (personasRoute.status === 404) {
    note(testInfo, `GET /api/mindstone/admin/personas: HTTP ${personasRoute.status}`);
    test.fixme(
      true,
      `PENDING ${ISSUES.persona}: this Console/gateway pair has no persona support (MindStone-Agent#112, mindstone-console#24). ` +
        'Done when: in chat the agent proposes a persona; the admin approves it on Approvals (saved, not active); switches to it ' +
        'on the Personas page; and the next chat runs with it.',
    );
    return;
  }
  // A fresh id and a word only this run uses, so the checks can't match an earlier run.
  const stamp = Date.now().toString(36);
  const wantedId = `journey-${stamp}`;
  const voiceWord = `heron${stamp}`;
  const since = Date.now();

  // 1. In chat, the agent proposes a persona. A real model is asked to use the
  // format from its standing instructions; the mock model only echoes, so the
  // block itself goes in the message (labelled MOCK, never a pass).
  const block =
    '```mindstone-persona-proposal\n' +
    JSON.stringify({
      id: wantedId,
      name: 'Journey',
      description: 'A persona drafted during the journey test.',
      voice: `Warm and direct. Uses the word ${voiceWord}.`,
      workingStyle: 'Asks before acting.',
      boundaries: ['Never sends anything without approval.'],
    }) +
    '\n```';
  const ask =
    PROVIDER === 'mock'
      ? `Please propose this persona.\n${block}`
      : `Please propose a working persona for yourself now, using the persona proposal format from your instructions. ` +
        `Use the id ${wantedId}, the name Journey, and put the word ${voiceWord} in the voice.`;
  await navigate(page, '/c/new');
  await ensureMindStoneModel(page, testInfo);
  const reply = await sendAndWaitForReply(page, ask);
  await shot(page, testInfo, 'proposal-reply');
  expect(reply.error, `the proposal turn answered without an error (${reply.errorText ?? ''})`).toBe(false);
  expect(reply.text, 'the proposal block is stripped from what the user sees').not.toContain('mindstone-persona-proposal');

  // 2. It waits on Approvals as a persona_create proposal.
  type Listed = { id: string; kind: string; status: string; summary: string; createdAt?: string };
  let proposal: Listed | undefined;
  for (let tries = 0; tries < 20 && !proposal; tries += 1) {
    const listed = await consoleApi<{ actions?: Listed[] }>(page, 'GET', '/api/mindstone/admin/approvals');
    proposal = (listed.json?.actions ?? [])
      .filter((a) => a.kind === 'persona_create' && a.status === 'pending' && (!a.createdAt || Date.parse(a.createdAt) >= since - 5_000))
      .pop();
    if (!proposal) await page.waitForTimeout(1_500);
  }
  expect(proposal, `a pending persona proposal appears on Approvals (${ISSUES.persona}); the agent replied: ${reply.text.slice(0, 200)}`).toBeTruthy();
  const detail = await consoleApi<{ action?: { persona?: { id: string; name: string; voice?: string } } }>(
    page,
    'GET',
    `/api/mindstone/admin/approvals/${proposal!.id}`,
  );
  const persona = detail.json?.action?.persona;
  expect(persona?.id, 'the proposal carries the persona').toBeTruthy();
  note(testInfo, `proposed persona ${persona!.id} (${persona!.name}); asked for ${wantedId}`);

  // 3. The admin sees it on the Approvals page and approves it: saved, not active.
  await navigate(page, '/mindstone/approvals');
  await expect(page.getByRole('heading', { name: 'Approvals' }).first()).toBeVisible();
  await page.getByRole('button', { name: new RegExp(`\\(${persona!.id}\\)`) }).first().click();
  await expect(page.getByTestId('ms-appr-persona')).toBeVisible();
  await expect(page.getByTestId('ms-appr-persona')).toContainText(persona!.name);
  await shot(page, testInfo, 'approval-card');
  await page.getByRole('button', { name: 'Approve', exact: true }).click();
  await page.getByRole('button', { name: 'Yes, approve' }).click();
  await expect(page.getByText('is saved to your personas')).toBeVisible({ timeout: 15_000 });
  const listedAfter = await consoleApi<{ active?: string | null; personas?: { id: string }[] }>(page, 'GET', '/api/mindstone/admin/personas');
  expect(listedAfter.json?.personas?.some((p) => p.id === persona!.id), 'the approved persona is on the list').toBe(true);
  expect(listedAfter.json?.active, 'approving saves the persona but does not make it active').not.toBe(persona!.id);

  // 4. The deliberate switch on the Personas page.
  await navigate(page, '/mindstone/personas');
  const row = page.getByTestId(`ms-persona-${persona!.id}`);
  await expect(row).toBeVisible();
  await row.getByRole('button', { name: 'Make active' }).click();
  await expect(row.getByText('Active', { exact: true })).toBeVisible({ timeout: 15_000 });
  await shot(page, testInfo, 'personas-active');

  // 5. The next chat uses it: the gateway records the persona it injected.
  await navigate(page, '/c/new');
  await ensureMindStoneModel(page, testInfo);
  const next = await sendAndWaitForReply(page, 'In one short sentence, how would you describe your working style?');
  await shot(page, testInfo, 'next-chat');
  expect(next.error, `the next chat answered without an error (${next.errorText ?? ''})`).toBe(false);
  expect(next.conversationId, 'the next chat has a conversation id').toBeTruthy();
  const used = personaForConversation(next.conversationId!);
  note(testInfo, `next chat: transcript entry ${used.found ? 'found' : 'not found'}, persona ${used.personaId ?? 'none'}`);
  expect(used.found, 'the gateway transcript has a reply in the next chat (UAT_TRANSCRIPT_DIR)').toBe(true);
  expect(used.personaId, 'the next chat ran with the approved persona').toBe(persona!.id);
  if (PROVIDER === 'mock') {
    testInfo.annotations.push({ type: 'mock', description: 'mock provider' }, { type: 'label', description: 'MOCK' });
  }
});

test('J9 memory recall across chats: a fact told in one chat is recalled in a fresh one', async ({}, testInfo) => {
  testInfo.setTimeout(20 * 60_000);
  const flow = requireFlow();
  await ensureSignedIn(page);
  const state = readState();

  // What the Console setup left: the saved config, the status checklist, and the gateway's recall index.
  type MemoryConfig = { config?: { memory?: { autoRecall?: boolean } }; etag?: string };
  const config = await consoleApi<MemoryConfig>(page, 'GET', '/api/mindstone/admin/config');
  const autoRecall = config.json.config?.memory?.autoRecall;
  const status = await adminStatus(page);
  const memoryDetail = (status.steps.memory as { detail?: string } | undefined)?.detail;
  const setupState = {
    autoRecall: autoRecall ?? null,
    recallDefaultOn: state.recallDefaultOn ?? null,
    statusMemoryDetail: memoryDetail ?? null,
    recallIndexBuilt: recallIndexExists(),
  };
  const described =
    `after setup: memory.autoRecall ${JSON.stringify(setupState.autoRecall)}; setup's recall checkbox default ` +
    `${setupState.recallDefaultOn === true ? 'on' : setupState.recallDefaultOn === false ? 'off' : 'not seen'}; ` +
    `status "${setupState.statusMemoryDetail ?? ''}"; recall index (vectors/memory.sqlite) ${setupState.recallIndexBuilt ? 'built' : 'absent'}`;

  if (autoRecall !== true) {
    // Today's exact state: recall off by default, no live recall index, nothing writes a memory
    // (J6's "please remember" codeword is in no memory store). Anything else is a change to review, not PENDING.
    if (!state.j6Codeword) {
      throw new Error('blocked by J6: J6 recorded no codeword, so "nothing writes a memory" could not be checked; this step was not judged');
    }
    const found = { ...setupState, j6CodewordInMemoryStores: memoryStoreFilesWith(state.j6Codeword) };
    await attachText(testInfo, 'memory-state.json', JSON.stringify({ ...found, j6Codeword: state.j6Codeword }, null, 2));
    note(testInfo, `${described}; J6's codeword in a memory store (memory/, vectors/, journals/, LOG.md): ${found.j6CodewordInMemoryStores.join(', ') || 'no'}`);
    if (flow === '102') {
      requireUnchanged('the memory state after setup', found, {
        autoRecall: false,
        recallDefaultOn: false,
        statusMemoryDetail: `vector store sqlite-vec, embeddings ollama:${state.embedModel}, autoRecall off`,
        recallIndexBuilt: false,
        j6CodewordInMemoryStores: [],
      });
    } else {
      requireUnchanged(
        'the memory state after setup',
        { autoRecall: found.autoRecall, recallIndexBuilt: found.recallIndexBuilt, j6CodewordInMemoryStores: found.j6CodewordInMemoryStores },
        { autoRecall: null, recallIndexBuilt: false, j6CodewordInMemoryStores: [] },
      );
    }
    test.fixme(
      true,
      `PENDING ${ISSUES.recall}: automatic recall is off after the Console setup (memory.autoRecall ${JSON.stringify(found.autoRecall)}), ` +
        'the gateway builds no recall index live, and nothing writes a memory. ' +
        'Done when: the Console setup saves memory.autoRecall: true with no manual toggle; a fact the owner tells the agent in one chat ' +
        '("My dog\'s name is <token>. Please remember it.") is captured into an embedded recall-index chunk, and is in none of the files every ' +
        'prompt carries (USER.md, IDENTITY.md, memory/MEMORY.md, invariant files); in a fresh chat, "What is my dog\'s name?" is answered with ' +
        'the token, stored and on screen in its assistant row; the gateway transcript for that chat records memory_recall_injected in the ' +
        "reply's own run, with a hit whose chunk holds the token, and the token in no other entry of that chat; and with memory.autoRecall " +
        'turned off, a third chat asking the same does not get the token.',
    );
    return;
  }

  // The real test: recall is on, so a fact from one chat must reach a fresh one, through recall and nothing else.
  await attachText(testInfo, 'memory-state.json', JSON.stringify(setupState, null, 2));
  note(testInfo, described);
  expect(state.recallDefaultOn, 'setup\'s "Recall memories automatically" was on by default (the harness never touches it)').toBe(true);
  expect(memoryDetail, '/admin/status reports automatic recall on').toMatch(/autoRecall on/);
  // A fact J6 doesn't share (J6 plants a project codename), so J6's memory can't satisfy this recall.
  const token = `${['juniper', 'pepper', 'marlow', 'tansy'][Date.now() % 4]}-${Date.now().toString(36)}`;
  const ask = "What is my dog's name? Answer with just the name.";

  // Chat 1: the owner tells the agent the fact.
  await navigate(page, '/c/new');
  await ensureMindStoneModel(page, testInfo);
  const told = await sendAndWaitForReply(page, `My dog's name is ${token}. Please remember it.`);
  await shot(page, testInfo, 'chat1');
  expectAnswer(told, 'chat 1 (the fact is told)');
  note(testInfo, `chat 1 ${told.conversationId}: told ${token}; reply "${told.text.slice(0, 120)}"`);

  // Capture and indexing: poll the recall index until an embedded chunk holds the fact. No blind sleep, no asking anyway.
  const captured = await waitForEmbeddedChunk(page, token, RECALL_CAPTURE_WAIT_MS);
  const waited = Math.round(captured.waitedMs / 1000);
  if (!captured.chunks.length) {
    const stores = memoryStoreFilesWith(token);
    const why =
      `not captured: after ${waited} s no embedded chunk in the recall index (vectors/memory.sqlite, embedding_json set) holds the fact` +
      `${captured.lastError ? ` (the index couldn't be read: ${captured.lastError})` : ''}; ` +
      `memory stores holding it: ${stores.join(', ') || 'none'}`;
    note(testInfo, why);
    throw new Error(why);
  }
  note(testInfo, `captured after ${waited} s: ${captured.chunks.map((c) => `${c.chunkId} (${c.kind}${c.path ? ` ${c.path}` : ''})`).join(', ')}`);

  // Nothing but recall may carry the fact into chat 2: it's in none of the files every prompt carries.
  // Checked before chat 2, and again after it, so a capture that updates USER.md mid-test is seen.
  const promptFilesClean = (when: string) => {
    const promptFiles = promptFilesWith(token);
    note(testInfo, `prompt files checked for the token ${when}: ${promptFiles.checked.join(', ') || 'none found'}`);
    expect(
      promptFiles.found,
      `${when}, the fact is in none of the files every prompt carries (USER.md, IDENTITY.md, memory/MEMORY.md, invariant files), so only recall can supply it`,
    ).toEqual([]);
  };
  promptFilesClean('before chat 2');

  // Chat 2: a fresh conversation asks for it.
  await navigate(page, '/c/new');
  await ensureMindStoneModel(page, testInfo);
  const answer = await sendAndWaitForReply(page, ask);
  await shot(page, testInfo, 'chat2');
  await gatewayExcerpt(testInfo, 40);
  expect(answer.conversationId, 'chat 2 is a new conversation').not.toBe(told.conversationId);
  expect(answer.error, `chat 2's reply is not an error: ${(answer.errorText ?? '').slice(0, 300)}`).toBe(false);
  promptFilesClean('after chat 2');

  // The token is nowhere in chat 2's own user messages, as the Console stored them.
  const stored = await consoleApi<StoredMessage[]>(page, 'GET', `/api/messages/${encodeURIComponent(answer.conversationId)}`);
  const userTexts = (Array.isArray(stored.json) ? stored.json : []).filter((m) => m.isCreatedByUser).map((m) => messageText(m));
  expect(userTexts.length, "chat 2's user messages are stored").toBeGreaterThan(0);
  expect(userTexts.filter((t) => t.toLowerCase().includes(token)), "the token is in none of chat 2's own user messages").toEqual([]);

  // The gateway's own record: recall supplied the fact to chat 2's turn. Not the model's wording.
  const recall = recallForConversation(answer.conversationId, token);
  note(
    testInfo,
    recall.reasons.length
      ? `gateway transcript for chat 2: recall NOT proven: ${recall.reasons.join('; ')}${recall.indexError ? ` (recall index: ${recall.indexError})` : ''}`
      : `gateway transcript for chat 2: memory_recall_injected at entry ${recall.recallAt} (run ${recall.runId}), ${recall.hitCount} hit(s), ` +
          `${recall.hitChunksWithToken} whose chunk holds the token: ${recall.hits.map((h) => h.chunkId).join(', ')}`,
  );
  for (const text of recall.notes) note(testInfo, text);

  // The reply holds the token: stored, and on screen in its own assistant row.
  await attachText(
    testInfo,
    'recall.txt',
    `chat 1 ${told.conversationId}\n${replyLog(told)}\nchat 2 ${answer.conversationId}\n${replyLog(answer)}`,
  );
  await attachText(testInfo, 'recall-transcript.json', JSON.stringify(recall, null, 2));
  expect(
    recall.reasons,
    `the gateway transcript for chat 2 (${answer.conversationId}) proves recall supplied the fact to its reply's turn ` +
      '(memory_recall_injected in its run, a hit whose chunk holds the token, the token in no other entry); without it recall is not ' +
      'observable, and a reply naming the token is not proof',
  ).toEqual([]);
  expect(answer.text.toLowerCase(), `chat 2's reply recalls ${token} from chat 1`).toContain(token);
  await expectOnScreen(page, token, "the token in chat 2's reply", { role: 'assistant', messageId: answer.messageId });
  await shot(page, testInfo, 'recalled');
  note(testInfo, `chat 2 ${answer.conversationId}: "${answer.text.slice(0, 120)}"`);

  // Negative control: with automatic recall turned off (through the Console; turning it off needs no
  // permission), a third chat asking the same must not get the token. The setting is put back afterwards.
  const setAutoRecall = async (value: boolean) => {
    const current = await consoleApi<MemoryConfig>(page, 'GET', '/api/mindstone/admin/config');
    const query = current.json.etag ? `?ifMatch=${encodeURIComponent(current.json.etag)}` : '';
    return consoleApi<{ restartRequired?: boolean; error?: string }>(page, 'PATCH', `/api/mindstone/admin/config/memory${query}`, { autoRecall: value });
  };
  const off = await setAutoRecall(false);
  expect(off.status, `memory.autoRecall turned off through the Console (${JSON.stringify(off.json)})`).toBeLessThan(300);
  try {
    const now = await consoleApi<MemoryConfig>(page, 'GET', '/api/mindstone/admin/config');
    expect(now.json.config?.memory?.autoRecall, 'the saved memory.autoRecall is now off').toBe(false);
    expect(off.json.restartRequired, 'turning recall off needs no gateway restart').not.toBe(true);
    await navigate(page, '/c/new');
    await ensureMindStoneModel(page, testInfo);
    const control = await sendAndWaitForReply(page, ask);
    await shot(page, testInfo, 'chat3-control');
    await attachText(testInfo, 'control.txt', `chat 3 ${control.conversationId} (memory.autoRecall off)\n${replyLog(control)}`);
    expect(control.conversationId, 'chat 3 is a new conversation').not.toBe(answer.conversationId);
    // A real answer (text, not an error message) first: an empty or failed reply would lack the token for the wrong reason.
    expectAnswer(control, 'chat 3 (control)');
    const controlEvidence = controlForConversation(control.conversationId, token);
    await attachText(testInfo, 'control-transcript.json', JSON.stringify(controlEvidence, null, 2));
    note(
      testInfo,
      `negative control, chat 3 ${control.conversationId} with recall off: ` +
        `${controlEvidence.reasons.length ? `BROKEN: ${controlEvidence.reasons.join('; ')}` : 'no recall event, no token'}; reply "${control.text.slice(0, 120)}"`,
    );
    expect(control.text.toLowerCase(), "with automatic recall off, chat 3's reply doesn't have the token").not.toContain(token);
    expect(controlEvidence.reasons, `the gateway transcript for chat 3 (${control.conversationId}), with recall off`).toEqual([]);
  } finally {
    const restored = await setAutoRecall(true).catch((error: Error) => ({ status: 0, json: { error: error.message } }));
    note(testInfo, `memory.autoRecall put back on: HTTP ${restored.status}${restored.status >= 300 || restored.status === 0 ? ` ${JSON.stringify(restored.json)}` : ''}`);
  }
});

/** The MindStone pages J13 opens from the chat page (console #53): each link's test id and the heading its page shows. */
const J13_PAGES: { id: string; heading: string }[] = [
  { id: 'personas', heading: 'Personas' },
  { id: 'skills', heading: 'Skills' },
  { id: 'memory', heading: 'Memory' },
  { id: 'approvals', heading: 'Approvals' },
  { id: 'providers', heading: 'Model providers' },
  { id: 'mindstone', heading: 'MindStone settings' },
];
/** A model id as the gateway lists it, which the menu must not show once the Console knows the agent's name. */
const J13_BARE_MODEL_ID = /\bmindstone\/[\w.-]+/i;

test('J13 MindStone navigation: every page one click from the chat page, the Memory page, agent names in the model menu, Personas at 400px', async ({}, testInfo) => {
  await ensureSignedIn(page, { stayIfSignedIn: true });

  await test.step('N1: from the chat page, each MindStone page opens from the sidebar (the rail tab, then its link)', async () => {
    const opened: string[] = [];
    for (const target of J13_PAGES) {
      // The chat page is the starting point each time; the MindStone page itself is never typed.
      await navigate(page, '/c/new');
      const tab = page.getByTestId('nav-panel-mindstone');
      await expect(tab, 'the MindStone tab on the sidebar rail (admins only)').toBeVisible({ timeout: 30_000 });
      // The tab toggles its panel: click it only when the panel isn't already the open one.
      let tabClicks = 0;
      if ((await tab.getAttribute('aria-pressed')) !== 'true') {
        await tab.click();
        tabClicks += 1;
      }
      const section = page.getByTestId('mindstone-section');
      await expect(section, 'the MindStone section after at most one click on the tab').toBeVisible();
      await section.getByTestId(`mindstone-nav-${target.id}`).click();
      await expect(page.getByRole('heading', { level: 1, name: target.heading, exact: true })).toBeVisible({ timeout: 30_000 });
      opened.push(`${target.heading} (${new URL(page.url()).pathname}, tab clicks ${tabClicks})`);
    }
    await shot(page, testInfo, 'n1-last-page');
    note(testInfo, `N1 opened: ${opened.join('; ')}`);
  });

  await test.step('N2: the Memory page shows the embedding model and the memory store status', async () => {
    const config = await consoleApi<{ config?: { memory?: { embeddingProvider?: string } } }>(page, 'GET', '/api/mindstone/admin/config');
    const embedding = config.json.config?.memory?.embeddingProvider ?? '';
    expect(embedding, 'the saved memory.embeddingProvider (set by J2)').not.toBe('');
    await navigate(page, '/c/new');
    const tab = page.getByTestId('nav-panel-mindstone');
    if ((await tab.getAttribute('aria-pressed')) !== 'true') await tab.click();
    await page.getByTestId('mindstone-section').getByTestId('mindstone-nav-memory').click();
    await expect(page.getByRole('heading', { level: 1, name: 'Memory', exact: true })).toBeVisible({ timeout: 30_000 });
    await expect(page.getByTestId('ms-mem-embedding'), 'the embedding model, as saved').toContainText(embedding, { timeout: 30_000 });
    const status = page.getByTestId('ms-sys-memory');
    await expect(status, 'the memory store status (search backend and indexed counts)').toBeVisible();
    await shot(page, testInfo, 'n2-memory');
    note(testInfo, `N2 Memory page: embedding "${embedding}"; status: ${(await status.innerText()).replace(/\s+/g, ' ').slice(0, 300)}`);
  });

  await test.step('N3: the model menu shows agent names, not bare mindstone/<id> options, and the selected model reads as a name', async () => {
    const names = await consoleApi<{ names?: Record<string, string> }>(page, 'GET', '/api/mindstone-model-names');
    expect(names.status, 'GET /api/mindstone-model-names').toBe(200);
    const labels = Object.values(names.json.names ?? {});
    expect(labels.length, 'the Console knows at least one agent name').toBeGreaterThan(0);
    for (const label of labels) expect(label, 'an agent name is a name, not a model id').not.toMatch(J13_BARE_MODEL_ID);

    await navigate(page, '/c/new');
    await ensureMindStoneModel(page, testInfo);
    const trigger = page.getByRole('button', { name: 'Select a model' }).first();
    const selected = ((await trigger.textContent()) ?? '').trim();
    expect(selected, 'the selected model reads as a name').not.toMatch(J13_BARE_MODEL_ID);

    await trigger.click();
    await page.getByRole('option', { name: new RegExp(ENDPOINT_LABEL, 'i') }).first().click();
    const options = page.getByRole('option');
    await expect(options.filter({ hasText: labels[0] }).first(), `the agent "${labels[0]}" is listed by name`).toBeVisible({ timeout: 30_000 });
    const texts = (await options.allTextContents()).map((t) => t.trim());
    await shot(page, testInfo, 'n3-model-menu');
    await page.keyboard.press('Escape');
    await page.keyboard.press('Escape');
    expect(texts.filter((t) => J13_BARE_MODEL_ID.test(t)), 'model menu options showing a bare mindstone/<id>').toEqual([]);
    note(testInfo, `N3 selected "${selected}"; options: ${texts.join(' | ').slice(0, 400)}`);
  });

  await test.step('N4: at 400px wide, Personas opens from the sidebar drawer', async () => {
    const size = page.viewportSize();
    await page.setViewportSize({ width: 400, height: 800 });
    try {
      await navigate(page, '/c/new');
      await page.getByTestId('header-open-sidebar-button').click();
      const drawer = page.locator('#mobile-drawer');
      await expect(drawer, 'the drawer is open').not.toHaveAttribute('inert', { timeout: 30_000 });
      // The rail doesn't exist at this width: the drawer's panel switcher is how MindStone is chosen. Always go through
      // it (N1 already left MindStone as the saved panel, and choosing it again keeps it), so the switcher is exercised.
      await drawer.getByTestId('panel-switcher-button').click();
      await page.getByRole('menuitemcheckbox', { name: 'MindStone', exact: true }).click();
      await drawer.getByTestId('mindstone-section').getByTestId('mindstone-nav-personas').click();
      await expect(page.getByRole('heading', { level: 1, name: 'Personas', exact: true })).toBeVisible({ timeout: 30_000 });
      // The closed drawer stays in the page, moved off screen and made inert.
      await expect(drawer, 'the drawer closes when a page is chosen').toHaveAttribute('inert', '');
      await shot(page, testInfo, 'n4-personas-400px');
      note(testInfo, `N4 at 400px: Personas opened at ${new URL(page.url()).pathname}, drawer closed`);
    } finally {
      await page.setViewportSize(size ?? { width: 1366, height: 900 });
    }
  });
});

/** Each guided-setup step's own heading, which its Change link must open (and nothing else). */
const J12_STEP_HEADINGS: Record<string, string> = {
  provider: 'Connect a model provider',
  model: 'Choose the model',
  persona: 'Choose a base persona',
  memory: 'Set up memory',
  connectors: 'Connect a chat app (optional)',
};
/**
 * How long J12 polls the index-clean count after chats under a model (#140: the backfill runs after each owner turn,
 * in the background, one update at a time): after the change, and after the restore.
 */
const J12_REEMBED_WAIT_MS = 120_000;
const J12_RESTORED_INDEX_WAIT_MS = J12_REEMBED_WAIT_MS;
/**
 * J12's question after the embedding change: the fact it tells in a chat under the new model ("My cat is called …").
 * Worded to share few words with earlier chats (J9 asks "What is my dog's name?"), so recall's word hits on older
 * chunks don't crowd the fact's vector hit out of the top results.
 */
const J12_RECALL_PROBE = 'What is my cat called? Answer with just the name.';
/** J12's question under the restored memory setting (the restore check's chat): the same fact. */
const J12_RESTORED_PROBE = "What is my cat called? If you don't know, say so in one short sentence.";
/** The memory step's Test (the Console's proxy gives the embed check 25 s; a model's first load can take longer). */
const J12_MEMORY_CHECK_MS = 90_000;
/** A memory Test result that says the check ran out of time (a cold model load), not that the model can't embed. */
const J12_TEST_AGAIN = /aborted|timed? ?out|no answer within/i;

type J12Config = {
  etag?: string;
  config?: {
    routing?: { mode?: string; defaultAgentId?: string; defaultModel?: string };
    memory?: { vectorStore?: string; embeddingProvider?: string; autoRecall?: boolean };
    onboarding?: { profile?: { id?: string; label?: string } };
    agents?: Record<string, { userPath?: string }>;
  };
};
type J12UserFile = { exists?: boolean; bytes?: number; etag?: string; markdown?: string; tooLarge?: boolean; error?: string };
type J12Kinds = { enterprise?: { kind: string; name?: string; fields?: { name: string; label: string; planned?: boolean }[] }[] };

test('J12 settings parity: every setup choice has its Settings equivalent; the model, memory and About you changed from Settings', async ({}, testInfo) => {
  testInfo.setTimeout(20 * 60_000);
  const expectParity = process.env.UAT_EXPECT_SETTINGS_PARITY === '1';
  testInfo.annotations.push({ type: 'label', description: expectParity ? 'gated: UAT_EXPECT_SETTINGS_PARITY=1' : 'not gated' });
  await ensureSignedIn(page);
  const yourSetup = page.locator('section[aria-labelledby="ms-your-setup"]');

  // Is the feature here? Positive first: Settings rendered; only then does "no Your setup" mean something.
  await navigate(page, '/mindstone');
  const settingsShown = await appears(page.getByRole('heading', { name: 'MindStone settings' }), 30_000);
  const sectionPresent = settingsShown && (await appears(yourSetup, 10_000));
  const probe = await probeGatewayAdmin('/admin/user');
  await shot(page, testInfo, 'settings');
  note(testInfo, `Settings: ${settingsShown ? 'shown' : 'NOT shown'}; "Your setup" ${sectionPresent ? 'present' : 'absent'}; gateway GET /admin/user ${probe.status}`);
  const decision = j12Decision({ settingsShown, sectionPresent, expectParity, gatewayRoute: probe.status !== 404 });
  if (decision.verdict === 'pending') {
    test.fixme(
      true,
      `PENDING ${ISSUES.settingsParity}: ${decision.why}. Not gated (set UAT_EXPECT_SETTINGS_PARITY=1 to require it). ` +
        'Done when: Settings shows every guided-setup choice (Access, Provider, Model, Persona, Memory, Connectors, About you), each with a Change ' +
        'link into just that setup step or a control in place; the default model changed there is saved as routing.defaultModel, shown on Settings, ' +
        "and the next chat's Pi session calls it; a new embedding model is saved as memory.embeddingProvider, and the vectors already stored are " +
        're-embedded or the change warns first; USER.md edited on Settings persists after a reload and a save with a stale etag is refused; the ' +
        "enterprise endpoints' other sign-in options are shown disabled as not available yet, and the gateway refuses a value for one.",
    );
    return;
  }
  if (decision.verdict === 'fail') throw new Error(decision.why);

  // The real test. It needs finished setup (J2).
  requireSetupDone();
  const stamp = Date.now().toString(36);
  const marker = `j12-${stamp}`;
  const readConfig = async () => (await consoleApi<J12Config>(page, 'GET', '/api/mindstone/admin/config')).json;
  const readUser = () => consoleApi<J12UserFile>(page, 'GET', '/api/mindstone/admin/user');
  const patchConfig = async (section: string, body: Record<string, unknown>) => {
    const { etag } = await readConfig();
    const query = etag ? `?ifMatch=${encodeURIComponent(etag)}` : '';
    return consoleApi<{ error?: string }>(page, 'PATCH', `/api/mindstone/admin/config/${section}${query}`, body);
  };
  const startConfig = await readConfig();
  const startUser = await readUser();
  expect(startUser.status, `GET /api/mindstone/admin/user (${JSON.stringify(startUser.json).slice(0, 200)})`).toBe(200);
  const original = {
    routing: { ...(startConfig.config?.routing ?? {}) },
    memory: { ...(startConfig.config?.memory ?? {}) },
    user: { exists: startUser.json.exists === true, markdown: startUser.json.markdown ?? '', etag: startUser.json.etag ?? '' },
  };
  const proof: Record<string, unknown> = {
    marker,
    original: { routing: original.routing, memory: original.memory, user: { exists: original.user.exists, bytes: startUser.json.bytes } },
  };
  const saveProof = () => attachText(testInfo, 'evidence.json', JSON.stringify(proof, null, 2));
  /** Checks that fail but let the rest run (so one run shows every problem); J12 fails on them at the end. */
  const deferred: string[] = [];
  const statusText = async (p: Page) => ((await p.getByRole('status').allTextContents()).join(' | ') || '').trim();

  /**
   * Puts the given settings back as they were when J12 began, through the Console's admin API; only what
   * differs is written. Returns what it did, and whether everything now matches.
   */
  const putBack = async (parts: Array<'model' | 'memory' | 'user'>): Promise<{ ok: boolean; lines: string[] }> => {
    const lines: string[] = [];
    let ok = true;
    const now = (await readConfig()).config ?? {};
    if (parts.includes('model') && now.routing?.defaultModel !== original.routing.defaultModel) {
      const r = await patchConfig('routing', { defaultModel: original.routing.defaultModel });
      const back = (await readConfig()).config?.routing?.defaultModel;
      ok &&= r.status < 300 && back === original.routing.defaultModel;
      lines.push(`routing.defaultModel ${now.routing?.defaultModel} put back to ${original.routing.defaultModel}: HTTP ${r.status}, now ${back}`);
    }
    if (parts.includes('memory')) {
      const keys = (['vectorStore', 'embeddingProvider', 'autoRecall'] as const).filter(
        (key) => original.memory[key] !== undefined && now.memory?.[key] !== original.memory[key],
      );
      if (keys.length) {
        const r = await patchConfig('memory', Object.fromEntries(keys.map((key) => [key, original.memory[key]])));
        const back = (await readConfig()).config?.memory ?? {};
        const same = keys.every((key) => back[key] === original.memory[key]);
        ok &&= r.status < 300 && same;
        lines.push(`memory ${keys.map((key) => `${key} ${JSON.stringify(now.memory?.[key])}`).join(', ')} put back: HTTP ${r.status}, ${same ? 'as before' : `now ${JSON.stringify(back)}`}`);
      }
    }
    if (parts.includes('user') && !original.user.exists) {
      // There was no USER.md: the one J12 wrote goes (no admin route removes it, so the harness deletes the file).
      const current = await readUser();
      if (current.json.exists) {
        const agentId = now.routing?.defaultAgentId ?? 'default';
        const userPath = now.agents?.[agentId]?.userPath;
        const removed = userPath ? removeAgentUserFile(userPath) : undefined;
        const back = (await readUser()).json.exists;
        ok &&= Boolean(removed) && back === false;
        lines.push(`USER.md (none before J12) removed from the data dir: ${removed ?? `nothing removed (userPath ${userPath ?? 'unset'})`}; GET /admin/user now says ${back ? 'it EXISTS' : 'there is none'}`);
      }
    }
    if (parts.includes('user') && original.user.exists) {
      const current = await readUser();
      if (current.json.markdown !== original.user.markdown) {
        const r = await consoleApi(page, 'PATCH', `/api/mindstone/admin/user?ifMatch=${encodeURIComponent(current.json.etag ?? '')}`, { markdown: original.user.markdown });
        const back = (await readUser()).json.markdown;
        ok &&= r.status < 300 && back === original.user.markdown;
        lines.push(`USER.md put back (${Buffer.byteLength(original.user.markdown)} bytes): HTTP ${r.status}, ${back === original.user.markdown ? 'as before' : 'NOT as before'}`);
      }
    }
    return { ok, lines: lines.length ? lines : [`${parts.join(', ')}: as before, nothing to put back`] };
  };

  let completed = false;
  /** The error that ended the step early, if one did (the finally reports a failed restore next to it). */
  let failure: unknown;
  /** Parts this Console/Ollama couldn't exercise: J12 ends PENDING with them once everything else passed. */
  const pendingParts: string[] = [];
  /** Set once the embedding model was changed: the model the restore puts back, whose vectors the index must hold again. */
  let restoredModel: { spec: string; dims?: number } | undefined;
  /** The chat that ran under the restored memory setting, whose recall shows whether another model's chunks are left out. */
  let restoredChat: string | undefined;
  /** The index just before that chat, which its recall is judged against. */
  let restoredSnapshot: IndexVector[] | undefined;
  /**
   * The index check after the restore (A2): runs in the finally, after putBack, whenever an embedding change was about
   * to be saved. With no chat under the restored setting yet (something threw first), it runs one. Then it waits up to
   * J12_RESTORED_INDEX_WAIT_MS for every chunk to be the restored model's, or another model's that recall left out.
   */
  const checkRestoredIndex = async (model: { spec: string; dims?: number }): Promise<string[]> => {
    if (!restoredChat) {
      restoredSnapshot = (await settledIndexVectors(page)).chunks;
      await navigate(page, '/c/new');
      await ensureMindStoneModel(page, testInfo);
      const reply = await sendAndWaitForReply(page, J12_RESTORED_PROBE);
      restoredChat = reply.conversationId;
      if (reply.error || !reply.text.trim()) return [`the chat under the restored ${model.spec} did not answer (${reply.errorText ?? 'an empty reply'}): recall with it doesn't work`];
    }
    const started = Date.now();
    const read = () => {
      const index = recallIndexVectors();
      const recalled = recallHitsForConversation(restoredChat!, restoredSnapshot);
      return { index, recalled, otherLeft: otherModelCount(index.chunks, model), reasons: restoredIndexReasons({ ...model, present: index.present, chunks: index.chunks, recalled }) };
    };
    // Poll until the backfill after the restored chat has re-embedded everything (#140), or the wait ends; then judge.
    let now = read();
    while ((now.reasons.length || now.otherLeft > 0) && Date.now() - started < J12_RESTORED_INDEX_WAIT_MS) {
      await page.waitForTimeout(3_000);
      now = read();
    }
    const otherSize = now.index.chunks.filter((c) => c.dims !== null && c.dims !== model.dims);
    proof.restoredIndex = { model, chat: restoredChat, waitedMs: Date.now() - started, chunks: now.index.chunks.length, otherLeft: now.otherLeft, otherSize, recalled: now.recalled, reasons: now.reasons };
    return now.reasons;
  };
  try {
    await test.step('Access: advanced settings on, from the Advanced settings card on Settings', async () => {
      // J4's Start a chat turned them off and J7 turned them on; they last an hour. Saving on Settings needs them.
      await navigate(page, '/mindstone');
      const state = page.getByTestId('ms-advanced-state');
      await expect(state).toBeVisible({ timeout: 30_000 });
      const before = ((await state.textContent()) ?? '').trim();
      if (/^Off\b/.test(before)) {
        await page.locator('section[aria-labelledby="ms-advanced"]').getByLabel('Confirmation').fill(TYPED_PHRASE);
        await page.getByRole('button', { name: 'Turn on' }).click();
      }
      await expect(state).toHaveText(/^On\b/);
      proof.access = { before, after: ((await state.textContent()) ?? '').trim() };
      note(testInfo, `advanced settings: "${before}"${/^Off\b/.test(before) ? ', turned on with the phrase' : ''}`);
    });

    const rows: ParityRow[] = [];
    await test.step('the parity table: every guided-setup step has its Settings equivalent', async () => {
      await navigate(page, '/mindstone');
      await expect(yourSetup).toBeVisible({ timeout: 30_000 });
      const saved = (await readConfig()).config ?? {};
      // Access: the Advanced settings card, in place.
      const advanced = page.locator('section[aria-labelledby="ms-advanced"]');
      const accessShows = ((await page.getByTestId('ms-advanced-state').textContent()) ?? '').trim();
      rows.push({ step: 'Access', kind: 'in-place', shows: accessShows, control: (await advanced.getByRole('button', { name: /^Turn (on|off)$/ }).count()) === 1 });
      // Provider to Connectors: a row in "Your setup" (a display: contents element, so read, not "visible") and its Change link.
      for (const [step, change] of Object.entries(CHANGE_STEPS)) {
        const row = page.getByTestId(`ms-setup-${change}`);
        if ((await row.count()) !== 1) continue;
        const link = page.getByTestId(`ms-setup-${change}-change`);
        const href = (await link.count()) === 1 ? ((await link.getAttribute('href')) ?? undefined) : undefined;
        rows.push({ step, kind: href ? 'change' : 'none', shows: ((await row.textContent()) ?? '').replace(/\s+/g, ' ').trim(), href });
      }
      // Any other "Your setup" row is a choice setup doesn't have (parityReasons flags it).
      const known = new Set(Object.values(CHANGE_STEPS));
      const listed = await yourSetup.locator('[data-testid^="ms-setup-"]').evaluateAll((els) => els.map((el) => el.getAttribute('data-testid') ?? ''));
      for (const key of new Set(listed.filter((id) => !id.endsWith('-change')).map((id) => id.replace(/^ms-setup-/, '')))) {
        if (!known.has(key)) rows.push({ step: `unknown:${key}`, kind: 'none' });
      }
      // About you: USER.md, edited in place.
      const about = page.getByTestId('ms-about');
      if (await appears(about, 15_000)) {
        const editor = await appears(page.getByTestId('ms-about-text'), 15_000);
        rows.push({ step: 'About you', kind: 'in-place', shows: `USER.md, ${original.user.exists ? `${Buffer.byteLength(original.user.markdown)} bytes` : 'none yet'}`, control: editor && (await page.getByTestId('ms-about-save').count()) === 1 });
      }
      await shot(page, testInfo, 'your-setup');

      // Settings shows what is saved.
      const shows = (step: string) => rows.find((r) => r.step === step)?.shows ?? '';
      const want: Array<[string, string | undefined]> = [
        ['Model', saved.routing?.defaultModel],
        ['Persona', saved.onboarding?.profile?.label ?? saved.onboarding?.profile?.id],
        ['Memory', saved.memory?.embeddingProvider],
      ];
      for (const [step, value] of want) {
        if (value && rows.some((r) => r.step === step) && !shows(step).includes(value)) deferred.push(`Settings' ${step} row shows "${shows(step)}", not the saved ${value}`);
      }

      // Each Change link opens just its step: "Change your setup", that step's heading and no other step's, no step list, a way back.
      for (const row of rows.filter((r) => r.kind === 'change')) {
        const change = CHANGE_STEPS[row.step];
        await navigate(page, '/mindstone');
        await page.getByTestId(`ms-setup-${change}-change`).click();
        const url = await page.waitForURL(/\/mindstone\/onboarding\?/, { timeout: 30_000 }).then(() => page.url(), () => page.url());
        const opened = {
          url: url.endsWith(`/mindstone/onboarding?change=${change}&from=settings`),
          heading: await appears(page.getByRole('heading', { name: J12_STEP_HEADINGS[change] }), 30_000),
          noOtherStep: (
            await Promise.all(
              Object.entries(J12_STEP_HEADINGS)
                .filter(([other]) => other !== change)
                .map(([, name]) => page.getByRole('heading', { name }).count()),
            )
          ).every((n) => n === 0),
          title: await appears(page.getByRole('heading', { name: 'Change your setup', level: 1 }), 5_000),
          noStepList: (await page.getByRole('list', { name: 'Setup steps' }).count()) === 0,
          back: await appears(page.getByTestId('ms-onb-change-back'), 5_000),
        };
        row.opened = Object.values(opened).every(Boolean);
        if (!row.opened) row.openedWhy = Object.entries(opened).filter(([, v]) => !v).map(([k]) => `no ${k}`).join(', ');
        await shot(page, testInfo, `change-${change}`);
      }

      const table = [
        '| Setup step | Settings equivalent | Shows | Change link | Opens just that step |',
        '|---|---|---|---|---|',
        ...SETUP_STEPS.map((step) => {
          const row = rows.find((r) => r.step === step);
          if (!row) return `| ${step} | **none** | | | |`;
          const what = row.kind === 'in-place' ? IN_PLACE_STEPS[step] : row.kind === 'change' ? `"Your setup" row, Change link` : '"Your setup" row, no link';
          return `| ${step} | ${what} | ${(row.shows ?? '').replace(/\|/g, '\\|')} | ${row.href ? `\`${row.href}\`` : row.kind === 'in-place' ? `(in place: control ${row.control ? 'present' : 'MISSING'})` : '**none**'} | ${row.opened === undefined ? '' : row.opened ? 'yes' : `**no** (${row.openedWhy})`} |`;
        }),
      ].join('\n');
      await attachText(testInfo, 'parity-table.md', table);
      const reasons = parityReasons(rows);
      proof.parity = { rows, reasons };
      await saveProof();
      note(testInfo, `parity table: ${reasons.length ? `INCOMPLETE: ${reasons.join('; ')}` : `all ${SETUP_STEPS.length} setup steps have their Settings equivalent`}`);
      deferred.push(...reasons.map((r) => `parity: ${r}`));
    });

    let chosenModel = original.routing.defaultModel ?? '';
    let shownModel: string | undefined;
    await test.step('Model: changed through its Change link; Settings and config.routing.defaultModel agree', async () => {
      await navigate(page, '/mindstone');
      await page.getByTestId('ms-setup-model-change').click();
      const section = page.locator('section[aria-labelledby="ms-onb-model"]');
      const select = section.getByRole('combobox', { name: 'Choose the model' });
      await expect(select, 'the Model step opens').toBeVisible({ timeout: 30_000 });
      await expect(select, 'the Model step opens filled in with the saved model').toHaveValue(original.routing.defaultModel ?? '');
      const values = await select.locator('option').evaluateAll((options) => options.map((o) => (o as HTMLOptionElement).value).filter(Boolean));
      await attachText(testInfo, 'model-options.txt', values.join('\n'));
      // The other cloud model run-journey.sh found answering (UAT_ALT_MODEL), or, without one, the first other cloud model offered.
      const preferred = process.env.UAT_ALT_MODEL || undefined;
      const alternate = pickAlternateModel(values, original.routing.defaultModel, preferred);
      let modelPending: string | undefined;
      if (!alternate) {
        modelPending =
          preferred === 'none'
            ? `no cloud model other than ${original.routing.defaultModel} answered the harness's probe (logs/provider.log)`
            : `the Model step offers no ${preferred ? `${preferred} (UAT_ALT_MODEL)` : `cloud model other than ${original.routing.defaultModel}`} (it offers: ${values.join(', ') || 'nothing'})`;
        pendingParts.push(`the model part: ${modelPending}, so the chosen model is the one set up before`);
      }
      chosenModel = alternate ?? original.routing.defaultModel ?? '';
      expect(chosenModel, 'a model to choose').not.toBe('');
      await select.selectOption(chosenModel);
      await shot(page, testInfo, 'model-change');
      const saved = await uiResponse(page, { method: 'PATCH', path: '/api/mindstone/admin/config/routing' }, () =>
        section.getByRole('button', { name: 'Save', exact: true }).click(),
      );
      expect(saved.status, `Save: PATCH /api/mindstone/admin/config/routing (the page says: "${await statusText(page)}")`).toBeLessThan(300);
      await expect(page.getByRole('status').filter({ hasText: 'Saved.' }), 'the change says it saved').toBeVisible({ timeout: 15_000 });
      await expect(section, 'a change stays on its step').toBeVisible();
      await shot(page, testInfo, 'model-saved');
      await page.getByTestId('ms-onb-change-back').click();
      await expect(page).toHaveURL(/\/mindstone$/);
      const row = page.getByTestId('ms-setup-model');
      await expect(row, 'Settings shows the new default model').toContainText(chosenModel, { timeout: 30_000 });
      shownModel = ((await row.textContent()) ?? '').replace(/\s+/g, ' ').trim();
      await shot(page, testInfo, 'settings-after-model');
      const routing = (await readConfig()).config?.routing ?? {};
      proof.model = { from: original.routing.defaultModel, to: chosenModel, offered: values, shown: shownModel, saved: routing, pending: modelPending ?? null };
      await saveProof();
      note(testInfo, `default model ${original.routing.defaultModel} -> ${chosenModel}${modelPending ? ` (${modelPending})` : ''}; Settings shows "${shownModel}"; config.routing ${routing.mode} ${routing.defaultModel}`);
      expect(routing.defaultModel, 'config.routing.defaultModel is the model chosen on Settings').toBe(chosenModel);
      expect(routing.mode, 'routing.mode is still pi-session').toBe(original.routing.mode);
    });

    await test.step('Memory: the embedding model changed through its Change link; config.memory agrees; the stored vectors judged', async () => {
      const beforeSpec = original.memory.embeddingProvider ?? '';
      const [kind, ...rest] = beforeSpec.split(':');
      const beforeModel = rest.join(':');
      const indexBefore = recallIndexDims();
      const sizes = Object.keys(indexBefore.byDims);
      const chunksBefore = Object.values(indexBefore.byDims).reduce((sum, n) => sum + n, 0);
      const beforeDims = Number(readState().memoryCheck?.match(/(\d+) dimensions/)?.[1] ?? 0) || (sizes.length === 1 ? Number(sizes[0]) : undefined);
      await navigate(page, '/mindstone');
      await page.getByTestId('ms-setup-memory-change').click();
      const section = page.locator('section[aria-labelledby="ms-onb-memory"]');
      await expect(page.getByRole('heading', { name: 'Set up memory' }), 'the Memory step opens').toBeVisible({ timeout: 30_000 });
      const select = section.locator('select');
      const recall = section.getByRole('checkbox', { name: 'Recall memories automatically' });
      const check = page.getByTestId('ms-onb-memory-check');
      // Filled in with what is saved.
      expect(kind, `the saved embedding provider is Ollama's (${beforeSpec})`).toBe('ollama');
      await expect(section.getByRole('radio', { name: 'Ollama (local)' }), 'the saved provider is picked').toBeChecked();
      await expect(select, 'the saved embedding model is picked').toHaveValue(beforeModel);
      expect(await recall.isChecked(), 'automatic recall shows as saved').toBe(original.memory.autoRecall === true);
      /** The section's sentences as rendered (a line or a sentence each), the Test result included: the memory check reports memories another model embedded. */
      const sentences = async () =>
        (await section.innerText())
          .split(/\n+|(?<=[.!?])\s+/)
          .map((line) => line.replace(/\s+/g, ' ').trim())
          .filter(Boolean);
      const sentencesBefore = new Set(await sentences());
      const testButton = section.getByRole('button', { name: 'Test', exact: true });
      /**
       * Test, for the model picked now: the page's own check request, which must be for that model (so the size it
       * reports is the picked model's, not the saved one's), then its result once the step is no longer busy.
       */
      /** The last Test's own answer: how many memories another model embedded, by the gateway's count (#140). */
      let lastCheck: { otherModel?: number; embedded?: number } | undefined;
      const testEmbedding = async (spec: string): Promise<string> => {
        const isCheck = (url: string) => new URL(url).pathname === '/api/mindstone/admin/memory/check';
        const sent = page.waitForRequest((r) => r.method() === 'POST' && isCheck(r.url()), { timeout: J12_MEMORY_CHECK_MS });
        const answered = page.waitForResponse((r) => r.request().method() === 'POST' && isCheck(r.url()), { timeout: J12_MEMORY_CHECK_MS });
        sent.catch(() => undefined);
        answered.catch(() => undefined);
        await uiResponse(page, { method: 'POST', path: '/api/mindstone/admin/memory/check', timeoutMs: J12_MEMORY_CHECK_MS }, () => testButton.click());
        const checked = ((await sent).postDataJSON() as { embeddingProvider?: string } | null)?.embeddingProvider;
        expect(checked, `the Test checks the picked model (${spec})`).toBe(spec);
        const body = (await (await answered).json().catch(() => ({}))) as { index?: { otherModel?: unknown; embedded?: unknown } };
        lastCheck = {
          otherModel: typeof body.index?.otherModel === 'number' ? body.index.otherModel : undefined,
          embedded: typeof body.index?.embedded === 'number' ? body.index.embedded : undefined,
        };
        await expect(testButton, 'the Test finishes').toBeEnabled({ timeout: 15_000 });
        await expect(check, 'the Test shows its result').not.toHaveText(/^$/);
        return ((await check.textContent()) ?? '').trim();
      };
      /**
       * A pulled model that isn't loaded yet outlasts the gateway's 10 s embed timeout on its first Test ("This operation
       * was aborted"), and the abort cancels Ollama's load, so pressing Test again never gets it loaded. The first
       * result is kept (as the product's behaviour on a cold model, in the note and evidence); then the harness loads
       * the model through Ollama itself (warmOllamaEmbedModel, read-only) and presses Test again, at most twice.
       */
      const coldTests: { spec: string; first: string; warm: Awaited<ReturnType<typeof warmOllamaEmbedModel>> }[] = [];
      const testWithRetry = async (spec: string): Promise<string[]> => {
        const results = [await testEmbedding(spec)];
        if (J12_TEST_AGAIN.test(results[0]) && spec.startsWith('ollama:')) {
          const warm = await warmOllamaEmbedModel(spec.slice('ollama:'.length));
          coldTests.push({ spec, first: results[0], warm });
          while (J12_TEST_AGAIN.test(results[results.length - 1]) && results.length < 3) results.push(await testEmbedding(spec));
        }
        return results;
      };
      // Another embedding model: each other choice the step offers that Ollama has pulled (run-journey.sh lists them in
      // UAT_OLLAMA_EMBED_MODELS; without the list, every other choice), tested; the harness never downloads one. A pulled
      // model whose Test fails is the product's failure, not a missing model.
      const pulledList = (process.env.UAT_OLLAMA_EMBED_MODELS ?? '').split(/\s+/).filter(Boolean).map((m) => m.replace(/:latest$/, ''));
      const offered = (await select.locator('option').evaluateAll((o) => o.map((x) => (x as HTMLOptionElement).value))).filter((v) => v && v !== beforeModel && v !== 'custom');
      const others = pulledList.length ? offered.filter((v) => pulledList.includes(v)) : offered;
      const tried: { model: string; result: string }[] = [];
      let after: { spec: string; dims: number } | undefined;
      for (const candidate of others) {
        await select.selectOption(candidate);
        const results = await testWithRetry(`ollama:${candidate}`);
        const result = results[results.length - 1];
        tried.push({ model: candidate, result: results.join(' -> ') });
        const dims = Number(result.match(/Embedding works: (\d+) dimensions/)?.[1] ?? 0);
        if (dims > 0) {
          after = { spec: `ollama:${candidate}`, dims };
          break;
        }
        if (pulledList.length) deferred.push(`the memory step's Test failed for ${candidate}, which Ollama has pulled: "${results.join(' -> ')}"`);
      }
      let safeField: string | undefined;
      if (!after) {
        // Only one embedding model is pulled: change a safe memory field instead (automatic recall), with the saved model.
        await select.selectOption(beforeModel);
        const results = await testWithRetry(beforeSpec);
        const result = results[results.length - 1];
        tried.push({ model: beforeModel, result: results.join(' -> ') });
        expect(result, `the saved embedding model still works (${beforeSpec})`).toMatch(/Embedding works: \d+ dimensions/);
        await recall.setChecked(!(original.memory.autoRecall === true));
        safeField = `autoRecall ${original.memory.autoRecall === true ? 'on -> off' : 'off -> on'}`;
      }
      // A warning is the product's own words about the memories another model embedded, on the step before Save
      // (the Test result included), and new since the step opened with the saved model.
      // #140's own warning is ms-onb-memory-reembed ("N memories were embedded by another model…", N the check's
      // index.otherModel); another product's words on the step count too.
      const reembed = section.getByTestId('ms-onb-memory-reembed');
      const reembedText = (await reembed.count()) ? ((await reembed.textContent()) ?? '').replace(/\s+/g, ' ').trim() : '';
      const warned =
        reembedText ||
        (await sentences())
          .filter((sentence) => EMBEDDING_WARNING.test(sentence) && !sentencesBefore.has(sentence))
          .join(' ') ||
        undefined;
      const reported = after ? lastCheck?.otherModel : undefined;
      await shot(page, testInfo, 'memory-change');
      // From here on the index may hold another model's vectors: the finally checks it after the restore, whatever
      // throws from now on (set before the Save, so no failure after it can skip the check).
      if (after) restoredModel = { spec: beforeSpec, dims: beforeDims };
      const saved = await uiResponse(page, { method: 'PATCH', path: '/api/mindstone/admin/config/memory' }, () =>
        section.getByRole('button', { name: 'Save', exact: true }).click(),
      );
      const said = await statusText(page);
      expect(saved.status, `Save: PATCH /api/mindstone/admin/config/memory (the page says: "${said}")`).toBeLessThan(300);
      await expect(page.getByRole('status').filter({ hasText: 'Saved.' }), 'the change says it saved').toBeVisible({ timeout: 15_000 });
      await shot(page, testInfo, 'memory-saved');
      await page.getByTestId('ms-onb-change-back').click();
      await expect(page).toHaveURL(/\/mindstone$/);
      const memoryRow = page.getByTestId('ms-setup-memory');
      const memory = (await readConfig()).config?.memory ?? {};
      proof.memory = { before: { spec: beforeSpec, dims: beforeDims ?? null, chunks: chunksBefore }, after: after ?? null, safeField: safeField ?? null, tried, coldTests, warned: warned ?? null, check: lastCheck ?? null, saved: memory, indexBefore };
      for (const cold of coldTests) {
        // R2: a product finding (MindStone-Agent #147), in the summary's findings and SUMMARY.md, not only a note.
        recordFinding(COLD_MODEL_FINDING.id, COLD_MODEL_FINDING.text(cold.spec, cold.first));
        note(
          testInfo,
          `FINDING ${COLD_MODEL_FINDING.id} (${COLD_MODEL_FINDING.issue}): the memory step's Test for ${cold.spec} first said "${cold.first}"; ` +
            `the harness loaded the model through Ollama (${cold.warm.ok ? `in ${Math.round(cold.warm.ms / 1000)} s` : `failed: ${cold.warm.error}`}) and pressed Test again`,
        );
      }
      await saveProof();
      if (!after) {
        const why = others.length
          ? `no other embedding model works (tried ${tried.map((t) => `${t.model}: "${t.result}"`).join('; ')})`
          : `no other embedding model the step offers is pulled (offered: ${offered.join(', ') || 'none'}; pulled: ${pulledList.join(', ') || 'not listed'})`;
        note(testInfo, `memory: ${why}, so a safe field was changed instead: ${safeField}`);
        pendingParts.push(`the embedding-model part: ${why}, so the warning before Save and recall after the change could not be exercised; automatic recall was changed instead`);
        await expect(memoryRow, 'Settings shows the new automatic-recall setting').toContainText(`automatic recall ${original.memory.autoRecall === true ? 'off' : 'on'}`, { timeout: 30_000 });
        await shot(page, testInfo, 'settings-after-memory');
        expect(memory.autoRecall, 'config.memory.autoRecall is what was chosen on Settings').toBe(!(original.memory.autoRecall === true));
        expect(memory.embeddingProvider, 'config.memory.embeddingProvider is unchanged').toBe(beforeSpec);
        return;
      }
      await expect(memoryRow, 'Settings shows the new embedding model').toContainText(after.spec, { timeout: 30_000 });
      await shot(page, testInfo, 'settings-after-memory');
      expect(memory.embeddingProvider, 'config.memory.embeddingProvider is the model chosen on Settings').toBe(after.spec);
      expect(memory.vectorStore, 'config.memory.vectorStore is unchanged').toBe(original.memory.vectorStore);
      expect(memory.autoRecall, 'config.memory.autoRecall is unchanged').toBe(original.memory.autoRecall);

      // Recall after the change, proven positively (#140): a fact told in one chat is captured by the new model, and a
      // fresh chat asks for it. Both chats must answer (a failed or empty chat is a FAIL, never clean evidence); the
      // fact's chunks must be the new model's, and no chunk recall supplies may be another model's (vectorOf): J9's
      // older facts, embedded by the old model, are in the index to be scored if the product doesn't leave them out.
      let probe: { error: boolean; errorText?: string; text: string; fact: IndexVector[]; hits: IndexVector[]; snapshotOther?: number } | undefined;
      if (memory.autoRecall === true) {
        const token = `${['quince', 'sorrel', 'tamarack', 'wren'][Date.now() % 4]}-${Date.now().toString(36)}`;
        const failed = (reply: Reply) => reply.error || !reply.text.trim() || ERROR_REPLY.test(reply.text);
        await navigate(page, '/c/new');
        await ensureMindStoneModel(page, testInfo);
        const told = await sendAndWaitForReply(page, `My cat is called ${token}. Please remember it.`);
        await attachText(testInfo, 'recall-after-change-told.txt', replyLog(told));
        const captured = failed(told) ? { chunks: [], waitedMs: 0 } : await waitForEmbeddedChunk(page, token, RECALL_CAPTURE_WAIT_MS);
        let fact = recallIndexVectors(captured.chunks.map((c) => c.chunkId)).chunks;
        let asked: Reply | undefined;
        let snapshot: Awaited<ReturnType<typeof settledIndexVectors>> | undefined;
        if (!failed(told)) {
          // The index as recall will score it: once the told turn's background indexing is done, just before asking.
          snapshot = await settledIndexVectors(page);
          await navigate(page, '/c/new');
          await ensureMindStoneModel(page, testInfo);
          asked = await sendAndWaitForReply(page, J12_RECALL_PROBE);
          await shot(page, testInfo, 'recall-after-change');
          await attachText(testInfo, 'recall-after-change.txt', replyLog(asked));
        }
        const bad = failed(told) ? told : asked && failed(asked) ? asked : undefined;
        probe = {
          error: Boolean(bad && (bad.error || ERROR_REPLY.test(bad.text))),
          errorText: bad ? (bad.errorText ?? bad.text.slice(0, 200)) : undefined,
          text: bad ? bad.text : (asked?.text ?? ''),
          fact,
          hits: asked ? recallHitsForConversation(asked.conversationId, snapshot?.chunks) : [],
        };
        // The fact's chunks as they were when recall scored them.
        if (snapshot) fact = fact.map((chunk) => snapshot!.chunks.find((c) => c.chunkId === chunk.chunkId) ?? chunk);
        probe.fact = fact;
        // How many chunks of another model recall could have scored (R3): with none, the cross-model rule isn't exercised.
        if (snapshot) probe.snapshotOther = otherModelCount(snapshot.chunks, after);
        proof.memory = {
          ...(proof.memory as object),
          recallProbe: {
            token,
            told: told.conversationId,
            asked: asked?.conversationId ?? null,
            capturedAfterMs: captured.waitedMs,
            snapshot: snapshot ? { chunks: snapshot.chunks.length, otherModel: probe.snapshotOther ?? null, settled: snapshot.settled, waitedMs: snapshot.waitedMs } : null,
            fact,
            hits: probe.hits,
            error: probe.error,
            errorText: probe.errorText ?? null,
          },
        };
      }
      // The per-turn backfill after those chats re-embeds every chunk from another model (#140): poll the index-clean
      // count (embedded chunks that aren't the new model's) until it reaches 0.
      let reembedded: { otherLeft: number; waitedMs: number } | undefined;
      if (probe) {
        const started = Date.now();
        let left = otherModelCount(recallIndexVectors().chunks, after);
        while (left > 0 && Date.now() - started < J12_REEMBED_WAIT_MS) {
          await page.waitForTimeout(3_000);
          left = otherModelCount(recallIndexVectors().chunks, after);
        }
        reembedded = { otherLeft: left, waitedMs: Date.now() - started };
        proof.memory = { ...(proof.memory as object), reembedded };
      }
      const index = recallIndexDims();
      const verdict = memoryChangeVerdict({ before: { spec: beforeSpec, dims: beforeDims, chunks: chunksBefore }, after, warned, reported, index, probe, reembedded });
      proof.memory = { ...(proof.memory as object), indexAfter: index, verdict };
      await saveProof();
      note(
        testInfo,
        `embedding ${beforeSpec} (${beforeDims ?? '?'} dims, ${chunksBefore} chunks embedded) -> ${after.spec} (${after.dims} dims); the check's index.otherModel ${reported ?? 'not reported'}; warning before Save: ${warned ? `"${warned}"` : 'none'}; ` +
          `recall after the change: ${probe ? `${probe.error || !probe.text.trim() ? 'a chat FAILED; ' : ''}the fact in ${probe.fact.length} chunk(s); ${probe.hits.length} chunk(s) recalled ${JSON.stringify(probe.hits.map((h) => [h.dims, h.model, h.recallMode ?? null]))}` : 'not run (automatic recall off)'}; ` +
          `recall index before ${JSON.stringify(indexBefore.byDims)}, after ${JSON.stringify(index.byDims)} (${index.pending} pending); ${verdict.why}`,
      );
      if (verdict.verdict === 'fail') deferred.push(verdict.why);
      if (verdict.verdict === 'pending') pendingParts.push(`the embedding-model part: ${verdict.unproven.join('; ')}`);
      for (const text of verdict.notExercised) note(testInfo, `NOT EXERCISED: ${text}`);
    });
    // Put the memory setting back at once: no later chat embeds with the changed model, and J10 recalls with the original.
    // The finally checks the index the restore left (restoredIndexReasons), after the chat below runs under it.
    const memoryBack = await putBack(['memory']);
    note(testInfo, `memory put back right after it was judged: ${memoryBack.lines.join('; ')}`);
    if (!memoryBack.ok) deferred.push(`the memory setting could not be put back: ${memoryBack.lines.join('; ')}`);

    await test.step('About you: USER.md edited and saved on Settings, kept after a reload; a save with a stale etag is refused', async () => {
      const text = page.getByTestId('ms-about-text');
      await navigate(page, '/mindstone');
      await expect(text, "Settings shows the agent's USER.md as saved").toHaveValue(original.user.markdown, { timeout: 30_000 });
      const edited = `${original.user.markdown.trimEnd()}\n\n- Settings check ${marker}: the owner edited this line on Settings.\n`;
      // A second tab reads the file before the save: its own save later carries the old etag.
      const tab = await context.newPage();
      try {
        await navigate(tab, '/mindstone');
        await expect(tab.getByTestId('ms-about-text')).toHaveValue(original.user.markdown, { timeout: 30_000 });

        await text.fill(edited);
        const saved = await uiResponse(page, { method: 'PATCH', path: '/api/mindstone/admin/user' }, () => page.getByTestId('ms-about-save').click());
        const said = ((await page.getByTestId('ms-about-status').textContent().catch(() => '')) ?? '').trim();
        expect(saved.status, `Save: PATCH /api/mindstone/admin/user (the page says: "${said}")`).toBeLessThan(300);
        await expect(page.getByTestId('ms-about-status')).toHaveText('Saved. Your next chat uses it.');
        await shot(page, testInfo, 'about-saved');

        await navigate(page, '/mindstone');
        await expect(text, 'after a reload, Settings shows the saved USER.md').toHaveValue(edited, { timeout: 30_000 });
        await shot(page, testInfo, 'about-reloaded');
        const reread = await readUser();
        expect(reread.json.markdown, 'GET /admin/user returns the saved text').toBe(edited);
        expect(reread.json.etag, 'the etag changed with the file').not.toBe(original.user.etag);
        const files = promptFilesWith(marker);
        expect(files.found.filter((f) => f.endsWith('USER.md')), "the agent's USER.md on disk holds the line (it goes into every prompt)").not.toEqual([]);

        // The tab that read the file before the save: its save is refused, its text kept, and saving stays off until it reloads.
        const stale = `${original.user.markdown.trimEnd()}\n\n- Stale edit ${marker}: this must never be saved.\n`;
        await tab.getByTestId('ms-about-text').fill(stale);
        const refused = await uiResponse(tab, { method: 'PATCH', path: '/api/mindstone/admin/user' }, () => tab.getByTestId('ms-about-save').click());
        expect(refused.status, 'a save with the etag read before the other save is refused (412)').toBe(412);
        await expect(tab.getByTestId('ms-about-status'), 'the page says the file changed').toContainText('changed since this page loaded it');
        await expect(tab.getByTestId('ms-about-save'), 'saving stays off until the current file is loaded').toBeDisabled();
        await expect(tab.getByTestId('ms-about-text'), 'the typed text is kept').toHaveValue(stale);
        await shot(tab, testInfo, 'about-stale');
        expect((await readUser()).json.markdown, 'the stale save did not overwrite USER.md').toBe(edited);
        // "Load the current file" keeps the typed text and shows the file as it is now beside it (#140 review); "Use the
        // current file instead" then takes it.
        await tab.getByTestId('ms-about-reload').click();
        await expect(tab.getByTestId('ms-about-current'), '"Load the current file" shows the file as it is now').toContainText(`Settings check ${marker}`);
        await expect(tab.getByTestId('ms-about-text'), 'the typed text is still kept').toHaveValue(stale);
        await tab.getByTestId('ms-about-use-current').click();
        await expect(tab.getByTestId('ms-about-text'), '"Use the current file instead" puts the saved text in the editor').toHaveValue(edited);
      } finally {
        await tab.close();
      }
      // The gateway's own guard, through the Console's proxy: an old etag is refused, and so is no etag at all.
      const oldEtag = await consoleApi<{ error?: string }>(page, 'PATCH', `/api/mindstone/admin/user?ifMatch=${encodeURIComponent(original.user.etag)}`, { markdown: `${edited}x` });
      const noEtag = await consoleApi<{ error?: string }>(page, 'PATCH', '/api/mindstone/admin/user', { markdown: `${edited}x` });
      proof.about = { bytesBefore: Buffer.byteLength(original.user.markdown), bytesAfter: Buffer.byteLength(edited), line: `Settings check ${marker}`, oldEtag: [oldEtag.status, oldEtag.json?.error], noEtag: [noEtag.status, noEtag.json?.error] };
      await saveProof();
      note(testInfo, `USER.md: saved on Settings and kept after a reload; the stale tab's save refused (412, text kept); PATCH with the old etag ${oldEtag.status}, with none ${noEtag.status}`);
      expect(oldEtag.status, `PATCH /admin/user with the etag read before the save (${oldEtag.json?.error ?? ''})`).toBe(412);
      expect(noEtag.status, `PATCH /admin/user with no etag (${noEtag.json?.error ?? ''})`).toBe(428);
      expect((await readUser()).json.markdown, 'neither refused write changed USER.md').toBe(edited);
    });

    await test.step('enterprise sign-in placeholders: listed, marked not available, disabled, and refused by the gateway', async () => {
      const kinds = (await consoleApi<J12Kinds>(page, 'GET', '/api/mindstone/admin/models')).json.enterprise ?? [];
      const wanted = kinds.map((k) => ({ kind: k.kind, planned: (k.fields ?? []).filter((f) => f.planned).map((f) => f.label) }));
      await navigate(page, '/mindstone/providers');
      const ent = page.locator('section[aria-labelledby="ms-prov-enterprise"]');
      await expect(ent, 'the Model providers page lists the enterprise endpoints').toBeVisible({ timeout: 30_000 });
      const seen: Record<string, { label: string; marked: boolean; disabled: boolean; editable: boolean }[]> = {};
      const reasons: string[] = [];
      for (const { kind, planned } of wanted) {
        await ent.locator(`input[name="ms-prov-kind"][value="${kind}"]`).check();
        const form = page.getByTestId(`ms-ent-form-${kind}`);
        await expect(form, `the ${kind} form opens`).toBeVisible();
        const fieldset = page.getByTestId(`ms-ent-planned-${kind}`);
        const shown = (await fieldset.count()) === 1;
        seen[kind] = [];
        if (shown) {
          for (const label of await fieldset.locator('label').all()) {
            const input = label.locator('input');
            seen[kind].push({
              label: ((await label.locator('span').first().textContent()) ?? '').replace(/\s+/g, ' ').trim(),
              marked: (await label.getByText('Not available yet', { exact: true }).count()) === 1,
              disabled: await input.isDisabled(),
              editable: await input.isEditable(),
            });
          }
          await shot(page, testInfo, `enterprise-${kind}`);
        }
        // Not a sign-in choice either: the form's own "Sign in with" options never offer one.
        const choices = (await form.locator('fieldset:not([data-testid]) label').allTextContents()).map((s) => s.trim());
        for (const label of planned) {
          const field = seen[kind].find((f) => f.label.startsWith(label));
          if (!field) reasons.push(`${kind}: "${label}" (planned, per the gateway) is not shown under "Other sign-in options"`);
          else if (!field.marked || !field.disabled || field.editable) reasons.push(`${kind}: "${label}" is ${[!field.marked && 'not marked "Not available yet"', !field.disabled && 'not disabled', field.editable && 'editable'].filter(Boolean).join(', ')}`);
          if (choices.some((c) => c.startsWith(label))) reasons.push(`${kind}: "${label}" is offered as a sign-in choice`);
        }
        const extra = seen[kind].filter((f) => !planned.some((label) => f.label.startsWith(label)));
        if (extra.length) reasons.push(`${kind}: shown as planned but not planned by the gateway: ${extra.map((f) => f.label).join(', ')}`);
      }
      // #140's placeholders, by kind (when the gateway lists the kind): Entra ID for Azure, a role or access keys for Bedrock,
      // workload identity for Vertex.
      for (const [kind, label] of [['azure-openai', /Entra/i], ['bedrock', /role|access key/i], ['vertex', /workload identity/i]] as const) {
        const listedKind = wanted.find((k) => k.kind === kind);
        if (listedKind && !listedKind.planned.some((l) => label.test(l))) reasons.push(`${kind} has no planned ${label.source} sign-in option (planned: ${listedKind.planned.join(', ') || 'none'})`);
      }
      if (!wanted.some((k) => k.kind === 'azure-openai')) reasons.push('the gateway lists no azure-openai enterprise kind');
      // Model providers also adds a local provider through setup's own step (#140).
      const addLocal = await page.getByTestId('ms-prov-add-local').getAttribute('href').catch(() => null);
      if (addLocal !== '/mindstone/onboarding?change=provider&from=providers') reasons.push(`Model providers' "Add a local provider" goes to ${JSON.stringify(addLocal)}, not /mindstone/onboarding?change=provider&from=providers`);
      // The request the page never sends: a value for a planned field, which the gateway must refuse before anything is saved.
      const refused = await consoleApi<{ error?: string }>(page, 'POST', '/api/mindstone/admin/providers/enterprise/azure-openai', { entraIdentity: `uat-${marker}` });
      proof.enterprise = { wanted, seen, refused: [refused.status, refused.json?.error], reasons };
      await saveProof();
      note(testInfo, `enterprise placeholders: ${wanted.map((k) => `${k.kind}: ${k.planned.join(', ') || 'none'}`).join('; ')}; a value for one: HTTP ${refused.status} "${refused.json?.error ?? ''}"`);
      expect(reasons, 'every planned sign-in option is shown, marked "Not available yet", disabled and not a sign-in choice').toEqual([]);
      expect(refused.status, 'the gateway refuses a value for a planned sign-in option').toBe(400);
      expect(refused.json?.error ?? '', "and says it isn't available").toMatch(/isn't available yet/);
    });

    await test.step('one chat after the changes: answered, on the model chosen on Settings', async () => {
      await navigate(page, '/c/new');
      await ensureMindStoneModel(page, testInfo);
      // Under the restored memory setting: the fact the chat after the embedding change told is the chunk most tempting
      // to recall from another model, so asking for it is the restore check's evidence too (the finally judges it).
      const snapshot = restoredModel ? (await settledIndexVectors(page)).chunks : undefined;
      const reply = await sendAndWaitForReply(page, J12_RESTORED_PROBE);
      if (restoredModel) {
        restoredChat = reply.conversationId;
        restoredSnapshot = snapshot;
      }
      await attachText(testInfo, 'reply.txt', replyLog(reply));
      await shot(page, testInfo, 'chat');
      await gatewayExcerpt(testInfo, 40);
      const answered = answeredInConversation(reply.conversationId);
      const saved = (await readConfig()).config?.routing?.defaultModel;
      const reasons = modelMatchReasons({ chosen: chosenModel, saved, shown: shownModel, answered });
      proof.chat = { conversationId: reply.conversationId, chosen: chosenModel, saved, answered: answered ?? null, reasons };
      await saveProof();
      note(testInfo, `chat ${reply.conversationId}: "${reply.text.slice(0, 100)}"; the Pi session called ${answered?.provider ?? '?'}/${answered?.model ?? '?'}${answered?.modelFallbackMessage ? ` (fallback: ${answered.modelFallbackMessage})` : ''}`);
      expectAnswer(reply, 'the chat after the Settings changes');
      if (PROVIDER === 'mock') {
        testInfo.annotations.push({ type: 'mock', description: 'mock provider' }, { type: 'label', description: 'MOCK' });
        return;
      }
      expect(reasons, `the chat ran on the model chosen on Settings (${chosenModel}): the saved route, the Settings row and the Pi session agree`).toEqual([]);
    });

    expect(deferred, 'J12 checks that failed along the way (each is in the notes and logs/j12-evidence.json)').toEqual([]);
    completed = true;
    if (pendingParts.length) {
      test.fixme(
        true,
        `PENDING ${ISSUES.settingsParity}: everything else passed, but ${pendingParts.join('; ')}. ` +
          'Done when: with a second cloud model that answers, the chat after the change runs on it; with a second embedding model pulled, the ' +
          'memory step warns about the memories the old model embedded before Save, and recall after the change scores none of them.',
      );
    }
  } catch (error) {
    failure = error;
    throw error;
  } finally {
    // Whatever happened above: the default model, the memory setting and USER.md go back to what they were (USER.md
    // absent when there was none), for J10, J11 and later runs; then, once an embedding change was about to be saved,
    // the recall index must be usable by the restored model.
    const settings = await putBack(['model', 'memory', 'user']).catch((error: Error) => ({ ok: false, lines: [`the settings could not be put back: ${error.message}`] }));
    let index: { required: boolean; ran: boolean; reasons?: string[]; why?: string } = { required: false, ran: false };
    if (restoredModel) {
      const model = restoredModel;
      index = await checkRestoredIndex(model)
        .then((reasons) => ({ required: true, ran: true, reasons }))
        .catch((error: Error) => ({ required: true, ran: false, why: error.message.split('\n')[0] }));
    }
    const restored = restoreOutcome({ settings, index });
    note(testInfo, `put back in the finally: ${restored.lines.join('; ')}`);
    proof.restore = restored;
    await saveProof().catch(() => undefined);
    if (!restored.ok) {
      // Always a restore failure, whatever J12's own verdict: the gate and the DEMO SUBSET fail on it even when J12
      // isn't counted (restore-failures.tsv), and a J12 that failed already keeps its own error, with this one added.
      recordRestoreFailure('J12', restored.failures.join('; '));
      const what = `J12 could not put things back: ${restored.failures.join('; ')}`;
      if (completed) throw new Error(what);
      throw new Error(`${failure instanceof Error ? failure.message : String(failure)} | AND ${what}`);
    }
  }
});

/**
 * J10's private-KB fact, asked in words no other step uses (J6 plants a project codename, J9 a dog's name),
 * so no other memory can answer it.
 */
const J10_ASK = 'What is the harbour lighthouse call sign? Answer with just the call sign.';
/** How long J10 waits for the page's Ingest to answer: the Console's proxy gives a private-KB ingest 4 minutes (#125). */
const J10_INGEST_TIMEOUT_MS = 270_000;

type PersonaList = { active?: string | null; personas?: { id: string; name: string; description?: string; error?: string }[] };
type LoadedPersona = {
  persona?: {
    description?: string;
    skills?: string[];
    knowledgebases?: string[];
    privateKnowledgebases?: { id: string; indexed?: boolean; entryCount?: number }[];
    active?: boolean;
  };
};

test('J10 persona builder in the Console: a skill and a private KB, saved not active, recalled only under its persona, edited', async ({}, testInfo) => {
  testInfo.setTimeout(20 * 60_000);
  const expectBuilder = process.env.UAT_EXPECT_PERSONA_BUILDER === '1';
  testInfo.annotations.push({ type: 'label', description: expectBuilder ? 'gated: UAT_EXPECT_PERSONA_BUILDER=1' : 'not gated' });
  await ensureSignedIn(page);
  const listPersonas = async () => (await consoleApi<PersonaList>(page, 'GET', '/api/mindstone/admin/personas')).json;
  const row = (id: string) => page.getByTestId(`ms-persona-${id}`);

  // Is the feature here? Positive first: the Personas page rendered its list; only then does "no Build a persona" mean something.
  await navigate(page, '/mindstone/personas');
  const listed = await consoleApi<PersonaList>(page, 'GET', '/api/mindstone/admin/personas');
  const listShown = listed.status === 200 && (await appears(page.locator('section[aria-labelledby="ms-per-list"]'), 30_000));
  const createOffered = listShown && (await appears(page.getByTestId('ms-persona-create'), 10_000));
  const probe = await probeGatewayAdmin('/admin/knowledgebases');
  await shot(page, testInfo, 'personas');
  note(testInfo, `Personas page: list ${listShown ? 'shown' : 'not shown'} (GET personas ${listed.status}); "Build a persona" ${createOffered ? 'offered' : 'absent'}; gateway GET /admin/knowledgebases ${probe.status}`);
  const decision = j10Decision({ listShown, createOffered, expectPersonaBuilder: expectBuilder, gatewayRoutes: probe.status === 200 });
  if (decision.verdict === 'pending') {
    test.fixme(
      true,
      `PENDING ${ISSUES.personaBuilder}: ${decision.why}. Not gated (set UAT_EXPECT_PERSONA_BUILDER=1 to require it). ` +
        'Done when: "Build a persona" on the Personas page builds persona A with an installed skill and a private knowledge base whose text source ' +
        "holds a per-run fact, ingested; saving leaves the active persona unchanged; under another persona a fresh chat's recall has no pkb:<A>: hit " +
        "and no fact; with A made active, a fresh chat's reply holds the fact, and its gateway transcript shows persona A answered, a pkb:<A>:<kb>: hit " +
        "in the reply's own run, and only the picked skill in A's prompt; an edit to A persists after a reload.",
    );
    return;
  }
  if (decision.verdict === 'fail') throw new Error(decision.why);

  // The real test. It needs finished setup (J2), automatic recall (a private KB is searched by recall) and an installed skill (J7).
  requireSetupDone();
  const config = await consoleApi<{ config?: { memory?: { autoRecall?: boolean } } }>(page, 'GET', '/api/mindstone/admin/config');
  if (config.json.config?.memory?.autoRecall !== true) {
    throw new Error('blocked: memory.autoRecall is not on, so no turn runs recall and a private KB is never searched (J9 judges that setting); J10 was not judged');
  }
  const skillList = await consoleApi<{ skills?: { id: string; source: string; error?: string }[] }>(page, 'GET', '/api/mindstone/admin/skills');
  const installed = (skillList.json.skills ?? []).filter((s) => s.source === 'installed' && !s.error).map((s) => s.id).sort();
  if (!installed.length) throw new Error('blocked: no installed skill to pick (J7 installs two); J10 was not judged');
  const picked = installed[0];
  const globals = await consoleApi<{ knowledgebases?: { id: string; error?: string }[] }>(page, 'GET', '/api/mindstone/admin/knowledgebases');
  expect(globals.status, 'GET /api/mindstone/admin/knowledgebases (the editor lists global collections from it)').toBe(200);
  const globalKb = (globals.json.knowledgebases ?? []).find((kb) => !kb.error)?.id;
  const activeBefore = (await listPersonas()).active ?? null;
  note(
    testInfo,
    `installed skills: ${installed.join(', ')} (picked ${picked}); global KBs: ${globalKb ?? 'none on this install, so none attached'}; active persona before: ${activeBefore ?? 'none'}`,
  );

  // Fresh ids and a fact token only this run uses, so nothing earlier can match. The token shares nothing with the
  // ids (its own random part), so an id in a transcript entry can't read as the fact.
  const stamp = Date.now().toString(36);
  const A = `j10-a-${stamp}`;
  const B = `j10-b-${stamp}`;
  const KB = `j10-facts-${stamp}`;
  const token = `${['lumen', 'corvid', 'tallow', 'quill'][Date.now() % 4]}-${Math.random().toString(36).slice(2, 8).padEnd(6, '7')}`;
  const descA = 'Built by the journey test: one skill and a private knowledge base.';
  const proof: Record<string, unknown> = { A, B, KB, token, picked, installed, globalKb: globalKb ?? null, activeBefore };
  const saveProof = () => attachText(testInfo, 'evidence.json', JSON.stringify(proof, null, 2));
  const editor = page.getByTestId('ms-persona-editor');

  /** "Build a persona": the text, the picked skill, a global KB; Save. Leaves the editor open on the saved persona. */
  const build = async (id: string, name: string, description: string, opts: { skill?: string; globalKb?: string } = {}) => {
    await navigate(page, '/mindstone/personas');
    await page.getByTestId('ms-persona-create').click();
    await expect(editor, 'the persona editor opens').toBeVisible({ timeout: 30_000 });
    await editor.getByTestId('ms-pe-id').fill(id);
    await editor.getByTestId('ms-pe-name').fill(name);
    await editor.getByTestId('ms-pe-description').fill(description);
    await editor.getByTestId('ms-pe-markdown').fill(`# ${name}\n\nYou are ${name}, a persona built in the journey test. Answer briefly and plainly.`);
    if (opts.skill) {
      const picker = editor.getByTestId('ms-skill-picker');
      await picker.getByRole('combobox', { name: 'Add an installed skill' }).selectOption(opts.skill);
      await picker.getByRole('button', { name: 'Add', exact: true }).click();
      await expect(picker.getByTestId(`ms-skill-picker-selected-${opts.skill}`), `the picker lists ${opts.skill}`).toBeVisible();
    }
    if (opts.globalKb) await editor.getByTestId(`ms-pe-global-kb-${opts.globalKb}`).check();
    const saved = await uiResponse(page, { method: 'POST', path: '/api/mindstone/admin/personas' }, () => editor.getByTestId('ms-pe-save').click());
    const status = editor.getByRole('status').filter({ hasText: `Saved ${id}.` });
    const shown = await appears(status, 15_000);
    const said = ((await editor.getByRole('status').allTextContents()).join(' | ') || '').trim();
    expect(saved.status, `POST /api/mindstone/admin/personas for ${id} (the editor says: "${said}")`).toBeLessThan(300);
    expect(shown, `the editor says ${id} was saved (it says: "${said}")`).toBe(true);
    await expect(status, 'the save says it is not active').toContainText("It isn't active");
  };

  /**
   * The active persona as it was before J10 (activeBefore), put back through the Console's admin API. Run in a
   * finally: a failure after a Make active must not leave A or B active for J11 (lib/persona-builder-evidence.js
   * personaRestore decides what to do, self-tested).
   */
  const restoreActivePersona = async (): Promise<{ ok: boolean; text: string }> => {
    const listed = await listPersonas();
    const plan = personaRestore({ before: activeBefore, now: listed.active ?? null, known: (listed.personas ?? []).map((p) => p.id) });
    if (plan.action === 'none') return { ok: true, text: `active persona: ${activeBefore ?? 'none'}, as before J10` };
    const config = await consoleApi<{ etag?: string }>(page, 'GET', '/api/mindstone/admin/config');
    const query = config.json.etag ? `?ifMatch=${encodeURIComponent(config.json.etag)}` : '';
    const patched = await consoleApi(page, 'PATCH', `/api/mindstone/admin/config/personas${query}`, { active: plan.active });
    const now = (await listPersonas()).active ?? null;
    const ok = patched.status < 300 && now === plan.active;
    return {
      ok,
      text: `active persona ${listed.active ?? 'none'} put back to ${plan.active ?? 'none'} (${plan.why}) in the finally: PATCH config/personas HTTP ${patched.status}; now ${now ?? 'none'}${ok ? '' : ': NOT restored'}`,
    };
  };

  let completed = false;
  /** The error that ended the step early, if one did (the finally reports a failed restore next to it). */
  let failure: unknown;
  try {
    await test.step('build persona A: the picked skill, a global KB if there is one, saved', async () => {
      await build(A, 'Northwind', descA, { skill: picked, globalKb });
      await shot(page, testInfo, 'built');
    });

    await test.step("A's private KB: created, a text source with the fact, ingested", async () => {
      const pkbs = editor.getByTestId('ms-private-kbs');
      await expect(pkbs, "once A is saved, the editor offers its own knowledge bases").toBeVisible();
      await pkbs.getByTestId('ms-pkb-new-id').fill(KB);
      const base = `/api/mindstone/admin/personas/${A}/knowledgebases`;
      const created = await uiResponse(page, { method: 'POST', path: base }, () => pkbs.getByTestId('ms-pkb-create').click());
      expect(created.status, `POST ${base}`).toBeLessThan(300);
      const kb = pkbs.getByTestId(`ms-pkb-${KB}`);
      await expect(kb).toContainText('not ingested yet');
      const ingest = kb.getByTestId(`ms-pkb-${KB}-ingest`);
      await expect(ingest, 'Ingest is disabled until the KB has a source').toBeDisabled();
      await kb.getByTestId(`ms-pkb-${KB}-text-name`).fill('harbour');
      await kb.getByTestId(`ms-pkb-${KB}-text`).fill(`The harbour lighthouse call sign is ${token}.\n`);
      const added = await uiResponse(page, { method: 'POST', path: `${base}/${KB}/sources` }, () => kb.getByTestId(`ms-pkb-${KB}-add-text`).click());
      expect(added.status, `POST ${base}/${KB}/sources (a text source)`).toBeLessThan(300);
      await expect(kb, 'the source is listed').toContainText('harbour.md');
      await expect(ingest, 'Ingest is enabled once the KB has a source').toBeEnabled();
      await shot(page, testInfo, 'private-kb');
      const ingested = await uiResponse(page, { method: 'POST', path: `${base}/${KB}/ingest`, timeoutMs: J10_INGEST_TIMEOUT_MS }, () => ingest.click());
      const said = ((await pkbs.getByRole('status').allTextContents()).join(' | ') || '').trim();
      expect(ingested.status, `POST ${base}/${KB}/ingest (the page says: "${said}")`).toBeLessThan(300);
      await expect(pkbs.getByRole('status')).toContainText(/Ingested: [1-9]\d* entries/);
      await expect(kb, 'the KB is listed as ingested').toContainText(/ingested, [1-9]\d* entries/);
      await shot(page, testInfo, 'ingested');
    });

    await test.step('saving did not make A active; the gateway has its components', async () => {
      const detail = await consoleApi<LoadedPersona>(page, 'GET', `/api/mindstone/admin/personas/${A}`);
      proof.savedA = detail.json.persona;
      await saveProof();
      const persona = detail.json.persona;
      expect(detail.status, `GET /api/mindstone/admin/personas/${A}`).toBe(200);
      expect(persona?.skills, "A's skills are the picked one").toEqual([picked]);
      expect(persona?.knowledgebases ?? [], "A's global KBs").toEqual(globalKb ? [globalKb] : []);
      expect(persona?.privateKnowledgebases?.find((kb) => kb.id === KB)?.indexed, `A's private KB ${KB} is ingested`).toBe(true);
      expect(persona?.active, 'A is not active').toBe(false);
      expect((await listPersonas()).active ?? null, 'saving A left the active persona unchanged').toBe(activeBefore);
      await editor.getByRole('button', { name: 'Close', exact: true }).click();
      await expect(row(A)).toBeVisible();
      await expect(row(A).getByText('Active', { exact: true }), 'the list does not mark A active').toHaveCount(0);
      await shot(page, testInfo, 'not-active');
    });

    await test.step('build persona B, the control: no skills listed, no KB of its own', async () => {
      await build(B, 'Southgate', 'The journey test control persona: no skills listed, no private knowledge base.');
      await editor.getByRole('button', { name: 'Close', exact: true }).click();
      expect((await listPersonas()).active ?? null, 'saving B left the active persona unchanged').toBe(activeBefore);
    });

    /** The Personas page's Make active, then the list and the gateway agree it is active. */
    const makeActive = async (id: string) => {
      await navigate(page, '/mindstone/personas');
      await expect(row(id)).toBeVisible({ timeout: 30_000 });
      const patched = await uiResponse(page, { method: 'PATCH', path: '/api/mindstone/admin/config/personas' }, () =>
        row(id).getByRole('button', { name: 'Make active' }).click(),
      );
      expect(patched.status, `Make active ${id}: PATCH /api/mindstone/admin/config/personas`).toBeLessThan(300);
      await expect(row(id).getByText('Active', { exact: true })).toBeVisible({ timeout: 15_000 });
      expect((await listPersonas()).active, `${id} is the active persona`).toBe(id);
    };
    /** A fresh chat asking for the fact; the stored reply, and the gateway transcript's evidence for it. */
    const ask = async (name: string) => {
      await navigate(page, '/c/new');
      await ensureMindStoneModel(page, testInfo);
      const reply = await sendAndWaitForReply(page, J10_ASK);
      await shot(page, testInfo, name);
      await attachText(testInfo, `${name}.txt`, replyLog(reply));
      return { reply, turn: personaTurnForConversation(reply.conversationId, token) };
    };
    const brief = (turn: PersonaTurnEvidence) => ({
      persona: turn.personaId ?? null,
      components: turn.components ?? null,
      recallInTurn: turn.recallAt >= 0,
      hits: turn.allHits.map((h) => h.id),
      entriesWithToken: turn.withToken.map((i) => turn.outline[i]),
      outline: turn.outline,
    });

    // The negative control first, while no chat has ever held the token: under B, A's private KB must not be searched.
    const control = await test.step('isolation: under B, before any chat held the fact, no pkb hit from A and no fact', async () => {
      await makeActive(B);
      const { reply, turn } = await ask('control-chat');
      const reasons = isolationReasons(turn, { builtPersonaId: A, controlPersonaId: B });
      proof.control = { conversationId: reply.conversationId, ...brief(turn), reasons };
      await saveProof();
      note(testInfo, `control chat ${reply.conversationId} under ${B}: ${reasons.length ? `BROKEN: ${reasons.join('; ')}` : `no pkb:${A}: hit, no fact`}; reply "${reply.text.slice(0, 100)}"`);
      expectAnswer(reply, 'the control chat under B');
      expect(reply.text.toLowerCase(), "under B, the reply doesn't have A's fact").not.toContain(token);
      expect(reasons, `the gateway transcript for the control chat (${reply.conversationId})`).toEqual([]);
      return turn;
    });

    const built = await test.step("A made active: a fresh chat's reply has the fact, from A's private KB, with only A's skill", async () => {
      await makeActive(A);
      const { reply, turn } = await ask('chat');
      const reasons = builtPersonaReasons(turn, { personaId: A, kbId: KB });
      proof.built = { conversationId: reply.conversationId, ...brief(turn), reasons };
      await saveProof();
      await gatewayExcerpt(testInfo, 40);
      note(
        testInfo,
        `chat ${reply.conversationId} under ${A}: ${reasons.length ? `NOT proven: ${reasons.join('; ')}` : `persona ${turn.personaId}, recall hit ${turn.turnHits.filter((h) => h.id?.startsWith(`pkb:${A}:`)).map((h) => h.id).join(', ')}`}; ` +
          `reply "${reply.text.slice(0, 100)}"`,
      );
      expect(reply.error, `the reply is not an error: ${(reply.errorText ?? '').slice(0, 300)}`).toBe(false);
      expect(
        reasons,
        `the gateway transcript for the chat under A (${reply.conversationId}) proves the private KB supplied the fact: A answered (personaContext), ` +
          `a pkb:${A}:${KB}: hit in the reply's own recall event, no other persona's private KB, the token in no other entry`,
      ).toEqual([]);
      expect(turn.components?.globalKnowledgebases, "A's turn searched its listed global KBs (every one when it lists none)").toEqual(globalKb ? [globalKb] : 'all');
      expect(turn.components?.privateKnowledgebases, "A's turn searched its own private KBs").toBe('own');
      if (PROVIDER === 'mock') {
        // The mock route echoes; whether the reply uses the fact can't be judged. MOCK counts as not passed.
        testInfo.annotations.push({ type: 'mock', description: 'mock provider' }, { type: 'label', description: 'MOCK' });
      } else {
        expect(reply.text.toLowerCase(), `the reply under A has the fact from its private KB (${token})`).toContain(token);
        await expectOnScreen(page, token, "the fact in A's reply", { role: 'assistant', messageId: reply.messageId });
      }
      return turn;
    });

    // Only the picked skill in A's prompt, from the turn records; B (none listed) is the positive control.
    const skills = skillsVerdict({ picked, installed, built: built.components, control: control.components });
    proof.skills = skills;
    await saveProof();
    note(testInfo, `skills: ${skills.reasons.length ? `NOT shown: ${skills.reasons.join('; ')}` : skills.provable ? `only ${picked} in A's prompt; ${skills.why}` : skills.why}`);
    expect(skills.reasons, `only the picked skill (${picked}) is in A's prompt (personaComponents.skillsInPrompt)`).toEqual([]);

    await test.step('isolation again: back under B after the chat under A, no pkb hit from A', async () => {
      await makeActive(B);
      const { reply, turn } = await ask('control-after');
      // A's reply is in the shared transcripts now (#125 design §2), so the fact may come back through transcript recall:
      // only the private-KB rule is judged here, and a token in the reply is noted.
      const reasons = isolationReasons(turn, { builtPersonaId: A, controlPersonaId: B, tokenMayLeak: true });
      proof.controlAfter = { conversationId: reply.conversationId, ...brief(turn), reasons };
      await saveProof();
      note(
        testInfo,
        `control chat after A (${reply.conversationId}) under ${B}: ${reasons.length ? `BROKEN: ${reasons.join('; ')}` : `no pkb:${A}: hit`}` +
          `${reply.text.toLowerCase().includes(token) ? '; the reply has the fact, through the shared transcripts, not the private KB' : '; the reply has no fact'}`,
      );
      expectAnswer(reply, 'the control chat under B, after A');
      expect(reasons, `the gateway transcript for the second control chat (${reply.conversationId})`).toEqual([]);
    });

    await test.step('edit A: a new description, saved, still there after a reload', async () => {
      const edited = `${descA} Edited ${stamp}.`;
      await navigate(page, '/mindstone/personas');
      await page.getByTestId(`ms-persona-edit-${A}`).click();
      await expect(editor.getByTestId('ms-pe-description'), 'the editor loads A').toHaveValue(descA, { timeout: 30_000 });
      await expect(editor.getByTestId(`ms-skill-picker-selected-${picked}`), 'the editor shows A\'s skill').toBeVisible();
      await editor.getByTestId('ms-pe-description').fill(edited);
      const patched = await uiResponse(page, { method: 'PATCH', path: `/api/mindstone/admin/personas/${A}` }, () => editor.getByTestId('ms-pe-save').click());
      expect(patched.status, `PATCH /api/mindstone/admin/personas/${A}`).toBeLessThan(300);
      await expect(editor.getByRole('status').filter({ hasText: /^Saved\./ }), 'the edit is saved, and A is still not active').toContainText("It isn't active");
      await shot(page, testInfo, 'edited');
      await navigate(page, '/mindstone/personas');
      await expect(row(A), 'the list shows the new description after a reload').toContainText(edited);
      await page.getByTestId(`ms-persona-edit-${A}`).click();
      await expect(editor.getByTestId('ms-pe-description'), 'the editor shows the new description after a reload').toHaveValue(edited, { timeout: 30_000 });
      await expect(editor.getByTestId(`ms-skill-picker-selected-${picked}`), 'the skill is kept').toBeVisible();
      await expect(editor.getByTestId(`ms-pkb-${KB}`), 'the private KB is kept, ingested').toContainText(/ingested, [1-9]\d* entries/);
      await shot(page, testInfo, 'reloaded');
      const reread = await consoleApi<LoadedPersona>(page, 'GET', `/api/mindstone/admin/personas/${A}`);
      proof.editedA = reread.json.persona;
      await saveProof();
      expect(reread.json.persona?.description, "the gateway has A's new description").toBe(edited);
      expect(reread.json.persona?.skills, "the edit kept A's skill").toEqual([picked]);
      expect((await listPersonas()).active, 'editing A did not make it active').toBe(B);
      await editor.getByRole('button', { name: 'Close', exact: true }).click();
    });

    // Put the active persona back as it was, through the same page (J11 and later runs shouldn't answer as B).
    await test.step('the active persona put back', async () => {
      if (activeBefore && (await listPersonas()).personas?.some((p) => p.id === activeBefore)) {
        await makeActive(activeBefore);
      } else {
        await navigate(page, '/mindstone/personas');
        await page.getByRole('button', { name: 'Use no persona' }).click();
        await expect.poll(async () => (await listPersonas()).active ?? null, { timeout: 15_000 }).toBe(null);
      }
      note(testInfo, `active persona put back to ${activeBefore ?? 'none'}`);
    });

    completed = true;
    if (!skills.provable) {
      test.fixme(
        true,
        `PENDING ${ISSUES.personaBuilder} (skills part): everything else passed, but ${skills.why}. ` +
          "Done when: with a second skill installed (J7 installs two), A's prompt holds only the picked one.",
      );
    }
  } catch (error) {
    failure = error;
    throw error;
  } finally {
    const restored = await restoreActivePersona().catch((error: Error) => ({ ok: false, text: `the active persona could not be put back: ${error.message}` }));
    note(testInfo, restored.text);
    proof.restore = restored;
    await saveProof().catch(() => undefined);
    if (!restored.ok) {
      // Always surfaced, whatever J10's own verdict: the gate and the DEMO SUBSET fail on it even when J10 isn't counted
      // (restore-failures.tsv), and a J10 that failed already keeps its own error, with this one added.
      recordRestoreFailure('J10', restored.text);
      const what = `J10 left the wrong active persona behind: ${restored.text}`;
      if (completed) throw new Error(what);
      throw new Error(`${failure instanceof Error ? failure.message : String(failure)} | AND ${what}`);
    }
  }
});

/** The provider step's enterprise choice for Azure (the gateway names it "Azure OpenAI / AI Foundry"), and its form. */
const AZURE_CHOICE = /^Azure OpenAI\b/;
const AZURE_FORM = 'ms-ent-form-azure-openai';

test('J11 enterprise endpoint (Azure OpenAI / Foundry): saved, tested and chatted through in the UI', async ({}, testInfo) => {
  testInfo.setTimeout(12 * 60_000);
  const expectEnterprise = process.env.UAT_EXPECT_ENTERPRISE === '1';
  testInfo.annotations.push({ type: 'label', description: expectEnterprise ? 'gated: UAT_EXPECT_ENTERPRISE=1' : 'not gated' });
  await ensureSignedIn(page);

  // Guided setup again, from the settings page's own link, through Access (turned on with the phrase if it's off).
  await test.step('guided setup, from the settings page', async () => {
    await navigate(page, '/mindstone');
    await expect(page.getByRole('heading', { name: 'MindStone settings' })).toBeVisible();
    await page.locator('section[aria-labelledby="ms-onboarding"] a[href="/mindstone/onboarding"]').first().click();
    await expect(page).toHaveURL(/\/mindstone\/onboarding$/);
    const access = await page.waitForFunction(
      () => {
        const card = document.querySelector('section[aria-labelledby="ms-onb-access"]');
        if (!card) return undefined;
        const hasInput = Boolean(card.querySelector('input[aria-label="Confirmation"]'));
        const hasNext = Array.from(card.querySelectorAll('button')).some((b) => b.textContent?.trim() === 'Next');
        return hasInput || hasNext ? { hasInput, hasNext } : undefined;
      },
      undefined,
      { timeout: 30_000 },
    );
    const state = (await access.jsonValue()) as { hasInput: boolean; hasNext: boolean };
    if (state.hasNext) {
      note(testInfo, 'advanced settings already on: Next');
      await page.locator('section[aria-labelledby="ms-onb-access"]').getByRole('button', { name: 'Next' }).click();
    } else {
      note(testInfo, 'advanced settings off: typed the phrase and turned them on');
      await page.getByRole('textbox', { name: 'Confirmation' }).fill(TYPED_PHRASE);
      await page.getByRole('button', { name: 'Turn on' }).click();
    }
    await expect(page.getByRole('heading', { name: 'Connect a model provider' })).toBeVisible();
  });

  // Is the feature here? Positive first: the provider step rendered its choices; only then does "no Azure choice" mean something.
  const provider = page.locator('section[aria-labelledby="ms-onb-provider"]');
  await expect(provider.getByRole('radio').first(), 'the provider step lists its choices').toBeVisible({ timeout: 30_000 });
  const choices = (await provider.locator('label:has(input[type="radio"])').allTextContents()).map((s) => s.trim());
  const azure = provider.getByRole('radio', { name: AZURE_CHOICE });
  const kindOffered = (await azure.count()) > 0;
  if (kindOffered) await azure.first().check();
  const formPresent = await appears(page.getByTestId(AZURE_FORM), kindOffered ? 10_000 : 1_000);
  await shot(page, testInfo, 'provider');
  const listed = await consoleApi<{ enterprise?: { kind: string }[] }>(page, 'GET', '/api/mindstone/admin/models');
  const gatewayKinds = (listed.json?.enterprise ?? []).map((k) => k.kind);
  note(testInfo, `provider step: ${choices.join(', ')}; the gateway lists enterprise kinds: ${gatewayKinds.join(', ') || 'none'}`);
  const decision = j11Decision({ kindOffered, formPresent, expectEnterprise, gatewayOffers: gatewayKinds.includes('azure-openai') });
  if (decision.verdict === 'pending') {
    test.fixme(
      true,
      `PENDING ${ISSUES.enterprise}: ${decision.why}. Not gated (set UAT_EXPECT_ENTERPRISE=1 to require it). ` +
        'Done when: the provider step (and settings) offer Azure OpenAI / AI Foundry with a form (Endpoint, Deployment names, API key, Save endpoint); ' +
        "saving it against the harness's stub Azure endpoint shows the setup's Test, whose result (ms-ent-test-result) is a success with the stub's token, " +
        'and the stub logged an authenticated POST <endpoint>/responses?api-version=v1 (the key in api-key); choosing its deployment as the model makes ' +
        "a chat's reply come from the stub (its token on screen, the chat's own message in the stub's log); and no gateway credential ever reaches the endpoint.",
    );
    return;
  }
  if (decision.verdict === 'fail') throw new Error(decision.why);

  // The real test. It needs finished setup (J2) and the stub run-journey.sh started.
  requireSetupDone();
  const stub = enterpriseStub();
  if (!stub) throw new Error('no stub Azure endpoint: run J11 through run-journey.sh (UAT_ENT_STUB_URL, UAT_ENT_TOKEN, UAT_ENT_KEY_FILE, UAT_ENT_STUB_LOG)');
  expect(await stubHealth(stub.url), 'the stub Azure endpoint answers its health route').toBe(200);
  const model = `enterprise-azure/${stub.deployment}`;
  const proofs: Record<string, unknown> = {};
  /** The last check on every path that doesn't FAIL: nothing in the stub's whole log leaked, including after the last proof. */
  const expectNoLeaks = async (when: string) => {
    const leaks = stubLeakReasons(stub.log);
    proofs.finalLeakCheck = { when, leaks };
    await attachText(testInfo, 'stub-proof.json', JSON.stringify(proofs, null, 2));
    expect(leaks, `${when}: no request in the stub's whole log carried a gateway credential, or the key outside api-key`).toEqual([]);
  };

  await test.step('save the endpoint: Endpoint, Deployment names, API key (the fake per-run key)', async () => {
    const form = page.getByTestId(AZURE_FORM);
    await form.getByLabel(/^Endpoint/).fill(stub.endpoint);
    await form.getByLabel(/^Deployment names/).fill(stub.deployment);
    const keyInput = form.getByLabel(/^API key/);
    await fillSecret(keyInput, readSecretFile('UAT_ENT_KEY_FILE'));
    // The screenshot must show dots, not the key.
    await expect(keyInput, 'the API key field is a password field (masked in the screenshot)').toHaveAttribute('type', 'password');
    await shot(page, testInfo, 'form');
    await form.getByRole('button', { name: 'Save endpoint' }).click();
    const done = page.getByTestId('ms-onb-enterprise-done');
    const saved = await appears(done, 60_000);
    const status = ((await page.getByRole('status').first().textContent().catch(() => '')) ?? '').trim();
    await shot(page, testInfo, 'saved');
    expect(saved, `the endpoint was saved (ms-onb-enterprise-done); the page says: "${status}"`).toBe(true);
    note(testInfo, `saved: "${status}"`);
  });

  await test.step("Test: a success with the stub's token, and the stub saw the authenticated call", async () => {
    const done = page.getByTestId('ms-onb-enterprise-done');
    const since = Date.now();
    await done.getByRole('button', { name: 'Test', exact: true }).click();
    const result = page.getByTestId('ms-ent-test-result');
    await expect(result).toBeVisible({ timeout: 120_000 });
    const text = ((await result.textContent()) ?? '').trim();
    await shot(page, testInfo, 'test-result');
    note(testInfo, `Test: "${text}"`);
    expect(text, 'the Test result is a success ("<model> answered in N ms: <reply>")').toMatch(/ answered in \d+ ms: /);
    expect(text, "the Test's reply is the stub's (its per-run token)").toContain(stub.token);
    // UI text alone is not proof: the stub must have answered an authenticated Responses API call, and the
    // request number the result shows must be that logged request.
    const requestN = Number(text.match(/\(request #(\d+)/)?.[1] ?? NaN);
    expect(requestN, 'the Test result names the stub request that answered it ("request #<n>")').toBeGreaterThan(0);
    const proof = await waitForStubProof(page, stub.log, { sinceMs: since, requestN });
    proofs.test = { matched: proof.matched, sinceTheClick: proof.recent, reasons: proof.reasons };
    expect(proof.reasons, 'the stub logged the Test: an authenticated POST <endpoint>/responses?api-version=v1, streamed, answered with the token').toEqual([]);
    note(testInfo, `stub: Test call #${proof.matched?.n} ${proof.matched?.method} ${proof.matched?.path}?api-version=${proof.matched?.apiVersion}, key ok`);
  });

  // The enterprise model for chat: the chat's model menu lists agents, not provider models, so the model the agent
  // chats with is chosen where the UI chooses it, guided setup's Model step (saved as the route's default model).
  const offered = await test.step('choose its deployment as the model (guided setup, Model step)', async () => {
    await page.getByTestId('ms-onb-enterprise-done').getByRole('button', { name: 'Save and continue' }).click();
    await expect(page.getByRole('heading', { name: 'Choose the model' })).toBeVisible();
    const select = page.getByRole('combobox', { name: 'Choose the model' });
    const values = (await select.count())
      ? await select.locator('option').evaluateAll((options) => options.map((o) => (o as HTMLOptionElement).value).filter(Boolean))
      : [];
    await attachText(testInfo, 'model-options.txt', values.join('\n'));
    const wanted = values.find((v) => v === model) ?? '';
    await shot(page, testInfo, 'model');
    if (!wanted) return { values };
    await select.selectOption(wanted);
    await page.getByRole('button', { name: 'Save and continue' }).click();
    await expect(page.getByRole('heading', { name: 'Choose a base persona' }), 'the model was saved (setup moved on)').toBeVisible({ timeout: 30_000 });
    const config = await consoleApi<{ config?: { routing?: { mode?: string; defaultModel?: string } } }>(page, 'GET', '/api/mindstone/admin/config');
    const routing = config.json.config?.routing ?? {};
    note(testInfo, `routing: ${routing.mode} ${routing.defaultModel}`);
    expect(routing.defaultModel, 'the chosen deployment is the default route').toBe(model);
    return { values, chosen: wanted };
  });
  if (!offered.chosen) {
    await expectNoLeaks('before the chat part goes PENDING');
    test.fixme(
      true,
      `PENDING ${ISSUES.enterprise} (chat part): the endpoint was saved and its Test proved against the stub, but the Model step doesn't offer ${model} ` +
        `(it offers: ${offered.values.join(', ') || 'nothing'}), so a chat can't be pointed at it from the UI. ` +
        `Done when: the Model step lists ${model}, and a chat after choosing it is answered by the stub.`,
    );
    return;
  }

  await test.step("a chat is answered through the endpoint: the stub's token on screen, the chat's message in the stub's log", async () => {
    await navigate(page, '/c/new');
    await ensureMindStoneModel(page, testInfo);
    // The stub echoes a [nonce:<value>] marker's value, and its own request number, in its reply.
    const nonce = `ent-${Date.now().toString(36)}`;
    const since = Date.now();
    const reply = await sendAndWaitForReply(page, `Enterprise endpoint check [nonce:${nonce}]: please reply in one short sentence.`);
    await attachText(testInfo, 'reply.txt', replyLog(reply));
    await shot(page, testInfo, 'chat-reply');
    await gatewayExcerpt(testInfo, 40);
    // Everything that says where the reply came from, gathered before any assertion, so a failure names it:
    // the stub's log (did the chat reach it?) and the gateway transcript (which provider and model Pi called).
    const requestN = Number(reply.text.match(/\(request #(\d+)/)?.[1] ?? NaN);
    const proof = await waitForStubProof(page, stub.log, { sinceMs: since, nonce, requestN: requestN > 0 ? requestN : undefined });
    const answered = answeredBy(reply.text);
    const calledBy = `${answered?.provider ?? '?'}/${answered?.model ?? '?'}${answered?.modelFallbackMessage ? ` (fallback: ${answered.modelFallbackMessage})` : ''}`;
    proofs.chat = { nonce, matched: proof.matched, sinceTheMessage: proof.recent, reasons: proof.reasons, answeredBy: answered ?? { found: false } };
    await attachText(testInfo, 'stub-proof.json', JSON.stringify(proofs, null, 2));
    note(
      testInfo,
      `chat ${reply.conversationId}: "${reply.text.slice(0, 120)}"; the stub ${proof.matched ? `answered it (call #${proof.matched.n})` : 'got no request for it'}; ` +
        `the Pi session called ${calledBy}`,
    );
    const where = `the saved route is ${model}; the Pi session called ${calledBy}; the stub: ${proof.reasons.join('; ') || 'answered it'}`;
    expectAnswer(reply, 'the chat through the enterprise endpoint');
    expect(proof.reasons, `the stub logged the chat: an authenticated, streamed POST <endpoint>/responses?api-version=v1 carrying the chat's own message (${where})`).toEqual([]);
    expect(reply.text, `the reply is the stub's, with its per-run token (${where})`).toContain(stub.token);
    expect(
      reply.text,
      "the reply is the stub's answer to this exact request: the logged request's number and the chat's own nonce",
    ).toContain(`request #${proof.matched?.n}, nonce ${nonce}`);
    await expectOnScreen(page, stub.token, "the stub's token in the reply", { role: 'assistant', messageId: reply.messageId });
    await expectOnScreen(page, nonce, "the chat's nonce, echoed by the stub, in the reply", { role: 'assistant', messageId: reply.messageId });
  });

  await test.step('settings: the Model providers page lists it', async () => {
    await navigate(page, '/mindstone');
    await page.locator('section[aria-labelledby="ms-onboarding"]').getByRole('link', { name: 'Model providers' }).click();
    await expect(page).toHaveURL(/\/mindstone\/providers$/);
    await expect(page.getByTestId('ms-provider-enterprise-azure'), 'the Model providers page lists enterprise-azure').toBeVisible({ timeout: 30_000 });
    await shot(page, testInfo, 'providers');
  });
  await expectNoLeaks('at the end of J11');
});
