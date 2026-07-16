import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createWorld, hydrateWorld, proposeLocalEvent, processLocalTurn, applyEvent,
  finalizeEvent, selectRelevantEvents, undoLastTurn, validateEvent,
  validateRenderedTurn, buildRippleProof, worldDigest
} from '../world-engine.mjs';

function ids(prefix = 'x') {
  ids.n = (ids.n || 0) + 1;
  return { turnId: `${prefix}-turn-${ids.n}`, eventId: `${prefix}-event-${ids.n}`, idempotencyKey: `${prefix}-request-${ids.n}`, sourceStratumId: `${prefix}-stratum-${ids.n}`, createdAt: `2026-01-${String((ids.n % 28) + 1).padStart(2, '0')}T00:00:00.000Z` };
}

function seededBlueberryWorld(quantity = 1) {
  return createWorld({
    seedEntities: {
      bird: { id: 'bird', type: 'actor', aliases: ['bird', 'the bird'], attributes: { present: true, locationId: null, hunger: 0, lastAction: null } },
      blueberry: { id: 'blueberry', type: 'resource', aliases: ['blueberry', 'blueberries', 'the blueberry'], attributes: { present: quantity > 0, quantity, ownerId: null, locationId: null, condition: 'fresh' } }
    }
  });
}

function accept(world, text, extras = {}) {
  const result = processLocalTurn(world, { text, mode: 'Stone', ...ids('accept'), ...extras });
  assert.equal(result.status, 'accepted', result.error || result.clarification?.question);
  return result;
}

test('blueberry depletion survives unrelated turns and later query cites the initiating event', () => {
  let world = seededBlueberryWorld(1);
  const eaten = accept(world, 'The bird eats the last blueberry.');
  world = eaten.world;
  for (let index = 0; index < 10; index += 1) {
    const unrelated = accept(world, `Bell ${index} is quiet.`, { mode: 'Stone' });
    world = unrelated.world;
  }
  const returned = accept(world, 'The bird returns tomorrow. What food remains?');
  assert.equal(returned.world.entities.blueberry.attributes.quantity, 0);
  assert.equal(returned.world.entities.blueberry.attributes.present, false);
  assert.ok(returned.relevantEvents.some(event => event.id === eaten.event.id));
  assert.ok(returned.render.consequences.some(item => /No blueberry remains/i.test(item.text)));
  assert.ok(returned.render.therefore.usedEventIds.includes(eaten.event.id));
});

test('undo restores the seeded blueberry instead of deleting it', () => {
  let world = seededBlueberryWorld(1);
  const eaten = accept(world, 'The bird eats the last blueberry.');
  world = eaten.world;
  assert.equal(world.entities.blueberry.attributes.quantity, 0);
  const undone = undoLastTurn(world);
  assert.equal(undone.world.entities.blueberry.attributes.quantity, 1);
  assert.equal(undone.world.entities.blueberry.attributes.present, true);
  assert.equal(undone.world.events.length, 0);
});

test('pronoun ambiguity does not mutate the world', () => {
  const world = createWorld({
    seedEntities: {
      bird: { id: 'bird', type: 'actor', aliases: ['bird'], attributes: { present: true, locationId: null, hunger: 0, lastAction: null } },
      fox: { id: 'fox', type: 'actor', aliases: ['fox'], attributes: { present: true, locationId: null, hunger: 0, lastAction: null } },
      berry: { id: 'berry', type: 'resource', aliases: ['berry'], attributes: { present: true, quantity: 1, ownerId: null, locationId: null, condition: 'fresh' } }
    }
  });
  const proposal = proposeLocalEvent(world, { text: 'It eats the berry.', ...ids('pronoun') });
  assert.equal(proposal.status, 'needs_clarification');
  assert.equal(proposal.clarification.code, 'ambiguous-pronoun');
  assert.equal(world.events.length, 0);
  assert.equal(world.entities.berry.attributes.quantity, 1);
});

test('resolved pronoun becomes the selected actor', () => {
  const world = createWorld({
    seedEntities: {
      bird: { id: 'bird', type: 'actor', aliases: ['bird'], attributes: { present: true, locationId: null, hunger: 0, lastAction: null } },
      fox: { id: 'fox', type: 'actor', aliases: ['fox'], attributes: { present: true, locationId: null, hunger: 0, lastAction: null } },
      berry: { id: 'berry', type: 'resource', aliases: ['berry'], attributes: { present: true, quantity: 1, ownerId: null, locationId: null, condition: 'fresh' } }
    }
  });
  const result = processLocalTurn(world, {
    text: 'It eats the berry.',
    originalText: 'It eats the berry.',
    resolution: { kind: 'replace-text', text: 'The bird eats the berry.' },
    ...ids('resolved')
  });
  assert.equal(result.status, 'accepted');
  assert.equal(result.event.action.actorId, 'bird');
  assert.equal(result.world.entities.berry.attributes.quantity, 0);
});

test('hypothetical statement requires explicit commitment or possibility recording', () => {
  const world = seededBlueberryWorld(1);
  const proposal = proposeLocalEvent(world, { text: 'Suppose the bird ate the last blueberry.', ...ids('hypo') });
  assert.equal(proposal.status, 'needs_clarification');
  assert.match(proposal.clarification.code, /noncommitted/);
  const possibility = processLocalTurn(world, {
    text: 'Suppose the bird ate the last blueberry.',
    resolution: { kind: 'record-proposition', epistemicStatus: 'hypothetical' },
    ...ids('hypo-record')
  });
  assert.equal(possibility.status, 'accepted');
  assert.equal(possibility.world.entities.blueberry.attributes.quantity, 1);
  assert.equal(possibility.event.committed, false);
  assert.equal(possibility.event.branchTarget, 'possibility');
});

test('negation stores non-consumption without depleting the resource', () => {
  const world = seededBlueberryWorld(1);
  const result = accept(world, 'The bird does not eat the blueberry.');
  assert.equal(result.event.action.operation, 'not-consume');
  assert.equal(result.world.entities.blueberry.attributes.quantity, 1);
  assert.equal(result.world.entities.blueberry.attributes.present, true);
});

test('explicit quantity changes the exact stored amount', () => {
  const world = seededBlueberryWorld(5);
  const result = accept(world, 'The bird eats three blueberries.');
  assert.equal(result.event.action.quantity, 3);
  assert.equal(result.world.entities.blueberry.attributes.quantity, 2);
  assert.equal(result.world.entities.blueberry.attributes.present, true);
});

test('insufficient quantity is clarified rather than fabricated', () => {
  const world = seededBlueberryWorld(2);
  const result = proposeLocalEvent(world, { text: 'The bird eats three blueberries.', ...ids('insufficient') });
  assert.equal(result.status, 'needs_clarification');
  assert.equal(result.clarification.code, 'insufficient-resource');
  assert.equal(world.entities.blueberry.attributes.quantity, 2);
});

test('ownership transfer changes relation without deleting the resource', () => {
  const world = createWorld({
    seedEntities: {
      bird: { id: 'bird', type: 'actor', aliases: ['bird'], attributes: { present: true, locationId: null, hunger: 0, lastAction: null } },
      fox: { id: 'fox', type: 'actor', aliases: ['fox'], attributes: { present: true, locationId: null, hunger: 0, lastAction: null } },
      blueberry: { id: 'blueberry', type: 'resource', aliases: ['blueberry'], attributes: { present: true, quantity: 1, ownerId: 'bird', locationId: null, condition: 'fresh' } }
    }
  });
  const result = accept(world, 'The bird gives the blueberry to the fox.');
  assert.equal(result.event.action.operation, 'transfer');
  assert.equal(result.world.entities.blueberry.attributes.ownerId, 'fox');
  assert.equal(result.world.entities.blueberry.attributes.quantity, 1);
});

test('unknown language is not silently converted into world truth', () => {
  const world = createWorld();
  const result = proposeLocalEvent(world, { text: 'Moonlight folds the river into a blue question.', ...ids('unknown') });
  assert.equal(result.status, 'needs_clarification');
  assert.equal(result.clarification.code, 'unsupported-action');
  assert.equal(world.events.length, 0);
});

test('explicit poetic assertion is stored with epistemic type but no material mutation', () => {
  const world = createWorld();
  const result = processLocalTurn(world, {
    text: 'Moonlight folds the river into a blue question.',
    resolution: { kind: 'record-proposition', epistemicStatus: 'asserted' },
    ...ids('assertion')
  });
  assert.equal(result.status, 'accepted');
  assert.equal(result.event.action.operation, 'record-proposition');
  assert.equal(Object.values(result.world.entities).filter(entity => entity.type === 'proposition').length, 1);
  assert.equal(result.event.changes.filter(change => !change.entityId.startsWith('stack:')).length, 0);
});

test('ontology rejects properties that do not belong to an entity type', () => {
  const world = seededBlueberryWorld(1);
  const bad = {
    id: 'bad-event', turnId: 'bad-turn', idempotencyKey: 'bad-request', sourceText: 'bad', interpretedText: 'bad', mode: 'Stone',
    speechAct: 'assertion', epistemicStatus: 'asserted', committed: true, action: { operation: 'set-state', polarity: 'positive' },
    entityUpserts: [], references: ['bird'], causedBy: [], branchTarget: null, inferredPreconditions: [], createdAt: '2026-01-01T00:00:00.000Z',
    changes: [{ entityId: 'bird', path: 'quantity', before: null, after: 9, persistence: 'permanent', reason: 'invalid' }]
  };
  const validation = validateEvent(world, bad);
  assert.equal(validation.ok, false);
  assert.ok(validation.errors.some(error => /not allowed on actor/.test(error)));
});

test('counterfactual twins differ only after the consuming event', () => {
  const seedA = seededBlueberryWorld(1);
  const seedB = seededBlueberryWorld(1);
  const worldA = accept(seedA, 'The bird eats the last blueberry.').world;
  const worldB = accept(seedB, 'The bird does not eat the blueberry.').world;
  assert.equal(worldA.entities.blueberry.attributes.quantity, 0);
  assert.equal(worldB.entities.blueberry.attributes.quantity, 1);
  const queryA = accept(worldA, 'What food remains?');
  const queryB = accept(worldB, 'What food remains?');
  assert.notEqual(queryA.render.therefore.text, queryB.render.therefore.text);
});

test('renderer cannot cite an irrelevant event merely because its id exists', () => {
  let world = seededBlueberryWorld(1);
  const berry = accept(world, 'The bird eats the last blueberry.');
  world = berry.world;
  const bell = accept(world, 'The bell is bronze.');
  world = bell.world;
  const queryProposal = proposeLocalEvent(world, { text: 'What food remains?', ...ids('render') });
  assert.equal(queryProposal.status, 'accepted');
  const relevant = selectRelevantEvents(world, queryProposal.event);
  const event = finalizeEvent(world, queryProposal.event, relevant);
  const next = applyEvent(world, event);
  const invalid = validateRenderedTurn(next, event, relevant, {
    consequences: [
      { text: 'One', usedEventIds: [event.id, bell.event.id] },
      { text: 'Two', usedEventIds: [event.id] },
      { text: 'Three', usedEventIds: [event.id] }
    ],
    therefore: { text: 'Therefore, test.', usedEventIds: [event.id] },
    branch: { text: 'Memory.', target: 'memory', usedEventIds: [event.id] }
  });
  assert.equal(invalid.ok, false);
  assert.ok(invalid.errors.some(error => /invalid causal events/.test(error)));
});

test('branch activation is an explicit state change and survives replay', () => {
  let world = seededBlueberryWorld(1);
  const consumed = accept(world, 'The bird eats the last blueberry.');
  world = consumed.world;
  const query = accept(world, 'What food remains?');
  assert.equal(query.event.branchTarget, 'memory');
  assert.equal(query.world.entities['stack:memory'].attributes.activationCount, 1);
  assert.ok(query.event.changes.some(change => change.entityId === 'stack:memory' && change.path === 'activationCount'));
  const hydrated = hydrateWorld(query.world);
  assert.deepEqual(hydrated.entities, query.world.entities);
});

test('duplicate idempotency key cannot manufacture a second event', () => {
  const world = seededBlueberryWorld(2);
  const common = { text: 'The bird eats one blueberry.', mode: 'Stone', turnId: 'turn-a', eventId: 'event-a', idempotencyKey: 'same-request', sourceStratumId: 's-a', createdAt: '2026-01-01T00:00:00.000Z' };
  const proposal = proposeLocalEvent(world, common);
  assert.equal(proposal.status, 'accepted');
  const event = finalizeEvent(world, proposal.event, []);
  const once = applyEvent(world, event);
  const duplicate = { ...event, id: 'event-b', turnId: 'turn-b' };
  assert.throws(() => applyEvent(once, duplicate), /Duplicate idempotency key/);
});

test('ripple proof exposes exact before and after evidence', () => {
  const world = seededBlueberryWorld(1);
  const result = accept(world, 'The bird eats the last blueberry.');
  const proof = buildRippleProof(result.world, [result.event.id]);
  assert.equal(proof.length, 1);
  assert.ok(proof[0].changes.some(change => change.entityId === 'blueberry' && change.path === 'quantity' && change.before === 1 && change.after === 0));
});

test('world digest is a typed explicit context, not a prose summary', () => {
  const world = seededBlueberryWorld(1);
  const result = accept(world, 'The bird eats the last blueberry.');
  const digest = worldDigest(result.world);
  assert.equal(digest.ontologyVersion, 2);
  assert.ok(digest.entities.some(entity => entity.id === 'blueberry' && entity.attributes.quantity === 0));
  assert.ok(digest.recentEvents.some(event => event.id === result.event.id));
});
