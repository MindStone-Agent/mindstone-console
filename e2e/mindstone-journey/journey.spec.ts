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
 * J11 (an enterprise Azure OpenAI endpoint, against the harness's stub) is
 * PENDING while the Console has no enterprise form; it is in the gate only
 * with UAT_EXPECT_ENTERPRISE=1, and never in the DEMO SUBSET. (J10 is kept
 * for the persona builder.)
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
  expectOnScreen,
  fillSecret,
  formationEvidence,
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
  waitForStubProof,
} from './lib/journey';
import type { FlowName, Reply, StoredMessage } from './lib/journey';

const ISSUES = {
  banner: 'mindstone-console#18 (PR #20)',
  memory: 'MindStone-Agent#102 / #106 (memory in guided setup)',
  identity: 'MindStone-Agent#102',
  skills: 'MindStone-Agent#104',
  persona: 'MindStone-Agent#105',
  recall: 'MindStone-Agent#106 (automatic memory recall, on by default)',
  enterprise: 'MindStone-Agent#126 (enterprise model endpoints)',
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

/** The MindStone-Agent #126 link to the Model providers page (J11), right after Skills. */
const PROVIDERS_LINK = 'Model providers';

/**
 * The links /mindstone must show, exactly: with UAT_EXPECT_ENTERPRISE=1, today's
 * plus Model providers right after Skills (required). Without it, today's with or
 * without that one link in that one place (a Console with or without #126);
 * everything else stays strict.
 */
function expectedStatusLinks(links: string[], testInfo: TestInfo): string[] {
  const withProviders = [...TODAY_STATUS_LINKS, PROVIDERS_LINK];
  if (process.env.UAT_EXPECT_ENTERPRISE === '1') return withProviders;
  if (JSON.stringify(links) === JSON.stringify(withProviders)) {
    note(testInfo, `"${PROVIDERS_LINK}" (#126) is there after Skills; accepted without UAT_EXPECT_ENTERPRISE (J11 checks it)`);
    return withProviders;
  }
  return TODAY_STATUS_LINKS;
}

/** Steps that judge the state after setup: when J2 failed they report "blocked by J2", not "state changed". */
const NEEDS_SETUP = /^J[789] /;

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
      if (wantedBase && (await address.inputValue()) !== wantedBase && !/\/\/(127\.0\.0\.1|localhost):11434\/v1$/.test(wantedBase)) {
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
  const dataDir = process.env.UAT_DATA_DIR ?? '';
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
    expect(links, 'the links on /mindstone').toEqual(expectedStatusLinks(links, testInfo));
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
  const decision = j11Decision({ kindOffered, formPresent, expectEnterprise });
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

  await test.step('save the endpoint: Endpoint, Deployment names, API key (the fake per-run key)', async () => {
    const form = page.getByTestId(AZURE_FORM);
    await form.getByLabel(/^Endpoint/).fill(stub.endpoint);
    await form.getByLabel(/^Deployment names/).fill(stub.deployment);
    await fillSecret(form.getByLabel(/^API key/), readSecretFile('UAT_ENT_KEY_FILE'));
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
    // UI text alone is not proof: the stub must have answered an authenticated Responses API call.
    const proof = await waitForStubProof(page, stub.log, { sinceMs: since });
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
    await attachText(testInfo, 'stub-proof.json', JSON.stringify(proofs, null, 2));
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
    const nonce = `ent-${Date.now().toString(36)}`;
    const since = Date.now();
    const reply = await sendAndWaitForReply(page, `Enterprise endpoint check ${nonce}: please reply in one short sentence.`);
    await attachText(testInfo, 'reply.txt', replyLog(reply));
    await shot(page, testInfo, 'chat-reply');
    await gatewayExcerpt(testInfo, 40);
    expectAnswer(reply, 'the chat through the enterprise endpoint');
    expect(reply.text, "the reply is the stub's (its per-run token)").toContain(stub.token);
    await expectOnScreen(page, stub.token, "the stub's token in the reply", { role: 'assistant', messageId: reply.messageId });
    const proof = await waitForStubProof(page, stub.log, { sinceMs: since, nonce });
    proofs.chat = { nonce, matched: proof.matched, sinceTheMessage: proof.recent, reasons: proof.reasons };
    expect(proof.reasons, "the stub logged the chat: an authenticated, streamed POST <endpoint>/responses?api-version=v1 carrying the chat's own message").toEqual([]);
    const answered = answeredBy(reply.text);
    note(
      testInfo,
      `chat ${reply.conversationId}: "${reply.text.slice(0, 120)}"; stub call #${proof.matched?.n}; ` +
        `answered by (Pi session): ${answered?.provider ?? '?'} / ${answered?.model ?? '?'}`,
    );
  });

  await test.step('settings: the Model providers page lists it', async () => {
    await navigate(page, '/mindstone');
    await page.locator('section[aria-labelledby="ms-onboarding"]').getByRole('link', { name: 'Model providers' }).click();
    await expect(page).toHaveURL(/\/mindstone\/providers$/);
    await expect(page.getByTestId('ms-provider-enterprise-azure'), 'the Model providers page lists enterprise-azure').toBeVisible({ timeout: 30_000 });
    await shot(page, testInfo, 'providers');
  });
  await attachText(testInfo, 'stub-proof.json', JSON.stringify(proofs, null, 2));
});
