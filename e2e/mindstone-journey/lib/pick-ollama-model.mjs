// Picks the chat model the journey uses from an Ollama's /api/tags (stdin).
// Read-only: it never pulls, loads or changes anything in Ollama.
//
//   node pick-ollama-model.mjs <allow-local 0|1> <max local GB>
//
// Default: the smallest ":cloud" model already listed. It runs remotely, so a
// shared Ollama never has to load anything for the journey. A local model
// is used only with allow-local=1 (UAT_OLLAMA_ALLOW_LOCAL=1), because chatting
// with it loads it into that Ollama; then the smallest one at or under the
// size cap wins, and :cloud is the fallback. Embedding models are skipped.
// Prints the model name, or nothing.
const allowLocal = process.argv[2] === '1';
const capGb = Number(process.argv[3] ?? '8');
let input = '';
for await (const chunk of process.stdin) input += chunk;
const models = (JSON.parse(input).models ?? []).filter((m) => {
  const family = `${m.details?.family ?? ''} ${(m.details?.families ?? []).join(' ')}`;
  return !/embed/i.test(m.name) && !/bert/i.test(family);
});
const isCloud = (m) => /[:-]cloud$/.test(m.name) || Boolean(m.remote_host);
const cloud = models.filter(isCloud).sort((a, b) => a.size - b.size || a.name.localeCompare(b.name));
const local = models
  .filter((m) => !isCloud(m) && m.size <= capGb * 1024 ** 3)
  .sort((a, b) => a.size - b.size);
const pick = allowLocal ? (local[0] ?? cloud[0]) : cloud[0];
console.error(
  `ollama: ${models.length} chat models; cloud: ${cloud.map((m) => m.name).join(', ') || 'none'}; ` +
    `local <= ${capGb}GB: ${local.map((m) => m.name).join(', ') || 'none'} (${allowLocal ? 'allowed' : 'not used without UAT_OLLAMA_ALLOW_LOCAL=1'}); ` +
    `picked: ${pick?.name ?? 'none'}`,
);
if (pick) process.stdout.write(pick.name);
