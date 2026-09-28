// Picks the chat model the journey uses from a local Ollama's /api/tags (stdin).
// Read-only: it never pulls, loads or changes anything in Ollama.
//
// Order: the smallest local chat model at or under the size cap (argv[2], GB),
// so a shared Ollama isn't made to load a huge model; otherwise the smallest
// ":cloud" model already listed (served remotely, nothing loaded locally).
// Embedding models are skipped. Prints the model name, or nothing.
const capGb = Number(process.argv[2] ?? '8');
let input = '';
for await (const chunk of process.stdin) input += chunk;
const models = (JSON.parse(input).models ?? []).filter((m) => {
  const family = `${m.details?.family ?? ''} ${(m.details?.families ?? []).join(' ')}`;
  return !/embed/i.test(m.name) && !/bert/i.test(family);
});
const isCloud = (m) => /[:-]cloud$/.test(m.name) || m.remote_host;
const local = models
  .filter((m) => !isCloud(m) && m.size <= capGb * 1024 ** 3)
  .sort((a, b) => a.size - b.size);
const cloud = models.filter(isCloud).sort((a, b) => a.size - b.size || a.name.localeCompare(b.name));
const pick = local[0] ?? cloud[0];
console.error(
  `ollama: ${models.length} chat models; local <= ${capGb}GB: ${local.map((m) => m.name).join(', ') || 'none'}; cloud: ${cloud.map((m) => m.name).join(', ') || 'none'}; picked: ${pick?.name ?? 'none'}`,
);
if (pick) process.stdout.write(pick.name);
