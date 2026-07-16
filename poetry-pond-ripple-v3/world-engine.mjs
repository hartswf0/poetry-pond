const WORLD_VERSION = 2;
const ONTOLOGY_VERSION = 2;
const STACK_IDS = Object.freeze(['history', 'memory', 'possibility', 'return', 'silence']);
const ALLOWED_MODES = Object.freeze(['Stone', 'Obstacle', 'Goal', 'Turn']);
const PERSISTENCE = new Set(['turn', 'session', 'until-restored', 'permanent']);
const EPISTEMIC = new Set(['asserted', 'question', 'hypothetical', 'desired', 'quoted', 'negated']);
const SPEECH_ACTS = new Set(['assertion', 'question', 'hypothetical', 'wish', 'command', 'quotation', 'negation']);
const PRONOUNS = new Set(['it', 'he', 'she', 'they', 'them', 'him', 'her', 'this', 'that']);

const TYPE_SCHEMAS = Object.freeze({
  actor: {
    present: 'boolean',
    locationId: 'nullable-string',
    hunger: 'number-0-1',
    lastAction: 'nullable-string'
  },
  resource: {
    present: 'boolean',
    quantity: 'nonnegative-number',
    ownerId: 'nullable-string',
    locationId: 'nullable-string',
    condition: 'resource-condition'
  },
  location: {
    present: 'boolean',
    description: 'nullable-string'
  },
  obstacle: {
    active: 'boolean',
    blocksId: 'nullable-string'
  },
  goal: {
    active: 'boolean',
    achieved: 'boolean',
    description: 'string'
  },
  concept: {
    present: 'boolean',
    state: 'nullable-string'
  },
  proposition: {
    active: 'boolean',
    text: 'string',
    epistemicStatus: 'epistemic-status'
  },
  'semantic-stack': {
    activationCount: 'nonnegative-integer',
    lastEventId: 'nullable-string',
    lastTurnId: 'nullable-string'
  },
  clock: {
    day: 'nonnegative-number'
  }
});

export {
  WORLD_VERSION, ONTOLOGY_VERSION, STACK_IDS, ALLOWED_MODES, TYPE_SCHEMAS
};

export function deepClone(value) {
  return value == null ? value : JSON.parse(JSON.stringify(value));
}

function nowIso(value) {
  return value || new Date().toISOString();
}

function defaultStackEntity(id) {
  return {
    id: `stack:${id}`,
    type: 'semantic-stack',
    aliases: [id],
    attributes: { activationCount: 0, lastEventId: null, lastTurnId: null }
  };
}

function defaultClockEntity() {
  return {
    id: 'clock:world',
    type: 'clock',
    aliases: ['clock', 'time', 'world time'],
    attributes: { day: 0 }
  };
}

export function createWorld(seed = {}) {
  const seedEntities = deepClone(seed.seedEntities || {});
  const world = {
    version: WORLD_VERSION,
    ontologyVersion: ONTOLOGY_VERSION,
    seedEntities,
    entities: deepClone(seedEntities),
    events: [],
    turns: [],
    causalEdges: [],
    idempotencyKeys: [],
    createdAt: seed.createdAt || new Date(0).toISOString(),
    updatedAt: seed.updatedAt || new Date(0).toISOString()
  };
  for (const id of STACK_IDS) {
    if (!world.entities[`stack:${id}`]) world.entities[`stack:${id}`] = defaultStackEntity(id);
  }
  if (!world.entities['clock:world']) world.entities['clock:world'] = defaultClockEntity();
  return world;
}

export function hydrateWorld(raw = {}) {
  const base = createWorld({
    seedEntities: raw.seedEntities || {},
    createdAt: raw.createdAt,
    updatedAt: raw.updatedAt
  });
  base.events = Array.isArray(raw.events) ? deepClone(raw.events) : [];
  base.turns = Array.isArray(raw.turns) ? [...raw.turns] : [];
  base.idempotencyKeys = Array.isArray(raw.idempotencyKeys) ? [...raw.idempotencyKeys] : [];
  return replayWorld(base);
}

export function normalizePhrase(value = '') {
  return String(value)
    .toLowerCase()
    .replace(/[’']/g, '')
    .replace(/[^a-z0-9\s-]/g, ' ')
    .replace(/\b(the|a|an|this|that|these|those)\b/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function singularize(word) {
  if (/ies$/.test(word) && word.length > 4) return `${word.slice(0, -3)}y`;
  if (/sses$/.test(word)) return word.slice(0, -2);
  if (/s$/.test(word) && !/ss$/.test(word) && word.length > 3) return word.slice(0, -1);
  return word;
}

export function entityIdFromPhrase(value = '') {
  const normalized = normalizePhrase(value)
    .split(' ')
    .map((part, index, all) => index === all.length - 1 ? singularize(part) : part)
    .join(' ')
    .trim();
  return normalized
    ? normalized.replace(/\s+/g, '-').replace(/^-+|-+$/g, '').slice(0, 72)
    : 'unnamed';
}

export function getPath(object, path) {
  if (!path) return object;
  return String(path).split('.').reduce((value, key) => value == null ? undefined : value[key], object);
}

export function setPath(object, path, value) {
  const keys = String(path).split('.');
  let cursor = object;
  for (const key of keys.slice(0, -1)) {
    if (!cursor[key] || typeof cursor[key] !== 'object' || Array.isArray(cursor[key])) cursor[key] = {};
    cursor = cursor[key];
  }
  cursor[keys[keys.length - 1]] = deepClone(value);
}

function valuesEqual(a, b) {
  return JSON.stringify(a === undefined ? null : a) === JSON.stringify(b === undefined ? null : b);
}

function stableHash(source) {
  let h = 2166136261;
  for (let i = 0; i < source.length; i += 1) {
    h ^= source.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0).toString(36);
}

function makeId(prefix, text, turnId) {
  return `${prefix}_${stableHash(`${prefix}|${text}|${turnId}`)}`;
}

function ensureEntityRecord(entity) {
  const type = String(entity.type || 'concept');
  const attributes = deepClone(entity.attributes || {});
  return {
    id: String(entity.id),
    type,
    aliases: [...new Set((entity.aliases || [entity.id]).map(String).filter(Boolean))],
    attributes
  };
}

export function findEntity(world, phraseOrId, preferredTypes = null) {
  if (!phraseOrId) return null;
  const direct = world.entities[String(phraseOrId)];
  if (direct && (!preferredTypes || preferredTypes.includes(direct.type))) return direct;
  const normalized = normalizePhrase(phraseOrId);
  return Object.values(world.entities).find(entity =>
    (!preferredTypes || preferredTypes.includes(entity.type)) &&
    entity.aliases?.some(alias => normalizePhrase(alias) === normalized)
  ) || null;
}

function validateScalar(rule, value) {
  switch (rule) {
    case 'boolean': return typeof value === 'boolean';
    case 'string': return typeof value === 'string';
    case 'nullable-string': return value === null || typeof value === 'string';
    case 'number-0-1': return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1;
    case 'nonnegative-number': return typeof value === 'number' && Number.isFinite(value) && value >= 0;
    case 'nonnegative-integer': return Number.isInteger(value) && value >= 0;
    case 'resource-condition': return ['unknown', 'fresh', 'ripe', 'rotting', 'rotten'].includes(value);
    case 'epistemic-status': return EPISTEMIC.has(value);
    default: return false;
  }
}

function validateEntityRecord(entity) {
  const errors = [];
  if (!entity?.id) return ['Entity id is required.'];
  if (!TYPE_SCHEMAS[entity.type]) return [`Unsupported entity type: ${entity.type}`];
  const schema = TYPE_SCHEMAS[entity.type];
  for (const [path, value] of Object.entries(entity.attributes || {})) {
    if (!Object.prototype.hasOwnProperty.call(schema, path)) {
      errors.push(`Property ${path} is not allowed on ${entity.type}.`);
      continue;
    }
    if (!validateScalar(schema[path], value)) errors.push(`Invalid value for ${entity.id}.${path}.`);
  }
  return errors;
}

function currentEntityValue(world, entityId, path) {
  return getPath(world.entities[entityId]?.attributes, path);
}

function materialChange(change, entities) {
  const type = entities[change.entityId]?.type;
  return type !== 'semantic-stack' && type !== 'proposition' && type !== 'clock';
}

export function validateEvent(world, proposed) {
  const errors = [];
  if (!proposed || typeof proposed !== 'object') return { ok: false, errors: ['Event is missing.'] };
  if (!proposed.id) errors.push('Event id is required.');
  if (!proposed.turnId) errors.push('Turn id is required.');
  if (!proposed.sourceText) errors.push('Source text is required.');
  if (!proposed.action?.operation) errors.push('Action operation is required.');
  if (proposed.mode && !ALLOWED_MODES.includes(proposed.mode)) errors.push(`Unsupported mode: ${proposed.mode}`);
  if (!EPISTEMIC.has(proposed.epistemicStatus || 'asserted')) errors.push(`Unsupported epistemic status: ${proposed.epistemicStatus}`);
  if (!SPEECH_ACTS.has(proposed.speechAct || 'assertion')) errors.push(`Unsupported speech act: ${proposed.speechAct}`);
  if (world.events.some(event => event.id === proposed.id)) errors.push(`Duplicate event id: ${proposed.id}`);
  if (proposed.idempotencyKey && world.idempotencyKeys.includes(proposed.idempotencyKey)) errors.push(`Duplicate idempotency key: ${proposed.idempotencyKey}`);

  const staged = deepClone(world.entities);
  for (const raw of proposed.entityUpserts || []) {
    if (!raw?.id) { errors.push('Entity upsert is missing an id.'); continue; }
    const incoming = ensureEntityRecord(raw);
    errors.push(...validateEntityRecord(incoming));
    const existing = staged[incoming.id];
    if (existing && existing.type !== incoming.type && existing.type !== 'concept') {
      errors.push(`Entity ${incoming.id} cannot change type from ${existing.type} to ${incoming.type}.`);
      continue;
    }
    staged[incoming.id] = existing
      ? {
          ...existing,
          type: existing.type === 'concept' ? incoming.type : existing.type,
          aliases: [...new Set([...(existing.aliases || []), ...incoming.aliases])],
          attributes: { ...(existing.attributes || {}), ...(incoming.attributes || {}) }
        }
      : incoming;
  }

  const seenChanges = new Set();
  for (const change of proposed.changes || []) {
    if (!change?.entityId || !change?.path) {
      errors.push('Each change requires entityId and path.');
      continue;
    }
    const key = `${change.entityId}|${change.path}`;
    if (seenChanges.has(key)) errors.push(`Duplicate state change for ${change.entityId}.${change.path}.`);
    seenChanges.add(key);
    const entity = staged[change.entityId];
    if (!entity) {
      errors.push(`Change targets missing entity: ${change.entityId}`);
      continue;
    }
    const schema = TYPE_SCHEMAS[entity.type];
    if (!schema || !Object.prototype.hasOwnProperty.call(schema, change.path)) {
      errors.push(`Property ${change.path} is not allowed on ${entity.type}.`);
      continue;
    }
    const actualBefore = getPath(entity.attributes, change.path);
    const expectedBefore = change.before === undefined ? null : change.before;
    if (!valuesEqual(actualBefore, expectedBefore)) {
      errors.push(`Before-value mismatch for ${change.entityId}.${change.path}: expected ${JSON.stringify(expectedBefore)}, actual ${JSON.stringify(actualBefore ?? null)}.`);
      continue;
    }
    if (valuesEqual(actualBefore, change.after)) {
      errors.push(`No-op change for ${change.entityId}.${change.path}.`);
      continue;
    }
    if (!validateScalar(schema[change.path], change.after)) {
      errors.push(`Invalid after-value for ${change.entityId}.${change.path}.`);
      continue;
    }
    if (change.persistence && !PERSISTENCE.has(change.persistence)) errors.push(`Unsupported persistence: ${change.persistence}`);
    setPath(entity.attributes, change.path, change.after);
  }

  const allowedReferenceIds = new Set([...Object.keys(staged), ...(proposed.entityUpserts || []).map(item => item.id)]);
  for (const id of proposed.references || []) if (!allowedReferenceIds.has(id)) errors.push(`Unknown entity reference: ${id}`);
  for (const eventId of proposed.causedBy || []) if (!world.events.some(event => event.id === eventId)) errors.push(`Unknown causal event: ${eventId}`);
  if (proposed.branchTarget && !STACK_IDS.includes(proposed.branchTarget)) errors.push(`Unknown semantic stack: ${proposed.branchTarget}`);

  if (proposed.committed === false) {
    const illegal = (proposed.changes || []).filter(change => materialChange(change, staged));
    if (illegal.length) errors.push('A non-committed proposition cannot alter material world state.');
  }
  if (proposed.action?.operation === 'query') {
    const illegal = (proposed.changes || []).filter(change => materialChange(change, staged));
    if (illegal.length) errors.push('A query cannot directly mutate material world state.');
  }
  if (proposed.epistemicStatus === 'negated' && proposed.action?.operation === 'consume') {
    errors.push('A negated consumption cannot be accepted as consumption.');
  }

  return { ok: errors.length === 0, errors };
}

export function applyEvent(world, proposed) {
  const validation = validateEvent(world, proposed);
  if (!validation.ok) {
    const error = new Error(`Rejected event: ${validation.errors.join(' ')}`);
    error.validationErrors = validation.errors;
    throw error;
  }
  const next = deepClone(world);
  for (const raw of proposed.entityUpserts || []) {
    const incoming = ensureEntityRecord(raw);
    const existing = next.entities[incoming.id];
    next.entities[incoming.id] = existing
      ? {
          ...existing,
          type: existing.type === 'concept' ? incoming.type : existing.type,
          aliases: [...new Set([...(existing.aliases || []), ...incoming.aliases])],
          attributes: { ...(existing.attributes || {}), ...(incoming.attributes || {}) }
        }
      : incoming;
  }
  const accepted = deepClone(proposed);
  accepted.changes = (accepted.changes || []).map(change => ({
    ...change,
    before: change.before === undefined ? null : deepClone(change.before),
    persistence: change.persistence || 'until-restored'
  }));
  for (const change of accepted.changes) setPath(next.entities[change.entityId].attributes, change.path, change.after);
  next.events.push(accepted);
  next.idempotencyKeys.push(accepted.idempotencyKey || accepted.id);
  if (!next.turns.includes(accepted.turnId)) next.turns.push(accepted.turnId);
  for (const sourceId of accepted.causedBy || []) next.causalEdges.push({ from: sourceId, to: accepted.id, type: 'caused' });
  next.updatedAt = accepted.createdAt || new Date().toISOString();
  return next;
}

export function replayWorld(world) {
  let rebuilt = createWorld({ seedEntities: world.seedEntities || {}, createdAt: world.createdAt, updatedAt: world.updatedAt });
  for (const event of world.events || []) rebuilt = applyEvent(rebuilt, event);
  return rebuilt;
}

export function undoLastTurn(world) {
  const lastTurnId = world.turns?.[world.turns.length - 1];
  if (!lastTurnId) return { world: deepClone(world), removedTurnId: null, removedEvents: [] };
  const removedEvents = world.events.filter(event => event.turnId === lastTurnId);
  const retained = { ...deepClone(world), events: world.events.filter(event => event.turnId !== lastTurnId) };
  return { world: replayWorld(retained), removedTurnId: lastTurnId, removedEvents };
}

function upsertFor(world, phrase, type, attributes = {}) {
  const existing = findEntity(world, phrase, [type, 'concept']);
  if (existing) return { id: existing.id, upsert: null };
  const id = entityIdFromPhrase(phrase);
  return {
    id,
    upsert: {
      id,
      type,
      aliases: [phrase, normalizePhrase(phrase), id.replace(/-/g, ' ')],
      attributes
    }
  };
}

function before(world, entityId, path, fallback = null) {
  const value = currentEntityValue(world, entityId, path);
  return value === undefined ? fallback : deepClone(value);
}

function splitClauses(text) {
  return String(text)
    .split(/(?<=[.!?])\s+|\s+(?:and then|then)\s+/i)
    .map(value => value.trim())
    .filter(Boolean);
}

function numberFromToken(token) {
  if (token == null || token === '') return null;
  if (/^\d+(?:\.\d+)?$/.test(token)) return Number(token);
  const words = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10 };
  return words[String(token).toLowerCase()] ?? null;
}

function detectSpeechAct(text) {
  const clean = String(text).trim();
  if (/^[“"].+[”"]$/.test(clean)) return { speechAct: 'quotation', epistemicStatus: 'quoted', committed: false };
  if (/\b(?:suppose|imagine|what if|perhaps|maybe)\b/i.test(clean) || /^if\b/i.test(clean)) return { speechAct: 'hypothetical', epistemicStatus: 'hypothetical', committed: false };
  if (/^(?:i wish|we wish|may |let us hope|hopefully)\b/i.test(clean)) return { speechAct: 'wish', epistemicStatus: 'desired', committed: false };
  if (/\b(?:does not|doesn't|did not|didn't|never)\b/i.test(clean)) return { speechAct: 'negation', epistemicStatus: 'negated', committed: true };
  if (/\?$/.test(clean) || /^(?:what|which|where|who|when|why|how)\b/i.test(clean)) return { speechAct: 'question', epistemicStatus: 'question', committed: false };
  return { speechAct: 'assertion', epistemicStatus: 'asserted', committed: true };
}

function actorCandidates(world) {
  return Object.values(world.entities).filter(entity => entity.type === 'actor' && entity.attributes?.present !== false);
}

function resolvePronoun(world, phrase, fullText) {
  const normalized = normalizePhrase(phrase);
  if (!PRONOUNS.has(normalized)) return { status: 'resolved', phrase };
  const candidates = actorCandidates(world);
  if (candidates.length === 1) return { status: 'resolved', phrase: candidates[0].aliases?.[0] || candidates[0].id };
  const options = candidates.slice(0, 5).map(entity => {
    const label = entity.aliases?.[0] || entity.id;
    const pattern = new RegExp(`\\b${normalized}\\b`, 'i');
    return {
      id: `actor:${entity.id}`,
      label,
      resolution: { kind: 'replace-text', text: String(fullText).replace(pattern, label) }
    };
  });
  options.push({ id: 'record-only', label: 'Keep the pronoun unresolved', resolution: { kind: 'record-proposition', epistemicStatus: 'asserted' } });
  return {
    status: 'needs_clarification',
    clarification: {
      code: 'ambiguous-pronoun',
      question: candidates.length ? `Who does “${phrase}” refer to?` : `“${phrase}” has no established referent.`,
      options
    }
  };
}

function collectMentionedEntities(world, text) {
  const normalized = normalizePhrase(text);
  return Object.values(world.entities)
    .filter(entity => !['semantic-stack', 'clock'].includes(entity.type))
    .filter(entity => entity.aliases?.some(alias => {
      const key = normalizePhrase(alias);
      return key.length > 1 && normalized.includes(key);
    }))
    .map(entity => entity.id);
}

function baseEvent(input, text, interpretedText, speech) {
  const mode = ALLOWED_MODES.includes(input?.mode) ? input.mode : 'Stone';
  const turnId = String(input?.turnId || makeId('turn', text, Date.now()));
  return {
    id: String(input?.eventId || makeId('event', interpretedText, turnId)),
    idempotencyKey: String(input?.idempotencyKey || turnId),
    turnId,
    sourceText: String(input?.originalText || text),
    interpretedText,
    sourceStratumId: input?.sourceStratumId || null,
    mode,
    speechAct: speech.speechAct,
    epistemicStatus: speech.epistemicStatus,
    committed: speech.committed,
    interpretationConfidence: 1,
    interpretationNotes: [],
    action: { operation: 'assert', actorId: null, targetId: null, recipientId: null, quantity: null, queryType: null, polarity: speech.epistemicStatus === 'negated' ? 'negative' : 'positive' },
    entityUpserts: [],
    changes: [],
    references: [],
    causedBy: [],
    branchTarget: null,
    inferredPreconditions: [],
    createdAt: nowIso(input?.createdAt)
  };
}

function propositionEvent(world, input, text, epistemicStatus = 'asserted') {
  const speechAct = epistemicStatus === 'hypothetical' ? 'hypothetical' : epistemicStatus === 'desired' ? 'wish' : 'assertion';
  const speech = { speechAct, epistemicStatus, committed: epistemicStatus === 'asserted' };
  const event = baseEvent(input, text, text, speech);
  const id = `proposition:${makeId('p', text, event.turnId).slice(2)}`;
  event.entityUpserts.push({
    id,
    type: 'proposition',
    aliases: [text],
    attributes: { active: true, text, epistemicStatus }
  });
  event.references.push(id);
  event.action = { operation: 'record-proposition', actorId: null, targetId: id, recipientId: null, quantity: null, queryType: null, polarity: 'positive' };
  event.interpretationNotes.push('The participant explicitly chose to record this as a proposition rather than a material state change.');
  if (epistemicStatus === 'hypothetical' || epistemicStatus === 'desired') event.branchTarget = 'possibility';
  return event;
}

function clarificationForNonCommitted(text, speech) {
  const statusLabel = speech.epistemicStatus === 'hypothetical' ? 'possibility' : speech.epistemicStatus === 'desired' ? 'desire' : 'quotation';
  const stripped = String(text)
    .replace(/^\s*(?:suppose|imagine|perhaps|maybe|what if)\s+/i, '')
    .replace(/^\s*if\s+/i, '')
    .replace(/^\s*(?:i wish|we wish)\s+/i, '')
    .replace(/[?]+$/g, '')
    .trim();
  return {
    status: 'needs_clarification',
    clarification: {
      code: `noncommitted-${speech.epistemicStatus}`,
      question: `Should this remain a ${statusLabel}, or become an actual world event?`,
      options: [
        { id: 'record-proposition', label: `Keep as ${statusLabel}`, resolution: { kind: 'record-proposition', epistemicStatus: speech.epistemicStatus } },
        ...(stripped ? [{ id: 'commit-event', label: 'Commit as actual event', resolution: { kind: 'replace-text', text: stripped } }] : []),
        { id: 'cancel', label: 'Cancel', resolution: { kind: 'cancel' } }
      ]
    }
  };
}

function addChange(event, staged, change) {
  const duplicate = event.changes.find(item => item.entityId === change.entityId && item.path === change.path);
  if (duplicate) {
    duplicate.after = deepClone(change.after);
    setPath(staged.entities[change.entityId].attributes, change.path, change.after);
    return;
  }
  event.changes.push(change);
  setPath(staged.entities[change.entityId].attributes, change.path, change.after);
}

function addUpsert(event, staged, record) {
  if (!record || event.entityUpserts.some(item => item.id === record.id) || staged.entities[record.id]) return;
  event.entityUpserts.push(record);
  staged.entities[record.id] = ensureEntityRecord(record);
}

function addReference(event, id) {
  if (id && !event.references.includes(id)) event.references.push(id);
}

function clarificationUnsupported(text) {
  return {
    status: 'needs_clarification',
    clarification: {
      code: 'unsupported-action',
      question: 'The local engine cannot safely infer a typed world change from this line.',
      options: [
        { id: 'record-assertion', label: 'Record as poetic assertion only', resolution: { kind: 'record-proposition', epistemicStatus: 'asserted' } },
        { id: 'cancel', label: 'Cancel', resolution: { kind: 'cancel' } }
      ],
      sourceText: text
    }
  };
}

export function proposeLocalEvent(world, input = {}) {
  const text = String(input.text || '').trim().slice(0, 600);
  if (!text) return { status: 'rejected', error: 'A participant line is required.' };
  const resolution = input.resolution || null;
  if (resolution?.kind === 'cancel') return { status: 'rejected', error: 'The participant cancelled the unresolved action.' };
  if (resolution?.kind === 'replace-text') {
    return proposeLocalEvent(world, { ...input, text: resolution.text, originalText: input.originalText || text, resolution: null });
  }
  if (resolution?.kind === 'record-proposition') {
    const event = propositionEvent(world, input, input.originalText || text, resolution.epistemicStatus || 'asserted');
    return { status: 'accepted', event, interpretation: event.interpretationNotes[0], source: 'local-proposer' };
  }

  const speech = detectSpeechAct(text);
  if (['hypothetical', 'wish', 'quotation'].includes(speech.speechAct)) return clarificationForNonCommitted(text, speech);

  const event = baseEvent(input, text, text, speech);
  const staged = deepClone(world);
  let recognized = false;
  const clauses = splitClauses(text);

  for (const clause of clauses) {
    const clean = clause.replace(/[.!?]+$/g, '').trim();
    if (!clean) continue;
    let match;

    if (/\b(?:what|which|where|who|how many|remains?|left|available|food)\b/i.test(clean) || /\?$/.test(clause)) {
      recognized = true;
      const queryType = /\b(remains?|left|available|food|how many)\b/i.test(clean) ? 'availability' : 'state';
      if (event.changes.length === 0 && event.action.operation === 'assert') {
        event.speechAct = 'question';
        event.epistemicStatus = 'question';
        event.committed = false;
        event.action.operation = 'query';
      } else {
        event.interpretationNotes.push('The turn combines a committed action with a question about its consequences.');
      }
      event.action.queryType = queryType;
      for (const id of collectMentionedEntities(staged, clean)) addReference(event, id);
      if (queryType === 'availability') {
        for (const entity of Object.values(staged.entities)) if (entity.type === 'resource') addReference(event, entity.id);
      }
      continue;
    }

    match = clean.match(/^(?:the\s+)?(.+?)\s+(?:does not|doesn't|did not|didn't|never)\s+(?:eat|eats|ate|consume|consumes|consumed)\s+(?:the\s+)?(.+)$/i);
    if (match) {
      recognized = true;
      const resolved = resolvePronoun(staged, match[1], text);
      if (resolved.status !== 'resolved') return resolved;
      const actor = upsertFor(staged, resolved.phrase, 'actor', { present: true, locationId: null, hunger: 0, lastAction: null });
      const target = upsertFor(staged, match[2], 'resource', { present: true, quantity: 1, ownerId: null, locationId: null, condition: 'unknown' });
      addUpsert(event, staged, actor.upsert); addUpsert(event, staged, target.upsert);
      addReference(event, actor.id); addReference(event, target.id);
      event.action = { operation: 'not-consume', actorId: actor.id, targetId: target.id, recipientId: null, quantity: 0, queryType: null, polarity: 'negative' };
      event.speechAct = 'negation'; event.epistemicStatus = 'negated'; event.committed = true;
      const prior = before(staged, actor.id, 'lastAction', null);
      addChange(event, staged, { entityId: actor.id, path: 'lastAction', before: prior, after: `did-not-consume:${target.id}`, persistence: 'turn', reason: 'The negative action is stored without consuming the resource.' });
      continue;
    }

    match = clean.match(/^(?:the\s+)?(.+?)\s+(?:eats?|ate|consumes?|consumed)\s+(?:(\d+|one|two|three|four|five|six|seven|eight|nine|ten)\s+)?(?:the\s+)?(?:(last|final)\s+)?(.+)$/i);
    if (match) {
      recognized = true;
      const resolved = resolvePronoun(staged, match[1], text);
      if (resolved.status !== 'resolved') return resolved;
      const actor = upsertFor(staged, resolved.phrase, 'actor', { present: true, locationId: null, hunger: 0, lastAction: null });
      const explicitQuantity = numberFromToken(match[2]);
      const last = Boolean(match[3]);
      const targetPhrase = match[4].trim();
      const existing = findEntity(staged, targetPhrase, ['resource']);
      let initialQuantity;
      if (existing) initialQuantity = Number(existing.attributes?.quantity ?? 0);
      else initialQuantity = last ? 1 : explicitQuantity || 1;
      const target = existing
        ? { id: existing.id, upsert: null }
        : upsertFor(staged, targetPhrase, 'resource', { present: initialQuantity > 0, quantity: initialQuantity, ownerId: null, locationId: null, condition: 'unknown' });
      addUpsert(event, staged, actor.upsert); addUpsert(event, staged, target.upsert);
      addReference(event, actor.id); addReference(event, target.id);
      if (!existing) event.inferredPreconditions.push({ entityId: target.id, path: 'quantity', value: initialQuantity, reason: 'Consumption implies the resource existed immediately before the action.' });
      const quantityBefore = Number(before(staged, target.id, 'quantity', initialQuantity));
      const consumeQuantity = last ? quantityBefore : explicitQuantity || 1;
      if (consumeQuantity > quantityBefore) {
        return {
          status: 'needs_clarification',
          clarification: {
            code: 'insufficient-resource',
            question: `${targetPhrase} has quantity ${quantityBefore}, but the action consumes ${consumeQuantity}.`,
            options: [
              ...(quantityBefore > 0 ? [{ id: 'consume-remaining', label: `Consume the remaining ${quantityBefore}`, resolution: { kind: 'replace-text', text: `${resolved.phrase} eats ${quantityBefore} ${targetPhrase}` } }] : []),
              { id: 'record-only', label: 'Record as assertion only', resolution: { kind: 'record-proposition', epistemicStatus: 'asserted' } },
              { id: 'cancel', label: 'Cancel', resolution: { kind: 'cancel' } }
            ]
          }
        };
      }
      const quantityAfter = Math.max(0, quantityBefore - consumeQuantity);
      addChange(event, staged, { entityId: target.id, path: 'quantity', before: quantityBefore, after: quantityAfter, persistence: 'until-restored', reason: `${consumeQuantity} unit${consumeQuantity === 1 ? '' : 's'} were consumed.` });
      const presentBefore = before(staged, target.id, 'present', quantityBefore > 0);
      if (presentBefore !== (quantityAfter > 0)) addChange(event, staged, { entityId: target.id, path: 'present', before: presentBefore, after: quantityAfter > 0, persistence: 'until-restored', reason: quantityAfter > 0 ? 'Some resource remains.' : 'No available unit remains.' });
      addChange(event, staged, { entityId: actor.id, path: 'lastAction', before: before(staged, actor.id, 'lastAction', null), after: `consumed:${target.id}:${consumeQuantity}`, persistence: 'turn', reason: 'The actor performed the initiating action.' });
      event.action = { operation: 'consume', actorId: actor.id, targetId: target.id, recipientId: null, quantity: consumeQuantity, queryType: null, polarity: 'positive' };
      continue;
    }

    match = clean.match(/^(?:the\s+)?(.+?)\s+(?:gives?|gave)\s+(?:the\s+)?(.+?)\s+to\s+(?:the\s+)?(.+)$/i);
    if (match) {
      recognized = true;
      const giverResolved = resolvePronoun(staged, match[1], text);
      if (giverResolved.status !== 'resolved') return giverResolved;
      const recipientResolved = resolvePronoun(staged, match[3], text);
      if (recipientResolved.status !== 'resolved') return recipientResolved;
      const giver = upsertFor(staged, giverResolved.phrase, 'actor', { present: true, locationId: null, hunger: 0, lastAction: null });
      const recipient = upsertFor(staged, recipientResolved.phrase, 'actor', { present: true, locationId: null, hunger: 0, lastAction: null });
      const resourcePhrase = match[2].trim();
      const existing = findEntity(staged, resourcePhrase, ['resource']);
      const resource = existing
        ? { id: existing.id, upsert: null }
        : upsertFor(staged, resourcePhrase, 'resource', { present: true, quantity: 1, ownerId: giver.id, locationId: null, condition: 'unknown' });
      addUpsert(event, staged, giver.upsert); addUpsert(event, staged, recipient.upsert); addUpsert(event, staged, resource.upsert);
      addReference(event, giver.id); addReference(event, recipient.id); addReference(event, resource.id);
      const ownerBefore = before(staged, resource.id, 'ownerId', giver.id);
      if (ownerBefore && ownerBefore !== giver.id) {
        return {
          status: 'needs_clarification',
          clarification: {
            code: 'ownership-conflict',
            question: `${resourcePhrase} is currently owned by ${ownerBefore}, not ${giver.id}.`,
            options: [
              { id: 'record-only', label: 'Record as assertion only', resolution: { kind: 'record-proposition', epistemicStatus: 'asserted' } },
              { id: 'cancel', label: 'Cancel', resolution: { kind: 'cancel' } }
            ]
          }
        };
      }
      addChange(event, staged, { entityId: resource.id, path: 'ownerId', before: ownerBefore, after: recipient.id, persistence: 'until-restored', reason: 'Ownership transferred from giver to recipient.' });
      addChange(event, staged, { entityId: giver.id, path: 'lastAction', before: before(staged, giver.id, 'lastAction', null), after: `gave:${resource.id}:to:${recipient.id}`, persistence: 'turn', reason: 'The transfer is stored on the initiating actor.' });
      event.action = { operation: 'transfer', actorId: giver.id, targetId: resource.id, recipientId: recipient.id, quantity: 1, queryType: null, polarity: 'positive' };
      continue;
    }

    match = clean.match(/^(?:the\s+)?(.+?)\s+(?:blocks?|blocked)\s+(?:the\s+)?(.+)$/i);
    if (match) {
      recognized = true;
      const obstacle = upsertFor(staged, match[1], 'obstacle', { active: false, blocksId: null });
      const target = upsertFor(staged, match[2], 'location', { present: true, description: null });
      addUpsert(event, staged, obstacle.upsert); addUpsert(event, staged, target.upsert);
      addReference(event, obstacle.id); addReference(event, target.id);
      addChange(event, staged, { entityId: obstacle.id, path: 'active', before: before(staged, obstacle.id, 'active', false), after: true, persistence: 'until-restored', reason: 'The obstacle became active.' });
      addChange(event, staged, { entityId: obstacle.id, path: 'blocksId', before: before(staged, obstacle.id, 'blocksId', null), after: target.id, persistence: 'until-restored', reason: 'The blocked location is stored explicitly.' });
      event.action = { operation: 'block', actorId: obstacle.id, targetId: target.id, recipientId: null, quantity: null, queryType: null, polarity: 'positive' };
      continue;
    }

    match = clean.match(/^(?:the\s+)?(.+?)\s+(?:returns?|returned)(?:\s+to\s+(?:the\s+)?(.+?))?(?:\s+(?:tomorrow|today|later))?$/i);
    if (match) {
      recognized = true;
      const resolved = resolvePronoun(staged, match[1], text);
      if (resolved.status !== 'resolved') return resolved;
      const actor = upsertFor(staged, resolved.phrase, 'actor', { present: true, locationId: null, hunger: 0, lastAction: null });
      addUpsert(event, staged, actor.upsert); addReference(event, actor.id);
      let locationId = null;
      if (match[2]) {
        const location = upsertFor(staged, match[2], 'location', { present: true, description: null });
        addUpsert(event, staged, location.upsert); addReference(event, location.id); locationId = location.id;
        addChange(event, staged, { entityId: actor.id, path: 'locationId', before: before(staged, actor.id, 'locationId', null), after: location.id, persistence: 'until-restored', reason: 'The actor returned to a location.' });
      }
      addChange(event, staged, { entityId: actor.id, path: 'lastAction', before: before(staged, actor.id, 'lastAction', null), after: locationId ? `returned:${locationId}` : 'returned', persistence: 'turn', reason: 'The return is stored on the actor.' });
      event.action = { operation: 'return', actorId: actor.id, targetId: locationId, recipientId: null, quantity: null, queryType: event.action.queryType, polarity: 'positive' };
      continue;
    }

    match = clean.match(/^(?:the\s+)?(.+?)\s+(?:removes?|removed|destroys?|destroyed)\s+(?:the\s+)?(.+)$/i);
    if (match) {
      recognized = true;
      const actor = upsertFor(staged, match[1], 'actor', { present: true, locationId: null, hunger: 0, lastAction: null });
      const existing = findEntity(staged, match[2]);
      if (!existing) {
        return {
          status: 'needs_clarification',
          clarification: {
            code: 'missing-target',
            question: `${match[2]} does not yet exist in the world.`,
            options: [
              { id: 'record-only', label: 'Record as assertion only', resolution: { kind: 'record-proposition', epistemicStatus: 'asserted' } },
              { id: 'cancel', label: 'Cancel', resolution: { kind: 'cancel' } }
            ]
          }
        };
      }
      addUpsert(event, staged, actor.upsert); addReference(event, actor.id); addReference(event, existing.id);
      const path = Object.prototype.hasOwnProperty.call(TYPE_SCHEMAS[existing.type] || {}, 'present') ? 'present' : Object.prototype.hasOwnProperty.call(TYPE_SCHEMAS[existing.type] || {}, 'active') ? 'active' : null;
      if (!path) return clarificationUnsupported(text);
      addChange(event, staged, { entityId: existing.id, path, before: before(staged, existing.id, path, true), after: false, persistence: 'until-restored', reason: 'The target was removed from the active world.' });
      addChange(event, staged, { entityId: actor.id, path: 'lastAction', before: before(staged, actor.id, 'lastAction', null), after: `removed:${existing.id}`, persistence: 'turn', reason: 'The removal is stored on the actor.' });
      event.action = { operation: 'remove', actorId: actor.id, targetId: existing.id, recipientId: null, quantity: null, queryType: null, polarity: 'positive' };
      continue;
    }

    match = clean.match(/^(?:the\s+)?(.+?)\s+(?:creates?|created|adds?|added)\s+(?:the\s+)?(.+)$/i);
    if (match) {
      recognized = true;
      const actor = upsertFor(staged, match[1], 'actor', { present: true, locationId: null, hunger: 0, lastAction: null });
      const target = upsertFor(staged, match[2], 'concept', { present: false, state: null });
      addUpsert(event, staged, actor.upsert); addUpsert(event, staged, target.upsert);
      addReference(event, actor.id); addReference(event, target.id);
      addChange(event, staged, { entityId: target.id, path: 'present', before: before(staged, target.id, 'present', false), after: true, persistence: 'until-restored', reason: 'The created entity entered the active world.' });
      addChange(event, staged, { entityId: actor.id, path: 'lastAction', before: before(staged, actor.id, 'lastAction', null), after: `created:${target.id}`, persistence: 'turn', reason: 'The creation is stored on the actor.' });
      event.action = { operation: 'create', actorId: actor.id, targetId: target.id, recipientId: null, quantity: null, queryType: null, polarity: 'positive' };
      continue;
    }

    match = clean.match(/^(?:the\s+)?(.+?)\s+is\s+(.+)$/i);
    if (match) {
      recognized = true;
      const subject = upsertFor(staged, match[1], 'concept', { present: true, state: null });
      addUpsert(event, staged, subject.upsert); addReference(event, subject.id);
      addChange(event, staged, { entityId: subject.id, path: 'state', before: before(staged, subject.id, 'state', null), after: match[2].trim(), persistence: 'until-restored', reason: 'The participant asserted a state.' });
      event.action = { operation: 'set-state', actorId: subject.id, targetId: subject.id, recipientId: null, quantity: null, queryType: null, polarity: 'positive' };
      event.interpretationConfidence = 0.75;
      continue;
    }
  }

  if (!recognized) return clarificationUnsupported(text);
  for (const id of collectMentionedEntities(staged, text)) addReference(event, id);
  const hasMaterialChange = event.changes.some(change => materialChange(change, staged.entities));
  if (hasMaterialChange && event.action.operation !== 'query') {
    event.committed = true;
    if (event.epistemicStatus === 'question') event.epistemicStatus = 'asserted';
    if (event.speechAct === 'question') event.speechAct = 'assertion';
  }
  return { status: 'accepted', event, interpretation: `${event.action.operation} was parsed into typed state.`, source: 'local-proposer' };
}

function eventEntitySet(event) {
  return new Set([
    ...(event.references || []),
    event.action?.actorId,
    event.action?.targetId,
    event.action?.recipientId,
    ...(event.changes || []).map(change => change.entityId)
  ].filter(Boolean));
}

export function scoreRelevantEvent(world, currentEvent, candidate, index) {
  if (!candidate || candidate.id === currentEvent.id) return -Infinity;
  const currentRefs = eventEntitySet(currentEvent);
  const candidateRefs = eventEntitySet(candidate);
  let score = 0;
  for (const id of currentRefs) if (candidateRefs.has(id)) score += 18;
  if (currentEvent.action?.queryType === 'availability' && candidate.changes?.some(change => ['quantity', 'present', 'condition'].includes(change.path))) score += 14;
  if (currentEvent.action?.operation === 'return' && candidate.action?.actorId === currentEvent.action?.actorId) score += 8;
  if (currentEvent.action?.operation === 'not-consume' && candidate.action?.operation === 'consume' && candidate.action?.targetId === currentEvent.action?.targetId) score += 10;
  if ((candidate.changes || []).some(change => ['permanent', 'until-restored'].includes(change.persistence))) score += 4;
  const directCausal = world.causalEdges.some(edge => edge.from === candidate.id && edge.to === currentEvent.id);
  if (directCausal) score += 20;
  const distance = Math.max(1, world.events.length - index);
  score += Math.min(2, 2 / distance);
  return score;
}

export function selectRelevantEvents(world, currentEvent, limit = 6) {
  return world.events
    .map((event, index) => ({ event, score: scoreRelevantEvent(world, currentEvent, event, index) }))
    .filter(item => Number.isFinite(item.score) && item.score >= 8)
    .sort((a, b) => b.score - a.score || String(a.event.id).localeCompare(String(b.event.id)))
    .slice(0, limit)
    .map(item => ({ ...deepClone(item.event), relevanceScore: Number(item.score.toFixed(3)) }));
}

function chooseBranchTarget(event, relevantEvents) {
  if (event.epistemicStatus === 'hypothetical' || event.epistemicStatus === 'desired') return 'possibility';
  if (event.action?.operation === 'query' && relevantEvents.length) return 'memory';
  if (event.action?.operation === 'return' && relevantEvents.length) return 'memory';
  if (event.mode === 'Turn' && relevantEvents.length) return 'history';
  if ((event.mode === 'Obstacle' || event.action?.polarity === 'negative') && relevantEvents.length) return 'return';
  return null;
}

export function finalizeEvent(world, event, relevantEvents = []) {
  const finalized = deepClone(event);
  finalized.causedBy = [...new Set((relevantEvents || []).map(item => item.id).filter(id => world.events.some(eventItem => eventItem.id === id)))];
  finalized.branchTarget = finalized.branchTarget || chooseBranchTarget(finalized, relevantEvents);
  if (finalized.branchTarget) {
    const stackId = `stack:${finalized.branchTarget}`;
    const stack = world.entities[stackId];
    finalized.references = [...new Set([...(finalized.references || []), stackId])];
    finalized.changes = [...(finalized.changes || [])];
    finalized.changes.push({
      entityId: stackId,
      path: 'activationCount',
      before: Number(stack.attributes.activationCount || 0),
      after: Number(stack.attributes.activationCount || 0) + 1,
      persistence: 'session',
      reason: 'A verified semantic branch activated this stack.'
    });
    finalized.changes.push({
      entityId: stackId,
      path: 'lastEventId',
      before: stack.attributes.lastEventId ?? null,
      after: finalized.id,
      persistence: 'session',
      reason: 'The stack records the activating event.'
    });
    finalized.changes.push({
      entityId: stackId,
      path: 'lastTurnId',
      before: stack.attributes.lastTurnId ?? null,
      after: finalized.turnId,
      persistence: 'session',
      reason: 'The stack records the activating turn.'
    });
  }
  return finalized;
}

export function describeChange(change) {
  const beforeText = change.before === null || change.before === undefined ? 'unset' : JSON.stringify(change.before);
  const afterText = change.after === null || change.after === undefined ? 'unset' : JSON.stringify(change.after);
  return `${change.entityId}.${change.path}: ${beforeText} → ${afterText}`;
}

export function buildRippleProof(world, usedEventIds = []) {
  return [...new Set(usedEventIds)]
    .map(id => world.events.find(event => event.id === id))
    .filter(Boolean)
    .map(event => ({
      eventId: event.id,
      turnId: event.turnId,
      sourceText: event.sourceText,
      sourceStratumId: event.sourceStratumId || null,
      operation: event.action?.operation || null,
      epistemicStatus: event.epistemicStatus,
      changes: (event.changes || []).map(change => ({ ...deepClone(change), description: describeChange(change) }))
    }));
}

export function validateCausalUse(world, currentEvent, relevantEvents, usedEventIds = []) {
  const relevant = new Set((relevantEvents || []).map(event => event.id));
  const currentIndex = world.events.findIndex(event => event.id === currentEvent.id);
  const valid = [];
  const invalid = [];
  for (const id of [...new Set([currentEvent.id, ...(usedEventIds || [])])]) {
    if (id === currentEvent.id) { valid.push(id); continue; }
    const index = world.events.findIndex(event => event.id === id);
    if (index < 0 || (currentIndex >= 0 && index >= currentIndex) || !relevant.has(id)) invalid.push(id);
    else valid.push(id);
  }
  return { ok: invalid.length === 0, valid, invalid };
}

export function computeRippleProfile(event, relevantEvents = []) {
  const material = (event.changes || []).filter(change => !String(change.entityId).startsWith('stack:') && !String(change.entityId).startsWith('proposition:') && change.entityId !== 'clock:world');
  const changedProperties = material.length;
  const persistentChanges = material.filter(change => ['permanent', 'until-restored'].includes(change.persistence)).length;
  const affectedEntities = new Set(material.map(change => change.entityId)).size;
  const newMaterialEntities = (event.entityUpserts || []).filter(entity => !['semantic-stack', 'proposition', 'clock'].includes(entity.type)).length;
  const contradiction = event.mode === 'Obstacle' || event.mode === 'Turn' || event.action?.polarity === 'negative' ? 1 : 0;
  const causalReturn = relevantEvents.length ? Math.min(2, relevantEvents.length) : 0;
  const inferred = event.inferredPreconditions?.length ? 0.5 : 0;
  const raw = 0.12 + changedProperties * 0.075 + persistentChanges * 0.075 + affectedEntities * 0.05 + newMaterialEntities * 0.035 + contradiction * 0.12 + causalReturn * 0.07 + inferred * 0.04;
  const impact = Math.max(0.12, Math.min(0.92, raw));
  return {
    impact,
    consequences: [0.42, 0.52, 0.62].map(multiplier => Math.max(0.07, Math.min(0.56, impact * multiplier))),
    branch: event.branchTarget ? Math.max(0.12, Math.min(0.62, impact * 0.68)) : 0,
    final: Math.max(0.09, Math.min(0.62, impact * 0.58)),
    evidence: { changedProperties, persistentChanges, affectedEntities, newMaterialEntities, contradiction, causalReturn, inferredPreconditions: event.inferredPreconditions?.length || 0 }
  };
}

function entityName(world, id, fallback = 'the field') {
  const entity = world.entities[id];
  return entity?.aliases?.[0] || id || fallback;
}

function unavailableResources(world, refs = []) {
  const wanted = refs.length ? new Set(refs) : null;
  return Object.values(world.entities)
    .filter(entity => entity.type === 'resource' && (!wanted || wanted.has(entity.id)))
    .filter(entity => Number(entity.attributes?.quantity ?? 0) <= 0 || entity.attributes?.present === false);
}

export function renderLocalTurn(world, event, relevantEvents = []) {
  const priorIds = relevantEvents.map(item => item.id);
  const used = [event.id, ...priorIds];
  const actorName = entityName(world, event.action?.actorId, 'The action');
  const targetName = entityName(world, event.action?.targetId, 'the field');
  let consequences;
  let therefore;

  if (event.action?.queryType === 'availability' || event.action?.operation === 'query') {
    const unavailable = unavailableResources(world, event.references || []);
    if (unavailable.length) {
      const resource = unavailable[0];
      const name = entityName(world, resource.id);
      consequences = [
        `${actorName} returns to a field already altered.`,
        `No ${name} remains without a restoring event.`,
        `The earlier loss now constrains what can happen next.`
      ];
      therefore = `Therefore, the present encounter carries the stored absence of ${name}.`;
    } else {
      consequences = [
        `The question searches the current ledger.`,
        `No stored depletion governs the available field.`,
        `The world answers from its present validated state.`
      ];
      therefore = 'Therefore, no earlier material loss currently limits this encounter.';
    }
  } else if (event.action?.operation === 'consume') {
    const quantity = Number(world.entities[event.action.targetId]?.attributes?.quantity ?? 0);
    consequences = [
      `${actorName} consumes ${event.action.quantity || 1} ${targetName}.`,
      `${targetName} now carries an available quantity of ${quantity}.`,
      `Any later return must answer this stored condition.`
    ];
    therefore = `Therefore, ${targetName} becomes a binding fact rather than a passing image.`;
  } else if (event.action?.operation === 'not-consume') {
    consequences = [
      `${actorName} leaves ${targetName} materially unchanged.`,
      `The refusal is stored without inventing a disappearance.`,
      `A later scene may distinguish restraint from consumption.`
    ];
    therefore = `Therefore, ${targetName} remains available despite the negative action.`;
  } else if (event.action?.operation === 'transfer') {
    const recipient = entityName(world, event.action.recipientId, 'another keeper');
    consequences = [
      `${actorName} releases ${targetName}.`,
      `${recipient} now holds the transferred resource.`,
      `Later possession must follow the accepted ownership change.`
    ];
    therefore = `Therefore, ${targetName} changes relation without vanishing from the world.`;
  } else if (event.action?.operation === 'block') {
    consequences = [
      `${actorName} becomes an active obstruction.`,
      `${targetName} is now explicitly blocked in the ledger.`,
      `Later movement must confront or remove this condition.`
    ];
    therefore = `Therefore, passage now depends on the stored obstacle.`;
  } else if (event.action?.operation === 'record-proposition') {
    consequences = [
      `The line enters as a named proposition.`,
      `It does not silently rewrite material world state.`,
      `Its epistemic status remains visible to later readers.`
    ];
    therefore = 'Therefore, possibility and fact remain separate strata.';
  } else {
    const firstMaterial = (event.changes || []).find(change => !String(change.entityId).startsWith('stack:'));
    consequences = [
      `The action enters the typed event ledger.`,
      firstMaterial ? describeChange(firstMaterial) : 'No material property was changed.',
      relevantEvents.length ? 'A verified earlier event is active again.' : 'The new condition waits for a later causal return.'
    ];
    therefore = 'Therefore, the mountain stores an inspectable condition, not an ungrounded mood.';
  }

  return {
    consequences: consequences.map((text, index) => ({
      text,
      usedEventIds: index === 0 ? [event.id] : used
    })),
    therefore: { text: therefore, usedEventIds: used },
    branch: event.branchTarget ? {
      text: `${event.branchTarget} receives a verified branch from this accepted event.`,
      target: event.branchTarget,
      usedEventIds: used
    } : null,
    generator: 'local-typed'
  };
}

export function validateRenderedTurn(world, event, relevantEvents, rendered) {
  const errors = [];
  const validatePart = (part, label) => {
    if (!part || typeof part.text !== 'string' || !part.text.trim()) errors.push(`${label} is missing text.`);
    const use = validateCausalUse(world, event, relevantEvents, part?.usedEventIds || part?.used_event_ids || []);
    if (!use.ok) errors.push(`${label} cites invalid causal events: ${use.invalid.join(', ')}`);
    return { text: String(part?.text || '').slice(0, 260), usedEventIds: use.valid };
  };
  const consequences = Array.isArray(rendered?.consequences) ? rendered.consequences.slice(0, 3).map((part, index) => validatePart(part, `Consequence ${index + 1}`)) : [];
  if (consequences.length !== 3) errors.push('Exactly three consequences are required.');
  const therefore = validatePart(typeof rendered?.therefore === 'string' ? { text: rendered.therefore } : rendered?.therefore, 'Therefore');
  let branch = null;
  if (event.branchTarget) {
    if (!rendered?.branch) errors.push('The accepted event requires a branch rendering.');
    else {
      const raw = typeof rendered.branch === 'string' ? { text: rendered.branch } : rendered.branch;
      const checked = validatePart(raw, 'Branch');
      branch = { ...checked, target: event.branchTarget };
    }
  } else if (rendered?.branch) errors.push('The renderer invented a branch not present in the accepted event.');
  return { ok: errors.length === 0, errors, rendered: { consequences, therefore, branch, generator: rendered?.generator || 'validated-renderer' } };
}

export function worldDigest(world) {
  return {
    version: world.version,
    ontologyVersion: world.ontologyVersion,
    entities: Object.values(world.entities).map(entity => ({ id: entity.id, type: entity.type, aliases: entity.aliases, attributes: entity.attributes })),
    recentEvents: world.events.slice(-24).map(event => ({
      id: event.id,
      turnId: event.turnId,
      sourceText: event.sourceText,
      interpretedText: event.interpretedText,
      speechAct: event.speechAct,
      epistemicStatus: event.epistemicStatus,
      committed: event.committed,
      action: event.action,
      references: event.references,
      causedBy: event.causedBy,
      changes: event.changes,
      branchTarget: event.branchTarget
    }))
  };
}

export function processLocalTurn(world, input = {}) {
  const proposal = proposeLocalEvent(world, input);
  if (proposal.status !== 'accepted') return proposal;
  const preliminary = proposal.event;
  const relevantEvents = selectRelevantEvents(world, preliminary, 6);
  const event = finalizeEvent(world, preliminary, relevantEvents);
  const nextWorld = applyEvent(world, event);
  const profile = computeRippleProfile(event, relevantEvents);
  const rawRender = renderLocalTurn(nextWorld, event, relevantEvents);
  const checked = validateRenderedTurn(nextWorld, event, relevantEvents, rawRender);
  if (!checked.ok) return { status: 'rejected', error: checked.errors.join(' ') };
  return {
    status: 'accepted',
    world: nextWorld,
    event,
    relevantEvents,
    render: checked.rendered,
    ripple: profile,
    proof: buildRippleProof(nextWorld, [event.id, ...relevantEvents.map(item => item.id)]),
    source: proposal.source || 'local-proposer'
  };
}
