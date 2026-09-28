// Offline self-test of J9's transcript check (lib/recall-evidence.js), on
// synthetic gateway transcript lines shaped like MindStone-Agent's: it must
// PASS only when the reply's own turn has a memory_recall_injected event with
// hits, and must FAIL (with a reason) when the event is missing, empty, in
// another turn, after the reply, or when the token came from the chat itself.
// No dependencies.
//
//   node recall-evidence.selftest.mjs
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { RECALL_EVENT, sessionLines, recallEvidence } = require('./recall-evidence.js');

const CHAT2 = 'c2c2c2c2-0000-4000-8000-000000000002';
const CHAT1 = 'c1c1c1c1-0000-4000-8000-000000000001';
const TOKEN = 'amber-osprey-mabc123';
const key = (id) => `agent:default:console:${id}`;
const line = (o) => JSON.stringify(o);
const user = (id, text, runId) => line({ sessionKey: key(id), role: 'user', text, runId });
const assistant = (id, text, runId, memoryRecall) =>
  line({ sessionKey: key(id), role: 'assistant', text, runId, metadata: { provider: 'pi-session', model: 'mindstone/default', ...(memoryRecall ? { memoryRecall } : {}) } });
const recall = (id, runId, hits, query = 'What is my project codename?') =>
  line({
    sessionKey: key(id),
    role: 'event',
    text: `Injected ${hits.length} recalled memory chunk(s) into prompt context.`,
    runId,
    metadata: { event: RECALL_EVENT, query, hitCount: hits.length, promptTokens: 42, hits },
  });
const hit = { id: 'mem-1', chunkId: 'mem-1#0', title: 'Project codename', score: 0.81, recallMode: 'embedding' };
const ask = 'What is my project codename? Answer with just the codename.';

const cases = [
  {
    name: 'recall event with hits in the reply\'s own run: proven',
    text: [user(CHAT2, ask, 'r2'), recall(CHAT2, 'r2', [hit]), assistant(CHAT2, TOKEN, 'r2', { query: ask, hitCount: 1, promptTokens: 42 })],
    ok: true,
  },
  {
    name: 'the same, among other conversations, other events and junk lines',
    text: [
      'not json',
      user(CHAT1, `My project codename is ${TOKEN}. Please remember it.`, 'r1'),
      assistant(CHAT1, 'Noted.', 'r1'),
      line({ sessionKey: key(CHAT2), role: 'event', runId: 'r2', metadata: { event: 'memory_index_injected', total: 3 } }),
      user(CHAT2, ask, 'r2'),
      recall(CHAT2, 'r2', [hit]),
      assistant(CHAT2, TOKEN, 'r2'),
      recall(`x${CHAT2}`, 'r9', [hit]),
    ],
    ok: true,
    entries: 4,
  },
  {
    name: 'no recall event (the reply names the token anyway): not observable',
    text: [user(CHAT2, ask, 'r2'), assistant(CHAT2, TOKEN, 'r2', { query: ask, hitCount: 0, promptTokens: 0 })],
    ok: false,
    reason: /no memory_recall_injected event.*not observable/,
  },
  {
    name: 'only other events (identity formation, memory index): not recall',
    text: [
      line({ sessionKey: key(CHAT2), role: 'event', runId: 'r2', metadata: { event: 'identity_formation_prompted' } }),
      line({ sessionKey: key(CHAT2), role: 'event', runId: 'r2', metadata: { event: 'memory_index_injected' } }),
      user(CHAT2, ask, 'r2'),
      assistant(CHAT2, TOKEN, 'r2'),
    ],
    ok: false,
    reason: /not observable/,
  },
  {
    name: 'recall event with no hits',
    text: [user(CHAT2, ask, 'r2'), recall(CHAT2, 'r2', []), assistant(CHAT2, TOKEN, 'r2')],
    ok: false,
    reason: /lists no hits/,
  },
  {
    name: 'recall event in an earlier run, not the reply\'s',
    text: [user(CHAT2, 'hello', 'r1'), recall(CHAT2, 'r1', [hit]), assistant(CHAT2, 'Hi.', 'r1'), user(CHAT2, ask, 'r2'), assistant(CHAT2, TOKEN, 'r2')],
    ok: false,
    reason: /not in the reply's own turn/,
  },
  {
    name: 'recall event after the reply',
    text: [user(CHAT2, ask, 'r2'), assistant(CHAT2, TOKEN, 'r2'), recall(CHAT2, 'r2', [hit])],
    ok: false,
    reason: /not in the reply's own turn/,
  },
  {
    name: 'the token is in chat 2\'s own user turn',
    text: [user(CHAT2, `Is my codename ${TOKEN.toUpperCase()}?`, 'r2'), recall(CHAT2, 'r2', [hit]), assistant(CHAT2, TOKEN, 'r2')],
    ok: false,
    reason: /own user turns/,
  },
  {
    name: 'the token is in the recall query',
    text: [user(CHAT2, ask, 'r2'), recall(CHAT2, 'r2', [hit], `codename ${TOKEN}`), assistant(CHAT2, TOKEN, 'r2')],
    ok: false,
    reason: /recall query itself holds the token/,
  },
  {
    name: 'the reply\'s memoryRecall disagrees with the event',
    text: [user(CHAT2, ask, 'r2'), recall(CHAT2, 'r2', [hit]), assistant(CHAT2, TOKEN, 'r2', { query: ask, hitCount: 3, promptTokens: 42 })],
    ok: false,
    reason: /doesn't match/,
  },
  {
    name: 'no entries for the conversation (only chat 1 is in the transcript)',
    text: [user(CHAT1, `My project codename is ${TOKEN}.`, 'r1'), recall(CHAT1, 'r1', [hit]), assistant(CHAT1, 'Noted.', 'r1')],
    ok: false,
    reason: /no entries for this conversation/,
  },
  {
    name: 'no assistant entry yet',
    text: [user(CHAT2, ask, 'r2'), recall(CHAT2, 'r2', [hit])],
    ok: false,
    reason: /no assistant entry/,
  },
];

let failed = 0;
for (const c of cases) {
  const entries = sessionLines(c.text.join('\n'), CHAT2);
  const got = recallEvidence(entries, TOKEN);
  const ok = got.reasons.length === 0;
  const problems = [];
  if (ok !== c.ok) problems.push(`expected ${c.ok ? 'proven' : 'not proven'}, got ${ok ? 'proven' : `not proven (${got.reasons.join('; ')})`}`);
  if (!c.ok && c.reason && !got.reasons.some((r) => c.reason.test(r))) problems.push(`no reason matching ${c.reason}: ${got.reasons.join('; ')}`);
  if (c.entries !== undefined && got.entries !== c.entries) problems.push(`expected ${c.entries} entries for chat 2, got ${got.entries}`);
  if (ok && got.hitCount < 1) problems.push('proven with no hits');
  if (problems.length) failed += 1;
  console.log(`${problems.length ? 'FAIL' : 'ok  '} ${c.name}${problems.length ? `: ${problems.join('; ')}` : ''}`);
}
// sessionLines matches the conversation id as a whole segment, never as a substring.
if (sessionLines(recall(`x${CHAT2}`, 'r', [hit]), CHAT2).length !== 0 || sessionLines(user(CHAT2, 'x'), '').length !== 0) {
  failed += 1;
  console.log('FAIL sessionLines matched a different conversation, or an empty id');
} else {
  console.log('ok   sessionLines matches only `:<conversationId>`');
}
console.log(failed ? `recall-evidence self-test: ${failed} FAILED` : `recall-evidence self-test: all ${cases.length + 1} passed`);
process.exit(failed ? 1 : 0);
