/**
 * How J9 reads the gateway transcript and the recall index for proof that
 * automatic memory recall supplied a fact to a chat's turn. Plain CommonJS,
 * shared with the offline self-test (lib/recall-evidence.selftest.mjs), so
 * both run the same code. Pure functions: the file and database reads are in
 * lib/journey.ts.
 *
 * What the gateway records (MindStone-Agent main,
 * packages/mindstone-gateway/src/index.ts:1309-1334): when recall found hits
 * for a turn, a `role: "event"` entry with `metadata.event:
 * "memory_recall_injected"`, the turn's `runId`, and `metadata.query`,
 * `hitCount`, `promptTokens` and `hits` (id, chunkId, title, score,
 * recallMode; no text). The hit's chunkId is the recall index's
 * `memory_chunks.chunk_id`, so J9 reads the chunk text from there.
 * `memoryRecall` ({ query, hitCount, promptTokens }) goes only into the HTTP
 * response (index.ts:1415-1421), NOT onto the assistant transcript entry
 * (index.ts:1370-1381); Cairn is asked to add it there. Until then the
 * hitCount cross-check can't run, and the evidence says so in `notes`.
 * With no event, recall wasn't injected or isn't observable, and a reply that
 * names the fact proves nothing.
 */
const RECALL_EVENT = 'memory_recall_injected';

/** A conversation's entries from one transcript file's text: JSON lines whose session key ends in exactly `:<conversationId>`. */
function sessionLines(text, conversationId) {
  const entries = [];
  if (!conversationId) return entries;
  const suffix = `:${conversationId}`;
  for (const line of String(text).split('\n')) {
    if (!line.trim()) continue;
    try {
      const parsed = JSON.parse(line);
      const key = parsed && typeof parsed === 'object' ? parsed.sessionKey : undefined;
      if (typeof key === 'string' && key.length > suffix.length && key.slice(-suffix.length) === suffix) entries.push(parsed);
    } catch {
      // not JSON
    }
  }
  return entries;
}

const lower = (value) => String(value ?? '').toLowerCase();
const isRecallEvent = (entry) => entry?.role === 'event' && entry?.metadata?.event === RECALL_EVENT;
const lastAssistantAt = (list) => {
  let at = -1;
  list.forEach((entry, i) => {
    if (entry?.role === 'assistant') at = i;
  });
  return at;
};
/** An entry as the text it carries anywhere (JSON), without the recall event's own hit list (recall's provenance). */
const entryText = (entry) => lower(JSON.stringify(isRecallEvent(entry) ? { ...entry, metadata: { ...entry.metadata, hits: undefined } } : entry));
const outlineOf = (list) => list.map((e, i) => `${i} ${e?.role}${e?.metadata?.event ? ` ${e.metadata.event}` : ''}${e?.runId ? ` run ${e.runId}` : ''}`);

/**
 * Judges one conversation's entries (in order) for the reply that answered
 * its latest turn: did recall supply `token` to that turn?
 * - the reply's own turn has a memory_recall_injected event: before the
 *   reply, both carrying a run id, the same one;
 * - it lists hits, and at least one hit's chunk (`chunkTexts`: chunk_id ->
 *   text, read from the recall index) holds the token;
 * - the token is in no other entry of the conversation, whatever its role
 *   (only the reply may carry it; the recall event's hit list is exempt);
 * - the reply's metadata.memoryRecall.hitCount matches, when the entry
 *   carries it (a missing field is reported in `notes`, never passed silently).
 * Returns the evidence (no message text) and `reasons`, empty when proven.
 */
function recallEvidence(entries, token, chunkTexts) {
  const list = Array.isArray(entries) ? entries : [];
  const want = lower(token);
  const reasons = [];
  const notes = [];
  const assistantAt = lastAssistantAt(list);
  const assistant = assistantAt >= 0 ? list[assistantAt] : undefined;
  const runId = assistant?.runId;
  const recallEvents = list.map((entry, i) => (isRecallEvent(entry) ? i : -1)).filter((i) => i >= 0);
  const sameTurn = recallEvents.filter((i) => i < assistantAt && runId && list[i].runId && list[i].runId === runId);
  const recallAt = sameTurn.length ? sameTurn[sameTurn.length - 1] : -1;
  const event = recallAt >= 0 ? list[recallAt] : undefined;
  const hits = Array.isArray(event?.metadata?.hits) ? event.metadata.hits : [];
  const hitCount = typeof event?.metadata?.hitCount === 'number' ? event.metadata.hitCount : hits.length;
  const replyRecall = assistant?.metadata?.memoryRecall;
  const otherEntriesWithToken = want ? list.map((e, i) => (i !== assistantAt && entryText(e).includes(want) ? i : -1)).filter((i) => i >= 0) : [];
  const chunks = chunkTexts && typeof chunkTexts === 'object' ? chunkTexts : undefined;
  const hitChunksWithToken = chunks ? hits.filter((h) => typeof h?.chunkId === 'string' && lower(chunks[h.chunkId]).includes(want)).length : 0;

  if (!list.length) reasons.push('the gateway transcript has no entries for this conversation');
  else if (!assistant) reasons.push("the gateway transcript has no assistant entry for this conversation's reply");
  else if (!runId) reasons.push("the reply's transcript entry has no run id, so no recall event can be tied to its turn");
  if (otherEntriesWithToken.length) {
    reasons.push(
      `the token is in ${otherEntriesWithToken.length} entr${otherEntriesWithToken.length === 1 ? 'y' : 'ies'} of this conversation other than the reply ` +
        `(${otherEntriesWithToken.map((i) => outlineOf(list)[i]).join('; ')}), so it didn't have to come from recall`,
    );
  }
  if (assistant && runId && recallAt < 0) {
    reasons.push(
      recallEvents.length
        ? `a ${RECALL_EVENT} event is in this conversation, but not in the reply's own turn (before it, with run ${runId})`
        : `no ${RECALL_EVENT} event in this conversation: recall was not injected, or the gateway did not record it (not observable)`,
    );
  }
  if (event && !(hitCount > 0)) reasons.push(`the ${RECALL_EVENT} event lists no hits (hitCount ${hitCount})`);
  if (event && hitCount > 0) {
    if (!chunks) reasons.push("the recalled chunks' text could not be read from the recall index, so no hit is tied to the fact");
    else if (!hitChunksWithToken) reasons.push(`none of the ${hits.length} recalled chunk(s) holds the token: recall didn't supply it`);
  }
  if (event && replyRecall && typeof replyRecall.hitCount === 'number' && replyRecall.hitCount !== hitCount) {
    reasons.push(`the reply's metadata.memoryRecall.hitCount (${replyRecall.hitCount}) doesn't match the event's (${hitCount})`);
  }
  if (assistant && !replyRecall) {
    notes.push("the reply's transcript entry carries no metadata.memoryRecall (the gateway puts it only in the HTTP response; Cairn is asked to add it), so the hitCount cross-check did not run");
  }

  return {
    entries: list.length,
    sessionKey: list[0]?.sessionKey,
    assistantAt,
    runId,
    recallAt,
    recallEvents: recallEvents.length,
    hitCount: event ? hitCount : 0,
    hits: hits.map((h) => ({ id: h?.id, chunkId: h?.chunkId, title: h?.title, score: h?.score, recallMode: h?.recallMode })),
    /** Recalled chunks (by the recall index's text) that hold the token. */
    hitChunksWithToken,
    replyMemoryRecall: replyRecall ? { hitCount: replyRecall.hitCount, promptTokens: replyRecall.promptTokens } : undefined,
    otherEntriesWithToken: otherEntriesWithToken.length,
    /** The entries as index, role, event and run only: no text. */
    outline: outlineOf(list),
    notes,
    reasons,
  };
}

/**
 * The negative control (J9's chat 3, with automatic recall turned off): the
 * conversation has a reply, no recall event anywhere, and the token in no
 * entry, the reply included. Returns `reasons`, empty when the control holds.
 */
function controlEvidence(entries, token) {
  const list = Array.isArray(entries) ? entries : [];
  const want = lower(token);
  const reasons = [];
  const assistantAt = lastAssistantAt(list);
  const recallEvents = list.filter(isRecallEvent).length;
  const withToken = want ? list.map((e, i) => (entryText(e).includes(want) ? i : -1)).filter((i) => i >= 0) : [];
  if (!list.length) reasons.push('the gateway transcript has no entries for the control conversation');
  else if (assistantAt < 0) reasons.push('the gateway transcript has no reply in the control conversation');
  if (recallEvents) reasons.push(`with automatic recall off, the control conversation still has ${recallEvents} ${RECALL_EVENT} event(s)`);
  if (withToken.length) {
    reasons.push(
      `with automatic recall off, the token is still in the control conversation (${withToken.map((i) => outlineOf(list)[i]).join('; ')}): ` +
        'something other than automatic recall supplies it (a memory tool, the prompt files, or the model)',
    );
  }
  return { entries: list.length, assistantAt, recallEvents, withToken: withToken.length, outline: outlineOf(list), reasons };
}

/**
 * Whether a markdown memory file is an invariant (the gateway injects it on
 * every turn, with no recall): top-level frontmatter with a non-empty
 * `invariant:`. Deliberately wider than the gateway's rule (which also needs
 * `critical: true`), so no always-injected file is missed.
 */
function isInvariantMarkdown(text) {
  const normalized = String(text).replace(/\r\n/g, '\n');
  if (!normalized.startsWith('---\n')) return false;
  const end = normalized.indexOf('\n---', 4);
  if (end === -1) return false;
  return normalized
    .slice(4, end)
    .split('\n')
    .some((line) => /^invariant:\s*\S/.test(line));
}

module.exports = { RECALL_EVENT, sessionLines, recallEvidence, controlEvidence, isInvariantMarkdown };
