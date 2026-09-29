// A stub Azure OpenAI endpoint for J11 (enterprise endpoint, MindStone-Agent
// #126). It stands in for `https://<resource>.openai.azure.com/openai/v1`:
//
// - POST <anything>/responses (the OpenAI Responses API, which Pi's
//   azure-openai-responses client calls as `<endpoint>/responses?api-version=v1`)
//   answers only a request whose `api-key` header is this run's fake key, with
//   the Responses API's SSE stream (or its JSON, for stream: false). The text is
//   "Enterprise stub reply: <token> (request #<n>, nonce <nonce>).", where
//   <token> is unique to the run, <n> is the request's number in the log, and
//   <nonce> is echoed from a `[nonce:<value>]` marker in the last user message
//   (left out when there is none). A reply or Test result that shows it came
//   from here, and from that exact logged request.
// - A missing or wrong key gets Azure's 401. Anything else gets 404.
// - GET /__stub/health answers 200 without a key (readiness only).
//
// Every request is appended to the request log (JSON lines) BEFORE it is
// answered, with the key never in it: the `api-key` header is recorded as
// "ok" / "wrong" / "missing", every other credential-like header as
// "<redacted, N chars>", and the key, if the request carries it anywhere else
// (the URL with its query, another header, the body; percent-decoded too), is
// replaced and flagged (`keyOutsideApiKeyHeader`). The request also records
// whether it carried any "forbidden" credential anywhere (the gateway's own
// token, the admin credential: MindStone-Agent #80 says they never leave the
// gateway), again as a flag, never the value. The body is summarised (model, stream,
// size, the last user message's text), not stored: it holds the whole system
// prompt.
//
// The key and the forbidden values are read from files (never argv, never the
// log). A watched file that can't be read, or holds less than 8 characters,
// stops the stub (exit 1): a credential it can't see is one it can't watch for. Used as a module by lib/enterprise.selftest.mjs, and run by
// run-journey.sh:
//
//   UAT_ENT_STUB_PORT=<port> UAT_ENT_KEY_FILE=<file> UAT_ENT_TOKEN=<token> \
//   UAT_ENT_STUB_LOG=<requests.jsonl> [UAT_ENT_FORBIDDEN_FILES=<file>:<file>] \
//   [UAT_ENT_STUB_PARENT_PID=<pid>] node azure-stub.mjs
//
// It listens on 127.0.0.1 only, and exits by itself when its parent (the
// harness) is gone or after UAT_ENT_STUB_MAX_MS (default 3 h), so a killed
// harness can't leave it running.
//
// With UAT_ENT_STUB_TLS_CERT and UAT_ENT_STUB_TLS_KEY (PEM files) it speaks
// https instead of http. The harness's stack mode (UAT_INSTALL=stack) needs it:
// the gateway in its container reaches the stub as host.docker.internal, which
// isn't loopback, and MindStone-Agent #126 allows plain http to loopback only.
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import { fileURLToPath } from 'node:url';

/** Where the Responses API is called, as a path suffix. Pi posts to `<endpoint>/responses`; adjust here if that changes. */
export const RESPONSES_SUFFIX = '/responses';
/** The key header Azure OpenAI takes (the AzureOpenAI SDK sends the key in it). */
export const KEY_HEADER = 'api-key';
export const HEALTH_PATH = '/__stub/health';

/** Headers whose values are never recorded, only their length. */
const SENSITIVE_HEADER = /^(authorization|proxy-authorization|cookie|api-key|ocp-apim-subscription-key)$|(key|token|secret|auth)/i;

/** The marker J11 puts in a chat message; the stub echoes its value (letters, digits and dashes only). */
export const NONCE_MARKER = /\[nonce:([A-Za-z0-9-]{1,40})\]/;

/** The reply text the stub streams: the run's token, the request's number in the log, and the message's nonce, if any. */
export function replyText(token, n, nonce) {
  return `Enterprise stub reply: ${token} (request #${n}${nonce ? `, nonce ${nonce}` : ''}).`;
}

/** The text and its percent-decoded form, so an encoded credential is still seen. */
function withDecoded(text) {
  try {
    const decoded = decodeURIComponent(text);
    return decoded === text ? [text] : [text, decoded];
  } catch {
    return [text];
  }
}

/** Constant-time comparison of two strings (a length mismatch is simply false). */
function sameSecret(a, b) {
  const x = Buffer.from(String(a));
  const y = Buffer.from(String(b));
  return x.length === y.length && x.length > 0 && crypto.timingSafeEqual(x, y);
}

/** The last user message's text in a Responses API `input` (a string, or a list of items). */
export function lastUserText(input) {
  if (typeof input === 'string') return input;
  if (!Array.isArray(input)) return '';
  const users = input.filter((item) => item && item.role === 'user');
  const last = users[users.length - 1];
  if (!last) return '';
  if (typeof last.content === 'string') return last.content;
  if (!Array.isArray(last.content)) return '';
  return last.content
    .map((part) => (part && typeof part.text === 'string' ? part.text : ''))
    .filter(Boolean)
    .join('\n');
}

/** Every occurrence of each secret replaced with a label, so a value can never reach the log. */
function scrub(text, secrets) {
  let out = String(text);
  for (const { value, label } of secrets) {
    if (value) out = out.split(value).join(label);
  }
  return out;
}

/** The Responses API stream for one reply: created, the message item, text deltas, done, completed. */
export function responseEvents(text, model) {
  const id = `resp_${crypto.randomBytes(8).toString('hex')}`;
  const itemId = `msg_${crypto.randomBytes(8).toString('hex')}`;
  const item = {
    id: itemId,
    type: 'message',
    role: 'assistant',
    status: 'completed',
    content: [{ type: 'output_text', text, annotations: [] }],
  };
  const response = {
    id,
    object: 'response',
    created_at: Math.floor(Date.now() / 1000),
    status: 'completed',
    model,
    output: [item],
    usage: { input_tokens: 12, output_tokens: 8, total_tokens: 20, input_tokens_details: { cached_tokens: 0 }, output_tokens_details: { reasoning_tokens: 0 } },
  };
  // A few deltas, so the client really streams.
  const words = text.split(/(?<= )/);
  const events = [
    { type: 'response.created', response: { ...response, status: 'in_progress', output: [], usage: null } },
    { type: 'response.in_progress', response: { ...response, status: 'in_progress', output: [], usage: null } },
    { type: 'response.output_item.added', output_index: 0, item: { ...item, status: 'in_progress', content: [] } },
    { type: 'response.content_part.added', output_index: 0, content_index: 0, item_id: itemId, part: { type: 'output_text', text: '', annotations: [] } },
    ...words.map((delta) => ({ type: 'response.output_text.delta', output_index: 0, content_index: 0, item_id: itemId, delta })),
    { type: 'response.output_text.done', output_index: 0, content_index: 0, item_id: itemId, text },
    { type: 'response.content_part.done', output_index: 0, content_index: 0, item_id: itemId, part: { type: 'output_text', text, annotations: [] } },
    { type: 'response.output_item.done', output_index: 0, item },
    { type: 'response.completed', response },
  ];
  return { events: events.map((event, n) => ({ ...event, sequence_number: n })), response };
}

/**
 * Starts the stub. Options: port, key (the fake key's value), token, log (the
 * request log path), forbidden ([{ value, label }]: credentials that must
 * never arrive), host (127.0.0.1), tls ({ cert, key } in PEM: https instead
 * of http). Resolves to { server, port, url, close() }.
 */
export async function startAzureStub({ port, key, token, log, forbidden = [], host = '127.0.0.1', deltaDelayMs = 15, tls }) {
  if (!key || key.length < 8) throw new Error('azure stub: no key (at least 8 characters)');
  if (!token) throw new Error('azure stub: no token');
  if (!log) throw new Error('azure stub: no request log path');
  if (forbidden.some((f) => !f.value || f.value.length < 8)) throw new Error('azure stub: a watched credential is empty or shorter than 8 characters');
  const secrets = [{ value: key, label: '<the run key>' }, ...forbidden];
  let n = 0;

  const record = (entry) => {
    fs.appendFileSync(log, `${scrub(JSON.stringify(entry), secrets)}\n`);
  };

  const handler = (req, res) => {
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size <= 4 * 1024 * 1024) chunks.push(chunk);
    });
    req.on('end', () => {
      n += 1;
      const raw = Buffer.concat(chunks).toString('utf8');
      const url = new URL(req.url ?? '/', 'http://stub.invalid');
      const given = req.headers[KEY_HEADER];
      const auth = given === undefined ? 'missing' : sameSecret(given, key) ? 'ok' : 'wrong';
      const headers = {};
      // Everywhere but the api-key header: the URL (path and query), every other header, the body.
      const elsewhere = [...withDecoded(req.url ?? ''), ...withDecoded(raw)];
      const forbiddenSeen = new Set();
      for (const [name, value] of Object.entries(req.headers)) {
        const text = Array.isArray(value) ? value.join(', ') : String(value ?? '');
        if (name !== KEY_HEADER) elsewhere.push(...withDecoded(text));
        else for (const f of forbidden) if (text.includes(f.value)) forbiddenSeen.add(f.label);
        headers[name] = name === KEY_HEADER ? `<${auth}>` : SENSITIVE_HEADER.test(name) ? `<redacted, ${text.length} chars>` : text;
      }
      const keyOutsideApiKeyHeader = elsewhere.some((text) => text.includes(key));
      for (const f of forbidden) if (elsewhere.some((text) => text.includes(f.value))) forbiddenSeen.add(f.label);
      let body;
      try {
        body = raw ? JSON.parse(raw) : undefined;
      } catch {
        body = undefined;
      }
      const isResponses = req.method === 'POST' && url.pathname.endsWith(RESPONSES_SUFFIX);
      const entry = {
        n,
        at: new Date().toISOString(),
        method: req.method,
        path: url.pathname,
        apiVersion: url.searchParams.get('api-version'),
        queryNames: [...new Set(url.searchParams.keys())],
        auth,
        headers,
        keyOutsideApiKeyHeader,
        forbiddenCredentialSeen: [...forbiddenSeen],
        body: {
          bytes: Buffer.byteLength(raw),
          json: body !== undefined,
          model: body && typeof body.model === 'string' ? body.model : undefined,
          stream: body ? body.stream === true : undefined,
          lastUserText: body ? lastUserText(body.input).slice(-4000) : undefined,
        },
      };

      const answer = (status, answered, payload, type = 'application/json') => {
        record({ ...entry, status, answered, tokenSent: answered.startsWith('responses') });
        res.writeHead(status, { 'content-type': type });
        res.end(payload);
      };

      if (req.method === 'GET' && url.pathname === HEALTH_PATH) return answer(200, 'health', '{"ok":true}');
      if (auth !== 'ok') {
        // What Azure says for a bad key.
        return answer(401, 'unauthorized', JSON.stringify({ error: { code: '401', message: 'Access denied due to invalid subscription key or wrong API endpoint. Make sure to provide a valid key for an active subscription and use a correct regional API endpoint for your resource.' } }));
      }
      if (!isResponses) return answer(404, 'not-found', JSON.stringify({ error: { code: '404', message: 'Resource not found' } }));
      const model = entry.body.model ?? 'unknown';
      const nonce = String(entry.body.lastUserText ?? '').match(NONCE_MARKER)?.[1];
      const { events, response } = responseEvents(replyText(token, entry.n, nonce), model);
      if (!entry.body.stream) return answer(200, 'responses-json', JSON.stringify(response));

      record({ ...entry, status: 200, answered: 'responses-sse', tokenSent: true });
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
      let i = 0;
      const next = () => {
        if (i >= events.length) return res.end();
        const event = events[i++];
        res.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
        setTimeout(next, deltaDelayMs);
      };
      next();
    });
  };
  const server = tls ? https.createServer({ cert: tls.cert, key: tls.key }, handler) : http.createServer(handler);

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, resolve);
  });
  const actual = server.address().port;
  return {
    server,
    port: actual,
    url: `${tls ? 'https' : 'http'}://${host}:${actual}`,
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
}

/** Reads a one-line value from a file (a key or a credential), trimmed; throws (naming the variable, not the value) when it can't be read or is too short. */
function readValue(file, what) {
  let value = '';
  try {
    value = fs.readFileSync(file, 'utf8').trim();
  } catch {
    throw new Error(`${what}: the file can't be read`);
  }
  if (value.length < 8) throw new Error(`${what}: the file holds less than 8 characters`);
  return value;
}

async function main() {
  const env = process.env;
  const port = Number(env.UAT_ENT_STUB_PORT);
  if (!(port > 0)) throw new Error('UAT_ENT_STUB_PORT is not set');
  if (port >= 18000 && port <= 18999) throw new Error('18000-18999 is reserved for live gateways');
  const key = readValue(env.UAT_ENT_KEY_FILE ?? '', 'UAT_ENT_KEY_FILE');
  // Every watched file must be readable: one that isn't would silently not be watched.
  const forbidden = (env.UAT_ENT_FORBIDDEN_FILES ?? '')
    .split(':')
    .filter(Boolean)
    .map((file, i) => ({ value: readValue(file, `UAT_ENT_FORBIDDEN_FILES entry ${i + 1}`), label: `<forbidden credential ${i + 1}>` }));
  // https (stack mode): both PEM files, or neither.
  if (!env.UAT_ENT_STUB_TLS_CERT !== !env.UAT_ENT_STUB_TLS_KEY) throw new Error('UAT_ENT_STUB_TLS_CERT and UAT_ENT_STUB_TLS_KEY go together');
  const tls = env.UAT_ENT_STUB_TLS_CERT ? { cert: fs.readFileSync(env.UAT_ENT_STUB_TLS_CERT), key: fs.readFileSync(env.UAT_ENT_STUB_TLS_KEY) } : undefined;
  const stub = await startAzureStub({ port, key, token: env.UAT_ENT_TOKEN, log: env.UAT_ENT_STUB_LOG, forbidden, tls });
  console.log(`azure stub listening on ${stub.url} (responses at *${RESPONSES_SUFFIX}, key in the ${KEY_HEADER} header; ${forbidden.length} forbidden credential(s) watched)`);
  // Never outlive the harness.
  const parent = Number(env.UAT_ENT_STUB_PARENT_PID);
  const maxMs = Number(env.UAT_ENT_STUB_MAX_MS) > 0 ? Number(env.UAT_ENT_STUB_MAX_MS) : 3 * 60 * 60_000;
  const stop = (why) => {
    console.log(`azure stub stopping: ${why}`);
    process.exit(0);
  };
  setTimeout(() => stop(`the ${Math.round(maxMs / 60_000)} min limit`), maxMs).unref();
  if (parent > 1) {
    setInterval(() => {
      try {
        process.kill(parent, 0);
      } catch {
        stop('the harness is gone');
      }
    }, 5_000).unref();
  }
  for (const signal of ['SIGTERM', 'SIGINT', 'SIGHUP']) process.on(signal, () => stop(signal));
}

if (process.argv[1] && fs.realpathSync(process.argv[1]) === fs.realpathSync(fileURLToPath(import.meta.url))) {
  main().catch((error) => {
    console.log(`azure stub: ${error.message}`);
    process.exit(1);
  });
}
