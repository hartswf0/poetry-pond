import http from 'node:http';
import { readFile, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const HOST = process.env.HOST || '127.0.0.1';
const PORT = Number(process.env.PORT || 8788);
// Runtime-settable key (POST /api/llm-key): env first, else .runtime-config.json.
// Held on the server only; never echoed back to the browser.
let OPENAI_API_KEY = process.env.OPENAI_API_KEY || '';
let keySource = OPENAI_API_KEY ? 'env' : 'none';
const RUNTIME_CONFIG_PATH = path.join(__dirname, '.runtime-config.json');
async function loadRuntimeKey() {
  try {
    const raw = JSON.parse(await readFile(RUNTIME_CONFIG_PATH, 'utf8'));
    if (!OPENAI_API_KEY && typeof raw.apiKey === 'string' && raw.apiKey) { OPENAI_API_KEY = raw.apiKey; keySource = 'runtime'; }
  } catch { /* no runtime config yet */ }
}
async function saveRuntimeKey() {
  await writeFile(RUNTIME_CONFIG_PATH, JSON.stringify({ apiKey: keySource === 'env' ? '' : OPENAI_API_KEY }, null, 2), { mode: 0o600 });
}
function isLoopback(req) {
  return ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(req.socket.remoteAddress || '');
}
const OPENAI_MODEL = process.env.OPENAI_MODEL || 'gpt-5.6-sol';
const OPENAI_ENDPOINT = 'https://api.openai.com/v1/responses';
const MAX_BODY_BYTES = 64 * 1024;

const pondSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    consequences: {
      type: 'array',
      minItems: 3,
      maxItems: 3,
      items: { type: 'string' }
    },
    therefore: { type: 'string' },
    branch: { type: ['string', 'null'] },
    target: {
      type: 'string',
      enum: ['history', 'memory', 'possibility', 'return', 'silence']
    },
    context_summary: { type: 'string' },
    ripple: {
      type: 'object',
      additionalProperties: false,
      properties: {
        impact: { type: 'number' },
        consequences: {
          type: 'array',
          minItems: 3,
          maxItems: 3,
          items: { type: 'number' }
        },
        branch: { type: 'number' },
        final: { type: 'number' }
      },
      required: ['impact', 'consequences', 'branch', 'final']
    }
  },
  required: ['consequences', 'therefore', 'branch', 'target', 'context_summary', 'ripple']
};

const instructions = `You are the context engine inside Poetry Pond, an immersive 3D text mountain.

The visible mountain is the complete conversation record. A participant line becomes a user stratum. Your answer becomes exactly three consequence strata, an optional branch stratum, and one therefore stratum. The first five instruction strata are interface rules, not prior participant content.

Maintain semantic continuity across the full conversation. Use the previous response chain when supplied, then reconcile it with the current context summary and recent visible strata. Refer to specific prior ideas when relevant; do not produce generic inspirational filler.

Interpret the selected mask as follows:
- Stone: a direct assertion that adds weight.
- Obstacle: resistance, contradiction, friction, or blockage.
- Goal: attraction toward a desired future state.
- Turn: reversal, reframing, or change of direction.

Writing rules:
- Each visible stratum must be concise, ideally 6 to 16 words.
- Each consequence must do a different job: interpret, connect to prior context, then alter the field.
- The therefore line must begin with "Therefore," and provisionally resolve the turn.
- A branch is only used when the new line meaningfully activates a distant semantic stack; otherwise return null.
- The context summary should be a compact durable account of what the mountain now means, not a transcript.

Ripple semantics:
- impact is the initial force of the participant line.
- consequences contains one amplitude per consequence.
- branch is zero when branch is null, otherwise the distant impact amplitude.
- final is the settling force of the therefore line.
Use values roughly between 0.08 and 0.80. Strong contradiction, reversal, or conceptual novelty creates larger values. Quiet continuity creates smaller values.`;

function json(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(payload),
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff'
  });
  res.end(payload);
}

async function readJson(req) {
  let total = 0;
  const chunks = [];
  for await (const chunk of req) {
    total += chunk.length;
    if (total > MAX_BODY_BYTES) throw new Error('Request body is too large.');
    chunks.push(chunk);
  }
  const raw = Buffer.concat(chunks).toString('utf8');
  return raw ? JSON.parse(raw) : {};
}

function extractOutputText(response) {
  if (typeof response.output_text === 'string' && response.output_text.trim()) {
    return response.output_text.trim();
  }
  for (const item of response.output || []) {
    for (const part of item.content || []) {
      if (part.type === 'output_text' && typeof part.text === 'string') return part.text.trim();
    }
  }
  return '';
}

function clamp(value, min, max, fallback) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.max(min, Math.min(max, number)) : fallback;
}

function validatePondOutput(output) {
  if (!output || !Array.isArray(output.consequences) || output.consequences.length !== 3) {
    throw new Error('OpenAI returned an incomplete consequence field.');
  }
  const branch = output.branch == null || output.branch === '' ? null : String(output.branch);
  const targetSet = new Set(['history', 'memory', 'possibility', 'return', 'silence']);
  const rippleValues = Array.isArray(output.ripple?.consequences)
    ? output.ripple.consequences.slice(0, 3)
    : [0.19, 0.23, 0.27];
  while (rippleValues.length < 3) rippleValues.push(0.22);

  return {
    consequences: output.consequences.map(value => String(value).slice(0, 220)),
    therefore: String(output.therefore || 'Therefore, the new layer remains open.').slice(0, 240),
    branch: branch?.slice(0, 220) || null,
    target: targetSet.has(output.target) ? output.target : 'history',
    context_summary: String(output.context_summary || '').slice(0, 1800),
    ripple: {
      impact: clamp(output.ripple?.impact, 0.15, 0.95, 0.58),
      consequences: rippleValues.map(value => clamp(value, 0.05, 0.55, 0.22)),
      branch: branch ? clamp(output.ripple?.branch, 0.08, 0.70, 0.30) : 0,
      final: clamp(output.ripple?.final, 0.08, 0.70, 0.34)
    }
  };
}

async function callOpenAI(input, abortSignal) {
  const text = String(input.text || '').trim().slice(0, 240);
  const mode = ['Stone', 'Obstacle', 'Goal', 'Turn'].includes(input.mode) ? input.mode : 'Stone';
  if (!text) throw new Error('A line is required.');

  const recent = Array.isArray(input.recent_strata)
    ? input.recent_strata.slice(-18).map(item => ({
        role: String(item?.role || 'unknown').slice(0, 24),
        mode: item?.mode ? String(item.mode).slice(0, 24) : null,
        text: String(item?.text || '').slice(0, 240)
      }))
    : [];

  const currentTurn = {
    participant_line: text,
    mask: mode,
    exchange_count: Math.max(0, Number(input.exchange_count) || 0),
    context_summary: String(input.context_summary || '').slice(0, 1800),
    recent_visible_strata: recent
  };

  const body = {
    model: OPENAI_MODEL,
    store: true,
    reasoning: { effort: 'medium' },
    max_output_tokens: 1200,
    instructions,
    input: `Continue the Poetry Pond from this exact visible state:\n${JSON.stringify(currentTurn, null, 2)}`,
    text: {
      format: {
        type: 'json_schema',
        name: 'poetry_pond_turn',
        strict: true,
        schema: pondSchema
      }
    }
  };

  const previousResponseId = String(input.previous_response_id || '').trim();
  if (previousResponseId) body.previous_response_id = previousResponseId;

  const response = await fetch(OPENAI_ENDPOINT, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${OPENAI_API_KEY}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(body),
    signal: abortSignal
  });

  const raw = await response.json().catch(() => ({}));
  if (!response.ok) {
    const detail = raw?.error?.message || `OpenAI returned HTTP ${response.status}.`;
    throw new Error(detail);
  }

  const outputText = extractOutputText(raw);
  if (!outputText) throw new Error('OpenAI returned no structured text output.');

  let parsed;
  try {
    parsed = JSON.parse(outputText);
  } catch {
    throw new Error('OpenAI returned structured output that could not be parsed.');
  }

  return {
    ...validatePondOutput(parsed),
    response_id: raw.id,
    model: raw.model || OPENAI_MODEL,
    generator: 'openai',
    usage: raw.usage || null
  };
}

const mimeTypes = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.svg': 'image/svg+xml'
};

async function serveStatic(req, res) {
  const requestUrl = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const pathname = requestUrl.pathname === '/' ? '/index.html' : requestUrl.pathname;
  const decoded = decodeURIComponent(pathname);
  const filePath = path.resolve(__dirname, `.${decoded}`);
  if (!filePath.startsWith(__dirname + path.sep)) return json(res, 403, { error: 'Forbidden.' });

  try {
    const info = await stat(filePath);
    if (!info.isFile()) throw new Error('Not a file');
    const data = await readFile(filePath);
    res.writeHead(200, {
      'Content-Type': mimeTypes[path.extname(filePath).toLowerCase()] || 'application/octet-stream',
      'Content-Length': data.length,
      'Cache-Control': 'no-cache',
      'X-Content-Type-Options': 'nosniff'
    });
    res.end(data);
  } catch {
    json(res, 404, { error: 'Not found.' });
  }
}

const server = http.createServer(async (req, res) => {
  try {
    if (req.method === 'GET' && req.url === '/api/status') {
      return json(res, 200, {
        configured: Boolean(OPENAI_API_KEY),
        keySource: OPENAI_API_KEY ? keySource : 'none',
        keyTail: OPENAI_API_KEY ? OPENAI_API_KEY.slice(-4) : '',
        model: OPENAI_MODEL,
        context: 'previous_response_id',
        endpoint: 'Responses API'
      });
    }

    if (req.method === 'POST' && req.url === '/api/llm-key') {
      if (!isLoopback(req)) return json(res, 403, { error: 'The key endpoint only accepts loopback connections.' });
      const body = await readJson(req);
      const key = typeof body.key === 'string' ? body.key.trim() : '';
      if (key === '') {
        OPENAI_API_KEY = process.env.OPENAI_API_KEY || '';
        keySource = OPENAI_API_KEY ? 'env' : 'none';
        await saveRuntimeKey();
        return json(res, 200, { configured: Boolean(OPENAI_API_KEY), keySource, keyTail: OPENAI_API_KEY ? OPENAI_API_KEY.slice(-4) : '', cleared: true });
      }
      if (!/^sk-[A-Za-z0-9_-]{10,}$/.test(key)) {
        return json(res, 400, { error: 'That does not look like an OpenAI key (expected sk-…). Nothing was saved.' });
      }
      OPENAI_API_KEY = key;
      keySource = 'runtime';
      await saveRuntimeKey();
      return json(res, 200, { configured: true, keySource, keyTail: OPENAI_API_KEY.slice(-4) });
    }

    if (req.method === 'POST' && req.url === '/api/pond') {
      if (!OPENAI_API_KEY) {
        return json(res, 503, {
          error: 'OPENAI_API_KEY is not set on the server. The browser will continue with local generation.'
        });
      }

      const input = await readJson(req);
      const controller = new AbortController();
      res.on('close', () => {
        if (!res.writableEnded) controller.abort();
      });
      const output = await callOpenAI(input, controller.signal);
      return json(res, 200, output);
    }

    if (req.method === 'GET' || req.method === 'HEAD') return serveStatic(req, res);
    return json(res, 405, { error: 'Method not allowed.' });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown server error.';
    if (!res.headersSent) json(res, 500, { error: message });
    else res.end();
  }
});

await loadRuntimeKey();
server.listen(PORT, HOST, () => {
  const mode = OPENAI_API_KEY ? `${OPENAI_MODEL} enabled (key source: ${keySource})` : 'local fallback only';
  console.log(`Poetry Pond running at http://${HOST}:${PORT} — ${mode}`);
});
