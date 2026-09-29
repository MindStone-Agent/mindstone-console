/**
 * Reads the gateway's recall index (<dataDir>/vectors/memory.sqlite) for J9
 * (and J12, which reads the stored vectors' sizes),
 * OUT OF PROCESS: Playwright's module loader hook can't load `node:sqlite` in
 * the test process ("Expected a string, an ArrayBuffer, or a TypedArray to be
 * returned for the "source" from the "load" hook but got null"). So
 * `queryRecallIndex` runs this same file under plain node
 * (process.execPath), which opens the index read-only with node:sqlite
 * (Node 22.13+; the harness needs 22.19) and prints JSON.
 *
 * A reader that fails (no index yet, locked, unreadable) throws with the
 * reader's own message; callers keep that a FAIL, never a pass.
 *
 * Plain CommonJS, shared by lib/journey.ts and lib/recall-evidence.selftest.mjs.
 *
 *   node recall-index.js <dbPath> embedded <token>
 *   node recall-index.js <dbPath> chunks <chunkId>...
 *   node recall-index.js <dbPath> dims
 *   node recall-index.js <dbPath> chunkdims <chunkId>...
 *   node recall-index.js <dbPath> vectors
 */
const { execFileSync } = require('node:child_process');

/** Rows from the recall index, read in a child node process. Throws if the reader fails. */
function queryRecallIndex(dbPath, mode, args = []) {
  let out;
  try {
    out = execFileSync(process.execPath, ['--no-warnings', __filename, dbPath, mode, ...args.map(String)], {
      encoding: 'utf8',
      // No inherited preloads: the child is plain node, whatever the parent was started with.
      env: { ...process.env, NODE_OPTIONS: '' },
      stdio: ['ignore', 'pipe', 'pipe'],
      maxBuffer: 64 * 1024 * 1024,
      timeout: 30_000,
    });
  } catch (error) {
    const stderr = String(error?.stderr ?? '').trim();
    throw new Error(`the recall index reader failed: ${stderr.split('\n').pop() || error?.message || String(error)}`);
  }
  const parsed = JSON.parse(out);
  if (!parsed || !Array.isArray(parsed.rows)) throw new Error('the recall index reader returned no rows array');
  return parsed.rows;
}

/**
 * The SQL for the embedding model a chunk records: a column named for it (the first of EMBEDDING_MODEL_COLUMNS the
 * table has), else a key in metadata_json, else NULL (the index records none). MindStone-Agent #140 adds the record;
 * adjust the names here if it lands under another one.
 */
const EMBEDDING_MODEL_COLUMNS = ['embedding_model', 'embedding_provider', 'embedding_spec', 'embedded_by'];
const EMBEDDING_MODEL_KEYS = ['$.embeddingModel', '$.embeddingProvider', '$.embedding.model'];
function embeddingModelColumn(db) {
  const columns = db.prepare('PRAGMA table_info(memory_chunks)').all().map((c) => c.name);
  const column = EMBEDDING_MODEL_COLUMNS.find((name) => columns.includes(name));
  if (column) return column;
  if (!columns.includes('metadata_json')) return 'NULL';
  return `CASE WHEN json_valid(metadata_json) THEN coalesce(${EMBEDDING_MODEL_KEYS.map((key) => `json_extract(metadata_json, '${key}')`).join(', ')}) END`;
}

/** The reader itself (run as a child). */
function read(dbPath, mode, args) {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { DatabaseSync } = require('node:sqlite');
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    if (mode === 'embedded') {
      // Chunks that hold the token and are embedded: the fact is ready to recall.
      return db
        .prepare('SELECT chunk_id, kind, path FROM memory_chunks WHERE instr(lower(text), ?) > 0 AND embedding_json IS NOT NULL')
        .all(String(args[0] ?? '').toLowerCase());
    }
    if (mode === 'chunks') {
      if (!args.length) return [];
      // updated_at when the index has the column: a chunk written after the recall event can't be what it injected.
      const hasUpdatedAt = db.prepare('PRAGMA table_info(memory_chunks)').all().some((c) => c.name === 'updated_at');
      return db
        .prepare(`SELECT chunk_id, text${hasUpdatedAt ? ', updated_at' : ''} FROM memory_chunks WHERE chunk_id IN (${args.map(() => '?').join(', ')})`)
        .all(...args);
    }
    if (mode === 'dims') {
      // Chunks by their vector's size (J12): dims null for a chunk not embedded yet, -1 for an unreadable vector.
      return db
        .prepare(
          `SELECT CASE WHEN embedding_json IS NULL THEN NULL WHEN json_valid(embedding_json) THEN json_array_length(embedding_json) ELSE -1 END AS dims,
                  count(*) AS n
           FROM memory_chunks GROUP BY 1 ORDER BY 1`,
        )
        .all();
    }
    if (mode === 'chunkdims' || mode === 'vectors') {
      // J12: each chunk's vector size (as in `dims`) and the embedding model it records, if the index records one
      // (MindStone-Agent #140: every chunk records the model that embedded it). `chunkdims`: the given chunks (what
      // recall scored); `vectors`: every chunk.
      if (mode === 'chunkdims' && !args.length) return [];
      const model = embeddingModelColumn(db);
      return db
        .prepare(
          `SELECT chunk_id,
                  CASE WHEN embedding_json IS NULL THEN NULL WHEN json_valid(embedding_json) THEN json_array_length(embedding_json) ELSE -1 END AS dims,
                  ${model} AS model
           FROM memory_chunks${mode === 'chunkdims' ? ` WHERE chunk_id IN (${args.map(() => '?').join(', ')})` : ''}`,
        )
        .all(...(mode === 'chunkdims' ? args : []));
    }
    throw new Error(`unknown mode "${mode}" (embedded, chunks, dims, chunkdims or vectors)`);
  } finally {
    db.close();
  }
}

if (require.main === module) {
  const [dbPath, mode, ...args] = process.argv.slice(2);
  try {
    process.stdout.write(JSON.stringify({ rows: read(dbPath, mode, args) }));
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(2);
  }
}

module.exports = { queryRecallIndex };
