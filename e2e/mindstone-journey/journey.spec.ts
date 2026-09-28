/**
 * The MindStone demo journey (MindStone-Agent #106), in the Console UI only,
 * against a fresh install made by run-journey.sh. Each step is its own test
 * and reports PASS, FAIL, PENDING or MOCK.
 *
 * PENDING steps first assert today's exact state: the setup step list, the
 * gateway's onboarding checklist keys, the links on /mindstone, and 404 from
 * the admin routes the feature will add. Only if all of that is unchanged do
 * they call test.fixme() with the issue's "done when". Any change fails the
 * step with "state changed: review this PENDING test", so a landed (or half
 * landed) feature can't sit unnoticed as PENDING.
 */
import { expect, test } from '@playwright/test';
import type { BrowserContext, Page, Request, TestInfo } from '@playwright/test';
import {
  ERROR_REPLY,
  PROVIDER,
  PROVIDER_MODEL,
  TODAY_SETUP_STEPS,
  TODAY_STATUS_STEPS,
  adminStatus,
  appears,
  attachText,
  consoleApi,
  ensureMindStoneModel,
  ensureSignedIn,
  fillSecret,
  gatewayExcerpt,
  note,
  probeGatewayAdmin,
  readSecretFile,
  readState,
  sendAndWaitForReply,
  shot,
  signIn,
  answeredBy,
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

/** The links in /mindstone's status section today (the setup link reads "Run guided setup again" once set up). */
const TODAY_STATUS_LINKS = ['Run guided setup again', 'Diagnostics', 'Approvals'];

/** Gateway admin routes #104 and #105 are likely to add; all 404 today. GET only: a probe never changes anything. */
const SKILL_ROUTES = ['/admin/skills', '/admin/skills/builder', '/admin/skills/drafts', '/admin/skills/build'];
const PERSONA_ROUTES = ['/admin/personas', '/admin/personas/proposals', '/admin/persona'];

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
  return (await section.getByRole('link').allTextContents()).map((s) => s.trim());
}

async function probeAll(testInfo: TestInfo, routes: string[]) {
  const results = [];
  for (const route of routes) results.push(await probeGatewayAdmin(route));
  await attachText(testInfo, 'gateway-probes.txt', results.map((r) => `GET ${r.route} -> ${r.status} ${r.error}`).join('\n'));
  return results.map((r) => `${r.route}:${r.status}`);
}

test('J1 sign in as admin; the setup banner is visible', async ({}, testInfo) => {
  await page.goto('/login');
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

test('J2 guided setup in the UI: access, provider, model, persona, finish', async ({}, testInfo) => {
  if (PROVIDER === 'mock') testInfo.annotations.push({ type: 'mock', description: 'mock provider' });
  await ensureSignedIn(page, { stayIfSignedIn: true });
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

  // Access, on a fresh install: always off, so the phrase is always typed (capital + trailing space).
  await test.step('access', async () => {
    const confirm = page.getByRole('textbox', { name: 'Confirmation' });
    const next = page.getByRole('button', { name: 'Next' });
    await expect(confirm.or(next).first()).toBeVisible({ timeout: 30_000 });
    expect(await next.isVisible(), 'advanced settings are off on a fresh install (the access step asks for the phrase)').toBe(false);
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
    note(testInfo, 'MOCK run: model, persona and finish screens skipped (they need a real provider)');
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

  // Finish: the gateway reports set up, and the banner is gone.
  await test.step('finish', async () => {
    await expect(page.getByRole('heading', { name: 'MindStone is set up' })).toBeVisible();
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
      await tab.goto('/c/new');
      await statusCall;
      await tab.waitForTimeout(1_500);
      await expect(tab.getByTestId('mindstone-setup-banner'), 'the setup banner is gone once set up').toHaveCount(0);
      await shot(tab, testInfo, 'banner-gone');
    } finally {
      await tab.close();
    }
  });
});

test('J3 memory in guided setup: vector store, embedding provider and model, live embed check', async ({}, testInfo) => {
  const state = readState();
  const steps = state.setupSteps ?? [];
  // What's there today, checked in a second tab so the main one stays on Finish for J4.
  await ensureSignedIn(page, { stayIfSignedIn: true });
  const tab = await context.newPage();
  let statusKeys: string[] = [];
  try {
    await tab.goto('/mindstone');
    await expect(tab.getByRole('heading', { name: 'MindStone settings' })).toBeVisible();
    const memoryRow = tab.getByTestId('ms-step-memory');
    await expect(memoryRow, 'the status panel reports memory').toBeVisible();
    note(testInfo, `status panel: ${((await memoryRow.textContent()) ?? '').trim()}`);
    await shot(tab, testInfo, 'status-panel');
    statusKeys = (await adminStatus(tab)).stepKeys;
  } finally {
    await tab.close();
  }
  requireUnchanged('the guided setup steps', steps, TODAY_SETUP_STEPS);
  requireUnchanged('the /admin/status checklist keys', statusKeys, TODAY_STATUS_STEPS);
  if (state.finishHint) note(testInfo, `finish page: "${state.finishHint}"`);
  test.fixme(
    true,
    `PENDING ${ISSUES.memory}: guided setup has no memory step (steps: ${steps.join(' > ')}). ` +
      'Done when: setup includes a memory step that picks the vector store, the embedding provider and the embedding model, ' +
      'runs a live embed check that must succeed, turns autoRecall on, and setup is not finished until a test memory is ' +
      'written, embedded and recalled in chat.',
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
  // #102: does the agent speak first? Listen before "Start a chat" navigates, so nothing is missed.
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
    await page.goto('/c/new');
  }
  await expect(page).toHaveURL(/\/c\/new/, { timeout: 30_000 });
  await page.waitForTimeout(15_000);
  page.off('request', onRequest);
  const spoke = chatPosts.length > 0;
  writeState({ agentSpokeFirst: spoke });
  note(testInfo, spoke ? `the agent started the conversation (${chatPosts.join(', ')})` : 'the chat opened empty; the agent did not speak first');
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
  const called = answered?.provider && answered?.model ? `${answered.provider}/${answered.model}` : '';
  note(testInfo, `answered by: ${called || 'unknown'} (gateway: ${answered?.gatewayProvider} ${answered?.gatewayModel})`);
  expect(
    called === state.chosenModel || answered?.model === PROVIDER_MODEL,
    `the Pi session called ${state.chosenModel} (it recorded ${called || 'no provider/model'})`,
  ).toBe(true);
});

test('J5 identity formation on the first chat', async ({}, testInfo) => {
  await ensureSignedIn(page);
  const state = readState();
  await page.goto('/mindstone');
  await expect(page.getByRole('heading', { name: 'MindStone settings' })).toBeVisible();
  await shot(page, testInfo, 'status-panel');
  const status = await adminStatus(page);
  note(testInfo, `agent spoke first: ${state.agentSpokeFirst === true ? 'yes' : 'no'}; checklist: ${status.stepKeys.join(', ')}`);
  if (state.firstReply) note(testInfo, `first reply: "${state.firstReply.slice(0, 160)}"`);
  expect(state.agentSpokeFirst, 'J4 recorded whether the agent spoke first').not.toBeUndefined();
  requireUnchanged('the /admin/status checklist keys (no identity step yet)', status.stepKeys, TODAY_STATUS_STEPS);
  requireUnchanged('whether the agent speaks first after "Start a chat"', state.agentSpokeFirst, false);
  test.fixme(
    true,
    `PENDING ${ISSUES.identity}: Console setup doesn't start identity formation, and the chat opens empty. ` +
      'Done when: after Finish, "Start a chat" opens a chat where the agent speaks first with the identity-formation ' +
      '("who are you, how do you want to work") conversation; the admin API onboarding writes the onboarding record and ' +
      'the identity/user scaffold; and the status checklist (GET /admin/status or /admin/onboarding) reports an identity step as done.',
  );
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
  expect(r3.error, `the recall reply is not an error: ${(r3.errorText ?? '').slice(0, 200)}`).toBe(false);
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
  await ensureSignedIn(page);
  await page.goto('/mindstone');
  await expect(page.getByRole('heading', { name: 'MindStone settings' })).toBeVisible();
  const links = await statusLinks(page);
  await shot(page, testInfo, 'settings');
  // What's there today: the Approvals page, which the chat half will use.
  await page.goto('/mindstone/approvals');
  await expect(page.getByRole('heading', { name: 'Approvals' }).first()).toBeVisible();
  await shot(page, testInfo, 'approvals');
  const probes = await probeAll(testInfo, SKILL_ROUTES);
  note(testInfo, `links: ${links.join(', ')}; gateway: ${probes.join(', ')}`);
  requireUnchanged('the links on /mindstone', links, TODAY_STATUS_LINKS);
  requireUnchanged('the gateway skill routes', probes, SKILL_ROUTES.map((r) => `${r}:404`));
  test.fixme(
    true,
    `PENDING ${ISSUES.skills}: no Skill Builder in the Console, no admin API route and no chat tool for it (CLI only today). ` +
      'Done when: an admin builds a skill in the Console (from a built-in or from scratch: id, label, description, goal), ' +
      'reviews the draft and installs it, and skill status shows it active; and the agent, asked in chat, drafts a skill and ' +
      'proposes it for install, the admin approves it on Approvals, and it is used.',
  );
});

test('J8 the agent drafts its persona; approved in the Console', async ({}, testInfo) => {
  await ensureSignedIn(page);
  await page.goto('/mindstone');
  await expect(page.getByRole('heading', { name: 'MindStone settings' })).toBeVisible();
  const links = await statusLinks(page);
  await shot(page, testInfo, 'settings');
  const approvals = await consoleApi<unknown>(page, 'GET', '/api/mindstone/admin/approvals');
  const probes = await probeAll(testInfo, PERSONA_ROUTES);
  note(testInfo, `approvals API: HTTP ${approvals.status}; links: ${links.join(', ')}; gateway: ${probes.join(', ')}`);
  requireUnchanged('the links on /mindstone', links, TODAY_STATUS_LINKS);
  requireUnchanged('the gateway persona routes', probes, PERSONA_ROUTES.map((r) => `${r}:404`));
  test.fixme(
    true,
    `PENDING ${ISSUES.persona}: nothing can create a persona, and the Console has no persona page. ` +
      'Done when: in chat the agent proposes a persona overlay (name, voice, working style, boundaries); the admin sees it on ' +
      'Approvals, approves it, and it becomes the active persona; the next chat uses it; it never overrides IDENTITY.md/USER.md ' +
      'or safety rules; and the Console lists personas and can switch between them.',
  );
});
