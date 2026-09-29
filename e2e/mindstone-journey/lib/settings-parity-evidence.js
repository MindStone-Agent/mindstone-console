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
 * - memoryChangeVerdict: after the embedding model changed, the Console warned
 *   before Save when memories from the old model existed, and a chat after the
 *   change answered with no recalled vector of another size; a silent change
 *   that leaves old vectors behind is the product bug #140 names. Whatever
 *   couldn't be exercised is PENDING, never a pass.
 * - restoredIndexReasons: once the memory setting is put back, the recall
 *   index holds only vectors the restored model can score (for J10).
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
  // The probed model is an Ollama name: its Ollama id first, then the same name through another provider.
  if (preferred) return [preferred, `ollama/${preferred}`].map((id) => candidates.find((value) => value === id)).find(Boolean) ?? candidates.find((value) => value.endsWith(`/${preferred}`));
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
 * The words the product would use, on the memory step before Save, to warn that a new embedding model affects the
 * memories another model embedded (#140): re-embedding or re-indexing, incompatibility, or memories embedded by
 * another model. A neutral count ("43 memories indexed") is not a warning.
 */
const EMBEDDING_WARNING =
  /re-?index|re-?embed|incompatib|rebuil|(another|a different|the old|the previous|the current|this) (embedding )?model (embedded|made|produced)|(embedded|made) (by|with) (another|a different|the old|the previous) (embedding )?model/i;

/** How a recalled chunk's size reads: a vector size, or unknown (null: not embedded or gone; -1: unreadable). */
const knownSize = (dims) => typeof dims === 'number' && dims > 0;

/**
 * The embedding change, judged (MindStone-Agent #140: vectors from another
 * model must never be scored against the new one). Inputs:
 * - `before` { spec, dims, chunks }: the saved embeddingProvider, its vector
 *   size, and how many chunks the recall index held embedded before the change
 *   (the memories another model embedded);
 * - `after` { spec, dims }: the new model and its Test's dimension count;
 * - `warned`: the product's own words about those memories, shown on the
 *   memory step before Save, if any;
 * - `index`: the recall index read after the save ({ present, byDims, pending });
 * - `probe`: the chat run after the change ({ error, text, hits: [{ chunkId,
 *   dims }] }, `dims` each recalled chunk's size read after the chat), or
 *   undefined when none could run (automatic recall off).
 * Rules:
 * - the warning: when the index held memories from the old model, the Console
 *   must say so before Save (the same vector size is no excuse); with none,
 *   the warning can't be exercised (PENDING, never a vacuous pass);
 * - recall after the change: the chat must answer (an error or an empty reply
 *   FAILs, it is never clean evidence); no recalled chunk may be of another
 *   size than the new model's; a chunk whose size can't be read, no chunk
 *   recalled at all, or no chat, leave it unproven (PENDING).
 * Returns { verdict: 'pass' | 'fail' | 'pending', why, reasons, unproven,
 * stale } (`stale`: embedded chunks whose size isn't the new model's).
 */
function memoryChangeVerdict({ before, after, warned, index, probe }) {
  const done = (verdict, why, extra = {}) => ({ verdict, why, reasons: [], unproven: [], stale: 0, ...extra });
  if (!before?.spec || !after?.spec) return done('fail', 'the embedding model before or after the change is not known');
  if (before.spec === after.spec) return done('fail', `the embedding model did not change (${after.spec})`);
  if (!(after.dims > 0)) return done('fail', `the new model's Test gave no dimension count (${after.spec})`);
  const { byDims } = indexTotals(index);
  const stale = Object.entries(byDims)
    .filter(([dims]) => Number(dims) !== after.dims)
    .reduce((sum, [, n]) => sum + Number(n || 0), 0);
  const sizes = Object.entries(byDims).map(([dims, n]) => `${n} at ${dims}`).join(', ') || 'none';
  const state = `the recall index now holds ${sizes}${index?.pending ? ` (${index.pending} pending)` : ''}`;
  const reasons = [];
  const unproven = [];

  // The warning before Save.
  if (!(before.chunks > 0)) {
    unproven.push(`the warning: no memories were embedded before the change (${index?.present ? `${before.chunks ?? 0} chunks` : 'no recall index'}), so there was nothing to warn about`);
  } else if (!warned) {
    reasons.push(
      `${stale ? 'PRODUCT BUG: ' : ''}the Console saved ${after.spec} (${after.dims} dimensions) in place of ${before.spec} (${before.dims || '?'}) with no warning before Save, ` +
        `though ${before.chunks} memories were embedded by ${before.spec}; ${state}` +
        `${stale ? `, so recall compares ${after.dims}-dimension queries with ${stale} vector(s) of another size` : ''}`,
    );
  }

  // Recall after the change.
  if (!probe) {
    unproven.push('recall after the change: no chat ran with automatic recall on');
  } else if (probe.error || !String(probe.text ?? '').trim()) {
    reasons.push(
      `the chat after the embedding change did not answer (${probe.error ? `the Console stored an error: ${String(probe.errorText ?? '').slice(0, 200)}` : 'an empty reply'}); ` +
        'recall with the new model must work, and a failed chat is no evidence that old vectors were left out',
    );
  } else {
    const hits = Array.isArray(probe.hits) ? probe.hits : [];
    const scored = hits.filter((hit) => knownSize(hit?.dims) && hit.dims !== after.dims);
    const unknown = hits.filter((hit) => !knownSize(hit?.dims));
    if (scored.length) {
      reasons.push(
        `recall after the change scored ${scored.length} chunk(s) embedded at another size against ${after.spec} (${scored.map((hit) => `${hit.chunkId} at ${hit.dims}`).join(', ')}): ` +
          'chunks from the old model must be re-embedded or left out',
      );
    }
    if (unknown.length) {
      unproven.push(`recall after the change: ${unknown.length} recalled chunk(s) whose size can't be read after the chat (${unknown.map((hit) => `${hit.chunkId}: ${hit.dims === -1 ? 'unreadable' : 'no vector'}`).join(', ')})`);
    }
    if (!hits.length && before.chunks > 0) {
      unproven.push('recall after the change: recall supplied no chunk to the chat, so whether it scores old vectors is not observable');
    }
  }

  if (reasons.length) return done('fail', reasons.join('; '), { reasons, unproven, stale });
  if (unproven.length) return done('pending', `not proven: ${unproven.join('; ')}; ${state}`, { unproven, stale });
  const recalled = probe.hits.length;
  return done(
    'pass',
    `the Console warned before Save ("${warned}"); recall after the change scored ${recalled} chunk(s), all at ${after.dims} dimensions; ${state}` +
      `${before.dims === after.dims ? ' (the same size: old vectors cannot be told apart by size)' : ''}`,
    { stale },
  );
}

/**
 * Why the recall index isn't back in a state the restored model can use
 * (J12 puts the memory setting back, then J10 recalls with it): after the
 * restore and a chat under it, every embedded chunk must be at the restored
 * model's size `dims` (chunks J12's chat after the change embedded with the
 * other model must have been re-embedded, or removed), and none unreadable.
 * Pending chunks are fine: the restored model embeds them. Empty when usable.
 */
function restoredIndexReasons({ spec, dims, index }) {
  if (!index?.present) return [];
  if (!(dims > 0)) return [`the restored model's vector size (${spec}) is not known, so the index can't be checked`];
  const reasons = [];
  const other = Object.entries(index.byDims ?? {}).filter(([size, n]) => Number(size) !== dims && Number(n) > 0);
  if (other.length) {
    reasons.push(
      `after the memory setting was put back to ${spec} (${dims} dimensions), the recall index still holds ${other.map(([size, n]) => `${n} chunk(s) at ${size}`).join(', ')}: ` +
        'later recall (J10) would score them against the restored model',
    );
  }
  if (index.unreadable > 0) reasons.push(`the recall index holds ${index.unreadable} unreadable vector(s)`);
  return reasons;
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
  restoredIndexReasons,
  EMBEDDING_WARNING,
};
