/**
 * J11 (enterprise endpoint, MindStone-Agent #126): what the step decides from,
 * shared with lib/enterprise.selftest.mjs so the self-test runs the same code.
 *
 * - j11Decision: PENDING, FAIL or run, from what the Console's provider step
 *   offers and whether UAT_EXPECT_ENTERPRISE=1 is set.
 * - readStubLog / stubProof: the stub Azure endpoint's request log
 *   (lib/azure-stub.mjs), judged. UI text alone is not proof that the
 *   endpoint was called: the stub must have answered an authenticated
 *   Responses API request at the expected path, after the step's own action
 *   (and, for the chat, one carrying the chat's own nonce).
 */
const fs = require('node:fs');

/** The path J11 types after the stub's origin as the Endpoint, like a real `https://<resource>.openai.azure.com/openai/v1`. */
const ENDPOINT_PATH = '/openai/v1';
/** Where Pi's AzureOpenAI client posts: `<endpoint>/responses?api-version=v1` (MindStone-Agent #126). Adjust here if it changes. */
const RESPONSES_PATH = `${ENDPOINT_PATH}/responses`;
const API_VERSION = 'v1';

/**
 * What J11 does with the Console under test:
 * - neither the Azure choice nor its form is on the provider step: the feature
 *   isn't in this Console. PENDING, or FAIL with UAT_EXPECT_ENTERPRISE=1;
 * - the choice is offered but its form doesn't appear: half landed. FAIL
 *   ("state changed"), never PENDING, so it can't sit unnoticed;
 * - the form is there: run the real test.
 */
function j11Decision({ kindOffered, formPresent, expectEnterprise }) {
  if (formPresent) return { verdict: 'run', why: 'the Azure OpenAI form is on the provider step' };
  if (kindOffered) {
    return {
      verdict: 'fail',
      why:
        'state changed: the provider step offers Azure OpenAI but its form (ms-ent-form-azure-openai) did not appear. ' +
        'The feature may have half landed: review this PENDING test (README).',
    };
  }
  if (expectEnterprise) {
    return {
      verdict: 'fail',
      why: 'UAT_EXPECT_ENTERPRISE=1, but the provider step has no Azure OpenAI choice and no ms-ent-form-azure-openai form (MindStone-Agent #126 is not in this Console/gateway pair)',
    };
  }
  return { verdict: 'pending', why: 'the provider step has no Azure OpenAI choice and no ms-ent-form-azure-openai form' };
}

/** The stub's request log: one JSON object per line; unreadable lines are skipped (and counted). */
function readStubLog(file) {
  let text = '';
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch {
    return { entries: [], unreadable: 0, missing: true };
  }
  const entries = [];
  let unreadable = 0;
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    try {
      entries.push(JSON.parse(line));
    } catch {
      unreadable += 1;
    }
  }
  return { entries, unreadable, missing: false };
}

/** One line per request, for notes and evidence: no bodies. */
function outline(entry) {
  return `#${entry.n} ${entry.at} ${entry.method} ${entry.path}${entry.apiVersion ? `?api-version=${entry.apiVersion}` : ''} key:${entry.auth} -> ${entry.status} ${entry.answered}`;
}

/**
 * Whether the stub proves the step's call: among the requests since `sinceMs`,
 * one POST to `path` with `api-version=apiVersion`, the run's key in the
 * api-key header, streamed, answered 200 with the token, and (with `nonce`)
 * whose last user message holds the nonce. Anywhere in the whole log, a
 * forbidden credential (the gateway's own token or admin credential) or the
 * key outside the api-key header is a reason too. Returns the matching entry
 * and `reasons` (empty when proven).
 */
function stubProof(entries, { sinceMs, nonce, path = RESPONSES_PATH, apiVersion = API_VERSION } = {}) {
  const reasons = [];
  const recent = entries.filter((e) => Date.parse(e.at) >= (sinceMs ?? 0) && e.answered !== 'health');
  const leaks = entries.filter((e) => (e.forbiddenCredentialSeen ?? []).length > 0);
  if (leaks.length) reasons.push(`a forbidden credential (the gateway's own token or admin credential) reached the endpoint: ${leaks.map(outline).join('; ')}`);
  const keyElsewhere = entries.filter((e) => e.keyOutsideApiKeyHeader);
  if (keyElsewhere.length) reasons.push(`the key was sent outside the api-key header: ${keyElsewhere.map(outline).join('; ')}`);
  const matched = recent.find(
    (e) =>
      e.method === 'POST' &&
      e.path === path &&
      e.apiVersion === apiVersion &&
      e.auth === 'ok' &&
      e.status === 200 &&
      e.tokenSent === true &&
      e.body?.stream === true &&
      (nonce === undefined || String(e.body?.lastUserText ?? '').includes(nonce)),
  );
  if (!matched) {
    const want = `POST ${path}?api-version=${apiVersion} with the run's key in api-key, streamed, answered 200${nonce === undefined ? '' : `, its last user message holding "${nonce}"`}`;
    reasons.push(
      recent.length
        ? `no request since the step's action was ${want}; the stub saw: ${recent.map(outline).join('; ')}`
        : `the stub received no request since the step's action (wanted ${want})`,
    );
  }
  return { matched, recent: recent.map(outline), reasons };
}

module.exports = { ENDPOINT_PATH, RESPONSES_PATH, API_VERSION, j11Decision, readStubLog, stubProof, outline };
