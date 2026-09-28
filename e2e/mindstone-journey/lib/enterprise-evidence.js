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
 * - stubLeaks: the whole log's leak check on its own, which J11 runs again as
 *   its last check on every path that doesn't FAIL, so no request after the
 *   last proof goes unchecked.
 * - expectedStatusLinks: J7's rule for the /mindstone links, now that #126
 *   adds "Model providers" after Skills.
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
function j11Decision({ kindOffered, formPresent, expectEnterprise, gatewayOffers = false }) {
  if (formPresent) return { verdict: 'run', why: 'the Azure OpenAI form is on the provider step' };
  if (gatewayOffers) {
    // The gateway has #126 (GET /admin/models lists azure-openai) but the Console doesn't offer it: half landed.
    return {
      verdict: 'fail',
      why:
        'state changed: the gateway lists the azure-openai enterprise kind, but the provider step ' +
        `${kindOffered ? 'shows no form for it' : 'does not offer it'} (ms-ent-form-azure-openai). Review this PENDING test (README).`,
    };
  }
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
  return { verdict: 'pending', why: 'the provider step has no Azure OpenAI choice and no ms-ent-form-azure-openai form, and the gateway lists no azure-openai kind' };
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
 * whose last user message holds the nonce, and (with `requestN`) that is the
 * request the reply names (its "request #<n>"). Anywhere in the whole log, a
 * forbidden credential (the gateway's own token or admin credential) or the
 * key outside the api-key header is a reason too. Returns the matching entry
 * and `reasons` (empty when proven).
 */
/**
 * Leaks anywhere in the log: a request that carried a forbidden credential
 * (the gateway's own token or the admin credential), or the key outside the
 * api-key header (URL, another header, the body). Empty when there are none.
 */
function stubLeaks(entries) {
  const reasons = [];
  const leaks = entries.filter((e) => (e.forbiddenCredentialSeen ?? []).length > 0);
  if (leaks.length) reasons.push(`a forbidden credential (the gateway's own token or admin credential) reached the endpoint: ${leaks.map(outline).join('; ')}`);
  const keyElsewhere = entries.filter((e) => e.keyOutsideApiKeyHeader);
  if (keyElsewhere.length) reasons.push(`the key was sent outside the api-key header: ${keyElsewhere.map(outline).join('; ')}`);
  return reasons;
}

function stubProof(entries, { sinceMs, nonce, requestN, path = RESPONSES_PATH, apiVersion = API_VERSION } = {}) {
  const reasons = stubLeaks(entries);
  const recent = entries.filter((e) => Date.parse(e.at) >= (sinceMs ?? 0) && e.answered !== 'health');
  const matched = recent.find(
    (e) =>
      e.method === 'POST' &&
      e.path === path &&
      e.apiVersion === apiVersion &&
      e.auth === 'ok' &&
      e.status === 200 &&
      e.tokenSent === true &&
      e.body?.stream === true &&
      (nonce === undefined || String(e.body?.lastUserText ?? '').includes(nonce)) &&
      (requestN === undefined || e.n === requestN),
  );
  if (!matched) {
    const want =
      `POST ${path}?api-version=${apiVersion} with the run's key in api-key, streamed, answered 200` +
      `${nonce === undefined ? '' : `, its last user message holding "${nonce}"`}${requestN === undefined ? '' : `, logged as request #${requestN} (the number the reply shows)`}`;
    reasons.push(
      recent.length
        ? `no request since the step's action was ${want}; the stub saw: ${recent.map(outline).join('; ')}`
        : `the stub received no request since the step's action (wanted ${want})`,
    );
  }
  return { matched, recent: recent.map(outline), reasons };
}

/** The link #126 adds to /mindstone, right after Skills. */
const PROVIDERS_LINK = 'Model providers';

/**
 * J7's rule for the /mindstone links (less the ignored ones): the list it must
 * equal, exactly. With UAT_EXPECT_ENTERPRISE=1: today's plus Model providers
 * right after Skills (required). Without it: today's, or today's plus Model
 * providers in that one place (a Console with or without #126). Anything else
 * (the link elsewhere, twice, or another link changed) doesn't match either.
 */
function expectedStatusLinks({ links, today, expectEnterprise }) {
  const withProviders = [...today, PROVIDERS_LINK];
  if (expectEnterprise) return { expected: withProviders };
  if (JSON.stringify(links) === JSON.stringify(withProviders)) {
    return { expected: withProviders, note: `"${PROVIDERS_LINK}" (#126) is there after Skills; accepted without UAT_EXPECT_ENTERPRISE (J11 checks it)` };
  }
  return { expected: today };
}

module.exports = {
  ENDPOINT_PATH,
  RESPONSES_PATH,
  API_VERSION,
  PROVIDERS_LINK,
  j11Decision,
  readStubLog,
  stubProof,
  stubLeaks,
  expectedStatusLinks,
  outline,
};
