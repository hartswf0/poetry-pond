import http from 'node:http';
import { spawn } from 'node:child_process';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const mockCalls = [];

function listen(server, port = 0) {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => resolve(server.address().port));
  });
}

function close(server) {
  return new Promise(resolve => server.close(() => resolve()));
}

function outputText(value) {
  return [{ type: 'message', content: [{ type: 'output_text', text: JSON.stringify(value) }] }];
}

const mockServer = http.createServer(async (req, res) => {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {};
  if (req.url === '/v1/responses/input_tokens') {
    res.writeHead(200, { 'content-type': 'application/json' });
    return res.end(JSON.stringify({ object: 'response.input_tokens', input_tokens: 420 }));
  }
  if (req.url !== '/v1/responses') {
    res.writeHead(404);
    return res.end();
  }

  const schemaName = body.text?.format?.name;
  const dynamic = JSON.parse(body.input?.[1]?.content?.[0]?.text || '{}');
  mockCalls.push({ model: body.model, schemaName, cacheKey: body.prompt_cache_key, store: body.store });
  let result;
  if (schemaName === 'poetry_pond_event_proposal_v3') {
    result = {
      status: 'accepted',
      interpretation: 'Moonlight sets the river state.',
      confidence: 0.92,
      speech_act: 'assertion',
      epistemic_status: 'asserted',
      committed: true,
      action: { operation: 'set-state', actor_ref: 'new:river', target_ref: 'new:river', recipient_ref: null, quantity: null, query_type: null, polarity: 'positive' },
      entities: [{ ref: 'new:river', name: 'river', type: 'concept', aliases: ['river'] }],
      changes: [{ entity_ref: 'new:river', path: 'state', after: 'folded by moonlight', persistence: 'until-restored', reason: 'The line asserts a changed river state.' }],
      references: ['new:river'],
      clarification: { needed: false, code: '', question: '', options: [] }
    };
  } else if (schemaName === 'poetry_pond_causal_review_v3') {
    result = { selected_event_ids: (dynamic.candidates || []).slice(0, 2).map(item => item.id), rationale: 'The selected events preserve verified state continuity.', confidence: 0.9 };
  } else {
    const eventId = dynamic.acceptedEvent?.id;
    result = {
      consequences: [
        { text: 'Moonlight enters the river as a stored condition.', used_event_ids: [eventId] },
        { text: 'The accepted change settles without inventing another world fact.', used_event_ids: [eventId] },
        { text: 'A visible stratum preserves the altered river state.', used_event_ids: [eventId] }
      ],
      therefore: { text: 'Therefore, the river now remembers moonlight as state.', used_event_ids: [eventId] },
      branch: null
    };
  }
  const count = mockCalls.length;
  const response = {
    id: `mock_response_${count}`,
    model: body.model,
    output: outputText(result),
    usage: {
      input_tokens: 420,
      output_tokens: 100,
      total_tokens: 520,
      input_tokens_details: { cached_tokens: count > 1 ? 300 : 0, cache_write_tokens: count === 1 ? 300 : 0 },
      output_tokens_details: { reasoning_tokens: 10 }
    }
  };
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(JSON.stringify(response));
});

const mockPort = await listen(mockServer);
const appPort = 18000 + Math.floor(Math.random() * 1000);
const child = spawn(process.execPath, ['server.mjs'], {
  cwd: __dirname,
  env: {
    ...process.env,
    PORT: String(appPort),
    OPENAI_API_KEY: 'integration-test-key',
    OPENAI_ENDPOINT: `http://127.0.0.1:${mockPort}/v1/responses`,
    OPENAI_TOKEN_PREFLIGHT: 'always'
  },
  stdio: ['ignore', 'pipe', 'pipe']
});

let childLog = '';
child.stdout.on('data', chunk => { childLog += chunk.toString(); });
child.stderr.on('data', chunk => { childLog += chunk.toString(); });

async function waitForServer() {
  const deadline = Date.now() + 8000;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`http://127.0.0.1:${appPort}/api/status`);
      if (response.ok) return;
    } catch {}
    await new Promise(resolve => setTimeout(resolve, 80));
  }
  throw new Error(`V3 server did not start. ${childLog}`);
}

async function turn(text, id) {
  const response = await fetch(`http://127.0.0.1:${appPort}/api/turn`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      world: {}, text, mode: 'Stone', request_id: id, turn_id: id, event_id: `${id}-event`, source_stratum_id: `${id}-user`, use_openai: true, ai_policy: 'efficient'
    })
  });
  if (!response.ok) throw new Error(`Turn failed with HTTP ${response.status}`);
  return response.json();
}

let report;
try {
  await waitForServer();
  const routine = await turn('Moonlight folds the river.', 'routine');
  const complex = await turn('Moonlight folds the river because the bird remembers three vanished bridges, and the current carries that memory into tomorrow.', 'complex');

  const checks = [
    { name: 'routine uses Luna planner', passed: routine.aiRoute?.trace?.some(item => item.stage === 'luna-planner') },
    { name: 'routine uses Luna writer', passed: routine.aiRoute?.writer?.model === 'gpt-5.6-luna' },
    { name: 'complex uses Sol planner', passed: complex.aiRoute?.trace?.some(item => item.stage === 'sol-planner') },
    { name: 'complex still uses Luna writer', passed: complex.aiRoute?.writer?.model === 'gpt-5.6-luna' },
    { name: 'all API generation uses store false', passed: mockCalls.every(call => call.store === false) },
    { name: 'all routes send cache keys', passed: mockCalls.every(call => Boolean(call.cacheKey)) },
    { name: 'usage exposes cache and cost', passed: routine.usage?.totals?.cachedTokens >= 0 && routine.usage?.totals?.estimatedCostUsd > 0 }
  ];
  report = {
    generatedAt: new Date().toISOString(),
    passed: checks.filter(check => check.passed).length,
    total: checks.length,
    checks,
    calls: mockCalls,
    routineRoute: routine.aiRoute,
    complexRoute: complex.aiRoute
  };
  await writeFile(path.join(__dirname, 'evals', 'openai-routing-report.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
  if (report.passed !== report.total) process.exitCode = 1;
} finally {
  child.kill('SIGTERM');
  await close(mockServer);
}
