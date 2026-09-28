/**
 * Helpers for the journey spec: evidence (screenshots, log excerpts), shared
 * state between steps, sign-in, and reading a conversation's persisted
 * messages. Nothing here prints a secret.
 */
import fs from 'node:fs';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import type { Locator, Page, TestInfo } from '@playwright/test';

export const EVIDENCE = process.env.UAT_EVIDENCE_DIR ?? path.resolve(__dirname, '..', 'evidence', 'manual');
export const SHOTS = path.join(EVIDENCE, 'screens');
export const LOGS = path.join(EVIDENCE, 'logs');
const STATE_FILE = path.join(EVIDENCE, 'journey-state.json');

export const PROVIDER = (process.env.UAT_PROVIDER ?? 'mock') as 'ollama' | 'ollama-cloud' | 'mock';
export const PROVIDER_MODEL = process.env.UAT_PROVIDER_MODEL ?? '';
/** The agent the chat uses: the gateway lists each persona as mindstone/<agentId>. */
export const CHAT_MODEL = process.env.UAT_CHAT_MODEL ?? 'mindstone/default';
/** The Console's endpoint label (mindstone/librechat.yaml). */
export const ENDPOINT_LABEL = process.env.UAT_ENDPOINT_LABEL ?? 'MindStone';

/** State that later steps need, kept on disk: a failed step restarts the worker. */
export type JourneyState = {
  setupSteps?: string[];
  enteredSetupVia?: 'banner' | 'direct-url';
  finishReached?: boolean;
  finishHint?: string;
  chosenModel?: string;
  conversationUrl?: string;
  agentSpokeFirst?: boolean;
  firstReply?: string;
  /** Set when J2 finished guided setup; later steps that depend on it report "blocked by J2" otherwise. */
  j2Passed?: boolean;
  /** Which guided-setup flow the Console under test has (detected from its step list in J2). */
  flow?: FlowName;
  /** The memory step's Test result text, and the embedding model chosen there (#102 flow). */
  memoryCheck?: string;
  embedModel?: string;
  /** The first user turn of J4's conversation (sent by Start a chat itself in the #102 flow). */
  firstUserText?: string;
  /** The reply to J4's own hello (the last exchange J4 checked). */
  lastReply?: string;
  /** J4's conversation, and the stored ids of its first and last replies (for the scoped screen checks). */
  conversationId?: string;
  firstReplyId?: string;
  lastReplyId?: string;
  /** Whether setup's "Recall memories automatically" was on by default (J2 leaves it as it is; J9 judges it). */
  recallDefaultOn?: boolean;
  /** The codeword J6 asked the agent to remember in the conversation (J9 checks no memory store holds it yet). */
  j6Codeword?: string;
};

/**
 * The guided-setup flows the harness knows, by their "Setup steps" list. J2 detects which one the
 * Console under test has and drives it; the PENDING checks compare against that flow's exact state.
 * - `pre-102`: Access, provider, model, persona, finish (mindstone-console main before #102).
 * - `102`: adds Memory, Connectors and About you; Start a chat sends the first turn itself and the
 *   agent answers with identity formation (mindstone-console #23 with MindStone-Agent #111).
 */
export const FLOWS = {
  'pre-102': {
    setupSteps: ['Access', 'Model provider', 'Model', 'Persona', 'Finish'],
    statusSteps: ['connectors', 'memory', 'persona', 'provider'],
    label: 'pre-#102 setup (Access, Model provider, Model, Persona, Finish)',
  },
  '102': {
    setupSteps: ['Access', 'Model provider', 'Model', 'Persona', 'Memory', 'Connectors', 'About you', 'Finish'],
    statusSteps: ['connectors', 'identity', 'memory', 'persona', 'provider'],
    label: '#102 setup (adds Memory, Connectors, About you; the agent speaks first)',
  },
} as const;
export type FlowName = keyof typeof FLOWS;

/** The flow whose step list is exactly `steps`, if any. */
export function detectFlow(steps: string[]): FlowName | undefined {
  return (Object.keys(FLOWS) as FlowName[]).find(
    (name) => JSON.stringify(FLOWS[name].setupSteps) === JSON.stringify(steps),
  );
}

export function readState(): JourneyState {
  try {
    return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')) as JourneyState;
  } catch {
    return {};
  }
}

export function writeState(patch: Partial<JourneyState>): JourneyState {
  const next = { ...readState(), ...patch };
  fs.mkdirSync(EVIDENCE, { recursive: true });
  fs.writeFileSync(STATE_FILE, `${JSON.stringify(next, null, 2)}\n`);
  return next;
}

export function stepId(testInfo: TestInfo): string {
  return testInfo.title.match(/^(J\d+)/)?.[1]?.toLowerCase() ?? 'j';
}

/** Lists a file (under the evidence dir) as this step's evidence in the summary. */
function evidence(testInfo: TestInfo, file: string) {
  testInfo.annotations.push({ type: 'evidence', description: path.relative(EVIDENCE, file) });
}

/** A full-page screenshot into evidence/screens, attached to the step. */
export async function shot(page: Page, testInfo: TestInfo, name: string): Promise<string> {
  fs.mkdirSync(SHOTS, { recursive: true });
  const file = path.join(SHOTS, `${stepId(testInfo)}-${name}.png`);
  await page.screenshot({ path: file, fullPage: true }).catch(() => undefined);
  if (fs.existsSync(file)) {
    await testInfo.attach(name, { path: file, contentType: 'image/png' });
    evidence(testInfo, file);
  }
  return file;
}

/** A text file into evidence/logs, attached to the step. */
export async function attachText(testInfo: TestInfo, name: string, text: string): Promise<string> {
  fs.mkdirSync(LOGS, { recursive: true });
  const file = path.join(LOGS, `${stepId(testInfo)}-${name}`);
  fs.writeFileSync(file, text.endsWith('\n') ? text : `${text}\n`);
  await testInfo.attach(name, { path: file, contentType: 'text/plain' });
  evidence(testInfo, file);
  return file;
}

/** The last lines of the gateway log, as a log excerpt for the step. */
export async function gatewayExcerpt(testInfo: TestInfo, lines = 80): Promise<void> {
  const log = process.env.UAT_GATEWAY_LOG;
  if (!log || !fs.existsSync(log)) return;
  const tail = fs.readFileSync(log, 'utf8').split('\n').slice(-lines).join('\n');
  await attachText(testInfo, 'gateway-tail.log', tail);
}

/** Waits up to `timeout` for the locator to show; true if it did. (`isVisible()` doesn't wait.) */
export async function appears(locator: Locator, timeout: number): Promise<boolean> {
  return locator
    .first()
    .waitFor({ state: 'visible', timeout })
    .then(() => true)
    .catch(() => false);
}

export function note(testInfo: TestInfo, text: string) {
  testInfo.annotations.push({ type: 'note', description: text });
}

/**
 * Types a secret into an input without it being recorded anywhere: Playwright
 * puts `fill()`'s value in the step title ("Fill \"…\""), which reports and
 * traces keep. This sets the value in the page (React's value setter, then
 * input and change events), under a step whose title carries no value.
 */
export async function fillSecret(locator: Locator, value: string): Promise<void> {
  await test.step('type a secret (value not recorded)', async () => {
    await locator.waitFor({ state: 'visible' });
    await locator.evaluate((element, secret) => {
      const input = element as HTMLInputElement;
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
      input.focus();
      setter?.call(input, secret);
      input.dispatchEvent(new Event('input', { bubbles: true }));
      input.dispatchEvent(new Event('change', { bubbles: true }));
    }, value);
  });
}

export function readSecretFile(envName: string): string {
  const file = process.env[envName];
  if (!file) throw new Error(`${envName} is not set`);
  return fs.readFileSync(file, 'utf8').trim();
}

/**
 * Signs in on /login unless the session is still good. With stayIfSignedIn, a
 * page already inside the app (not /login, not blank) is left where it is.
 */
export async function ensureSignedIn(page: Page, options: { stayIfSignedIn?: boolean } = {}): Promise<void> {
  const url = page.url();
  if (options.stayIfSignedIn && /^https?:/.test(url) && !url.includes('/login')) return;
  await page.goto('/c/new');
  await page.waitForLoadState('domcontentloaded');
  const onLogin = await page
    .waitForURL(/\/login/, { timeout: 5_000 })
    .then(() => true)
    .catch(() => page.url().includes('/login'));
  if (!onLogin) return;
  await signIn(page);
}

export async function signIn(page: Page): Promise<void> {
  if (!page.url().includes('/login')) await page.goto('/login');
  await page.getByLabel('Email').fill(process.env.UAT_ADMIN_EMAIL ?? '');
  await fillSecret(page.getByLabel('Password'), readSecretFile('UAT_ADMIN_PASSWORD_FILE'));
  await page.getByTestId('login-button').click();
  await page.waitForURL(/\/c\//, { timeout: 60_000 });
}

/** The Console's own access token (from its refresh cookie), for reading what the UI shows. */
export async function accessToken(page: Page): Promise<string> {
  const token = await page.evaluate(async () => {
    const response = await fetch('/api/auth/refresh', {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: '{}',
    });
    const body = (await response.json().catch(() => ({}))) as { token?: string };
    return body.token ?? '';
  });
  if (!token) throw new Error('no access token from /api/auth/refresh: not signed in?');
  return token;
}

export async function consoleApi<T = unknown>(
  page: Page,
  method: string,
  url: string,
  body?: unknown,
): Promise<{ status: number; json: T }> {
  const token = await accessToken(page);
  return page.evaluate(
    async ({ method, url, body, token }) => {
      const response = await fetch(url, {
        method,
        credentials: 'include',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      const text = await response.text();
      let json: unknown = null;
      try {
        json = JSON.parse(text);
      } catch {
        json = text;
      }
      return { status: response.status, json: json as never };
    },
    { method, url, body, token },
  );
}

export type StoredMessage = {
  messageId: string;
  parentMessageId?: string;
  isCreatedByUser?: boolean;
  unfinished?: boolean;
  error?: boolean;
  text?: string;
  content?: Array<{ type?: string; text?: string | { value?: string }; error?: string }>;
};

export function messageText(message: StoredMessage): string {
  const parts = (message.content ?? [])
    .filter((part) => part?.type === 'text')
    .map((part) => (typeof part.text === 'string' ? part.text : (part.text?.value ?? '')));
  const joined = parts.join('\n').trim();
  return joined || (message.text ?? '').trim();
}

/** An error the Console stored in place of an answer: the error flag, or an `error` content part. */
export function messageError(message: StoredMessage): string | undefined {
  const parts = (message.content ?? []).filter((part) => part?.type === 'error');
  if (parts.length) {
    return parts.map((part) => part.error ?? (typeof part.text === 'string' ? part.text : '') ?? 'error').join(' ').trim() || 'error part';
  }
  return message.error === true ? messageText(message) || 'error flag set' : undefined;
}

export function conversationId(url: string): string | undefined {
  const match = new URL(url).pathname.match(/^\/c\/([^/]+)\/?$/);
  return match && match[1] !== 'new' ? decodeURIComponent(match[1]) : undefined;
}

/** Makes sure the MindStone endpoint and agent are selected in the composer. */
export async function ensureMindStoneModel(page: Page, testInfo: TestInfo): Promise<void> {
  const trigger = page.getByRole('button', { name: 'Select a model' }).first();
  await expect(trigger).toBeVisible({ timeout: 30_000 });
  const current = (await trigger.textContent())?.trim() ?? '';
  if (current && !/select a model/i.test(current)) {
    note(testInfo, `model menu shows "${current}"`);
    return;
  }
  await trigger.click();
  await page.getByRole('option', { name: new RegExp(ENDPOINT_LABEL, 'i') }).first().click();
  const model = page.getByRole('option', { name: CHAT_MODEL, exact: true });
  if (await appears(model, 3_000)) await model.click();
  await expect(trigger).not.toHaveText(/select a model/i);
  note(testInfo, `model menu set to ${ENDPOINT_LABEL} / ${CHAT_MODEL}`);
}

/**
 * Types a message in the composer, sends it, and waits until the Console has
 * stored the assistant's reply to it (finished, not streaming). Returns the
 * reply as stored, which is what the user sees after a reload.
 */
export async function sendAndWaitForReply(
  page: Page,
  text: string,
  timeoutMs = 240_000,
): Promise<Reply> {
  const input = page.getByRole('textbox', { name: 'Message input' });
  await expect(input).toBeVisible({ timeout: 30_000 });
  await input.click();
  await input.fill(text);
  await input.press('Enter');
  return waitForReplyTo(page, text, timeoutMs);
}

export type Reply = {
  /** The stored reply's id, and how the screen check found it ('by-id' or 'assistant-turn'). */
  messageId: string;
  shownBy: string;
  userText: string;
  text: string;
  error: boolean;
  errorText?: string;
  contentTypes: string[];
  conversationId: string;
};

/**
 * Waits until the Console has stored the assistant's finished reply to a
 * user turn, then requires both turns to be visible on screen. `text` is the
 * user turn; without it, the conversation's first user turn is used (the one
 * Start a chat sends by itself in the #102 flow). Returns the reply as stored.
 */
export async function waitForReplyTo(page: Page, text: string | undefined, timeoutMs = 240_000): Promise<Reply> {
  await page.waitForURL((url) => conversationId(url.toString()) !== undefined, { timeout: 60_000 });
  const convo = conversationId(page.url())!;
  const deadline = Date.now() + timeoutMs;
  let lastSeen = '';
  let stableSince = 0;
  while (Date.now() < deadline) {
    const { status, json } = await consoleApi<StoredMessage[]>(
      page,
      'GET',
      `/api/messages/${encodeURIComponent(convo)}`,
    );
    if (status === 200 && Array.isArray(json)) {
      const users = json.filter((m) => m.isCreatedByUser && (text === undefined || messageText(m) === text));
      const user = text === undefined ? users[0] : users[users.length - 1];
      const reply = user && json.find((m) => !m.isCreatedByUser && m.parentMessageId === user.messageId);
      if (user && reply && !reply.unfinished) {
        const replyText = messageText(reply);
        const errorText = messageError(reply);
        const signature = `${errorText}|${replyText}`;
        if (signature === lastSeen && Date.now() - stableSince > 2_000) {
          // Stored is not enough: the user must see it. Both turns must be on the screen.
          const shown =
            errorText === undefined && replyText
              ? await expectOnScreen(page, replyText, 'the stored reply', { role: 'assistant', messageId: reply.messageId })
              : '';
          await expectOnScreen(page, messageText(user), 'the user turn', { role: 'user' });
          return {
            messageId: reply.messageId,
            shownBy: shown,
            userText: messageText(user),
            text: replyText,
            error: errorText !== undefined,
            errorText,
            contentTypes: (reply.content ?? []).map((part) => part?.type ?? '?'),
            conversationId: convo,
          };
        }
        if (signature !== lastSeen) {
          lastSeen = signature;
          stableSince = Date.now();
        }
      }
    }
    await page.waitForTimeout(1_500);
  }
  throw new Error(`no finished reply to ${text === undefined ? 'the first turn' : `"${text}"`} within ${Math.round(timeoutMs / 1000)}s`);
}

/** Text as it reads on screen: markdown markers and list bullets gone, whitespace collapsed. */
export function screenText(text: string): string {
  return text
    .replace(/```[a-z]*\n?/gi, ' ')
    .replace(/^\s*(?:[-*+]|\d+[.)])\s+/gm, ' ')
    .replace(/[*_`#>|~]/g, '')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\s+/g, ' ')
    .trim();
}

/** The start of the message as the screen shows it: up to 60 characters, cut at a word boundary. */
function screenSnippet(text: string): string {
  const flat = screenText(text);
  if (flat.length <= 60) return flat;
  const cut = flat.slice(0, 60);
  return cut.slice(0, Math.max(cut.lastIndexOf(' '), 20)).trim();
}

type ScreenRole = 'assistant' | 'user';
// Shared with lib/screen-check.selftest.mjs, so the self-test runs the same in-page code.
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { screenMatch } = require('./screen-match.js') as {
  screenMatch: (arg: { needle: string; role: ScreenRole; messageId?: string }) => string;
};

/**
 * Asserts the message is visible in the rendered conversation: the text the
 * browser actually renders (innerText of visible message bodies), not the
 * database. Streaming could break while the server still stores the reply;
 * this is what would catch a demo that shows a spinner. A reply must be in
 * the assistant row with the stored reply's messageId (or, if the row kept a
 * client-side id, in an assistant turn); a user bubble never counts as the
 * reply, so a codeword the user typed can't satisfy J6. Returns how it matched.
 */
export async function expectOnScreen(
  page: Page,
  text: string,
  what: string,
  opts: { role?: ScreenRole; messageId?: string; timeout?: number } = {},
): Promise<string> {
  const snippet = screenSnippet(text);
  const arg = { needle: snippet, role: opts.role ?? 'assistant', messageId: opts.messageId };
  let how = '';
  await expect
    .poll(
      async () => {
        how = await page.evaluate(screenMatch, arg);
        return how !== '';
      },
      { message: `${what} is visible in the message list (${arg.role} turn${arg.messageId ? ` ${arg.messageId}` : ''}): "${snippet}"`, timeout: opts.timeout ?? 30_000 },
    )
    .toBe(true);
  return how;
}

/** GET /admin/status through the Console's admin proxy: `onboarded` and the checklist keys. */
export async function adminStatus(page: Page): Promise<{ onboarded: unknown; stepKeys: string[]; steps: Record<string, unknown> }> {
  const { status, json } = await consoleApi<{ onboarded?: unknown; steps?: Record<string, unknown> }>(
    page,
    'GET',
    '/api/mindstone/admin/status',
  );
  expect(status, 'GET /api/mindstone/admin/status').toBe(200);
  const steps = json.steps ?? {};
  return { onboarded: json.onboarded, stepKeys: Object.keys(steps).sort(), steps };
}

function headerFromFile(envName: string): [string, string] {
  const line = readSecretFile(envName);
  const at = line.indexOf(':');
  return [line.slice(0, at).trim(), line.slice(at + 1).trim()];
}

/**
 * GET a gateway admin route directly (a detection probe, not part of the
 * journey), with the service token and admin credential from the harness's
 * header files. Returns the status and the error text; never a header value.
 */
export async function probeGatewayAdmin(route: string): Promise<{ route: string; status: number; error: string }> {
  const base = process.env.UAT_GATEWAY_URL;
  if (!base) throw new Error('UAT_GATEWAY_URL is not set (run through run-journey.sh)');
  const headers = Object.fromEntries([
    headerFromFile('UAT_GATEWAY_AUTH_HEADER_FILE'),
    headerFromFile('UAT_GATEWAY_ADMIN_HEADER_FILE'),
    ['x-mindstone-user-id', 'uat-harness'],
    ['x-mindstone-user-role', 'admin'],
  ]);
  const response = await fetch(`${base}${route}`, { headers });
  const body = (await response.json().catch(() => ({}))) as { error?: string };
  return { route, status: response.status, error: String(body.error ?? '') };
}

type TranscriptLine = {
  role?: string;
  text?: string;
  metadata?: {
    model?: string;
    provider?: string;
    providerDiagnostics?: { piSession?: { sessionFile?: string; modelFallbackMessage?: string } };
  };
};

export type AnsweredBy = {
  /** The gateway's own ids (for a Pi session, provider "pi-session" and model "mindstone/<agent>"). */
  gatewayProvider?: string;
  gatewayModel?: string;
  /** What the Pi session actually called: the last provider/model pair its session file records. */
  provider?: string;
  model?: string;
  modelFallbackMessage?: string;
  transcriptFile?: string;
  sessionFile?: string;
};

/** The last {provider, model|modelId} pair anywhere in a JSONL file. */
function lastModelPair(file: string): { provider?: string; model?: string } {
  let last: { provider?: string; model?: string } = {};
  const visit = (value: unknown, depth: number) => {
    if (!value || typeof value !== 'object' || depth > 6) return;
    const record = value as Record<string, unknown>;
    const model = typeof record.model === 'string' ? record.model : typeof record.modelId === 'string' ? record.modelId : undefined;
    if (typeof record.provider === 'string' && model) last = { provider: record.provider, model };
    for (const child of Object.values(record)) visit(child, depth + 1);
  };
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    try {
      visit(JSON.parse(line), 0);
    } catch {
      // not JSON
    }
  }
  return last;
}

/**
 * Which model answered: the gateway transcript's assistant entry whose text
 * starts like the reply, and the Pi session file it points to, which records
 * the provider and model that were actually called.
 */
export function answeredBy(replyText: string): AnsweredBy | undefined {
  const dir = process.env.UAT_TRANSCRIPT_DIR;
  if (!dir || !fs.existsSync(dir)) return undefined;
  const head = replyText.trim().slice(0, 40);
  const files: string[] = [];
  const walk = (d: string) => {
    for (const entry of fs.readdirSync(d, { withFileTypes: true })) {
      const full = path.join(d, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (/\.jsonl?$/.test(entry.name)) files.push(full);
    }
  };
  walk(dir);
  for (const file of files) {
    for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
      if (!line.trim()) continue;
      let entry: TranscriptLine;
      try {
        entry = JSON.parse(line) as TranscriptLine;
      } catch {
        continue;
      }
      if (entry.role !== 'assistant' || !head || !(entry.text ?? '').trim().startsWith(head)) continue;
      const pi = entry.metadata?.providerDiagnostics?.piSession;
      const result: AnsweredBy = {
        gatewayProvider: entry.metadata?.provider,
        gatewayModel: entry.metadata?.model,
        modelFallbackMessage: pi?.modelFallbackMessage,
        transcriptFile: path.relative(dir, file),
        sessionFile: pi?.sessionFile ? path.basename(pi.sessionFile) : undefined,
      };
      if (pi?.sessionFile && fs.existsSync(pi.sessionFile)) Object.assign(result, lastModelPair(pi.sessionFile));
      return result;
    }
  }
  return undefined;
}

type SessionEntry = {
  sessionKey?: string;
  role?: string;
  text?: string;
  runId?: string;
  timestamp?: string;
  metadata?: {
    event?: string;
    mode?: string;
    personaContext?: { injected?: boolean; personaId?: string };
  };
};

// Shared with lib/recall-evidence.selftest.mjs, so the self-test runs the same transcript parsing and judging J9 uses.
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { sessionLines, recallEvidence, controlEvidence, isInvariantMarkdown } = require('./recall-evidence.js') as {
  sessionLines: (text: string, conversationId: string) => SessionEntry[];
  recallEvidence: (entries: SessionEntry[], token: string, chunks?: Record<string, { text: string; updatedAt?: string }>) => RecallEvidence;
  controlEvidence: (entries: SessionEntry[], token: string) => ControlEvidence;
  isInvariantMarkdown: (text: string) => boolean;
};

/** A Console conversation's gateway transcript entries (session key ending in its id), in order. */
function conversationEntries(conversationId: string): SessionEntry[] {
  const dir = process.env.UAT_TRANSCRIPT_DIR;
  if (!dir || !fs.existsSync(dir) || !conversationId) return [];
  const entries: SessionEntry[] = [];
  const walk = (d: string) => {
    for (const entry of fs.readdirSync(d, { withFileTypes: true })) {
      const full = path.join(d, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (/\.jsonl?$/.test(entry.name)) entries.push(...sessionLines(fs.readFileSync(full, 'utf8'), conversationId));
    }
  };
  walk(dir);
  return entries;
}

export type FormationEvidence = {
  sessionKey?: string;
  entries: number;
  /** Index (in the session's transcript order) of the identity_formation_prompted event, and of the first assistant entry. */
  promptedAt: number;
  firstAssistantAt: number;
  promptedRunId?: string;
  firstAssistantRunId?: string;
  mode?: string;
  /** The session's entries as role/event/runId only: no text. */
  outline: string[];
};

/**
 * What the gateway recorded for a Console conversation: its transcript
 * entries (session key ending in the conversation id), in order. Identity
 * formation shows as a `role: "event"` entry with `metadata.event:
 * "identity_formation_prompted"`, written when the prompt was injected into
 * that turn (MindStone-Agent #111); a turn without it wasn't formation, however
 * the reply reads.
 */
export function formationEvidence(conversationId: string): FormationEvidence | undefined {
  const entries = conversationEntries(conversationId);
  if (!entries.length) return undefined;
  const prompted = entries.findIndex((e) => e.role === 'event' && e.metadata?.event === 'identity_formation_prompted');
  const firstAssistant = entries.findIndex((e) => e.role === 'assistant');
  return {
    sessionKey: entries[0].sessionKey,
    entries: entries.length,
    promptedAt: prompted,
    firstAssistantAt: firstAssistant,
    promptedRunId: prompted >= 0 ? entries[prompted].runId : undefined,
    firstAssistantRunId: firstAssistant >= 0 ? entries[firstAssistant].runId : undefined,
    mode: prompted >= 0 ? entries[prompted].metadata?.mode : undefined,
    outline: entries.map((e, i) => `${i} ${e.role}${e.metadata?.event ? ` ${e.metadata.event}` : ''}${e.runId ? ` run ${e.runId}` : ''}`),
  };
}

/**
 * The persona that answered a Console conversation's latest turn (#105): the
 * gateway records the persona it injected on each assistant entry, in
 * metadata.personaContext (MindStone-Agent #112). Read by conversation, not by
 * reply text, so an older reply can't stand in for it.
 */
export function personaForConversation(conversationId: string): { found: boolean; personaId?: string } {
  const assistants = conversationEntries(conversationId).filter((e) => e.role === 'assistant');
  const latest = assistants[assistants.length - 1];
  if (!latest) return { found: false };
  const persona = latest.metadata?.personaContext;
  return { found: true, personaId: persona?.injected ? persona.personaId : undefined };
}

export type RecallEvidence = {
  entries: number;
  sessionKey?: string;
  /** Index of the reply's assistant entry, its run, and the index of the recall event in that turn (-1: none). */
  assistantAt: number;
  runId?: string;
  recallAt: number;
  recallEvents: number;
  hitCount: number;
  hits: { id?: string; chunkId?: string; title?: string; score?: number; recallMode?: string }[];
  /** Recalled chunks whose text (in the recall index) holds the token. */
  hitChunksWithToken: number;
  replyMemoryRecall?: { hitCount?: number; promptTokens?: number };
  otherEntriesWithToken: number;
  outline: string[];
  /** What the check couldn't run (not failures, but never silent). */
  notes: string[];
  /** Why the transcript doesn't prove recall; empty when it does. */
  reasons: string[];
};

export type ControlEvidence = { entries: number; assistantAt: number; recallEvents: number; withToken: number; outline: string[]; reasons: string[] };

/** The gateway's data dir (<checkout>/.runtime/mindstone); J5 and J9 read its records. */
function dataDir(): string {
  const dir = process.env.UAT_DATA_DIR ?? '';
  if (!dir || !fs.existsSync(dir)) throw new Error("UAT_DATA_DIR is not set or doesn't exist: the gateway's data dir (run through run-journey.sh)");
  return dir;
}

/** The recall index the gateway's sqlite-vec recall reads (MindStone-Agent: <dataDir>/vectors/memory.sqlite). */
function recallIndexPath(): string {
  return path.join(dataDir(), 'vectors', 'memory.sqlite');
}

export function recallIndexExists(): boolean {
  return fs.existsSync(recallIndexPath());
}

type SqliteDb = { prepare(sql: string): { all(...params: unknown[]): Record<string, unknown>[] }; close(): void };

/**
 * Runs `read` on the recall index, opened read-only with node:sqlite (Node
 * 22.13+; the harness needs 22.19). undefined when there's no index yet.
 */
function readRecallIndex<T>(read: (db: SqliteDb) => T): T | undefined {
  const file = recallIndexPath();
  if (!fs.existsSync(file)) return undefined;
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { DatabaseSync } = require('node:sqlite') as { DatabaseSync: new (file: string, options?: { readOnly?: boolean }) => SqliteDb };
  const db = new DatabaseSync(file, { readOnly: true });
  try {
    return read(db);
  } finally {
    db.close();
  }
}

/** Recall-index chunks whose text holds `token` and that are embedded (embedding_json set): the fact is ready to recall. */
export function embeddedChunksWith(token: string): { chunkId: string; kind: string; path: string | null }[] {
  return (
    readRecallIndex((db) =>
      db
        .prepare('SELECT chunk_id, kind, path FROM memory_chunks WHERE instr(lower(text), ?) > 0 AND embedding_json IS NOT NULL')
        .all(token.toLowerCase())
        .map((r) => ({ chunkId: String(r.chunk_id), kind: String(r.kind), path: r.path === null ? null : String(r.path) })),
    ) ?? []
  );
}

/**
 * Waits (polling, not sleeping blindly) until the recall index has an
 * embedded chunk holding `token`: the product's capture and indexing are
 * done. Returns at once when it's already there, and empty on timeout. An
 * index that can't be read yet (being created) counts as not ready.
 */
export async function waitForEmbeddedChunk(
  page: Page,
  token: string,
  timeoutMs: number,
): Promise<{ chunks: { chunkId: string; kind: string; path: string | null }[]; waitedMs: number; lastError?: string }> {
  const started = Date.now();
  let lastError: string | undefined;
  for (;;) {
    let chunks: { chunkId: string; kind: string; path: string | null }[] = [];
    try {
      chunks = embeddedChunksWith(token);
      lastError = undefined;
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }
    if (chunks.length || Date.now() - started >= timeoutMs) return { chunks, waitedMs: Date.now() - started, lastError };
    await page.waitForTimeout(2_000);
  }
}

/**
 * Whether the gateway's recall supplied `token` to a Console conversation's
 * latest turn (J9): its transcript's `memory_recall_injected` event for the
 * reply's own run, with hits, one of whose chunks (read from the recall
 * index by chunk_id) holds the token and was written no later than the
 * event (by updated_at, when the index has it); and the token in no other entry
 * (lib/recall-evidence.js). Read by conversation, so another chat's recall
 * can't stand in.
 */
export function recallForConversation(conversationId: string, token: string): RecallEvidence & { indexError?: string } {
  const entries = conversationEntries(conversationId);
  const chunkIds = entries
    .filter((e) => e.role === 'event' && e.metadata?.event === 'memory_recall_injected')
    .flatMap((e) => ((e.metadata as { hits?: { chunkId?: unknown }[] }).hits ?? []).map((h) => h?.chunkId))
    .filter((id): id is string => typeof id === 'string');
  let chunks: Record<string, { text: string; updatedAt?: string }> | undefined;
  let indexError: string | undefined;
  try {
    chunks = chunkIds.length
      ? readRecallIndex((db) => {
          // updated_at, when the index has the column: a chunk written after the recall event can't be what it injected.
          const hasUpdatedAt = db.prepare('PRAGMA table_info(memory_chunks)').all().some((c) => c.name === 'updated_at');
          return Object.fromEntries(
            db
              .prepare(`SELECT chunk_id, text${hasUpdatedAt ? ', updated_at' : ''} FROM memory_chunks WHERE chunk_id IN (${chunkIds.map(() => '?').join(', ')})`)
              .all(...chunkIds)
              .map((r) => [String(r.chunk_id), { text: String(r.text), ...(hasUpdatedAt ? { updatedAt: String(r.updated_at) } : {}) }]),
          );
        })
      : {};
  } catch (error) {
    indexError = error instanceof Error ? error.message : String(error);
  }
  const evidence = recallEvidence(entries, token, chunks);
  return indexError ? { ...evidence, indexError } : evidence;
}

/** J9's negative control: with automatic recall off, the conversation has no recall event and no token (lib/recall-evidence.js). */
export function controlForConversation(conversationId: string, token: string): ControlEvidence {
  return controlEvidence(conversationEntries(conversationId), token);
}

/** Text files under `dir` (recursively), or `dir` itself if it's a file. */
function filesUnder(dir: string): string[] {
  if (!fs.existsSync(dir)) return [];
  if (fs.statSync(dir).isFile()) return [dir];
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    return entry.isDirectory() ? filesUnder(full) : entry.isFile() ? [full] : [];
  });
}

/** Whether a file's bytes hold `text` (an ASCII token), ignoring case; binary files (the sqlite index) included. */
const fileHolds = (file: string, text: string) =>
  fs.statSync(file).size < 256 * 1024 * 1024 && fs.readFileSync(file).toString('latin1').toLowerCase().includes(text.toLowerCase());

/**
 * The files in the gateway's memory stores whose bytes hold `text`, as paths
 * relative to the data dir: <dataDir>/memory, <dataDir>/vectors (the sqlite
 * index included), <dataDir>/journals and <dataDir>/LOG.md. Left out:
 * memory/recall-usage.jsonl (a usage log, not a memory) and the transcripts
 * (they hold every message anyway).
 */
export function memoryStoreFilesWith(text: string): string[] {
  const root = dataDir();
  return ['memory', 'vectors', 'journals', 'LOG.md']
    .flatMap((store) => filesUnder(path.join(root, store)))
    .filter((file) => path.basename(file) !== 'recall-usage.jsonl' && fileHolds(file, text))
    .map((file) => path.relative(root, file))
    .sort();
}

/**
 * The files the gateway puts in every prompt, with no recall: each agent's
 * USER.md and IDENTITY.md (agents/<id>/, and any identityPath/userPath the
 * config names, relative to it), memory/MEMORY.md (the memory index), and
 * the invariant files (memory files with a top-level `invariant:`, which the
 * invariant tier injects on every turn). Returns what was checked and which
 * of them hold `text`, relative to the data dir.
 */
export function promptFilesWith(text: string): { checked: string[]; found: string[] } {
  const root = dataDir();
  const files = new Set<string>();
  for (const agent of fs.existsSync(path.join(root, 'agents')) ? fs.readdirSync(path.join(root, 'agents')) : []) {
    for (const name of ['USER.md', 'IDENTITY.md']) files.add(path.join(root, 'agents', agent, name));
  }
  try {
    const config = JSON.parse(fs.readFileSync(path.join(root, 'config.json'), 'utf8')) as unknown;
    const visit = (value: unknown, depth: number) => {
      if (!value || typeof value !== 'object' || depth > 6) return;
      for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
        if ((k === 'identityPath' || k === 'userPath') && typeof v === 'string') files.add(path.resolve(root, v));
        else visit(v, depth + 1);
      }
    };
    visit((config as { agents?: unknown }).agents, 0);
  } catch {
    // no readable config: the agents/ files still count
  }
  files.add(path.join(root, 'memory', 'MEMORY.md'));
  for (const store of ['memory', 'journals', 'LOG.md']) {
    for (const file of filesUnder(path.join(root, store))) {
      if (file.endsWith('.md') && isInvariantMarkdown(fs.readFileSync(file, 'utf8'))) files.add(file);
    }
  }
  const existing = [...files].filter((file) => fs.existsSync(file) && fs.statSync(file).isFile());
  return {
    checked: existing.map((file) => path.relative(root, file)).sort(),
    found: existing.filter((file) => fileHolds(file, text)).map((file) => path.relative(root, file)).sort(),
  };
}

/** Text that means the Console showed an error, not an answer. */
export const ERROR_REPLY =
  /(routing_error|no model route|something went wrong|an error occurred|error occurred while|\b(401|403|404|500|501|502|503)\b.*(error|unauthorized|not implemented)|ECONNREFUSED|fetch failed)/i;
