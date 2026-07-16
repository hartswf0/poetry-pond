import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { createWorld, processLocalTurn, getPath } from './world-engine.mjs';

const scenarios = JSON.parse(await readFile(new URL('./evals/ripple-scenarios.json', import.meta.url), 'utf8'));
const results = [];
let counter = 0;
const meta = id => ({ turnId: `${id}-turn-${++counter}`, eventId: `${id}-event-${counter}`, idempotencyKey: `${id}-request-${counter}`, sourceStratumId: `${id}-stratum-${counter}`, createdAt: `2026-02-${String((counter % 28) + 1).padStart(2, '0')}T00:00:00.000Z` });

function inspectState(world, dotted) {
  const [entityId, ...path] = dotted.split('.');
  return getPath(world.entities[entityId]?.attributes, path.join('.'));
}

function checkStep(world, scenario, step, result) {
  const failures = [];
  if (result.status !== step.expect.status) failures.push(`expected status ${step.expect.status}, got ${result.status}`);
  if (step.expect.clarificationCode && result.clarification?.code !== step.expect.clarificationCode) failures.push(`expected clarification ${step.expect.clarificationCode}`);
  for (const [path, expected] of Object.entries(step.expect.state || {})) {
    const actual = inspectState(result.world || world, path);
    if (JSON.stringify(actual) !== JSON.stringify(expected)) failures.push(`${path}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
  if (step.expect.relevantSourceText && !result.relevantEvents?.some(event => event.sourceText === step.expect.relevantSourceText)) failures.push('required earlier event was not selected');
  if (step.expect.renderIncludes && !result.render?.consequences?.some(item => item.text.includes(step.expect.renderIncludes))) failures.push(`render did not include ${step.expect.renderIncludes}`);
  return failures;
}

for (const scenario of scenarios) {
  if (scenario.twins) {
    let worldA = createWorld({ seedEntities: scenario.seed });
    let worldB = createWorld({ seedEntities: scenario.seed });
    let lastA = null;
    let lastB = null;
    for (const text of scenario.worldA) { lastA = processLocalTurn(worldA, { text, ...meta(`${scenario.id}-a`) }); if (lastA.status === 'accepted') worldA = lastA.world; }
    for (const text of scenario.worldB) { lastB = processLocalTurn(worldB, { text, ...meta(`${scenario.id}-b`) }); if (lastB.status === 'accepted') worldB = lastB.world; }
    const stateA = inspectState(worldA, scenario.expectDifferentStatePath);
    const stateB = inspectState(worldB, scenario.expectDifferentStatePath);
    const failures = [];
    if (JSON.stringify(stateA) === JSON.stringify(stateB)) failures.push('counterfactual states did not diverge');
    if (scenario.expectDifferentTherefore && lastA?.render?.therefore?.text === lastB?.render?.therefore?.text) failures.push('counterfactual outputs did not diverge');
    results.push({ id: scenario.id, passed: failures.length === 0, failures, observed: { stateA, stateB, thereforeA: lastA?.render?.therefore?.text, thereforeB: lastB?.render?.therefore?.text } });
    continue;
  }
  let world = createWorld({ seedEntities: scenario.seed || {} });
  const steps = [];
  for (const step of scenario.steps) {
    const result = processLocalTurn(world, { text: step.text, resolution: step.resolution, ...meta(scenario.id) });
    const failures = checkStep(world, scenario, step, result);
    steps.push({ text: step.text, status: result.status, failures });
    if (result.status === 'accepted') world = result.world;
  }
  const failures = steps.flatMap(step => step.failures);
  results.push({ id: scenario.id, passed: failures.length === 0, failures, steps });
}

const report = {
  generatedAt: new Date().toISOString(),
  engine: 'poetry-pond-ripple-v2',
  passed: results.filter(result => result.passed).length,
  total: results.length,
  results
};
await mkdir(new URL('./evals/', import.meta.url), { recursive: true });
await writeFile(new URL('./evals/latest-report.json', import.meta.url), JSON.stringify(report, null, 2));
console.log(JSON.stringify(report, null, 2));
if (report.passed !== report.total) process.exitCode = 1;
