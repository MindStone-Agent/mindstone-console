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
 * - vectorOf: the one rule both memory checks judge a chunk by (#140: a chunk
 *   records its model; recall never compares across models).
 * - restoredIndexReasons: once the memory setting is put back, every chunk is
 *   the restored model's, or another model's that recall leaves out (for J10).
 * - restoreOutcome: a failed restore, or an index check that didn't run or
 *   failed, is a restore failure (it fails the gate even when J12 isn't counted).
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

/** How a chunk's size reads: a vector size, or unknown (null: not embedded or gone; -1: unreadable). */
const knownSize = (dims) => typeof dims === 'number' && dims > 0;

/** An embedding spec or a chunk's model record as a bare model name: "ollama:nomic-embed-text:latest" -> "nomic-embed-text". */
const bareModel = (spec) =>
  String(spec ?? '')
    .trim()
    .replace(/^(ollama|openai|openai-compatible|enterprise-azure|enterprise-openai)[:/]/, '')
    .replace(/:latest$/, '');

/**
 * THE rule both J12 memory checks judge by (MindStone-Agent #140 at 452aa06: `memory_chunks.embedding_spec` is exactly
 * `<provider id>:<model>`; NULL means a vector embedded before the model was recorded, which never counts as the
 * current model's; recall scores only the current model's vectors, and finds other chunks by their words until the
 * per-turn backfill re-embeds them): whether a chunk's vector is `model`'s ({ spec, dims }).
 * - 'same': it records `model`'s spec (provider prefix and `:latest` aside);
 * - 'other': it records another spec; or the index records specs (`recorded`) and this embedded chunk has none;
 *   or, in an index from before #140 (no record at all), its vector is another size;
 * - 'unknown': no vector (not embedded yet, or gone), or, before #140, no size to go by.
 */
function vectorOf(chunk, model) {
  if (chunk?.model) return bareModel(chunk.model) === bareModel(model?.spec) ? 'same' : 'other';
  const embedded = knownSize(chunk?.dims) || chunk?.dims === -1;
  if (chunk?.recorded) return embedded ? 'other' : 'unknown';
  if (!knownSize(chunk?.dims) || !(model?.dims > 0)) return 'unknown';
  return chunk.dims === model.dims ? 'same' : 'other';
}

/**
 * How many embedded chunks aren't `model`'s (vectorOf): #140's index-clean count (`embedding_json IS NOT NULL AND
 * (embedding_spec IS NULL OR embedding_spec != '<spec>')`), which the backfill after a turn brings to 0.
 */
function otherModelCount(chunks, model) {
  return (chunks ?? []).filter((chunk) => (knownSize(chunk?.dims) || chunk?.dims === -1) && vectorOf(chunk, model) === 'other').length;
}

/** A chunk for a message: its id, its size or "no vector" / "unreadable", and its model record. */
const describe = (chunk) =>
  `${chunk?.chunkId} (${knownSize(chunk?.dims) ? `${chunk.dims} dims` : chunk?.dims === -1 ? 'unreadable' : 'no vector'}${chunk?.model ? `, ${chunk.model}` : ''}${chunk?.recallMode ? `, by ${chunk.recallMode}` : ''})`;

/**
 * Whether recall found a chunk by its vector. The gateway's memory_recall_injected event records each hit's
 * `recallMode`: "embedding" (scored by vector) or "lexical" (found by its words). #140 finds a chunk another model
 * embedded by its words until the backfill re-embeds it: that is by design, and never scores its vector. A hit with
 * no recallMode (a gateway that doesn't record it) counts as a vector hit, so nothing is excused unseen.
 */
const byVector = (hit) => hit?.recallMode !== 'lexical';

/**
 * The chunks recall supplied to a chat, judged by the rule against the model the chat ran under: { other, unknown,
 * lexical } (other: a vector hit from another model, a failure; unknown: a vector hit that can't be told, unproven;
 * lexical: found by words, not judged).
 */
function recalledFrom(hits, model) {
  const list = Array.isArray(hits) ? hits : [];
  const vector = list.filter(byVector);
  return {
    other: vector.filter((hit) => vectorOf(hit, model) === 'other'),
    unknown: vector.filter((hit) => vectorOf(hit, model) === 'unknown'),
    lexical: list.filter((hit) => !byVector(hit)),
  };
}

/**
 * The chunks recall supplied, as they were when it scored them: `modes` the hits' [chunkId, recallMode] in order,
 * `snapshot` the index read just before the chat, `now` the index read after it (for a chunk the snapshot doesn't
 * have). What the chat's own turn embeds afterwards (the backfill re-embedding an old chunk) can't change the verdict.
 */
function hitsAsScored({ modes, snapshot, now }) {
  const before = new Map((snapshot ?? []).map((chunk) => [chunk.chunkId, chunk]));
  const after = new Map((now ?? []).map((chunk) => [chunk.chunkId, chunk]));
  return (modes ?? []).map(([chunkId, mode]) => ({
    ...(before.get(chunkId) ?? after.get(chunkId) ?? { chunkId, dims: null, model: null }),
    ...(mode ? { recallMode: mode } : {}),
  }));
}

/**
 * The embedding change, judged (MindStone-Agent #140). Inputs:
 * - `before` { spec, dims, chunks }: the saved embeddingProvider, its vector size, and how many chunks the recall
 *   index held embedded before the change (the memories another model embedded);
 * - `after` { spec, dims }: the new model and its Test's dimension count;
 * - `warned`: the product's own words about those memories, shown on the memory step before Save, if any (#140:
 *   ms-onb-memory-reembed, "N memories were embedded by another model…");
 * - `reported`: the memory check's own count of them (POST /admin/memory/check `index.otherModel`), if it gave one:
 *   with memories before the change it must be above 0, and the warning must show that number;
 * - `index`: the recall index read after the save ({ present, byDims, pending });
 * - `probe`: what ran after the change, or undefined when nothing could (automatic recall off): a fact told in one
 *   chat ({ fact: the index chunks that captured it, with dims and model }), asked for in a fresh chat
 *   ({ error, errorText, text, hits: the chunks recall supplied, with dims and model }).
 * Rules:
 * - the warning: when the index held memories from the old model, the Console must say so before Save (the same
 *   vector size is no excuse); with none, the warning can't be exercised (PENDING, never a vacuous pass);
 * - recall after the change (vectorOf, on the index as it was just before the asking chat): the chats must answer
 *   (an error or an empty reply FAILs, never clean evidence); the new fact must be embedded by the new model and
 *   recalled by its vector (recallMode "embedding"); no chunk recalled by its vector may be another model's (one
 *   found by its words is #140's design). PENDING only when there was genuinely nothing to recall (the fact
 *   wasn't captured), or a vector hit can't be told apart.
 * - the re-embed (`reembedded` { otherLeft, waitedMs }): after those chats, the per-turn backfill must bring the
 *   count of embedded chunks that aren't the new model's (otherModelCount) to 0.
 * Returns { verdict: 'pass' | 'fail' | 'pending', why, reasons, unproven, stale } (`stale`: embedded chunks whose
 * size isn't the new model's).
 */
function memoryChangeVerdict({ before, after, warned, reported, index, probe, reembedded }) {
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
  } else if (reported !== undefined && !(reported > 0)) {
    reasons.push(
      `the memory check for ${after.spec} reported ${reported} memories embedded by another model (index.otherModel), though ${before.chunks} were embedded by ${before.spec}`,
    );
  } else if (!warned) {
    reasons.push(
      `${stale ? 'PRODUCT BUG: ' : ''}the Console saved ${after.spec} (${after.dims} dimensions) in place of ${before.spec} (${before.dims || '?'}) with no warning before Save, ` +
        `though ${before.chunks} memories were embedded by ${before.spec}; ${state}` +
        `${stale ? `, so recall compares ${after.dims}-dimension queries with ${stale} vector(s) of another size` : ''}`,
    );
  }

  // The warning's count is the gateway's (index.otherModel).
  const shownCount = Number(String(warned ?? '').match(/\d+/)?.[0] ?? NaN);
  if (warned && reported > 0 && shownCount !== reported) reasons.push(`the warning says ${shownCount || 'no number'}, but the memory check reported ${reported} memories embedded by another model`);

  // Recall after the change.
  let recalled = 0;
  let lexicalNote = '';
  if (!probe) {
    unproven.push('recall after the change: no chat ran with automatic recall on');
  } else if (probe.error || !String(probe.text ?? '').trim()) {
    reasons.push(
      `a chat after the embedding change did not answer (${probe.error ? `the Console stored an error: ${String(probe.errorText ?? '').slice(0, 200)}` : 'an empty reply'}); ` +
        'recall with the new model must work, and a failed chat is no evidence that old vectors were left out',
    );
  } else {
    const fact = Array.isArray(probe.fact) ? probe.fact : [];
    const factOther = fact.filter((chunk) => vectorOf(chunk, after) === 'other');
    if (factOther.length) reasons.push(`the fact told after the change was embedded by another model than ${after.spec}: ${factOther.map(describe).join(', ')}`);
    const { other, unknown, lexical } = recalledFrom(probe.hits, after);
    recalled = (probe.hits ?? []).length;
    lexicalNote = lexical.length ? `; ${lexical.length} found by words (not judged: #140 finds another model's chunks by words until the backfill re-embeds them)` : '';
    if (other.length) {
      reasons.push(`recall after the change scored ${other.length} chunk(s) by the vector of another model than ${after.spec}: ${other.map(describe).join(', ')}; chunks from the old model must be re-embedded, or found by words only`);
    }
    if (unknown.length) unproven.push(`recall after the change: ${unknown.length} recalled chunk(s) whose model can't be told (${unknown.map(describe).join(', ')})`);
    // The positive proof (N2): the new fact itself, recalled by its vector, from the new model.
    if (!fact.length) {
      unproven.push('recall after the change: the fact told after it was not captured in time, so there was nothing to recall');
    } else {
      const ids = new Set(fact.map((chunk) => chunk.chunkId));
      const factHits = (probe.hits ?? []).filter((hit) => ids.has(hit.chunkId));
      const proven = factHits.filter((hit) => hit.recallMode === 'embedding' && vectorOf(hit, after) === 'same');
      if (!proven.length) {
        reasons.push(
          `recall after the change did not find the new fact by the new model's vector (${after.spec}): the fact is in ${fact.map(describe).join(', ')}; ` +
            `recall supplied ${factHits.length ? factHits.map(describe).join(', ') : 'none of its chunks'}${recalled ? ` among ${recalled} hit(s)` : ' (nothing at all)'}`,
        );
      }
    }
  }

  // The backfill after the post-change turns re-embeds every chunk from another model (#140): the index-clean
  // count must reach 0 (`reembedded` { otherLeft, waitedMs }, polled after the chats).
  if (probe && !reasons.length) {
    if (!reembedded) unproven.push('the re-embed after the change: the index-clean count was not read');
    else if (reembedded.otherLeft > 0) {
      reasons.push(`${reembedded.otherLeft} embedded chunk(s) were still another model's ${Math.round((reembedded.waitedMs ?? 0) / 1000)} s after the chats under ${after.spec}: the backfill did not re-embed them`);
    }
  }

  if (reasons.length) return done('fail', reasons.join('; '), { reasons, unproven, stale });
  if (unproven.length) return done('pending', `not proven: ${unproven.join('; ')}; ${state}`, { unproven, stale });
  return done(
    'pass',
    `the Console warned before Save ("${warned}"); recall after the change supplied ${recalled} chunk(s), none by another model's vector${lexicalNote}; ${state}` +
      `${before.dims === after.dims ? ' (the same size: without a model record, old vectors cannot be told apart by size)' : ''}`,
    { stale },
  );
}

/**
 * Why the recall index isn't usable by the model the restore put back (J10 recalls with it), by the same rule
 * (vectorOf). `chunks` are every chunk in the index ({ chunkId, dims, model }); `recalled` the chunks recall supplied
 * to a chat run under the restored model (undefined when none ran). Usable when every embedded chunk is the restored
 * model's, or records another model and recall under the restored model provably left it out (no recalled chunk
 * from another model, and a chat did run); pending chunks are fine (the restored model embeds them). A chunk of
 * another size with no model record, or an unreadable one, is a reason. Empty when usable.
 */
function restoredIndexReasons({ spec, dims, present, chunks, recalled }) {
  if (!present) return [];
  const model = { spec, dims };
  if (!(dims > 0)) return [`the restored model's vector size (${spec}) is not known, so the index can't be checked`];
  const reasons = [];
  const list = Array.isArray(chunks) ? chunks : [];
  const other = list.filter((chunk) => vectorOf(chunk, model) === 'other');
  // Another model's by its record (a spec, or none in an index that records them) vs by size alone (an index from before #140).
  const untagged = other.filter((chunk) => !chunk.model && !chunk.recorded);
  const tagged = other.filter((chunk) => chunk.model || chunk.recorded);
  const unreadable = list.filter((chunk) => chunk?.dims === -1 && !chunk.model && !chunk.recorded);
  if (untagged.length) {
    reasons.push(
      `after the memory setting was put back to ${spec} (${dims} dimensions), the recall index still holds ${untagged.length} chunk(s) of another size with no model record ` +
        `(${summarize(untagged)}): they were neither re-embedded nor marked as another model's, so later recall (J10) would score them`,
    );
  }
  if (unreadable.length) reasons.push(`the recall index holds ${unreadable.length} unreadable vector(s)`);
  if (tagged.length || recalled !== undefined) {
    if (recalled === undefined) {
      reasons.push(`${tagged.length} chunk(s) record another model (${summarize(tagged)}), and no chat ran under ${spec} to show recall leaves them out`);
    } else {
      const { other: scored } = recalledFrom(recalled, model);
      if (scored.length) reasons.push(`recall under the restored ${spec} scored ${scored.length} chunk(s) by the vector of another model: ${scored.map(describe).join(', ')}`);
    }
  }
  return reasons;
}

/** Chunks counted by size and model record, for a message. */
function summarize(chunks) {
  const counts = new Map();
  for (const chunk of chunks) {
    const key = `${knownSize(chunk.dims) ? `${chunk.dims} dims` : 'no vector'}${chunk.model ? `, ${chunk.model}` : ''}`;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return [...counts].map(([key, n]) => `${n} at ${key}`).join('; ');
}

/**
 * What J12's finally reports (A2): the settings put back (`settings` { ok, lines }) and, once an embedding model
 * change was about to be saved, the index check (`index` { required, ran, reasons }). The check being required but
 * not run, or finding the index unusable, is a restore failure like a setting not put back (recordRestoreFailure:
 * it fails the gate even when J12 is uncounted), never a deferred J12 check. Returns { ok, lines, failures }.
 */
function restoreOutcome({ settings, index }) {
  const failures = [];
  if (!settings?.ok) failures.push(...(settings?.lines ?? ['the settings could not be put back']));
  if (index?.required && !index.ran) failures.push(`the recall index was not checked after the restore${index.why ? ` (${index.why})` : ''}`);
  if (index?.required && index.ran) failures.push(...(index.reasons ?? []));
  const lines = [...(settings?.lines ?? [])];
  if (index?.required) lines.push(index.ran ? `recall index after the restore: ${index.reasons?.length ? index.reasons.join('; ') : 'usable by the restored model'}` : 'recall index after the restore: NOT checked');
  return { ok: failures.length === 0, lines, failures };
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
  restoreOutcome,
  vectorOf,
  otherModelCount,
  byVector,
  hitsAsScored,
  EMBEDDING_WARNING,
};
