/**
 * How J9 reads the gateway transcript for proof that automatic memory recall
 * was injected into a chat's turn. Plain CommonJS, shared with the offline
 * self-test (lib/recall-evidence.selftest.mjs), so both run the same code.
 *
 * What the gateway records (MindStone-Agent main,
 * packages/mindstone-gateway/src/index.ts): when recall found hits for a
 * turn, a `role: "event"` entry with `metadata.event:
 * "memory_recall_injected"`, the turn's `runId`, and `metadata.query`,
 * `hitCount`, `promptTokens` and `hits` (id, chunkId, title, score; no text).
 * The turn's assistant entry also carries `metadata.memoryRecall` ({ query,
 * hitCount, promptTokens }) whenever recall ran. With no hits, or with recall
 * off, there is no event: then recall wasn't injected, or isn't observable,
 * and a reply that happens to name the fact proves nothing.
 */
const RECALL_EVENT = 'memory_recall_injected';

/** A conversation's entries from one transcript file's text: JSON lines whose session key ends in `:<conversationId>`. */
function sessionLines(text, conversationId) {
  const entries = [];
  if (!conversationId) return entries;
  for (const line of String(text).split('\n')) {
    if (!line.trim()) continue;
    try {
      const parsed = JSON.parse(line);
      if (parsed && typeof parsed === 'object' && typeof parsed.sessionKey === 'string' && parsed.sessionKey.endsWith(`:${conversationId}`)) {
        entries.push(parsed);
      }
    } catch {
      // not JSON
    }
  }
  return entries;
}

const lower = (value) => String(value ?? '').toLowerCase();

/**
 * Judges one conversation's entries (in order) for the reply that answered
 * its latest turn: was recall injected into that turn? `token` is the fact
 * that must come from memory; it must not be in the conversation's own user
 * turns. Returns the evidence (no message text) and `reasons`, empty when the
 * transcript proves recall.
 */
function recallEvidence(entries, token) {
  const list = Array.isArray(entries) ? entries : [];
  const want = lower(token);
  const reasons = [];
  let assistantAt = -1;
  list.forEach((entry, i) => {
    if (entry?.role === 'assistant') assistantAt = i;
  });
  const assistant = assistantAt >= 0 ? list[assistantAt] : undefined;
  const runId = assistant?.runId;
  const isRecall = (entry) => entry?.role === 'event' && entry?.metadata?.event === RECALL_EVENT;
  const recallEvents = list.map((entry, i) => (isRecall(entry) ? i : -1)).filter((i) => i >= 0);
  // The reply's own turn: before the reply, and in its run when both carry a run id.
  const sameTurn = recallEvents.filter((i) => i < assistantAt && (!runId || !list[i].runId || list[i].runId === runId));
  const recallAt = sameTurn.length ? sameTurn[sameTurn.length - 1] : -1;
  const event = recallAt >= 0 ? list[recallAt] : undefined;
  const hits = Array.isArray(event?.metadata?.hits) ? event.metadata.hits : [];
  const hitCount = typeof event?.metadata?.hitCount === 'number' ? event.metadata.hitCount : hits.length;
  const replyRecall = assistant?.metadata?.memoryRecall;
  const userTurnsWithToken = want ? list.filter((e) => e?.role === 'user' && lower(e.text).includes(want)).length : 0;

  if (!list.length) reasons.push('the gateway transcript has no entries for this conversation');
  else if (!assistant) reasons.push("the gateway transcript has no assistant entry for this conversation's reply");
  if (want && userTurnsWithToken) reasons.push(`the token is in ${userTurnsWithToken} of this conversation's own user turns, so a reply naming it proves nothing`);
  if (assistant && recallAt < 0) {
    reasons.push(
      recallEvents.length
        ? `a ${RECALL_EVENT} event is in this conversation, but not in the reply's own turn (before it${runId ? `, run ${runId}` : ''})`
        : `no ${RECALL_EVENT} event in this conversation: recall was not injected, or the gateway did not record it (not observable)`,
    );
  }
  if (event && !(hitCount > 0)) reasons.push(`the ${RECALL_EVENT} event lists no hits (hitCount ${hitCount})`);
  if (event && want && lower(event.metadata?.query).includes(want)) reasons.push("the recall query itself holds the token: it came from this conversation, not from memory");
  if (event && replyRecall && typeof replyRecall.hitCount === 'number' && replyRecall.hitCount !== hitCount) {
    reasons.push(`the reply's metadata.memoryRecall.hitCount (${replyRecall.hitCount}) doesn't match the event's (${hitCount})`);
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
    /** Hits whose id, chunk id or title holds the token (provenance, not required: the event carries no hit text). */
    hitsNamingToken: want ? hits.filter((h) => [h?.id, h?.chunkId, h?.title].some((v) => lower(v).includes(want))).length : 0,
    replyMemoryRecall: replyRecall ? { hitCount: replyRecall.hitCount, promptTokens: replyRecall.promptTokens } : undefined,
    userTurnsWithToken,
    /** The entries as index, role, event and run only: no text. */
    outline: list.map((e, i) => `${i} ${e?.role}${e?.metadata?.event ? ` ${e.metadata.event}` : ''}${e?.runId ? ` run ${e.runId}` : ''}`),
    reasons,
  };
}

module.exports = { RECALL_EVENT, sessionLines, recallEvidence };
