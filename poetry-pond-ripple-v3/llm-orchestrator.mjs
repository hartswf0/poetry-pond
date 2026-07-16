const MODEL_PRICES = Object.freeze({
  'gpt-5.6-sol': { input: 5, cachedInput: 0.5, output: 30, cacheWriteMultiplier: 1.25 },
  'gpt-5.6': { input: 5, cachedInput: 0.5, output: 30, cacheWriteMultiplier: 1.25 },
  'gpt-5.6-luna': { input: 1, cachedInput: 0.1, output: 6, cacheWriteMultiplier: 1.25 }
});

const GENERIC_PRICE = MODEL_PRICES['gpt-5.6-luna'];

export const DEFAULT_TOKEN_BUDGETS = Object.freeze({
  lunaPlannerInput: 3200,
  solPlannerInput: 6200,
  solReviewInput: 5200,
  lunaWriterInput: 2800,
  lunaPlannerOutput: 700,
  solPlannerOutput: 900,
  solReviewOutput: 420,
  lunaWriterOutput: 360,
  maxCallsPerTurn: 3,
  maxSolCallsPerTurn: 1,
  maxCostUsdPerTurn: 0.075
});

export function estimateTokens(value) {
  const text = typeof value === 'string' ? value : JSON.stringify(value ?? null);
  if (!text) return 0;
  // Conservative for JSON and mixed prose. Exact OpenAI counting is used near limits.
  return Math.ceil(text.length / 3.45) + 12;
}

export function normalizeUsage(raw = {}, model = '', meta = {}) {
  const details = raw.input_tokens_details || raw.inputTokensDetails || {};
  const outputDetails = raw.output_tokens_details || raw.outputTokensDetails || {};
  const inputTokens = Number(raw.input_tokens ?? raw.inputTokens ?? 0);
  const outputTokens = Number(raw.output_tokens ?? raw.outputTokens ?? 0);
  const cachedTokens = Number(details.cached_tokens ?? details.cachedTokens ?? 0);
  const cacheWriteTokens = Number(details.cache_write_tokens ?? details.cacheWriteTokens ?? 0);
  const reasoningTokens = Number(outputDetails.reasoning_tokens ?? outputDetails.reasoningTokens ?? 0);
  const totalTokens = Number(raw.total_tokens ?? raw.totalTokens ?? inputTokens + outputTokens);
  return {
    model,
    route: meta.route || null,
    inputTokens,
    cachedTokens,
    cacheWriteTokens,
    outputTokens,
    reasoningTokens,
    totalTokens,
    preflightTokens: Number(meta.preflightTokens || 0),
    estimatedInputTokens: Number(meta.estimatedInputTokens || 0),
    latencyMs: Number(meta.latencyMs || 0),
    cacheKey: meta.cacheKey || null,
    responseId: meta.responseId || null,
    estimatedCostUsd: estimateCostUsd(model, { inputTokens, cachedTokens, cacheWriteTokens, outputTokens })
  };
}

export function estimateCostUsd(model, usage = {}) {
  const price = MODEL_PRICES[model] || GENERIC_PRICE;
  const input = Number(usage.inputTokens || 0);
  const cached = Math.min(input, Number(usage.cachedTokens || 0));
  const writes = Math.min(input - cached, Number(usage.cacheWriteTokens || 0));
  const uncached = Math.max(0, input - cached - writes);
  const output = Number(usage.outputTokens || 0);
  return Number((
    uncached * price.input / 1_000_000 +
    cached * price.cachedInput / 1_000_000 +
    writes * price.input * price.cacheWriteMultiplier / 1_000_000 +
    output * price.output / 1_000_000
  ).toFixed(8));
}

export function worstCaseCostUsd(model, inputTokens, maxOutputTokens) {
  const price = MODEL_PRICES[model] || GENERIC_PRICE;
  return Number((Number(inputTokens || 0) * price.input / 1_000_000 + Number(maxOutputTokens || 0) * price.output / 1_000_000).toFixed(8));
}

export function createTurnBudget(overrides = {}) {
  const limits = { ...DEFAULT_TOKEN_BUDGETS, ...overrides };
  return {
    limits,
    calls: [],
    reservedCalls: 0,
    solCalls: 0,
    reservedCostUsd: 0,
    actualCostUsd: 0,
    canReserve({ model, inputTokens, maxOutputTokens }) {
      const isSol = String(model).includes('sol') || model === 'gpt-5.6';
      const projected = worstCaseCostUsd(model, inputTokens, maxOutputTokens);
      if (this.reservedCalls >= limits.maxCallsPerTurn) return { ok: false, reason: 'call-limit', projected };
      if (isSol && this.solCalls >= limits.maxSolCallsPerTurn) return { ok: false, reason: 'sol-call-limit', projected };
      if (this.reservedCostUsd + projected > limits.maxCostUsdPerTurn) return { ok: false, reason: 'cost-limit', projected };
      return { ok: true, projected };
    },
    reserve(call) {
      const check = this.canReserve(call);
      if (!check.ok) return check;
      const isSol = String(call.model).includes('sol') || call.model === 'gpt-5.6';
      this.reservedCostUsd += check.projected;
      this.reservedCalls += 1;
      if (isSol) this.solCalls += 1;
      return check;
    },
    record(usage) {
      this.calls.push(usage);
      this.actualCostUsd += Number(usage?.estimatedCostUsd || 0);
    },
    summary() {
      return {
        callCount: this.calls.length,
        attemptedCallCount: this.reservedCalls,
        solCallCount: this.solCalls,
        reservedCostUsd: Number(this.reservedCostUsd.toFixed(8)),
        actualCostUsd: Number(this.actualCostUsd.toFixed(8)),
        maxCostUsd: limits.maxCostUsdPerTurn,
        calls: this.calls
      };
    }
  };
}

function compactChange(change) {
  return {
    e: change.entityId,
    p: change.path,
    b: change.before ?? null,
    a: change.after ?? null,
    d: change.persistence
  };
}

export function compactEvent(event, includeText = true) {
  return {
    id: event.id,
    ...(includeText ? { text: String(event.sourceText || event.interpretedText || '').slice(0, 240) } : {}),
    op: event.action?.operation || null,
    actor: event.action?.actorId || null,
    target: event.action?.targetId || null,
    recipient: event.action?.recipientId || null,
    qty: event.action?.quantity ?? null,
    query: event.action?.queryType || null,
    refs: [...new Set(event.references || [])].slice(0, 12),
    causedBy: [...new Set(event.causedBy || [])].slice(0, 10),
    changes: (event.changes || []).slice(0, 12).map(compactChange),
    branch: event.branchTarget || null
  };
}

export function compactEntity(entity, includeAliases = true) {
  return {
    id: entity.id,
    type: entity.type,
    ...(includeAliases ? { aliases: (entity.aliases || []).slice(0, 5) } : {}),
    state: entity.attributes || {}
  };
}

function mentionedEntityIds(world, text) {
  const lower = String(text || '').toLowerCase();
  const found = [];
  for (const entity of Object.values(world.entities || {})) {
    const names = [entity.id, ...(entity.aliases || [])].map(value => String(value).toLowerCase()).filter(Boolean);
    if (names.some(name => name.length > 1 && lower.includes(name))) found.push(entity.id);
  }
  return found;
}

function recentTouchedIds(world, count = 8) {
  const ids = [];
  for (const event of [...(world.events || [])].slice(-count).reverse()) {
    for (const id of [event.action?.actorId, event.action?.targetId, event.action?.recipientId, ...(event.references || []), ...(event.changes || []).map(change => change.entityId)]) {
      if (id && !ids.includes(id)) ids.push(id);
    }
  }
  return ids;
}

function ontologyDigest(typeSchemas = {}) {
  return Object.fromEntries(Object.entries(typeSchemas).map(([type, schema]) => [type, Object.keys(schema || {})]));
}

export function classifyTurnComplexity(world, input, localProposal = null) {
  const text = String(input?.text || '');
  const lower = text.toLowerCase();
  let score = 0;
  const reasons = [];
  const add = (value, reason) => { score += value; reasons.push(reason); };
  if (text.length > 160) add(2, 'long-line');
  else if (text.length > 80) add(1, 'medium-line');
  if ((text.match(/[.!?]/g) || []).length > 1) add(1, 'multi-sentence');
  if (/\b(if|unless|although|because|therefore|before|after|while|until|suppose|imagine|might|could|would)\b/i.test(text)) add(2, 'conditional-or-temporal');
  if (/\b(it|they|them|this|that|those|these|he|she)\b/i.test(text)) add(1, 'reference-resolution');
  if (/\b(gives?|takes?|moves?|returns?|remembers?|forgets?|promises?|prevents?|causes?|changes?)\b/i.test(text)) add(1, 'relational-action');
  if ((text.match(/\b\d+\b/g) || []).length > 1) add(1, 'multiple-quantities');
  if ((world?.events || []).length > 20) add(1, 'long-ledger');
  if ((world?.events || []).length > 80) add(2, 'very-long-ledger');
  if (mentionedEntityIds(world, lower).length > 2) add(1, 'many-entities');
  if (localProposal?.clarification?.code === 'unsupported-action') add(2, 'unsupported-local-grammar');
  if (localProposal?.status === 'needs_clarification' && localProposal?.clarification?.code !== 'unsupported-action') add(1, 'true-ambiguity');
  return { score, tier: score >= 6 ? 'high' : score >= 3 ? 'medium' : 'low', reasons };
}

export function choosePlannerRoute({ policy = 'efficient', complexity, localProposal }) {
  if (!localProposal || localProposal.status === 'accepted') return { modelTier: 'none', reason: 'local-parser-accepted' };
  if (localProposal.clarification?.code !== 'unsupported-action') return { modelTier: 'none', reason: 'ambiguity-must-remain-visible' };
  if (policy === 'luna') return { modelTier: 'luna', reason: 'luna-policy' };
  if (policy === 'deep') return { modelTier: 'sol', reason: 'deep-policy' };
  if ((complexity?.score || 0) >= 6) return { modelTier: 'sol', reason: 'high-complexity' };
  return { modelTier: 'luna', reason: 'routine-unsupported-language' };
}

export function shouldEscalateLunaProposal(proposal, complexity) {
  if (!proposal) return true;
  if (proposal.status === 'rejected') return true;
  if (proposal.status === 'accepted' && Number(proposal.event?.interpretationConfidence || 0) < 0.58 && (complexity?.score || 0) >= 3) return true;
  return false;
}

export function shouldRunSolReview({ policy = 'efficient', complexity, world, preliminaryEvent, candidateEvents, solAlreadyUsed = false }) {
  if (solAlreadyUsed || !candidateEvents?.length) return false;
  if (policy === 'luna') return false;
  if (policy === 'deep' && candidateEvents.length >= 2) return true;
  const query = preliminaryEvent?.action?.operation === 'query' || preliminaryEvent?.action?.operation === 'return';
  const multiHop = candidateEvents.some(event => (event.causedBy || []).length > 0);
  return Boolean((complexity?.score || 0) >= 4 || (query && candidateEvents.length >= 4) || ((world?.events || []).length > 24 && multiHop));
}

function fitContext(context, budget, reducers = []) {
  let current = context;
  let estimated = estimateTokens(current);
  for (const reduce of reducers) {
    while (estimated > budget && reduce.can(current)) {
      current = reduce.apply(current);
      estimated = estimateTokens(current);
    }
  }
  return { context: current, estimatedTokens: estimated, fits: estimated <= budget };
}

export function buildPlannerContext(world, input, typeSchemas, budget = DEFAULT_TOKEN_BUDGETS.lunaPlannerInput) {
  const mentioned = mentionedEntityIds(world, input.text);
  const orderedIds = [...new Set([...mentioned, ...recentTouchedIds(world, 10), ...Object.keys(world.entities || {})])];
  const entities = orderedIds.slice(0, 28).map(id => world.entities[id]).filter(Boolean).map(entity => compactEntity(entity, true));
  const events = (world.events || []).slice(-10).map(event => compactEvent(event, true));
  const base = {
    task: 'propose_typed_event',
    line: String(input.text || '').slice(0, 600),
    mask: input.mode || 'Stone',
    ontology: ontologyDigest(typeSchemas),
    entities,
    recentEvents: events,
    ledgerCount: (world.events || []).length
  };
  return fitContext(base, budget, [
    { can: c => c.recentEvents.length > 4, apply: c => ({ ...c, recentEvents: c.recentEvents.slice(1) }) },
    { can: c => c.entities.length > 12, apply: c => ({ ...c, entities: c.entities.slice(0, -1) }) },
    { can: c => c.entities.some(entity => entity.aliases), apply: c => ({ ...c, entities: c.entities.map(entity => ({ id: entity.id, type: entity.type, state: entity.state })) }) },
    { can: c => c.recentEvents.some(event => event.text?.length > 120), apply: c => ({ ...c, recentEvents: c.recentEvents.map(event => ({ ...event, text: event.text?.slice(0, 120) })) }) }
  ]);
}

export function buildReviewContext(world, preliminaryEvent, candidateEvents, budget = DEFAULT_TOKEN_BUDGETS.solReviewInput) {
  const ids = new Set([preliminaryEvent.id, ...candidateEvents.map(event => event.id)]);
  const edges = (world.causalEdges || []).filter(edge => ids.has(edge.from) && ids.has(edge.to)).slice(-24);
  const base = {
    task: 'rerank_verified_causal_candidates',
    current: compactEvent(preliminaryEvent, true),
    candidates: candidateEvents.slice(0, 12).map(event => ({ ...compactEvent(event, true), relevanceScore: event.relevanceScore ?? null })),
    verifiedEdges: edges
  };
  return fitContext(base, budget, [
    { can: c => c.candidates.length > 6, apply: c => ({ ...c, candidates: c.candidates.slice(0, -1) }) },
    { can: c => c.candidates.some(event => event.text?.length > 100), apply: c => ({ ...c, candidates: c.candidates.map(event => ({ ...event, text: event.text?.slice(0, 100) })) }) }
  ]);
}

export function buildWriterContext(nextWorld, event, relevantEvents, budget = DEFAULT_TOKEN_BUDGETS.lunaWriterInput) {
  const entityIds = new Set([
    event.action?.actorId,
    event.action?.targetId,
    event.action?.recipientId,
    ...(event.references || []),
    ...(event.changes || []).map(change => change.entityId),
    ...relevantEvents.flatMap(prior => [prior.action?.actorId, prior.action?.targetId, prior.action?.recipientId, ...(prior.references || [])])
  ].filter(Boolean));
  const entities = [...entityIds].map(id => nextWorld.entities[id]).filter(Boolean).map(entity => compactEntity(entity, false));
  const base = {
    task: 'render_accepted_event',
    acceptedEvent: compactEvent(event, true),
    relevantPriorEvents: relevantEvents.slice(0, 6).map(prior => compactEvent(prior, true)),
    resultingEntities: entities.slice(0, 18),
    allowedEventIds: [event.id, ...relevantEvents.map(item => item.id)],
    branchTarget: event.branchTarget || null
  };
  return fitContext(base, budget, [
    { can: c => c.relevantPriorEvents.length > 3, apply: c => ({ ...c, relevantPriorEvents: c.relevantPriorEvents.slice(0, -1), allowedEventIds: [c.acceptedEvent.id, ...c.relevantPriorEvents.slice(0, -1).map(item => item.id)] }) },
    { can: c => c.resultingEntities.length > 10, apply: c => ({ ...c, resultingEntities: c.resultingEntities.slice(0, -1) }) },
    { can: c => c.relevantPriorEvents.some(event => event.text?.length > 100), apply: c => ({ ...c, relevantPriorEvents: c.relevantPriorEvents.map(event => ({ ...event, text: event.text?.slice(0, 100) })) }) }
  ]);
}

export function summarizeUsage(calls = []) {
  const total = calls.reduce((sum, call) => ({
    inputTokens: sum.inputTokens + Number(call.inputTokens || 0),
    cachedTokens: sum.cachedTokens + Number(call.cachedTokens || 0),
    cacheWriteTokens: sum.cacheWriteTokens + Number(call.cacheWriteTokens || 0),
    outputTokens: sum.outputTokens + Number(call.outputTokens || 0),
    reasoningTokens: sum.reasoningTokens + Number(call.reasoningTokens || 0),
    totalTokens: sum.totalTokens + Number(call.totalTokens || 0),
    estimatedCostUsd: sum.estimatedCostUsd + Number(call.estimatedCostUsd || 0)
  }), { inputTokens: 0, cachedTokens: 0, cacheWriteTokens: 0, outputTokens: 0, reasoningTokens: 0, totalTokens: 0, estimatedCostUsd: 0 });
  total.estimatedCostUsd = Number(total.estimatedCostUsd.toFixed(8));
  total.cacheHitRate = total.inputTokens ? Number((total.cachedTokens / total.inputTokens).toFixed(4)) : 0;
  return total;
}
