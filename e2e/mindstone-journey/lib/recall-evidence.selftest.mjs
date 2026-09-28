// Offline self-test of J9's recall checks (lib/recall-evidence.js), on
// synthetic gateway transcript lines and recall-index chunks shaped like
// MindStone-Agent's. Recall is proven only when the reply's own run has a
// memory_recall_injected event with hits, a hit's chunk holds the token, and
// the token is in no other entry. Every way that can fail must fail with a
// reason; the negative control and the invariant-file rule are checked too.
// No dependencies.
//
//   node recall-evidence.selftest.mjs
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { RECALL_EVENT, sessionLines, recallEvidence, controlEvidence, isInvariantMarkdown } = require('./recall-evidence.js');

const CHAT3 = 'c3c3c3c3-0000-4000-8000-000000000003';
const CHAT2 = 'c2c2c2c2-0000-4000-8000-000000000002';
const CHAT1 = 'c1c1c1c1-0000-4000-8000-000000000001';
const TOKEN = 'juniper-mabc123';
const key = (id) => `agent:default:console:${id}`;
const line = (o) => JSON.stringify(o);
const user = (id, text, runId) => line({ sessionKey: key(id), role: 'user', text, runId });
const entry = (id, role, text, runId, metadata) => line({ sessionKey: key(id), role, text, runId, metadata });
const assistant = (id, text, runId, memoryRecall) =>
  line({ sessionKey: key(id), role: 'assistant', text, runId, metadata: { event: 'assistant_response', provider: 'pi-session', ...(memoryRecall ? { memoryRecall } : {}) } });
const EVENT_AT = '2026-09-28T12:00:10.000Z';
const recall = (id, runId, hits, query = "What is my dog's name?", role = 'event', sessionKey = key(id), timestamp = EVENT_AT) =>
  line({
    sessionKey,
    role,
    ...(timestamp ? { timestamp } : {}),
    text: `Injected ${hits.length} recalled memory chunk(s) into prompt context.`,
    ...(runId ? { runId } : {}),
    metadata: { event: RECALL_EVENT, query, hitCount: hits.length, promptTokens: 42, hits },
  });
const hit = { id: 'transcript:c1', chunkId: 'chunk-dog', title: 'Owner facts', score: 0.81, recallMode: 'embedding' };
const j6hit = { id: 'transcript:c0', chunkId: 'chunk-j6', title: 'Owner facts', score: 0.4, recallMode: 'lexical' };
const CHUNKS = {
  'chunk-dog': { text: `My dog's name is ${TOKEN}. Please remember it.`, updatedAt: '2026-09-28T12:00:00.000Z' },
  'chunk-j6': { text: 'my project codename is amber-heron-4242', updatedAt: '2026-09-28T11:00:00.000Z' },
};
const withChunk = (patch) => ({ ...CHUNKS, 'chunk-dog': { ...CHUNKS['chunk-dog'], ...patch } });
const ask = "What is my dog's name? Answer with just the name.";
const meta = { query: ask, hitCount: 1, promptTokens: 42 };

const proofCases = [
  { name: "proven: event with hits in the reply's run, a hit's chunk holds the token", text: [user(CHAT2, ask, 'r2'), recall(CHAT2, 'r2', [hit]), assistant(CHAT2, TOKEN, 'r2', meta)], ok: true },
  {
    name: 'proven among other conversations, other events and junk lines',
    text: [
      'not json',
      user(CHAT1, `My dog's name is ${TOKEN}. Please remember it.`, 'r1'),
      assistant(CHAT1, 'Noted.', 'r1'),
      entry(CHAT2, 'event', 'Injected the memory index', 'r2', { event: 'memory_index_injected', total: 3 }),
      user(CHAT2, ask, 'r2'),
      recall(CHAT2, 'r2', [j6hit, hit]),
      assistant(CHAT2, TOKEN, 'r2', { ...meta, hitCount: 2 }),
    ],
    ok: true,
    entries: 4,
  },
  {
    name: 'proven, but the reply carries no memoryRecall: said in notes, not passed silently',
    text: [user(CHAT2, ask, 'r2'), recall(CHAT2, 'r2', [hit]), assistant(CHAT2, TOKEN, 'r2')],
    ok: true,
    note: /no metadata\.memoryRecall.*Cairn/,
  },
  { name: 'no recall event (the reply names the token anyway): not observable', text: [user(CHAT2, ask, 'r2'), assistant(CHAT2, TOKEN, 'r2', { ...meta, hitCount: 0 })], ok: false, reason: /no memory_recall_injected event.*not observable/ },
  {
    name: 'only other events (identity formation, memory index): not recall',
    text: [entry(CHAT2, 'event', '', 'r2', { event: 'identity_formation_prompted' }), entry(CHAT2, 'event', '', 'r2', { event: 'memory_index_injected' }), user(CHAT2, ask, 'r2'), assistant(CHAT2, TOKEN, 'r2')],
    ok: false,
    reason: /not observable/,
  },
  { name: 'recall event with no hits', text: [user(CHAT2, ask, 'r2'), recall(CHAT2, 'r2', []), assistant(CHAT2, TOKEN, 'r2')], ok: false, reason: /lists no hits/ },
  {
    name: "recall event in an earlier run, not the reply's",
    text: [user(CHAT2, 'hello', 'r1'), recall(CHAT2, 'r1', [hit]), assistant(CHAT2, 'Hi.', 'r1'), user(CHAT2, ask, 'r2'), assistant(CHAT2, TOKEN, 'r2')],
    ok: false,
    reason: /not in the reply's own turn/,
  },
  { name: 'recall event after the reply', text: [user(CHAT2, ask, 'r2'), assistant(CHAT2, TOKEN, 'r2'), recall(CHAT2, 'r2', [hit])], ok: false, reason: /not in the reply's own turn/ },
  // Mutant: run ids not required. An event without a run id, or a reply without one, must not pass.
  { name: 'recall event without a run id', text: [user(CHAT2, ask, 'r2'), recall(CHAT2, undefined, [hit]), assistant(CHAT2, TOKEN, 'r2')], ok: false, reason: /not in the reply's own turn/ },
  { name: 'reply without a run id', text: [user(CHAT2, ask), recall(CHAT2, 'r2', [hit]), assistant(CHAT2, TOKEN, undefined)], ok: false, reason: /no run id/ },
  // Mutant: role check dropped. A non-event entry carrying the event name is not the gateway's recall event.
  { name: 'a system entry named memory_recall_injected is not the event', text: [user(CHAT2, ask, 'r2'), recall(CHAT2, 'r2', [hit], "What is my dog's name?", 'system'), assistant(CHAT2, TOKEN, 'r2')], ok: false, reason: /not observable/ },
  // Mutant: session key matched with includes. Another session whose key only contains chat 2's id doesn't count.
  {
    name: "a recall event in a session whose key only contains chat 2's id",
    text: [user(CHAT2, ask, 'r2'), recall(CHAT2, 'r2', [hit], "What is my dog's name?", 'event', `${key(CHAT2)}:thread`), assistant(CHAT2, TOKEN, 'r2')],
    ok: false,
    reason: /not observable/,
    entries: 2,
  },
  // (b) the token anywhere else in chat 2.
  { name: "the token is in chat 2's own user turn", text: [user(CHAT2, `Is my dog ${TOKEN.toUpperCase()}?`, 'r2'), recall(CHAT2, 'r2', [hit]), assistant(CHAT2, TOKEN, 'r2')], ok: false, reason: /other than the reply/ },
  { name: 'the token is in the recall query', text: [user(CHAT2, ask, 'r2'), recall(CHAT2, 'r2', [hit], `dog ${TOKEN}`), assistant(CHAT2, TOKEN, 'r2')], ok: false, reason: /other than the reply/ },
  { name: 'the token is in a system entry', text: [entry(CHAT2, 'system', `Owner facts: dog ${TOKEN}`, 'r2'), user(CHAT2, ask, 'r2'), recall(CHAT2, 'r2', [hit]), assistant(CHAT2, TOKEN, 'r2')], ok: false, reason: /other than the reply/ },
  { name: 'the token is in a tool entry', text: [user(CHAT2, ask, 'r2'), recall(CHAT2, 'r2', [hit]), entry(CHAT2, 'tool', `search result: ${TOKEN}`, 'r2'), assistant(CHAT2, TOKEN, 'r2')], ok: false, reason: /other than the reply/ },
  { name: 'the token is in another event', text: [entry(CHAT2, 'event', 'x', 'r2', { event: 'identity_formation_prompted', prompt: TOKEN }), user(CHAT2, ask, 'r2'), recall(CHAT2, 'r2', [hit]), assistant(CHAT2, TOKEN, 'r2')], ok: false, reason: /other than the reply/ },
  { name: "a hit title naming the token is recall's own provenance, not a leak", text: [user(CHAT2, ask, 'r2'), recall(CHAT2, 'r2', [{ ...hit, title: `Dog ${TOKEN}` }]), assistant(CHAT2, TOKEN, 'r2')], ok: true },
  // (a) the hit must be tied to the fact.
  { name: "only J6's chunk was recalled", text: [user(CHAT2, ask, 'r2'), recall(CHAT2, 'r2', [j6hit]), assistant(CHAT2, TOKEN, 'r2')], ok: false, reason: /none of the 1 recalled chunk/ },
  { name: 'the chunk holding the token is not among the hits', text: [user(CHAT2, ask, 'r2'), recall(CHAT2, 'r2', [{ ...hit, chunkId: 'chunk-other' }]), assistant(CHAT2, TOKEN, 'r2')], ok: false, reason: /none of the 1 recalled chunk/ },
  // (a) the chunk must have been written before the recall event injected it (when the index has updated_at).
  { name: 'the chunk holding the token was written after the recall event', text: [user(CHAT2, ask, 'r2'), recall(CHAT2, 'r2', [hit]), assistant(CHAT2, TOKEN, 'r2')], chunks: withChunk({ updatedAt: '2026-09-28T12:00:11.000Z' }), ok: false, reason: /written after the recall event/ },
  { name: 'the chunk written at the same instant as the event counts', text: [user(CHAT2, ask, 'r2'), recall(CHAT2, 'r2', [hit]), assistant(CHAT2, TOKEN, 'r2')], chunks: withChunk({ updatedAt: EVENT_AT }), ok: true },
  { name: 'an index without updated_at: the time check is skipped', text: [user(CHAT2, ask, 'r2'), recall(CHAT2, 'r2', [hit]), assistant(CHAT2, TOKEN, 'r2')], chunks: withChunk({ updatedAt: undefined }), ok: true },
  { name: 'a recall event without a timestamp, against an index with updated_at', text: [user(CHAT2, ask, 'r2'), recall(CHAT2, 'r2', [hit], "What is my dog's name?", 'event', key(CHAT2), null), assistant(CHAT2, TOKEN, 'r2')], ok: false, reason: /no timestamp/ },
  { name: "the chunks' text could not be read", text: [user(CHAT2, ask, 'r2'), recall(CHAT2, 'r2', [hit]), assistant(CHAT2, TOKEN, 'r2')], chunks: null, ok: false, reason: /could not be read/ },
  // sev2: the hitCount cross-check fires when the field is there.
  { name: "the reply's memoryRecall disagrees with the event", text: [user(CHAT2, ask, 'r2'), recall(CHAT2, 'r2', [hit]), assistant(CHAT2, TOKEN, 'r2', { ...meta, hitCount: 3 })], ok: false, reason: /doesn't match/ },
  { name: 'no entries for the conversation (only chat 1 is in the transcript)', text: [user(CHAT1, `My dog's name is ${TOKEN}.`, 'r1'), recall(CHAT1, 'r1', [hit]), assistant(CHAT1, 'Noted.', 'r1')], ok: false, reason: /no entries for this conversation/ },
  { name: 'no assistant entry yet', text: [user(CHAT2, ask, 'r2'), recall(CHAT2, 'r2', [hit])], ok: false, reason: /no assistant entry/ },
];

const controlCases = [
  { name: 'control holds: a reply without the token, no recall event', text: [user(CHAT3, ask, 'r3'), assistant(CHAT3, "I don't know your dog's name yet.", 'r3')], ok: true },
  { name: 'control: a recall event with recall off', text: [user(CHAT3, ask, 'r3'), recall(CHAT3, 'r3', [hit]), assistant(CHAT3, 'No idea.', 'r3')], ok: false, reason: /still has 1 memory_recall_injected/ },
  { name: 'control: the reply still names the token', text: [user(CHAT3, ask, 'r3'), assistant(CHAT3, TOKEN, 'r3')], ok: false, reason: /token is still in the control/ },
  { name: 'control: the token reached the chat another way (a tool)', text: [user(CHAT3, ask, 'r3'), entry(CHAT3, 'tool', TOKEN, 'r3'), assistant(CHAT3, 'No idea.', 'r3')], ok: false, reason: /token is still in the control/ },
  { name: 'control: no reply', text: [user(CHAT3, ask, 'r3')], ok: false, reason: /no reply/ },
];

const invariantCases = [
  ['---\nname: rule\ncritical: true\ninvariant: Never share the dog\'s name\n---\nBody', true],
  ['---\ninvariant: >-\n  folded rule\n---\nBody', true],
  ['---\nname: note\ndescription: a fact\n---\ninvariant: in the body is not frontmatter', false],
  // The gateway's parseMarkdown keeps a nested invariant when there's no top-level one, and injects it.
  ['---\nmetadata:\n  invariant: nested\n  critical: true\n---\nBody', true],
  ['---\nname: rule\n  invariant: indented\n---\nBody', true],
  ['---\nmetadata:\n  invariant:\n---\nBody', false],
  ['---\ninvariant:\n---\nBody', false],
  ['# Just markdown\ninvariant: x', false],
];

let failed = 0;
let count = 0;
const report = (name, problems) => {
  count += 1;
  if (problems.length) failed += 1;
  console.log(`${problems.length ? 'FAIL' : 'ok  '} ${name}${problems.length ? `: ${problems.join('; ')}` : ''}`);
};
for (const c of proofCases) {
  const got = recallEvidence(sessionLines(c.text.join('\n'), CHAT2), TOKEN, c.chunks === null ? undefined : (c.chunks ?? CHUNKS));
  const ok = got.reasons.length === 0;
  const problems = [];
  if (ok !== c.ok) problems.push(`expected ${c.ok ? 'proven' : 'not proven'}, got ${ok ? 'proven' : `not proven (${got.reasons.join('; ')})`}`);
  if (!c.ok && c.reason && !got.reasons.some((r) => c.reason.test(r))) problems.push(`no reason matching ${c.reason}: ${got.reasons.join('; ')}`);
  if (c.note && !got.notes.some((n) => c.note.test(n))) problems.push(`no note matching ${c.note}`);
  if (c.entries !== undefined && got.entries !== c.entries) problems.push(`expected ${c.entries} entries for chat 2, got ${got.entries}`);
  if (ok && (got.hitCount < 1 || got.hitChunksWithToken < 1)) problems.push('proven without a hit tied to the token');
  report(c.name, problems);
}
for (const c of controlCases) {
  const got = controlEvidence(sessionLines(c.text.join('\n'), CHAT3), TOKEN);
  const ok = got.reasons.length === 0;
  const problems = [];
  if (ok !== c.ok) problems.push(`expected ${c.ok ? 'holds' : 'broken'}, got ${ok ? 'holds' : `broken (${got.reasons.join('; ')})`}`);
  if (!c.ok && c.reason && !got.reasons.some((r) => c.reason.test(r))) problems.push(`no reason matching ${c.reason}: ${got.reasons.join('; ')}`);
  report(c.name, problems);
}
for (const [text, want] of invariantCases) {
  const got = isInvariantMarkdown(text);
  report(`invariant file ${want ? 'recognised' : 'not claimed'}: ${JSON.stringify(text.slice(0, 40))}`, got === want ? [] : [`expected ${want}, got ${got}`]);
}
// sessionLines matches the conversation id as the whole last segment, never as a substring.
const stray = [recall(`x${CHAT2}`, 'r', [hit]), recall(CHAT2, 'r', [hit], 'q', 'event', `${key(CHAT2)}:sub`), recall(CHAT2, 'r', [hit], 'q', 'event', CHAT2)];
report(
  'sessionLines matches only a key ending in `:<conversationId>`',
  sessionLines(stray.join('\n'), CHAT2).length === 0 && sessionLines(user(CHAT2, 'x'), '').length === 0 ? [] : ['it matched a different session, or an empty id'],
);
console.log(failed ? `recall-evidence self-test: ${failed} of ${count} FAILED` : `recall-evidence self-test: all ${count} passed`);
process.exit(failed ? 1 : 0);
