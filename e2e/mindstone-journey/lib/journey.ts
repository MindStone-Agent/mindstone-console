/**
 * Helpers for the journey spec: evidence (screenshots, log excerpts), shared
 * state between steps, sign-in, and reading a conversation's persisted
 * messages. Nothing here prints a secret.
 */
import fs from 'node:fs';
import path from 'node:path';
import { expect } from '@playwright/test';
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
};

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
  await page.getByLabel('Password').fill(readSecretFile('UAT_ADMIN_PASSWORD_FILE'));
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

type StoredMessage = {
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
): Promise<{ text: string; error: boolean; errorText?: string; contentTypes: string[]; conversationId: string }> {
  const input = page.getByRole('textbox', { name: 'Message input' });
  await expect(input).toBeVisible({ timeout: 30_000 });
  await input.click();
  await input.fill(text);
  await input.press('Enter');
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
      const users = json.filter((m) => m.isCreatedByUser && messageText(m) === text);
      const user = users[users.length - 1];
      const reply = user && json.find((m) => !m.isCreatedByUser && m.parentMessageId === user.messageId);
      if (reply && !reply.unfinished) {
        const replyText = messageText(reply);
        const errorText = messageError(reply);
        const signature = `${errorText}|${replyText}`;
        if (signature === lastSeen && Date.now() - stableSince > 2_000) {
          return {
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
  throw new Error(`no finished reply to "${text}" within ${Math.round(timeoutMs / 1000)}s`);
}

/** Text that means the Console showed an error, not an answer. */
export const ERROR_REPLY =
  /(routing_error|no model route|something went wrong|an error occurred|error occurred while|\b(401|403|404|500|501|502|503)\b.*(error|unauthorized|not implemented)|ECONNREFUSED|fetch failed)/i;
