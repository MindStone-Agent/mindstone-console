/**
 * J12 (settings parity, MindStone-Agent #140): what the step decides from,
 * shared with lib/settings-parity.selftest.mjs so the self-test runs the same
 * code. Pure functions: the page, the config and the recall index are read in
 * journey.spec.ts and lib/journey.ts.
 *
 * - j12Decision: PENDING, FAIL or run, from what Settings shows and whether
 *   UAT_EXPECT_SETTINGS_PARITY=1 is set.
 * - parityReasons: every guided-setup step has its Settings equivalent: a
 *   Change link into that one step (`?change=<step>&from=settings`), or, for
 *   Access and About you, the control Settings has in place (the #140 audit:
 *   Access is the Advanced settings card, About you is edited as USER.md).
 * - pickAlternateModel: a different model for the Model change, only a cloud
 *   one (chatting with a local model would load it into a shared Ollama), the
 *   one run-journey.sh found answering when it probed.
 * - modelMatchReasons: the model chosen in Settings is the saved route, shown
 *   on Settings, and the model the gateway's Pi session actually called.
 * - memoryChangeVerdict: after the embedding model changed, either the vector
 *   size is the same, the recall index holds no vector of the old size (it was
 *   re-embedded, or held none), or the product warned; anything else is a
 *   product bug: recall silently compares vectors of different sizes.
 */

/** The guided-setup steps (#102 flow, less Finish), and how Settings changes each one. */
const SETUP_STEPS = ['Access', 'Provider', 'Model', 'Persona', 'Memory', 'Connectors', 'About you'];
/** Steps changed through a Change link into that one step of guided setup, by their `?change=` name. */
const CHANGE_STEPS = { Provider: 'provider', Model: 'model', Persona: 'persona', Memory: 'memory', Connectors: 'connectors' };
/** Steps Settings changes in place (the #140 parity audit), and the control that does it. */
const IN_PLACE_STEPS = {
  Access: 'the Advanced settings card (ms-advanced): Turn on with the phrase, or Turn off',
  'About you': 'What the agent knows about you (ms-about): USER.md, edited and saved',
};

/** The Change link's exact target for a step (YourSetup.tsx): never another page or query. */
const changeHref = (change) => `/mindstone/onboarding?change=${change}&from=settings`;

/**
 * What J12 does with the Console under test:
 * - Settings didn't render (no "MindStone settings" heading): the parity
 *   section can't be looked for, so FAIL, never PENDING;
 * - the "Your setup" section (ms-your-setup) is there: run the real test (a
 *   broken section is then a FAIL, with or without the flag);
 * - it isn't: PENDING, or FAIL with UAT_EXPECT_SETTINGS_PARITY=1. The reason
 *   says whether the gateway already has GET /admin/user (#140).
 */
function j12Decision({ settingsShown, sectionPresent, expectParity, gatewayRoute = false }) {
  if (!settingsShown) {
    return { verdict: 'fail', why: 'the Settings page (/mindstone) did not render its "MindStone settings" heading, so its parity section could not be looked for' };
  }
  if (sectionPresent) return { verdict: 'run', why: 'Settings has the "Your setup" section (ms-your-setup)' };
  const where = 'Settings (/mindstone) renders, but has no "Your setup" section (ms-your-setup)';
  const gateway = gatewayRoute
    ? 'the gateway already has GET /admin/user (#140)'
    : 'the gateway has no GET /admin/user (404)';
  if (expectParity) {
    return { verdict: 'fail', why: `UAT_EXPECT_SETTINGS_PARITY=1, but ${where}; ${gateway} (MindStone-Agent #140 is not in this Console/gateway pair)` };
  }
  return { verdict: 'pending', why: `${where}; ${gateway}` };
}

/**
 * Why the parity table is incomplete (empty when it isn't). `rows` is what
 * Settings showed, one per step: { step, kind: 'change' | 'in-place', href?,
 * control?, opened? }. Every setup step needs exactly one row; a Change step
 * a link whose href is exactly its `?change=` target (and, when the link was
 * followed, `opened` true: it opened that one step); an in-place step its
 * control (`control` true).
 */
function parityReasons(rows) {
  const reasons = [];
  const list = Array.isArray(rows) ? rows : [];
  for (const step of SETUP_STEPS) {
    const found = list.filter((row) => row?.step === step);
    if (found.length !== 1) {
      reasons.push(`${step}: ${found.length ? `${found.length} rows` : 'no Settings equivalent'}`);
      continue;
    }
    const row = found[0];
    if (Object.hasOwn(CHANGE_STEPS, step)) {
      const want = changeHref(CHANGE_STEPS[step]);
      if (row.kind !== 'change') reasons.push(`${step}: expected a Change link into the ${CHANGE_STEPS[step]} step, found ${row.kind ?? 'nothing'}`);
      else if (row.href !== want) reasons.push(`${step}: the Change link goes to ${JSON.stringify(row.href ?? null)}, not ${want}`);
      else if (row.opened === false) reasons.push(`${step}: the Change link did not open just the ${CHANGE_STEPS[step]} step${row.openedWhy ? ` (${row.openedWhy})` : ''}`);
    } else if (row.kind !== 'in-place' || row.control !== true) {
      reasons.push(`${step}: no control on Settings (${IN_PLACE_STEPS[step]})`);
    }
  }
  const unknown = list.filter((row) => !SETUP_STEPS.includes(row?.step));
  if (unknown.length) reasons.push(`rows for steps setup doesn't have: ${unknown.map((row) => row?.step).join(', ')}`);
  return reasons;
}

/** A model that runs remotely: an Ollama `:cloud` (or `-cloud`) tag. */
const isCloudModel = (id) => /[:-]cloud$/.test(String(id ?? ''));

/**
 * The model J12 switches to, from the ids the Model step offers
 * ("<provider>/<model>"), never the current one and never a local one:
 * - `preferred` set (run-journey.sh's UAT_ALT_MODEL: an Ollama cloud model
 *   that answered a probe): that model, if offered; "none" (no other cloud
 *   model answered): nothing;
 * - unset: the first other cloud model by id.
 * Undefined when there is none; J12 then keeps the current model and the
 * model part ends PENDING.
 */
function pickAlternateModel(values, current, preferred) {
  const candidates = [...new Set((values ?? []).filter((value) => typeof value === 'string' && value && value !== current && isCloudModel(value)))].sort();
  if (preferred === 'none') return undefined;
  if (preferred) return candidates.find((value) => value === preferred || value.endsWith(`/${preferred}`));
  return candidates[0];
}

/**
 * Why the chat after the change isn't proven to use the model chosen in
 * Settings (empty when it is): config.routing.defaultModel is the chosen id,
 * Settings' "Default model" row shows it, and the gateway transcript's Pi
 * session called that provider and model, with no fallback. Ids are
 * "<provider>/<model>" (the model part may hold more slashes).
 */
function modelMatchReasons({ chosen, saved, shown, answered }) {
  const reasons = [];
  if (!chosen) return ['no model was chosen'];
  if (saved !== chosen) reasons.push(`config.routing.defaultModel is ${JSON.stringify(saved ?? null)}, not the chosen ${chosen}`);
  if (shown !== undefined && !String(shown).includes(chosen)) reasons.push(`Settings' Default model row shows "${shown}", not ${chosen}`);
  if (!answered) {
    reasons.push("the gateway transcript has no assistant entry for the chat's reply, so the model it used isn't known");
    return reasons;
  }
  const [provider, ...rest] = chosen.split('/');
  const model = rest.join('/');
  if (answered.modelFallbackMessage) reasons.push(`the Pi session fell back to another model: ${answered.modelFallbackMessage}`);
  if (answered.provider !== provider || answered.model !== model) {
    reasons.push(`the Pi session called ${answered.provider ?? '?'}/${answered.model ?? '?'}, not ${chosen}`);
  }
  return reasons;
}

/** { total, byDims } of a recall index reading; `byDims` maps a vector size to its chunk count. */
function indexTotals(index) {
  const byDims = index?.byDims ?? {};
  return { byDims, total: Object.values(byDims).reduce((sum, n) => sum + Number(n || 0), 0) };
}

/**
 * The embedding change, judged. `before` and `after` are { spec, dims } (the
 * saved embeddingProvider, and the memory step's Test's dimension count),
 * `warned` the product's own words about existing memories when it gave any,
 * and `index` the recall index read after the save ({ present, byDims,
 * pending }). Returns { verdict: 'pass' | 'fail', why, stale }: `stale` is the
 * number of embedded chunks whose size isn't the new model's.
 */
function memoryChangeVerdict({ before, after, warned, index }) {
  if (!before?.spec || !after?.spec) return { verdict: 'fail', why: 'the embedding model before or after the change is not known', stale: 0 };
  if (before.spec === after.spec) return { verdict: 'fail', why: `the embedding model did not change (${after.spec})`, stale: 0 };
  if (!(after.dims > 0)) return { verdict: 'fail', why: `the new model's Test gave no dimension count (${after.spec})`, stale: 0 };
  const { byDims, total } = indexTotals(index);
  const stale = Object.entries(byDims)
    .filter(([dims]) => Number(dims) !== after.dims)
    .reduce((sum, [, n]) => sum + Number(n || 0), 0);
  const sizes = Object.entries(byDims).map(([dims, n]) => `${n} at ${dims}`).join(', ') || 'none';
  if (before.dims > 0 && before.dims === after.dims) {
    return {
      verdict: 'pass',
      why: `${before.spec} and ${after.spec} both embed at ${after.dims} dimensions, so the vector size stays compatible (whether old vectors from another model at the same size are re-embedded can't be told from their size)`,
      stale,
    };
  }
  if (!index?.present || total === 0) {
    return { verdict: 'pass', why: `the recall index holds no embedded chunk (${index?.present ? 'empty' : 'absent'}), so no stored vector became incompatible`, stale: 0 };
  }
  if (stale === 0) return { verdict: 'pass', why: `re-indexed: every embedded chunk is now ${after.dims}-dimensional (${sizes})`, stale };
  if (warned) {
    return { verdict: 'pass', why: `the product warned before the change ("${warned}"); the index still holds ${stale} chunk(s) at another size (${sizes})`, stale };
  }
  return {
    verdict: 'fail',
    why:
      `PRODUCT BUG: the embedding model changed from ${before.spec} (${before.dims || '?'} dimensions) to ${after.spec} (${after.dims}) with no warning and no re-index: ` +
      `the recall index still holds ${stale} chunk(s) at another size (${sizes}${index.pending ? `; ${index.pending} pending` : ''}), ` +
      `so recall now compares ${after.dims}-dimension queries with vectors of another size`,
    stale,
  };
}

module.exports = {
  SETUP_STEPS,
  CHANGE_STEPS,
  IN_PLACE_STEPS,
  changeHref,
  j12Decision,
  parityReasons,
  isCloudModel,
  pickAlternateModel,
  modelMatchReasons,
  memoryChangeVerdict,
};
