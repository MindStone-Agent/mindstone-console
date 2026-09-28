/**
 * The MindStone demo journey (MindStone-Agent #106), in the Console UI only,
 * against a fresh install made by run-journey.sh. Each step is its own test
 * and reports PASS, FAIL or PENDING.
 *
 * PENDING steps call test.fixme() at run time, after checking what exists
 * today: when the feature lands, the detection trips and the step fails with
 * "write the real assertions" instead of silently staying PENDING. Each one
 * says what "done" looks like, from its issue.
 */
import { expect, test } from '@playwright/test';
import type { BrowserContext, Page } from '@playwright/test';
import {
  ERROR_REPLY,
  appears,
  PROVIDER,
  PROVIDER_MODEL,
  attachText,
  consoleApi,
  ensureMindStoneModel,
  ensureSignedIn,
  gatewayExcerpt,
  note,
  readSecretFile,
  readState,
  sendAndWaitForReply,
  shot,
  signIn,
  writeState,
} from './lib/journey';

const ISSUES = {
  banner: 'mindstone-console#18 (PR #20)',
  memory: 'MindStone-Agent#102 / #106 (memory in guided setup)',
  identity: 'MindStone-Agent#102',
  skills: 'MindStone-Agent#104',
  persona: 'MindStone-Agent#105',
};

/** The phrase as a phone or autocomplete types it: a capital and a trailing space (#18). */
const TYPED_PHRASE = 'Enable advanced settings ';

let context: BrowserContext;
let page: Page;

test.beforeAll(async ({ browser }) => {
  context = await browser.newContext();
  await context.addInitScript(() => {
    try {
      localStorage.setItem('navVisible', 'true');
    } catch {
      // storage refused
    }
  });
  page = await context.newPage();
});

test.afterAll(async () => {
  await context?.close();
});

test.afterEach(async ({}, testInfo) => {
  if (testInfo.status !== testInfo.expectedStatus && testInfo.status !== 'skipped') {
    await shot(page, testInfo, 'failure');
    await gatewayExcerpt(testInfo);
  }
});

test('J1 sign in as admin; the setup banner is visible', async ({}, testInfo) => {
  await page.goto('/login');
  await shot(page, testInfo, 'login');
  await signIn(page);
  const me = await consoleApi<{ role?: string; email?: string }>(page, 'GET', '/api/user');
  expect(me.json.role, 'the create-user account is the admin').toBe('ADMIN');
  const banner = page.getByTestId('mindstone-setup-banner');
  const visible = await appears(banner, 30_000);
  await shot(page, testInfo, visible ? 'banner' : 'no-banner');
  expect(visible, `the "MindStone isn't set up yet" banner (${ISSUES.banner})`).toBe(true);
  await expect(banner).toContainText("MindStone isn't set up yet");
  await expect(banner.getByRole('button', { name: 'Set up MindStone' })).toBeVisible();
});

test('J2 guided setup in the UI: access, provider, model, persona, finish', async ({}, testInfo) => {
  await ensureSignedIn(page);
  const bannerButton = page.getByTestId('mindstone-setup-banner').getByRole('button', { name: 'Set up MindStone' });
  if (await appears(bannerButton, 15_000)) {
    await bannerButton.click();
    writeState({ enteredSetupVia: 'banner' });
  } else {
    note(testInfo, 'no setup banner: opened /mindstone/onboarding directly, as the README says');
    writeState({ enteredSetupVia: 'direct-url' });
    await page.goto('/mindstone/onboarding');
  }
  await expect(page).toHaveURL(/\/mindstone\/onboarding/);
  await expect(page.getByRole('heading', { name: 'Set up MindStone', level: 1 })).toBeVisible();
  const setupSteps = (await page.getByRole('list', { name: 'Setup steps' }).locator('li').allTextContents()).map(
    (s) => s.replace(/^\d+\.\s*/, '').trim(),
  );
  writeState({ setupSteps });
  note(testInfo, `setup steps: ${setupSteps.join(' > ')}`);

  // Access: the phrase with a capital and a trailing space.
  await test.step('access', async () => {
    const confirm = page.getByRole('textbox', { name: 'Confirmation' });
    const next = page.getByRole('button', { name: 'Next' });
    // Wait for the access card: the phrase box, or "Next" when access is already on.
    await expect(confirm.or(next).first()).toBeVisible({ timeout: 30_000 });
    if (await confirm.isVisible()) {
      await confirm.fill(TYPED_PHRASE);
      await shot(page, testInfo, 'access-typed');
      const turnOn = page.getByRole('button', { name: 'Turn on' });
      await expect(turnOn, `"${TYPED_PHRASE}" enables Turn on (${ISSUES.banner})`).toBeEnabled({ timeout: 5_000 });
      await turnOn.click();
    } else {
      note(testInfo, 'advanced settings were already on');
      await next.click();
    }
    await expect(page.getByRole('heading', { name: 'Connect a model provider' })).toBeVisible();
  });

  // Provider.
  await test.step(`provider (${PROVIDER})`, async () => {
    if (PROVIDER === 'mock') {
      // No provider to connect: set the gateway's mock route through the Console's admin API
      // (not a UI path; labelled "mock"). The model, persona and finish screens need a real
      // provider's models, so the mock run stops the guided setup here.
      testInfo.annotations.push({ type: 'label', description: 'mock: route set via the Console admin API, not the UI' });
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
    if (PROVIDER === 'ollama-cloud') {
      await page.getByRole('textbox', { name: 'API key' }).fill(readSecretFile('UAT_PROVIDER_KEY_FILE'));
    }
    await shot(page, testInfo, 'provider');
    await page.getByRole('button', { name: 'Connect' }).click();
    const connected = page.getByText(/Connected\. \d+ models found/);
    await expect(connected, "the gateway listed the provider's models").toBeVisible({ timeout: 90_000 });
    note(testInfo, ((await connected.textContent()) ?? '').trim());
  });

  if (PROVIDER === 'mock') {
    note(testInfo, 'mock run: model, persona and finish screens skipped (they need a real provider)');
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

  // Finish.
  await test.step('finish', async () => {
    await expect(page.getByRole('heading', { name: 'MindStone is set up' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Start a chat' })).toBeEnabled();
    const hint = (await page.locator('section[aria-labelledby="ms-onb-finish"] p').first().textContent()) ?? '';
    writeState({ finishReached: true, finishHint: hint.trim() });
    await shot(page, testInfo, 'finish');
  });
});

test('J3 memory in guided setup: vector store, embedding provider and model, live embed check', async ({}, testInfo) => {
  const state = readState();
  const steps = state.setupSteps ?? [];
  const hasMemoryStep = steps.some((s) => /memory|embedding|vector/i.test(s));
  // What's there today: memory is outside guided setup, reported on the status panel. Checked in
  // a second tab, so the main one stays on Finish for J4's "Start a chat".
  await ensureSignedIn(page, { stayIfSignedIn: true });
  const tab = await context.newPage();
  try {
    await tab.goto('/mindstone');
    await expect(tab.getByRole('heading', { name: 'MindStone settings' })).toBeVisible();
    const memoryRow = tab.getByTestId('ms-step-memory');
    await expect(memoryRow, 'the status panel reports memory').toBeVisible();
    note(testInfo, `status panel: ${((await memoryRow.textContent()) ?? '').trim()}`);
    await shot(tab, testInfo, 'status-panel');
  } finally {
    await tab.close();
  }
  if (hasMemoryStep) {
    throw new Error(
      `guided setup now has a memory step (${steps.join(' > ')}): replace this PENDING check with the real memory-step test (see README)`,
    );
  }
  expect(steps, 'today the guided setup has no memory step').toEqual(
    expect.arrayContaining(['Access', 'Model provider', 'Model', 'Persona', 'Finish']),
  );
  if (state.finishHint) note(testInfo, `finish page: "${state.finishHint}"`);
  test.fixme(
    true,
    `PENDING ${ISSUES.memory}: guided setup has no memory step (steps: ${steps.join(' > ') || 'unknown'}). ` +
      'Done when: setup includes a memory step that picks the vector store, the embedding provider and the embedding model, ' +
      'runs a live embed check that must succeed, turns autoRecall on, and setup is not finished until a test memory is ' +
      'written, embedded and recalled in chat.',
  );
});

test('J4 start a chat; the agent answers', async ({}, testInfo) => {
  testInfo.setTimeout(10 * 60_000);
  if (PROVIDER === 'mock') testInfo.annotations.push({ type: 'label', description: 'mock' });
  else testInfo.annotations.push({ type: 'label', description: `${PROVIDER} ${readState().chosenModel ?? PROVIDER_MODEL}` });
  const state = readState();
  const startChat = page.getByRole('button', { name: 'Start a chat' });
  if (state.finishReached && (await appears(startChat, 3_000))) {
    await startChat.click();
  } else {
    note(testInfo, 'not on the Finish page: opened /c/new');
    await ensureSignedIn(page);
    await page.goto('/c/new');
  }
  await expect(page).toHaveURL(/\/c\/new/, { timeout: 30_000 });
  // #102: the agent should speak first. Watch for a while before typing anything.
  const spoke = await page
    .waitForResponse((r) => /\/api\/(agents\/)?chat/.test(new URL(r.url()).pathname) && r.request().method() === 'POST', {
      timeout: 15_000,
    })
    .then(() => true)
    .catch(() => false);
  writeState({ agentSpokeFirst: spoke });
  note(testInfo, spoke ? 'the agent started the conversation' : 'the chat opened empty; the agent did not speak first');
  await shot(page, testInfo, 'new-chat');
  await ensureMindStoneModel(page, testInfo);
  const prompt = 'Hi! I just set you up. Please say hello back in one short sentence.';
  const reply = await sendAndWaitForReply(page, prompt);
  writeState({ conversationUrl: page.url(), firstReply: reply.text.slice(0, 500) });
  await attachText(
    testInfo,
    'reply.txt',
    `> ${prompt}\n\n${reply.text}\n\n[content parts: ${reply.contentTypes.join(', ') || 'none'}]${reply.errorText ? `\n[error: ${reply.errorText}]` : ''}\n`,
  );
  await shot(page, testInfo, 'reply');
  await gatewayExcerpt(testInfo, 40);
  expect(reply.error, `the Console stored an error, not an answer: ${(reply.errorText ?? '').slice(0, 200)}`).toBe(false);
  expect(reply.text.length, 'the reply has text').toBeGreaterThan(0);
  expect(reply.text, 'the reply is an answer, not an error message').not.toMatch(ERROR_REPLY);
  note(testInfo, `reply: "${reply.text.slice(0, 160)}"`);
});

test('J5 identity formation on the first chat', async ({}, testInfo) => {
  await ensureSignedIn(page);
  const state = readState();
  await page.goto('/mindstone');
  await expect(page.getByRole('heading', { name: 'MindStone settings' })).toBeVisible();
  const identityRow = page.getByTestId('ms-step-identity');
  const hasIdentityStep = await appears(identityRow, 5_000);
  await shot(page, testInfo, 'status-panel');
  note(testInfo, `agent spoke first: ${state.agentSpokeFirst === true ? 'yes' : 'no'}`);
  if (state.firstReply) note(testInfo, `first reply: "${state.firstReply.slice(0, 160)}"`);
  if (!hasIdentityStep && state.agentSpokeFirst !== true) {
    test.fixme(
      true,
      `PENDING ${ISSUES.identity}: Console setup doesn't start identity formation, and the chat opens empty. ` +
        'Done when: after Finish, "Start a chat" opens a chat where the agent speaks first with the identity-formation ' +
        '("who are you, how do you want to work") conversation; the admin API onboarding writes the onboarding record and ' +
        'the identity/user scaffold; and the status checklist (GET /admin/status or /admin/onboarding) reports an identity step as done.',
    );
  }
  // The feature has (partly) landed: these are the real assertions.
  expect(state.agentSpokeFirst, 'the agent speaks first after "Start a chat"').toBe(true);
  expect(hasIdentityStep, 'the status panel reports an identity step').toBe(true);
  await expect(identityRow).toContainText('✓');
});

test('J6 memory recall within the conversation', async ({}, testInfo) => {
  testInfo.setTimeout(12 * 60_000);
  await ensureSignedIn(page);
  const state = readState();
  expect(state.conversationUrl, 'J4 left a conversation to continue').toBeTruthy();
  await page.goto(state.conversationUrl!);
  await ensureMindStoneModel(page, testInfo);
  const codeword = `${['amber', 'cobalt', 'violet', 'saffron'][Date.now() % 4]}-heron-${1000 + (Date.now() % 9000)}`;
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
  // An error or an empty reply is a FAIL (chat is broken), not a missing feature.
  expect(r3.error, `the recall reply is not an error: ${(r3.errorText ?? '').slice(0, 200)}`).toBe(false);
  expect(r3.text.length, 'the recall reply has text').toBeGreaterThan(0);
  if (!r3.text.toLowerCase().includes(codeword.toLowerCase())) {
    test.fixme(
      true,
      `PENDING ${ISSUES.memory}: the agent did not recall "${codeword}" from earlier in the conversation. ` +
        'Done when: the agent recalls a fact from earlier in the same conversation, and (per #106) a test memory written ' +
        'during setup is embedded and recalled in chat.',
    );
  }
  note(testInfo, 'in-conversation recall only (the context window); durable, embedded recall is part of J3');
});

test('J7 Skill Builder from the Console and from chat', async ({}, testInfo) => {
  await ensureSignedIn(page);
  await page.goto('/mindstone');
  await expect(page.getByRole('heading', { name: 'MindStone settings' })).toBeVisible();
  const builder = page.getByRole('link', { name: /skill/i }).or(page.getByRole('heading', { name: /skill builder/i }));
  const present = await appears(builder, 5_000);
  await shot(page, testInfo, 'settings');
  // What's there today: the Approvals page, which the chat half will use.
  await page.goto('/mindstone/approvals');
  await expect(page.getByRole('heading', { name: 'Approvals' }).first()).toBeVisible();
  await shot(page, testInfo, 'approvals');
  if (present) {
    throw new Error('the Console now shows a Skill Builder: replace this PENDING check with the real #104 test (see README)');
  }
  test.fixme(
    true,
    `PENDING ${ISSUES.skills}: no Skill Builder in the Console and no chat tool for it (CLI only today). ` +
      'Done when: an admin builds a skill in the Console (from a built-in or from scratch: id, label, description, goal), ' +
      'reviews the draft and installs it, and skill status shows it active; and the agent, asked in chat, drafts a skill and ' +
      'proposes it for install, the admin approves it on Approvals, and it is used.',
  );
});

test('J8 the agent drafts its persona; approved in the Console', async ({}, testInfo) => {
  await ensureSignedIn(page);
  await page.goto('/mindstone');
  await expect(page.getByRole('heading', { name: 'MindStone settings' })).toBeVisible();
  const personas = page.getByRole('link', { name: /persona/i }).or(page.getByRole('heading', { name: /personas/i }));
  const present = await appears(personas, 5_000);
  await shot(page, testInfo, 'settings');
  const approvals = await consoleApi<unknown>(page, 'GET', '/api/mindstone/admin/approvals');
  note(testInfo, `approvals API: HTTP ${approvals.status}`);
  if (present) {
    throw new Error('the Console now lists personas: replace this PENDING check with the real #105 test (see README)');
  }
  test.fixme(
    true,
    `PENDING ${ISSUES.persona}: nothing can create a persona, and the Console has no persona page. ` +
      'Done when: in chat the agent proposes a persona overlay (name, voice, working style, boundaries); the admin sees it on ' +
      'Approvals, approves it, and it becomes the active persona; the next chat uses it; it never overrides IDENTITY.md/USER.md ' +
      'or safety rules; and the Console lists personas and can switch between them.',
  );
});
