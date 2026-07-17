// Browser-direct OpenAI mode for Poetry Pond.
//
// When the page is served statically (GitHub Pages, python -m http.server)
// there is no local Node server to hold the key. In that case the participant
// may paste a key into the settings panel; it is kept in THIS browser's
// localStorage and every call goes directly from the page to OpenAI.
// The typed causal contract is unchanged: proposals from the model still pass
// the same ontology, before-value, quantity, and citation checks as local
// proposals. OpenAI cannot declare truth from the browser either.

import {
  hydrateWorld, proposeLocalEvent, selectRelevantEvents, finalizeEvent, applyEvent,
  computeRippleProfile, renderLocalTurn, validateRenderedTurn, buildRippleProof,
  worldDigest, entityIdFromPhrase, getPath, TYPE_SCHEMAS
} from './world-engine.mjs';

const OPENAI_ENDPOINT = 'https://api.openai.com/v1/responses';

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

const plannerInstructions = `You propose typed world events for Poetry Pond. You do not write literary prose and you do not own truth.

The application will validate every proposal against a strict ontology and the current before-values. Never guess through ambiguity. Return needs_clarification for unclear pronouns, hypothetical language that might be mistaken for fact, impossible quantities, uncertain ownership, unclear negation, or any action whose world effect is not defensible.

Use existing entity ids exactly. New entities must use refs beginning with new:. Only use paths allowed by the supplied ontology. A question does not mutate material state. A hypothetical, desire, or quotation is not committed material fact unless the participant explicitly resolves it. Negative consumption must not reduce quantity.

Changes contain only intended after-values. The application derives before-values from authoritative state. Keep interpretations compact and operational.`;

const writerInstructions = `You are the literary renderer for Poetry Pond. The accepted event, authoritative resulting world, and relevant prior events are already fixed. You may not invent world changes, causal sources, branches, or event ids.

Write exactly three concise consequence strata and one therefore stratum. Each line should usually be 6 to 18 words. The first consequence should render the current event. Later consequences may use only supplied relevant event ids. Every used_event_ids entry must be either the accepted current event id or a supplied relevant event id. If a branch target is supplied, write one branch line for exactly that target; otherwise branch must be null.

The visible layer should be poetic and readable. Precise before-and-after evidence remains in the selectable Ripple Proof, so do not turn every line into diagnostics. The therefore text must begin with “Therefore,”.`;

function extractOutputText(response) {
  if (typeof response.output_text === 'string' && response.output_text.trim()) return response.output_text.trim();
  for (const item of response.output || []) {
    for (const part of item.content || []) if (part.type === 'output_text' && typeof part.text === 'string') return part.text.trim();
  }
  return '';
}

async function callStructured({ key, model, instructions, input, schema, name, maxOutputTokens = 1400, signal }) {
  const response = await fetch(OPENAI_ENDPOINT, {
    method: 'POST',
    headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model,
      store: false,
      reasoning: { effort: 'medium' },
      max_output_tokens: maxOutputTokens,
      instructions,
      input: JSON.stringify(input),
      text: { format: { type: 'json_schema', name, strict: true, schema } }
    }),
    signal
  });
  const raw = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(raw?.error?.message || `OpenAI returned HTTP ${response.status}.`);
  const output = extractOutputText(raw);
  if (!output) throw new Error('OpenAI returned no structured text output.');
  return { parsed: JSON.parse(output), usage: raw.usage || null, responseId: raw.id || null, model: raw.model || model };
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
  if (raw.status === 'needs_clarification') return { status: 'needs_clarification', clarification: normalizePlannerClarification(raw), source: 'openai-browser-proposer' };
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
  for (const upsert of entityUpserts) staged.entities[upsert.id] = upsert;
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
    interpretationNotes: ['Proposed by OpenAI from the browser and validated by the local ontology.'],
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
  return { status: 'accepted', event, interpretation: raw.interpretation, source: 'openai-browser-proposer' };
}

// Mirrors the server's /api/turn flow, with the key supplied by the page.
export async function browserTurn(worldInput, input, { key, plannerModel = 'gpt-5.6-sol', writerModel = 'gpt-5.6-sol', signal } = {}) {
  if (!key) throw new Error('A browser API key is required for direct OpenAI mode.');
  const world = hydrateWorld(worldInput || {});

  const local = proposeLocalEvent(world, input);
  let proposal = local;
  let plannerUsage = null;
  if (local.status !== 'accepted' && local.clarification?.code === 'unsupported-action') {
    const context = { participant_line: input.text, mask: input.mode, ontology: TYPE_SCHEMAS, world: worldDigest(world) };
    try {
      const call = await callStructured({ key, model: plannerModel, instructions: plannerInstructions, input: context, schema: plannerSchema, name: 'poetry_pond_event_proposal', maxOutputTokens: 1700, signal });
      proposal = mapPlannerProposal(world, input, call.parsed);
      plannerUsage = { model: call.model, responseId: call.responseId, usage: call.usage };
    } catch (error) {
      if (error?.name === 'AbortError') throw error;
      proposal = local;
      plannerUsage = { model: plannerModel, responseId: null, usage: null, error: error.message };
    }
  }
  if (proposal.status !== 'accepted') return { ...proposal, plannerUsage, proposer: proposal.source || 'local-proposer' };

  const preliminary = proposal.event;
  const relevantEvents = selectRelevantEvents(world, preliminary, 6);
  const event = finalizeEvent(world, preliminary, relevantEvents);
  let nextWorld;
  try { nextWorld = applyEvent(world, event); }
  catch (error) {
    return {
      status: 'needs_clarification',
      clarification: {
        code: 'validation-failed',
        question: `The proposed event could not pass ontology validation: ${error.message}`,
        options: [
          { id: 'record-only', label: 'Record as poetic assertion only', resolution: { kind: 'record-proposition', epistemicStatus: 'asserted' } },
          { id: 'cancel', label: 'Cancel', resolution: { kind: 'cancel' } }
        ]
      },
      plannerUsage
    };
  }

  const ripple = computeRippleProfile(event, relevantEvents);
  let rendered = renderLocalTurn(nextWorld, event, relevantEvents);
  let writerUsage = null;
  try {
    const call = await callStructured({
      key, model: writerModel, instructions: writerInstructions,
      input: {
        accepted_event: event,
        relevant_prior_events: relevantEvents,
        resulting_entity_state: worldDigest(nextWorld).entities,
        allowed_event_ids: [event.id, ...relevantEvents.map(item => item.id)],
        branch_target: event.branchTarget
      },
      schema: writerSchema, name: 'poetry_pond_validated_render', maxOutputTokens: 1100, signal
    });
    const raw = {
      consequences: call.parsed.consequences.map(item => ({ text: item.text, usedEventIds: item.used_event_ids })),
      therefore: { text: call.parsed.therefore.text, usedEventIds: call.parsed.therefore.used_event_ids },
      branch: call.parsed.branch ? { text: call.parsed.branch.text, target: call.parsed.branch.target, usedEventIds: call.parsed.branch.used_event_ids } : null,
      generator: 'openai-browser-writer'
    };
    const checked = validateRenderedTurn(nextWorld, event, relevantEvents, raw);
    if (!checked.ok) throw new Error(checked.errors.join(' '));
    rendered = { ...checked.rendered, generator: 'openai-browser-writer' };
    writerUsage = { model: call.model, responseId: call.responseId, usage: call.usage };
  } catch (error) {
    if (error?.name === 'AbortError') throw error;
    writerUsage = { model: writerModel, responseId: null, usage: null, error: error.message };
  }

  const checked = validateRenderedTurn(nextWorld, event, relevantEvents, rendered);
  if (!checked.ok) throw new Error(checked.errors.join(' '));
  return {
    status: 'accepted',
    world: nextWorld,
    event,
    relevantEvents,
    render: checked.rendered,
    ripple,
    proof: buildRippleProof(nextWorld, [event.id, ...relevantEvents.map(item => item.id)]),
    proposer: proposal.source || 'local-proposer',
    generator: checked.rendered.generator || rendered.generator || 'local-typed',
    usage: { planner: plannerUsage, writer: writerUsage },
    request_id: input.request_id || null
  };
}
