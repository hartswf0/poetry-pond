import http from 'node:http';
import { readFile, stat, writeFile } from 'node:fs/promises';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  hydrateWorld, proposeLocalEvent, selectRelevantEvents, finalizeEvent, applyEvent,
  computeRippleProfile, renderLocalTurn, validateRenderedTurn, buildRippleProof,
  worldDigest, entityIdFromPhrase, getPath, TYPE_SCHEMAS
} from './world-engine.mjs';
import {
  DEFAULT_TOKEN_BUDGETS, estimateTokens, normalizeUsage, createTurnBudget,
  classifyTurnComplexity, choosePlannerRoute, shouldEscalateLunaProposal, shouldRunSolReview,
  buildPlannerContext, buildReviewContext, buildWriterContext, summarizeUsage
} from './llm-orchestrator.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
function loadLocalEnv() {
  const envPath = path.join(__dirname, '.env');
  if (!existsSync(envPath)) return;
  for (const rawLine of readFileSync(envPath, 'utf8').split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const match = line.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
    if (!match || process.env[match[1]] !== undefined) continue;
    let value = match[2].trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1);
    process.env[match[1]] = value;
  }
}
loadLocalEnv();
const HOST = process.env.HOST || '127.0.0.1';
const PORT = Number(process.env.PORT || 8789);
// The key is runtime-settable from the settings panel (POST /api/llm-key):
// env first, else .runtime-config.json. Never echoed back to the browser.
let OPENAI_API_KEY = process.env.OPENAI_API_KEY || '';
let keySource = OPENAI_API_KEY ? 'env' : 'none';
const RUNTIME_CONFIG_PATH = path.join(path.dirname(fileURLToPath(import.meta.url)), '.runtime-config.json');
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
const SOL_MODEL = process.env.OPENAI_SOL_MODEL || 'gpt-5.6-sol';
const LUNA_MODEL = process.env.OPENAI_LUNA_MODEL || 'gpt-5.6-luna';
const DEFAULT_AI_POLICY = ['efficient', 'deep', 'luna'].includes(process.env.OPENAI_AI_POLICY) ? process.env.OPENAI_AI_POLICY : 'efficient';
const TOKEN_PREFLIGHT = process.env.OPENAI_TOKEN_PREFLIGHT || 'auto';
const TOKEN_BUDGETS = {
  ...DEFAULT_TOKEN_BUDGETS,
  lunaPlannerInput: Number(process.env.OPENAI_LUNA_PLANNER_INPUT_TOKENS || DEFAULT_TOKEN_BUDGETS.lunaPlannerInput),
  solPlannerInput: Number(process.env.OPENAI_SOL_PLANNER_INPUT_TOKENS || DEFAULT_TOKEN_BUDGETS.solPlannerInput),
  solReviewInput: Number(process.env.OPENAI_SOL_REVIEW_INPUT_TOKENS || DEFAULT_TOKEN_BUDGETS.solReviewInput),
  lunaWriterInput: Number(process.env.OPENAI_LUNA_WRITER_INPUT_TOKENS || DEFAULT_TOKEN_BUDGETS.lunaWriterInput),
  maxCallsPerTurn: Number(process.env.OPENAI_MAX_CALLS_PER_TURN || DEFAULT_TOKEN_BUDGETS.maxCallsPerTurn),
  maxSolCallsPerTurn: Number(process.env.OPENAI_MAX_SOL_CALLS_PER_TURN || DEFAULT_TOKEN_BUDGETS.maxSolCallsPerTurn),
  maxCostUsdPerTurn: Number(process.env.OPENAI_MAX_COST_USD_PER_TURN || DEFAULT_TOKEN_BUDGETS.maxCostUsdPerTurn)
};
const OPENAI_ENDPOINT = process.env.OPENAI_ENDPOINT || 'https://api.openai.com/v1/responses';
const MAX_BODY_BYTES = 512 * 1024;
const RATE_WINDOW_MS = 60_000;
const RATE_MAX = Number(process.env.RATE_MAX || 24);
const rateBuckets = new Map();

const scalarSchema = { type: ['string', 'number', 'boolean', 'null'] };
const plannerSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    status: { type: 'string', enum: ['accepted', 'needs_clarification', 'rejected'] },
    interpretation: { type: 'string' },
    confidence: { type: 'number' },
    speech_act: { type: 'string', enum: ['assertion', 'question', 'hypothetical', 'wish', 'command', 'quotation', 'negation'] },
    epistemic_status: { type: 'string', enum: ['asserted', 'question', 'hypothetical', 'desired', 'quoted', 'negated'] },
    committed: { type: 'boolean' },
    action: {
      type: 'object', additionalProperties: false,
      properties: {
        operation: { type: 'string' },
        actor_ref: { type: ['string', 'null'] },
        target_ref: { type: ['string', 'null'] },
        recipient_ref: { type: ['string', 'null'] },
        quantity: { type: ['number', 'null'] },
        query_type: { type: ['string', 'null'] },
        polarity: { type: 'string', enum: ['positive', 'negative'] }
      },
      required: ['operation', 'actor_ref', 'target_ref', 'recipient_ref', 'quantity', 'query_type', 'polarity']
    },
    entities: {
      type: 'array', maxItems: 8,
      items: {
        type: 'object', additionalProperties: false,
        properties: {
          ref: { type: 'string' },
          name: { type: 'string' },
          type: { type: 'string', enum: ['actor', 'resource', 'location', 'obstacle', 'goal', 'concept', 'proposition'] },
          aliases: { type: 'array', maxItems: 6, items: { type: 'string' } }
        },
        required: ['ref', 'name', 'type', 'aliases']
      }
    },
    changes: {
      type: 'array', maxItems: 12,
      items: {
        type: 'object', additionalProperties: false,
        properties: {
          entity_ref: { type: 'string' },
          path: { type: 'string' },
          after: scalarSchema,
          persistence: { type: 'string', enum: ['turn', 'session', 'until-restored', 'permanent'] },
          reason: { type: 'string' }
        },
        required: ['entity_ref', 'path', 'after', 'persistence', 'reason']
      }
    },
    references: { type: 'array', maxItems: 12, items: { type: 'string' } },
    clarification: {
      type: 'object', additionalProperties: false,
      properties: {
        needed: { type: 'boolean' },
        code: { type: 'string' },
        question: { type: 'string' },
        options: {
          type: 'array', maxItems: 6,
          items: {
            type: 'object', additionalProperties: false,
            properties: {
              id: { type: 'string' },
              label: { type: 'string' },
              resolution_kind: { type: 'string', enum: ['replace-text', 'record-proposition', 'cancel'] },
              resolution_text: { type: 'string' },
              epistemic_status: { type: 'string', enum: ['asserted', 'hypothetical', 'desired', 'quoted'] }
            },
            required: ['id', 'label', 'resolution_kind', 'resolution_text', 'epistemic_status']
          }
        }
      },
      required: ['needed', 'code', 'question', 'options']
    }
  },
  required: ['status', 'interpretation', 'confidence', 'speech_act', 'epistemic_status', 'committed', 'action', 'entities', 'changes', 'references', 'clarification']
};

const writerSchema = {
  type: 'object', additionalProperties: false,
  properties: {
    consequences: {
      type: 'array', minItems: 3, maxItems: 3,
      items: {
        type: 'object', additionalProperties: false,
        properties: {
          text: { type: 'string' },
          used_event_ids: { type: 'array', maxItems: 6, items: { type: 'string' } }
        },
        required: ['text', 'used_event_ids']
      }
    },
    therefore: {
      type: 'object', additionalProperties: false,
      properties: { text: { type: 'string' }, used_event_ids: { type: 'array', maxItems: 6, items: { type: 'string' } } },
      required: ['text', 'used_event_ids']
    },
    branch: {
      anyOf: [
        { type: 'null' },
        {
          type: 'object', additionalProperties: false,
          properties: { text: { type: 'string' }, target: { type: 'string', enum: ['history', 'memory', 'possibility', 'return', 'silence'] }, used_event_ids: { type: 'array', maxItems: 6, items: { type: 'string' } } },
          required: ['text', 'target', 'used_event_ids']
        }
      ]
    }
  },
  required: ['consequences', 'therefore', 'branch']
};

const reviewerSchema = {
  type: 'object', additionalProperties: false,
  properties: {
    selected_event_ids: { type: 'array', maxItems: 6, items: { type: 'string' } },
    rationale: { type: 'string' },
    confidence: { type: 'number' }
  },
  required: ['selected_event_ids', 'rationale', 'confidence']
};

const plannerInstructions = `You propose typed world events for Poetry Pond. You do not write literary prose and you do not own truth.

The server will validate every proposal against a strict ontology and the current before-values. Never guess through ambiguity. Keep the proposal minimal: include only entities and changes necessary for this one action. Return needs_clarification for unclear pronouns, hypothetical language that might be mistaken for fact, impossible quantities, uncertain ownership, unclear negation, or any action whose world effect is not defensible.

Use existing entity ids exactly. New entities must use refs beginning with new:. Only use paths allowed by the supplied ontology. A question does not mutate material state. A hypothetical, desire, or quotation is not committed material fact unless the participant explicitly resolves it. Negative consumption must not reduce quantity.

Changes contain only intended after-values. The server derives before-values from authoritative state. Keep interpretations compact and operational.`;

const writerInstructions = `You are the literary renderer for Poetry Pond. The accepted event, authoritative resulting world, and relevant prior events are already fixed. You may not invent world changes, causal sources, branches, or event ids.

Write exactly three concise consequence strata and one therefore stratum. Each line should usually be 6 to 18 words. The first consequence should render the current event. Later consequences may use only supplied relevant event ids. Every used_event_ids entry must be either the accepted current event id or a supplied relevant event id. If a branch target is supplied, write one branch line for exactly that target; otherwise branch must be null.

The visible layer should be poetic and readable. Use the smallest number of words that preserves causality; do not restate the full context. Precise before-and-after evidence remains in the selectable Ripple Proof, so do not turn every line into diagnostics. The therefore text must begin with “Therefore,”.`;

const reviewerInstructions = `You are the Sol causal reviewer for Poetry Pond. The deterministic engine already produced a current typed event and a ranked list of eligible past events. You may only rerank or omit those supplied candidate ids. You may not add an event id, invent a causal link, alter state, or write literary prose.

Select at most six candidates that genuinely help explain the current event or its later output. Prefer direct entity continuity, verified causal edges, persistent state changes, unresolved goals, and multi-hop chains whose intermediate ids are supplied. Exclude thematic resemblance without state relevance. Keep the rationale under 60 words.`;

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
  if (typeof response.output_text === 'string' && response.output_text.trim()) return response.output_text.trim();
  for (const item of response.output || []) {
    for (const part of item.content || []) if (part.type === 'output_text' && typeof part.text === 'string') return part.text.trim();
  }
  return '';
}

async function countInputTokens({ model, inputMessages, schema, name, signal }) {
  const response = await fetch(`${OPENAI_ENDPOINT}/input_tokens`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${OPENAI_API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model,
      input: inputMessages,
      text: { format: { type: 'json_schema', name, strict: true, schema } }
    }),
    signal
  });
  const raw = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(raw?.error?.message || `OpenAI token count returned HTTP ${response.status}.`);
  return Number(raw.input_tokens || 0);
}

async function callStructured({
  model, instructions, input, schema, name, maxOutputTokens = 700, maxInputTokens = 3200,
  reasoningEffort = 'low', route, cacheKey, turnBudget, signal
}) {
  const dynamicText = JSON.stringify(input);
  const inputMessages = [
    {
      type: 'message',
      role: 'developer',
      content: [{ type: 'input_text', text: instructions }]
    },
    {
      type: 'message',
      role: 'user',
      content: [{ type: 'input_text', text: dynamicText }]
    }
  ];
  const estimatedInputTokens = estimateTokens({ input: inputMessages, schema });
  let preflightTokens = estimatedInputTokens;
  const shouldCount = TOKEN_PREFLIGHT === 'always' || (TOKEN_PREFLIGHT !== 'never' && (String(model).includes('sol') || estimatedInputTokens > maxInputTokens * 0.72));
  if (shouldCount) {
    try { preflightTokens = await countInputTokens({ model, inputMessages, schema, name, signal }); }
    catch (error) { console.warn(`Token preflight failed for ${route}: ${error.message}`); }
  }
  if (preflightTokens > maxInputTokens) throw new Error(`${route} context requires ${preflightTokens} input tokens; budget is ${maxInputTokens}.`);
  const reservation = turnBudget.reserve({ model, inputTokens: preflightTokens, maxOutputTokens });
  if (!reservation.ok) throw new Error(`${route} skipped by ${reservation.reason}; projected cost $${reservation.projected.toFixed(4)}.`);

  const started = performance.now();
  const response = await fetch(OPENAI_ENDPOINT, {
    method: 'POST',
    headers: { Authorization: `Bearer ${OPENAI_API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model,
      store: false,
      reasoning: { effort: reasoningEffort },
      max_output_tokens: maxOutputTokens,
      input: inputMessages,
      text: { format: { type: 'json_schema', name, strict: true, schema } },
      prompt_cache_key: cacheKey,
      prompt_cache_options: { mode: 'implicit', ttl: '30m' }
    }),
    signal
  });
  const raw = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(raw?.error?.message || `OpenAI returned HTTP ${response.status}.`);
  const output = extractOutputText(raw);
  if (!output) throw new Error('OpenAI returned no structured text output.');
  const actualModel = raw.model || model;
  const usage = normalizeUsage(raw.usage || {}, actualModel, {
    route,
    preflightTokens,
    estimatedInputTokens,
    latencyMs: Math.round(performance.now() - started),
    cacheKey,
    responseId: raw.id || null
  });
  turnBudget.record(usage);
  return { parsed: JSON.parse(output), usage, responseId: raw.id || null, model: actualModel };
}

function defaultsFor(type) {
  switch (type) {
    case 'actor': return { present: true, locationId: null, hunger: 0, lastAction: null };
    case 'resource': return { present: true, quantity: 1, ownerId: null, locationId: null, condition: 'unknown' };
    case 'location': return { present: true, description: null };
    case 'obstacle': return { active: false, blocksId: null };
    case 'goal': return { active: true, achieved: false, description: '' };
    case 'concept': return { present: true, state: null };
    case 'proposition': return { active: true, text: '', epistemicStatus: 'asserted' };
    default: return {};
  }
}

function normalizePlannerClarification(raw) {
  const clarification = raw?.clarification || {};
  return {
    code: String(clarification.code || 'ai-clarification').slice(0, 80),
    question: String(clarification.question || 'The proposed event remains ambiguous.').slice(0, 360),
    options: Array.isArray(clarification.options) ? clarification.options.slice(0, 6).map(option => ({
      id: String(option.id || 'option').slice(0, 80),
      label: String(option.label || 'Resolve').slice(0, 160),
      resolution: option.resolution_kind === 'replace-text'
        ? { kind: 'replace-text', text: String(option.resolution_text || '').slice(0, 600) }
        : option.resolution_kind === 'record-proposition'
          ? { kind: 'record-proposition', epistemicStatus: option.epistemic_status || 'asserted' }
          : { kind: 'cancel' }
    })) : []
  };
}

function mapPlannerProposal(world, input, raw) {
  if (raw.status === 'needs_clarification') return { status: 'needs_clarification', clarification: normalizePlannerClarification(raw), source: 'openai-proposer' };
  if (raw.status !== 'accepted') return { status: 'rejected', error: raw.interpretation || 'The AI proposer rejected the line.' };

  const refMap = new Map();
  for (const id of Object.keys(world.entities)) refMap.set(id, id);
  const entityUpserts = [];
  for (const entity of raw.entities || []) {
    const ref = String(entity.ref || '');
    if (!ref) continue;
    if (world.entities[ref]) { refMap.set(ref, ref); continue; }
    const id = entityIdFromPhrase(entity.name || ref.replace(/^new:/, ''));
    refMap.set(ref, id);
    if (!world.entities[id] && !entityUpserts.some(item => item.id === id)) {
      const attributes = defaultsFor(entity.type);
      if (entity.type === 'goal') attributes.description = String(entity.name || '');
      if (entity.type === 'proposition') {
        attributes.text = String(input.text || '');
        attributes.epistemicStatus = raw.epistemic_status || 'asserted';
      }
      entityUpserts.push({ id, type: entity.type, aliases: [...new Set([entity.name, ...(entity.aliases || [])].filter(Boolean))], attributes });
    }
  }
  const resolveRef = ref => ref == null ? null : refMap.get(String(ref)) || (world.entities[String(ref)] ? String(ref) : null);
  const staged = hydrateWorld(world);
  for (const upsert of entityUpserts) staged.entities[upsert.id] = JSON.parse(JSON.stringify(upsert));
  const changes = [];
  for (const change of raw.changes || []) {
    const entityId = resolveRef(change.entity_ref);
    if (!entityId || !staged.entities[entityId]) continue;
    const path = String(change.path || '');
    if (!Object.prototype.hasOwnProperty.call(TYPE_SCHEMAS[staged.entities[entityId].type] || {}, path)) continue;
    changes.push({
      entityId,
      path,
      before: getPath(staged.entities[entityId].attributes, path) ?? null,
      after: change.after,
      persistence: change.persistence || 'until-restored',
      reason: String(change.reason || 'AI-proposed typed change.').slice(0, 300)
    });
    staged.entities[entityId].attributes[path] = change.after;
  }
  const turnId = String(input.turnId || input.request_id || `turn-${Date.now()}`);
  const event = {
    id: String(input.eventId || `${turnId}-event`),
    idempotencyKey: String(input.idempotencyKey || input.request_id || turnId),
    turnId,
    sourceText: String(input.originalText || input.text || '').slice(0, 600),
    interpretedText: String(raw.interpretation || input.text || '').slice(0, 600),
    sourceStratumId: input.sourceStratumId || null,
    mode: ['Stone', 'Obstacle', 'Goal', 'Turn'].includes(input.mode) ? input.mode : 'Stone',
    speechAct: raw.speech_act,
    epistemicStatus: raw.epistemic_status,
    committed: Boolean(raw.committed),
    interpretationConfidence: Math.max(0, Math.min(1, Number(raw.confidence) || 0)),
    interpretationNotes: ['Proposed by OpenAI and validated by the local ontology.'],
    action: {
      operation: String(raw.action.operation || 'assert'),
      actorId: resolveRef(raw.action.actor_ref),
      targetId: resolveRef(raw.action.target_ref),
      recipientId: resolveRef(raw.action.recipient_ref),
      quantity: raw.action.quantity == null ? null : Number(raw.action.quantity),
      queryType: raw.action.query_type == null ? null : String(raw.action.query_type),
      polarity: raw.action.polarity || 'positive'
    },
    entityUpserts,
    changes,
    references: [...new Set((raw.references || []).map(resolveRef).filter(Boolean))],
    causedBy: [],
    branchTarget: null,
    inferredPreconditions: entityUpserts.map(entity => ({ entityId: entity.id, reason: 'The AI proposal introduced a new typed entity; defaults remain explicit and inspectable.' })),
    createdAt: input.createdAt || new Date().toISOString()
  };
  return { status: 'accepted', event, interpretation: raw.interpretation, source: 'openai-proposer' };
}

async function callPlanner({ world, input, model, route, maxInputTokens, maxOutputTokens, reasoningEffort, turnBudget, signal }) {
  const packed = buildPlannerContext(world, input, TYPE_SCHEMAS, maxInputTokens);
  if (!packed.fits) throw new Error(`${route} context could not fit the ${maxInputTokens}-token budget.`);
  const call = await callStructured({
    model,
    instructions: plannerInstructions,
    input: packed.context,
    schema: plannerSchema,
    name: 'poetry_pond_event_proposal_v3',
    maxInputTokens,
    maxOutputTokens,
    reasoningEffort,
    route,
    cacheKey: `poetry-pond:v3:${route}:ontology-v2`,
    turnBudget,
    signal
  });
  return { proposal: mapPlannerProposal(world, input, call.parsed), usage: call.usage };
}

async function proposeEvent(world, input, { useOpenAI, policy, complexity, turnBudget, signal }) {
  const local = proposeLocalEvent(world, input);
  complexity = complexity || classifyTurnComplexity(world, input, local);
  const route = choosePlannerRoute({ policy, complexity, localProposal: local });
  const trace = [{ stage: 'local-parser', outcome: local.status, reason: local.clarification?.code || local.source || null }];
  if (route.modelTier === 'none' || !useOpenAI || !OPENAI_API_KEY) return { proposal: local, trace, solUsed: false };

  const primaryModel = route.modelTier === 'sol' ? SOL_MODEL : LUNA_MODEL;
  const primaryRoute = route.modelTier === 'sol' ? 'sol-planner' : 'luna-planner';
  try {
    const primary = await callPlanner({
      world,
      input,
      model: primaryModel,
      route: primaryRoute,
      maxInputTokens: route.modelTier === 'sol' ? TOKEN_BUDGETS.solPlannerInput : TOKEN_BUDGETS.lunaPlannerInput,
      maxOutputTokens: route.modelTier === 'sol' ? TOKEN_BUDGETS.solPlannerOutput : TOKEN_BUDGETS.lunaPlannerOutput,
      reasoningEffort: route.modelTier === 'sol' ? 'medium' : 'low',
      turnBudget,
      signal
    });
    trace.push({ stage: primaryRoute, outcome: primary.proposal.status, reason: route.reason });
    if (route.modelTier === 'luna' && policy !== 'luna' && shouldEscalateLunaProposal(primary.proposal, complexity)) {
      try {
        const sol = await callPlanner({
          world,
          input,
          model: SOL_MODEL,
          route: 'sol-planner-escalation',
          maxInputTokens: TOKEN_BUDGETS.solPlannerInput,
          maxOutputTokens: TOKEN_BUDGETS.solPlannerOutput,
          reasoningEffort: 'medium',
          turnBudget,
          signal
        });
        trace.push({ stage: 'sol-planner-escalation', outcome: sol.proposal.status, reason: 'luna-low-confidence-or-rejected' });
        return { proposal: sol.proposal, trace, solUsed: true };
      } catch (error) {
        trace.push({ stage: 'sol-planner-escalation', outcome: 'skipped-or-failed', reason: error.message });
      }
    }
    return { proposal: primary.proposal, trace, solUsed: route.modelTier === 'sol' };
  } catch (error) {
    trace.push({ stage: primaryRoute, outcome: 'failed', reason: error.message });
    return { proposal: local, trace, solUsed: false };
  }
}

async function reviewRelevantEvents({ world, preliminaryEvent, candidateEvents, policy, complexity, solAlreadyUsed, useOpenAI, turnBudget, signal }) {
  const fallback = candidateEvents.slice(0, 6);
  const shouldReview = useOpenAI && OPENAI_API_KEY && shouldRunSolReview({ policy, complexity, world, preliminaryEvent, candidateEvents, solAlreadyUsed });
  if (!shouldReview) return { relevantEvents: fallback, review: { used: false, reason: 'deterministic-ranking-sufficient' }, solUsed: solAlreadyUsed };
  const packed = buildReviewContext(world, preliminaryEvent, candidateEvents, TOKEN_BUDGETS.solReviewInput);
  if (!packed.fits) return { relevantEvents: fallback, review: { used: false, reason: 'review-context-over-budget' }, solUsed: solAlreadyUsed };
  try {
    const call = await callStructured({
      model: SOL_MODEL,
      instructions: reviewerInstructions,
      input: packed.context,
      schema: reviewerSchema,
      name: 'poetry_pond_causal_review_v3',
      maxInputTokens: TOKEN_BUDGETS.solReviewInput,
      maxOutputTokens: TOKEN_BUDGETS.solReviewOutput,
      reasoningEffort: 'medium',
      route: 'sol-causal-review',
      cacheKey: 'poetry-pond:v3:sol-causal-review:rules-v1',
      turnBudget,
      signal
    });
    const eligible = new Map(candidateEvents.map(event => [event.id, event]));
    const selected = [...new Set(call.parsed.selected_event_ids || [])].map(id => eligible.get(id)).filter(Boolean).slice(0, 6);
    return {
      relevantEvents: selected.length ? selected : fallback,
      review: { used: true, model: call.model, confidence: call.parsed.confidence, rationale: call.parsed.rationale, selectedEventIds: selected.map(event => event.id) },
      solUsed: true
    };
  } catch (error) {
    return { relevantEvents: fallback, review: { used: false, reason: error.message }, solUsed: solAlreadyUsed };
  }
}

async function renderEvent(nextWorld, event, relevantEvents, { useOpenAI, turnBudget, signal }) {
  const local = renderLocalTurn(nextWorld, event, relevantEvents);
  if (!useOpenAI || !OPENAI_API_KEY) return { rendered: local, writer: { used: false, reason: 'local-renderer' } };
  const packed = buildWriterContext(nextWorld, event, relevantEvents, TOKEN_BUDGETS.lunaWriterInput);
  if (!packed.fits) return { rendered: local, writer: { used: false, reason: 'writer-context-over-budget' } };
  try {
    const call = await callStructured({
      model: LUNA_MODEL,
      instructions: writerInstructions,
      input: packed.context,
      schema: writerSchema,
      name: 'poetry_pond_validated_render_v3',
      maxInputTokens: TOKEN_BUDGETS.lunaWriterInput,
      maxOutputTokens: TOKEN_BUDGETS.lunaWriterOutput,
      reasoningEffort: 'none',
      route: 'luna-writer',
      cacheKey: 'poetry-pond:v3:luna-writer:style-v2',
      turnBudget,
      signal
    });
    const raw = {
      consequences: call.parsed.consequences.map(item => ({ text: item.text, usedEventIds: item.used_event_ids })),
      therefore: { text: call.parsed.therefore.text, usedEventIds: call.parsed.therefore.used_event_ids },
      branch: call.parsed.branch ? { text: call.parsed.branch.text, target: call.parsed.branch.target, usedEventIds: call.parsed.branch.used_event_ids } : null,
      generator: 'openai-luna-validated-writer'
    };
    const checked = validateRenderedTurn(nextWorld, event, relevantEvents, raw);
    if (!checked.ok) throw new Error(checked.errors.join(' '));
    return { rendered: { ...checked.rendered, generator: 'openai-luna-validated-writer' }, writer: { used: true, model: call.model } };
  } catch (error) {
    return { rendered: local, writer: { used: false, reason: error.message } };
  }
}

function rateLimit(req) {
  const key = req.socket.remoteAddress || 'unknown';
  const now = Date.now();
  const bucket = rateBuckets.get(key) || { start: now, count: 0 };
  if (now - bucket.start > RATE_WINDOW_MS) { bucket.start = now; bucket.count = 0; }
  bucket.count += 1;
  rateBuckets.set(key, bucket);
  return bucket.count <= RATE_MAX;
}

const mimeTypes = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8', '.png': 'image/png', '.svg': 'image/svg+xml'
};

async function serveStatic(req, res) {
  const requestUrl = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const pathname = requestUrl.pathname === '/' ? '/index.html' : requestUrl.pathname;
  const decoded = decodeURIComponent(pathname);
  const filePath = path.resolve(__dirname, `.${decoded}`);
  if (!filePath.startsWith(__dirname)) return json(res, 403, { error: 'Forbidden.' });
  try {
    const info = await stat(filePath);
    if (!info.isFile()) throw new Error('Not a file.');
    const body = await readFile(filePath);
    res.writeHead(200, { 'Content-Type': mimeTypes[path.extname(filePath)] || 'application/octet-stream', 'Content-Length': body.length, 'Cache-Control': 'no-store' });
    res.end(body);
  } catch {
    json(res, 404, { error: 'Not found.' });
  }
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    if (req.method === 'POST' && url.pathname === '/api/llm-key') {
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
    if (req.method === 'GET' && url.pathname === '/api/status') {
      return json(res, 200, {
        configured: Boolean(OPENAI_API_KEY),
        keySource: OPENAI_API_KEY ? keySource : 'none',
        keyTail: OPENAI_API_KEY ? OPENAI_API_KEY.slice(-4) : '',
        solModel: SOL_MODEL,
        lunaModel: LUNA_MODEL,
        plannerModel: `${LUNA_MODEL} → ${SOL_MODEL}`,
        writerModel: LUNA_MODEL,
        model: LUNA_MODEL,
        defaultPolicy: DEFAULT_AI_POLICY,
        policies: ['efficient', 'deep', 'luna'],
        contextMode: 'bounded-explicit-world-state',
        tokenStrategy: 'local-first, Luna routine, Sol escalation/review, Luna rendering',
        promptCaching: { enabled: true, mode: 'implicit', ttl: '30m' },
        tokenPreflight: TOKEN_PREFLIGHT,
        budgets: TOKEN_BUDGETS,
        store: false
      });
    }
    if (req.method === 'POST' && url.pathname === '/api/turn') {
      if (!rateLimit(req)) return json(res, 429, { error: 'Too many requests. Wait before dropping another stone.' });
      const body = await readJson(req);
      const world = hydrateWorld(body.world || {});
      const input = {
        text: String(body.text || '').trim().slice(0, 600),
        originalText: String(body.original_text || body.text || '').trim().slice(0, 600),
        mode: body.mode,
        resolution: body.resolution || null,
        turnId: String(body.turn_id || body.request_id || `turn-${Date.now()}`).slice(0, 100),
        eventId: String(body.event_id || `${body.request_id || `turn-${Date.now()}`}-event`).slice(0, 120),
        idempotencyKey: String(body.request_id || body.turn_id || `request-${Date.now()}`).slice(0, 120),
        sourceStratumId: String(body.source_stratum_id || '').slice(0, 120) || null,
        createdAt: body.created_at || new Date().toISOString(),
        request_id: body.request_id
      };
      if (!input.text) return json(res, 400, { error: 'A participant line is required.' });
      const controller = new AbortController();
      req.on('close', () => controller.abort());
      const useOpenAI = body.use_openai !== false;
      const policy = ['efficient', 'deep', 'luna'].includes(body.ai_policy) ? body.ai_policy : DEFAULT_AI_POLICY;
      const turnBudget = createTurnBudget(TOKEN_BUDGETS);
      const initialLocal = proposeLocalEvent(world, input);
      const complexity = classifyTurnComplexity(world, input, initialLocal);
      const proposalResult = await proposeEvent(world, input, { useOpenAI, policy, complexity, turnBudget, signal: controller.signal });
      const { proposal } = proposalResult;
      if (proposal.status !== 'accepted') {
        return json(res, 200, {
          ...proposal,
          aiRoute: { policy, complexity, trace: proposalResult.trace, review: null, writer: null },
          usage: { ...turnBudget.summary(), totals: summarizeUsage(turnBudget.calls) }
        });
      }

      const preliminary = proposal.event;
      const candidateEvents = selectRelevantEvents(world, preliminary, 12);
      const reviewed = await reviewRelevantEvents({
        world,
        preliminaryEvent: preliminary,
        candidateEvents,
        policy,
        complexity,
        solAlreadyUsed: proposalResult.solUsed,
        useOpenAI,
        turnBudget,
        signal: controller.signal
      });
      const relevantEvents = reviewed.relevantEvents;
      const event = finalizeEvent(world, preliminary, relevantEvents);
      let nextWorld;
      try { nextWorld = applyEvent(world, event); }
      catch (error) {
        return json(res, 200, {
          status: 'needs_clarification',
          clarification: {
            code: 'validation-failed',
            question: `The proposed event could not pass ontology validation: ${error.message}`,
            options: [
              { id: 'record-only', label: 'Record as poetic assertion only', resolution: { kind: 'record-proposition', epistemicStatus: 'asserted' } },
              { id: 'cancel', label: 'Cancel', resolution: { kind: 'cancel' } }
            ]
          },
          aiRoute: { policy, complexity, trace: proposalResult.trace, review: reviewed.review, writer: null },
          usage: { ...turnBudget.summary(), totals: summarizeUsage(turnBudget.calls) }
        });
      }
      const ripple = computeRippleProfile(event, relevantEvents);
      const renderedResult = await renderEvent(nextWorld, event, relevantEvents, { useOpenAI, turnBudget, signal: controller.signal });
      const checked = validateRenderedTurn(nextWorld, event, relevantEvents, renderedResult.rendered);
      if (!checked.ok) throw new Error(checked.errors.join(' '));
      return json(res, 200, {
        status: 'accepted',
        world: nextWorld,
        event,
        relevantEvents,
        render: checked.rendered,
        ripple,
        proof: buildRippleProof(nextWorld, [event.id, ...relevantEvents.map(item => item.id)]),
        proposer: proposal.source || 'local-proposer',
        generator: checked.rendered.generator || renderedResult.rendered.generator || 'local-typed',
        aiRoute: {
          policy,
          complexity,
          trace: proposalResult.trace,
          review: reviewed.review,
          writer: renderedResult.writer,
          solUsed: reviewed.solUsed || proposalResult.solUsed
        },
        usage: { ...turnBudget.summary(), totals: summarizeUsage(turnBudget.calls) },
        request_id: body.request_id || null
      });
    }
    if (req.method === 'GET') return serveStatic(req, res);
    json(res, 404, { error: 'Not found.' });
  } catch (error) {
    if (error?.name === 'AbortError') return;
    json(res, 500, { error: error.message || 'Unexpected server failure.' });
  }
});

await loadRuntimeKey();
server.listen(PORT, HOST, () => {
  console.log(`Poetry Pond Ripple V3 listening on http://${HOST}:${PORT}`);
  console.log(`OpenAI ${OPENAI_API_KEY ? 'enabled' : 'disabled'} · Luna ${LUNA_MODEL} · Sol ${SOL_MODEL} · policy ${DEFAULT_AI_POLICY}`);
});
