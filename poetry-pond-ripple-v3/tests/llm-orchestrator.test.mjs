import test from 'node:test';
import assert from 'node:assert/strict';
import {
  estimateTokens, normalizeUsage, createTurnBudget, classifyTurnComplexity,
  choosePlannerRoute, shouldRunSolReview, buildPlannerContext, buildWriterContext,
  DEFAULT_TOKEN_BUDGETS
} from '../llm-orchestrator.mjs';
import { createWorld, processLocalTurn, TYPE_SCHEMAS } from '../world-engine.mjs';

test('token estimator is conservative and monotonic', () => {
  assert.ok(estimateTokens('hello') > 0);
  assert.ok(estimateTokens('hello '.repeat(100)) > estimateTokens('hello'));
});

test('usage normalization exposes cache, reasoning, and cost', () => {
  const usage = normalizeUsage({
    input_tokens: 1000,
    output_tokens: 100,
    total_tokens: 1100,
    input_tokens_details: { cached_tokens: 800, cache_write_tokens: 0 },
    output_tokens_details: { reasoning_tokens: 40 }
  }, 'gpt-5.6-luna', { route: 'luna-writer' });
  assert.equal(usage.cachedTokens, 800);
  assert.equal(usage.reasoningTokens, 40);
  assert.ok(usage.estimatedCostUsd > 0);
});

test('turn budget allows one Sol call and blocks a second by default', () => {
  const budget = createTurnBudget({ ...DEFAULT_TOKEN_BUDGETS, maxCostUsdPerTurn: 1 });
  assert.equal(budget.reserve({ model: 'gpt-5.6-sol', inputTokens: 1000, maxOutputTokens: 100 }).ok, true);
  assert.equal(budget.reserve({ model: 'gpt-5.6-sol', inputTokens: 1000, maxOutputTokens: 100 }).reason, 'sol-call-limit');
});

test('routine unsupported language routes to Luna while complex language routes to Sol', () => {
  const localUnsupported = { status: 'needs_clarification', clarification: { code: 'unsupported-action' } };
  assert.equal(choosePlannerRoute({ policy: 'efficient', complexity: { score: 2 }, localProposal: localUnsupported }).modelTier, 'luna');
  assert.equal(choosePlannerRoute({ policy: 'efficient', complexity: { score: 7 }, localProposal: localUnsupported }).modelTier, 'sol');
});

test('true ambiguity remains visible instead of being escalated', () => {
  const ambiguous = { status: 'needs_clarification', clarification: { code: 'ambiguous-pronoun' } };
  assert.equal(choosePlannerRoute({ policy: 'deep', complexity: { score: 8 }, localProposal: ambiguous }).modelTier, 'none');
});

test('complexity detects conditional multi-entity context', () => {
  const world = createWorld({ seedEntities: {
    bird: { id: 'bird', type: 'actor', aliases: ['bird'], attributes: { present: true, locationId: null, hunger: 0, lastAction: null } },
    fox: { id: 'fox', type: 'actor', aliases: ['fox'], attributes: { present: true, locationId: null, hunger: 0, lastAction: null } },
    berry: { id: 'berry', type: 'resource', aliases: ['berry'], attributes: { present: true, quantity: 1, ownerId: null, locationId: null, condition: 'fresh' } }
  }});
  const result = classifyTurnComplexity(world, { text: 'If the bird gives the berry to the fox after dusk, what changes tomorrow?' }, { status: 'needs_clarification', clarification: { code: 'unsupported-action' } });
  assert.ok(result.score >= 6);
});

test('planner context stays within its explicit budget', () => {
  const world = createWorld();
  const packed = buildPlannerContext(world, { text: 'Moonlight folds the river.', mode: 'Stone' }, TYPE_SCHEMAS, 900);
  assert.equal(packed.fits, true);
  assert.ok(packed.estimatedTokens <= 900);
});

test('writer context contains only accepted event, relevant history, and touched entities', () => {
  let world = createWorld({ seedEntities: {
    bird: { id: 'bird', type: 'actor', aliases: ['bird'], attributes: { present: true, locationId: null, hunger: 0, lastAction: null } },
    blueberry: { id: 'blueberry', type: 'resource', aliases: ['blueberry'], attributes: { present: true, quantity: 1, ownerId: null, locationId: null, condition: 'fresh' } }
  }});
  const first = processLocalTurn(world, { text: 'The bird eats the last blueberry.', mode: 'Stone', turnId: 't1', eventId: 'e1', idempotencyKey: 'r1' });
  world = first.world;
  const second = processLocalTurn(world, { text: 'What food remains?', mode: 'Stone', turnId: 't2', eventId: 'e2', idempotencyKey: 'r2' });
  const packed = buildWriterContext(second.world, second.event, second.relevantEvents, 1200);
  assert.equal(packed.fits, true);
  assert.ok(packed.context.allowedEventIds.includes('e1'));
  assert.ok(packed.estimatedTokens <= 1200);
});

test('Sol review is reserved for complex causal retrieval', () => {
  const world = createWorld();
  assert.equal(shouldRunSolReview({ policy: 'efficient', complexity: { score: 1 }, world, preliminaryEvent: {}, candidateEvents: [{ id: 'e1' }], solAlreadyUsed: false }), false);
  assert.equal(shouldRunSolReview({ policy: 'deep', complexity: { score: 1 }, world, preliminaryEvent: {}, candidateEvents: [{ id: 'e1' }, { id: 'e2' }], solAlreadyUsed: false }), true);
});
