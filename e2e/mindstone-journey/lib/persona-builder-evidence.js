/**
 * J10 (the persona builder in the Console, MindStone-Agent #125): what the
 * step decides from, shared with lib/persona-builder.selftest.mjs so the
 * self-test runs the same code. Pure functions: the transcript reads are in
 * lib/journey.ts.
 *
 * - j10Decision: PENDING, FAIL or run, from what the Personas page offers and
 *   whether UAT_EXPECT_PERSONA_BUILDER=1 is set.
 * - personaTurnEvidence: one conversation's gateway transcript, read for the
 *   reply to its latest turn: which persona answered, its components, and the
 *   recall event's hit ids (no text).
 * - builtPersonaReasons: the reply under the built persona A had a private-KB
 *   hit (`pkb:<A>:<kb>:`) from recall in its own run.
 * - isolationReasons: the negative control, under another persona, had no
 *   `pkb:<A>:` hit anywhere (and, before any chat held it, no token).
 * - skillsVerdict: only A's listed skill was in its prompt.
 *
 * What the gateway records (MindStone-Agent #141/#142,
 * packages/mindstone-gateway/src/index.ts): each assistant entry carries
 * `metadata.personaContext` ({ injected, personaId, reason }) and, when a
 * persona answered, `metadata.personaComponents` ({ personaId, skills: [ids]
 * | "all", skillsInPrompt: [ids], globalKnowledgebases: [ids] | "all",
 * privateKnowledgebases: "own" | "none" }). Recall with hits writes a
 * `role: "event"` `memory_recall_injected` entry in the turn's run, whose
 * hits carry `id` (a private KB's is `pkb:<personaId>:<kbId>:<source>`, a
 * global one's `kb:<kbId>:<source>`) and `chunkId` (`<id>#0`), no text.
 */
const RECALL_EVENT = 'memory_recall_injected';
const PRIVATE_PREFIX = 'pkb:';

/**
 * What J10 does with the Console under test:
 * - "Build a persona" (ms-persona-create) is on the Personas page: run the
 *   real test (a flow that then breaks is a FAIL, with or without the flag);
 * - it isn't: PENDING, or FAIL with UAT_EXPECT_PERSONA_BUILDER=1. The reason
 *   says whether the page listed its personas (a positive control: the page
 *   rendered) and whether the gateway has the persona admin routes (#142).
 */
function j10Decision({ listShown, createOffered, expectPersonaBuilder, gatewayRoutes = false }) {
  if (createOffered) return { verdict: 'run', why: 'the Personas page offers "Build a persona" (ms-persona-create)' };
  const where = listShown
    ? 'the Personas page lists its personas but offers no "Build a persona" (ms-persona-create)'
    : 'the Personas page did not render its list, and offers no "Build a persona" (ms-persona-create)';
  const gateway = gatewayRoutes
    ? 'the gateway already has the persona builder routes (GET /admin/knowledgebases answers)'
    : 'the gateway has no persona builder routes (GET /admin/knowledgebases is not 200)';
  if (expectPersonaBuilder) {
    return { verdict: 'fail', why: `UAT_EXPECT_PERSONA_BUILDER=1, but ${where}; ${gateway} (MindStone-Agent #125 is not in this Console/gateway pair)` };
  }
  return { verdict: 'pending', why: `${where}; ${gateway}` };
}

const lower = (value) => String(value ?? '').toLowerCase();
const isRecallEvent = (entry) => entry?.role === 'event' && entry?.metadata?.event === RECALL_EVENT;
const outlineOf = (list) => list.map((e, i) => `${i} ${e?.role}${e?.metadata?.event ? ` ${e.metadata.event}` : ''}${e?.runId ? ` run ${e.runId}` : ''}`);
/** An entry as the text it carries anywhere (JSON); hits carry no text, only ids and hashes. */
const entryText = (entry) => lower(JSON.stringify(entry));
const hitIds = (event) => (Array.isArray(event?.metadata?.hits) ? event.metadata.hits : []).map((h) => ({ id: h?.id, chunkId: h?.chunkId, source: h?.source }));
/** A hit's id, or its chunk id, starts with `prefix`. */
const hitHas = (hit, prefix) => [hit.id, hit.chunkId].some((value) => typeof value === 'string' && value.startsWith(prefix));

/**
 * One conversation's entries (in order), read for the reply to its latest
 * turn: the answering persona (only when the gateway says it injected one),
 * its components, the recall event in the reply's own run (before it, same
 * run id) and its hits, every hit of every recall event in the conversation,
 * and which entries hold `token`. No message text.
 */
function personaTurnEvidence(entries, token) {
  const list = Array.isArray(entries) ? entries : [];
  let assistantAt = -1;
  list.forEach((entry, i) => {
    if (entry?.role === 'assistant') assistantAt = i;
  });
  const assistant = assistantAt >= 0 ? list[assistantAt] : undefined;
  const runId = assistant?.runId;
  const context = assistant?.metadata?.personaContext;
  const turnEvents = list.map((e, i) => (isRecallEvent(e) && i < assistantAt && runId && e.runId === runId ? i : -1)).filter((i) => i >= 0);
  const recallAt = turnEvents.length ? turnEvents[turnEvents.length - 1] : -1;
  const want = lower(token);
  const withToken = want ? list.map((e, i) => (entryText(e).includes(want) ? i : -1)).filter((i) => i >= 0) : [];
  return {
    entries: list.length,
    sessionKey: list[0]?.sessionKey,
    assistantAt,
    runId,
    personaId: context?.injected ? context.personaId : undefined,
    personaReason: context?.reason,
    components: assistant?.metadata?.personaComponents,
    recallAt,
    turnHits: recallAt >= 0 ? hitIds(list[recallAt]) : [],
    allHits: list.filter(isRecallEvent).flatMap(hitIds),
    /** Entries holding the token: the reply's own index is `assistantAt`. */
    withToken,
    outline: outlineOf(list),
  };
}

/**
 * Why the reply under the built persona is NOT proven to come from its
 * private KB (empty when it is): the gateway says persona `personaId`
 * answered; the recall event in the reply's own run has a hit from
 * `pkb:<personaId>:<kbId>:`; no hit is another persona's private KB; and the
 * token is in no entry but the reply (so only recall can have supplied it).
 */
function builtPersonaReasons(ev, { personaId, kbId }) {
  const reasons = [];
  const own = `${PRIVATE_PREFIX}${personaId}:${kbId}:`;
  if (!ev.entries) return ['the gateway transcript has no entries for this conversation'];
  if (ev.assistantAt < 0) return ["the gateway transcript has no assistant entry for this conversation's reply"];
  if (!ev.runId) reasons.push("the reply's transcript entry has no run id, so no recall event can be tied to its turn");
  if (ev.personaId !== personaId) {
    reasons.push(`the reply was answered by persona ${ev.personaId ?? '(none injected)'}, not ${personaId} (metadata.personaContext)`);
  }
  if (ev.runId && ev.recallAt < 0) {
    reasons.push(
      ev.allHits.length
        ? `a ${RECALL_EVENT} event is in this conversation, but not in the reply's own turn (before it, with run ${ev.runId})`
        : `no ${RECALL_EVENT} event in this conversation: recall found nothing, or it did not run (not observable)`,
    );
  } else if (ev.recallAt >= 0 && !ev.turnHits.some((h) => hitHas(h, own))) {
    reasons.push(`the recall event in the reply's turn has no hit from the private KB (${own}…): its hits are ${ev.turnHits.map((h) => h.id).join(', ') || 'none'}`);
  }
  const foreign = ev.allHits.filter((h) => hitHas(h, PRIVATE_PREFIX) && !hitHas(h, `${PRIVATE_PREFIX}${personaId}:`));
  if (foreign.length) reasons.push(`another persona's private KB was recalled under ${personaId}: ${foreign.map((h) => h.id).join(', ')}`);
  const others = ev.withToken.filter((i) => i !== ev.assistantAt);
  if (others.length) {
    reasons.push(`the token is in entries other than the reply (${others.map((i) => ev.outline[i]).join('; ')}), so it didn't have to come from the private KB`);
  }
  return reasons;
}

/**
 * Why the negative control is broken (empty when it holds): the gateway says
 * the control persona answered, not the built one, and no recall event in the
 * whole conversation has a hit from the built persona's private KBs
 * (`pkb:<builtPersonaId>:`). With `tokenMayLeak` false (no chat has held the
 * token yet), the token is also in no entry, the reply included. After a chat
 * under the built persona, the token may reach the control through the shared
 * transcripts (#125 design §2, "Transcripts are shared"), so the caller sets
 * `tokenMayLeak` and only the private-KB rule is judged.
 */
function isolationReasons(ev, { builtPersonaId, controlPersonaId, tokenMayLeak = false }) {
  const reasons = [];
  if (!ev.entries) return ['the gateway transcript has no entries for the control conversation'];
  if (ev.assistantAt < 0) return ['the gateway transcript has no reply in the control conversation'];
  if (ev.personaId !== controlPersonaId) {
    reasons.push(`the control was answered by persona ${ev.personaId ?? '(none injected)'}, not the control persona ${controlPersonaId} (metadata.personaContext)`);
  }
  const leaked = ev.allHits.filter((h) => hitHas(h, `${PRIVATE_PREFIX}${builtPersonaId}:`));
  if (leaked.length) reasons.push(`${builtPersonaId}'s private KB was recalled under ${ev.personaId ?? 'another persona'}: ${leaked.map((h) => h.id).join(', ')}`);
  if (ev.components && ev.components.privateKnowledgebases === 'own' && ev.components.personaId === builtPersonaId) {
    reasons.push(`the control turn's personaComponents are ${builtPersonaId}'s`);
  }
  if (!tokenMayLeak && ev.withToken.length) {
    reasons.push(`the token is in the control conversation (${ev.withToken.map((i) => ev.outline[i]).join('; ')}) though no chat has held it: the private KB reached another persona`);
  }
  return reasons;
}

const same = (a, b) => Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((x, i) => x === b[i]);

/**
 * Whether only the picked skill was in the built persona's prompt, from the
 * turn records (personaComponents): A lists exactly [picked], and its
 * skillsInPrompt is exactly [picked]. That is a restriction only if another
 * skill is installed; `installed` (GET /admin/skills) says. With one, the
 * restriction can't be told apart from "all": `provable` is false and `why`
 * says so. The control persona lists no skills, so its prompt must hold the
 * other installed skills (a positive control: the record can show a skill
 * that is there). Returns { provable, why, reasons } (reasons empty when shown).
 */
function skillsVerdict({ picked, installed, built, control }) {
  const reasons = [];
  const others = (installed ?? []).filter((id) => id !== picked);
  if (!built) reasons.push("the built persona's reply carries no metadata.personaComponents, so its prompt's skills aren't recorded");
  else {
    if (!same(built.skills, [picked])) reasons.push(`the built persona's skills are ${JSON.stringify(built.skills)}, not ["${picked}"]`);
    if (!Array.isArray(built.skillsInPrompt)) reasons.push("the built persona's turn record has no skillsInPrompt");
    else if (!same(built.skillsInPrompt, [picked])) reasons.push(`the built persona's prompt held skills ${JSON.stringify(built.skillsInPrompt)}, not only "${picked}"`);
  }
  if (!others.length) {
    return { provable: false, why: `only one skill is installed (${picked}), so a prompt holding just it doesn't show a restriction`, reasons };
  }
  if (!control) reasons.push("the control persona's reply carries no metadata.personaComponents (the positive control can't run)");
  else if (control.skills !== 'all') reasons.push(`the control persona lists skills ${JSON.stringify(control.skills)}; it should list none ("all")`);
  else if (!Array.isArray(control.skillsInPrompt) || !others.every((id) => control.skillsInPrompt.includes(id))) {
    reasons.push(`positive control: with no skills listed, the control persona's prompt should hold every installed skill (${others.join(', ')}), but held ${JSON.stringify(control.skillsInPrompt)}`);
  }
  return { provable: true, why: `${others.length} other installed skill(s) (${others.join(', ')}) were left out of the built persona's prompt`, reasons };
}

module.exports = { RECALL_EVENT, PRIVATE_PREFIX, j10Decision, personaTurnEvidence, builtPersonaReasons, isolationReasons, skillsVerdict };
