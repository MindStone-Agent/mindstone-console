// Picks a model from an Ollama's /api/tags (stdin). Read-only: it never
// pulls, loads or changes anything in Ollama.
//
//   node pick-ollama-model.mjs chat <allow-local 0|1> <max local GB>
//   node pick-ollama-model.mjs embed
//   node pick-ollama-model.mjs alt <current model>
//
// chat: the smallest ":cloud" model already listed. It runs remotely, so a
//   shared Ollama never has to load anything for the journey. A local chat
//   model is used only with allow-local=1 (UAT_OLLAMA_ALLOW_LOCAL=1), because
//   chatting with it loads a large model into that Ollama; then the smallest
//   one at or under the size cap wins, and :cloud is the fallback.
// embed: an embedding model that is already pulled (nomic-embed-text first,
//   then the smallest). These are small and embedding is read-only use, so no
//   opt-in is needed; nothing is ever pulled here (see UAT_OLLAMA_ALLOW_PULL).
// alt: J12's candidates for another default model: every ":cloud" chat model
//   other than <current>, smallest first, one per line (run-journey.sh asks
//   each for a short reply and passes on the first that answers).
// Prints the model name (alt: names), or nothing.
const mode = process.argv[2];
let input = '';
for await (const chunk of process.stdin) input += chunk;
const all = JSON.parse(input).models ?? [];
const family = (m) => `${m.details?.family ?? ''} ${(m.details?.families ?? []).join(' ')}`;
const isEmbed = (m) => /embed/i.test(m.name) || /bert/i.test(family(m));
const isCloud = (m) => /[:-]cloud$/.test(m.name) || Boolean(m.remote_host);

if (mode === 'embed') {
  const embeds = all.filter((m) => isEmbed(m) && !isCloud(m)).sort((a, b) => a.size - b.size);
  const pick = embeds.find((m) => /^nomic-embed-text(:|$)/.test(m.name)) ?? embeds[0];
  console.error(`ollama: embedding models pulled: ${embeds.map((m) => m.name).join(', ') || 'none'}; picked: ${pick?.name ?? 'none'}`);
  if (pick) process.stdout.write(pick.name);
} else if (mode === 'chat') {
  const allowLocal = process.argv[3] === '1';
  const capGb = Number(process.argv[4] ?? '8');
  const models = all.filter((m) => !isEmbed(m));
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
} else if (mode === 'alt') {
  const current = process.argv[3] ?? '';
  const cloud = all.filter((m) => !isEmbed(m) && isCloud(m) && m.name !== current).sort((a, b) => a.size - b.size || a.name.localeCompare(b.name));
  console.error(`ollama: other cloud chat models for J12: ${cloud.map((m) => m.name).join(', ') || 'none'}`);
  if (cloud.length) process.stdout.write(`${cloud.map((m) => m.name).join('\n')}\n`);
} else {
  console.error('usage: pick-ollama-model.mjs chat <allow-local> <max-gb> | embed | alt <current>');
  process.exit(2);
}
