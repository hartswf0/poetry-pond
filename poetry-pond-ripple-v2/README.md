# Poetry Pond — Ripple V2

Ripple V2 rebuilds the bottom of the system before extending the spectacle.

The governing contract is:

```
participant action
→ typed event proposal
→ ontology and state validation
→ accepted world change
→ deterministic relevance selection
→ later poetic rendering
→ inspectable causal proof
```

The mountain, water, distant stacks, Undo, and later prose are all derived from the same accepted event ledger.

## What changed from the earlier builds

### No prose summary as world truth

The canonical context is an explicit world containing typed entities, accepted events, before-and-after changes, causal edges, and semantic-stack state. A generated summary cannot overwrite it.

### No silently accepted ambiguity

Pronouns, hypotheticals, quotations, unsupported formulations, and insufficient resources enter a clarification state. They do not mutate the world until the participant chooses an interpretation.

Examples:

- `It eats the berry.` asks which actor `it` identifies.
- `Suppose the bird ate the berry.` asks whether to commit the event, preserve it as a possibility, or cancel it.
- `The bird eats three blueberries.` is rejected when fewer than three exist.
- Unknown poetic language may be recorded as a proposition, but is not silently converted into a material event.

### OpenAI cannot declare truth

The optional planner may propose a typed event when the deterministic parser cannot interpret the line. The proposal must still pass the same ontology, before-value, quantity, identity, and persistence checks as a local proposal.

The optional writer receives only an already accepted event and deterministically selected history. It may write visible strata, but every citation is checked. It cannot change entities, fabricate causal sources, set ripple strength, or manage Undo.

### Real causal branches

A branch changes a destination semantic stack in the world ledger. The distant mountain reads that state and shows the source event. It is not merely an arc or a water effect.

### State-derived ripples

Ripple force is calculated from accepted changes, persistence, affected entities, reversals, and causal return. The language model does not choose amplitudes.

### Replay Undo

Undo removes the last accepted turn and reconstructs the world by replaying the remaining ledger from the seeded initial world. It restores exact prior values rather than merely removing visible slabs.

## Run

Requires Node.js 20 or newer.

```bash
cd poetry-pond-ripple-v2
npm run verify
npm start
```

Open:

```text
http://127.0.0.1:8787
```

OpenAI is optional, and there are two ways to provide a key:

1. **From the settings panel** (no environment setup needed): open Settings → "OpenAI context engine" → paste the key → Save. The browser sends it once over loopback to your local server, which holds it in memory and persists it to `.runtime-config.json` (mode 0600). It is never echoed back to the browser; the status line shows only the last four characters. Clear removes it.
2. **From the environment** (takes precedence at boot):

```bash
export OPENAI_API_KEY="your-project-key"
export OPENAI_PLANNER_MODEL="gpt-5.6-sol"
export OPENAI_WRITER_MODEL="gpt-5.6-sol"
npm start
```

The key stays on the server either way. Requests use `store: false`. The browser sends explicit typed world context rather than relying on a hidden response chain. Without any key, everything runs on the typed local engine.

## Context inspector and logging

The ☷ button (or Settings → Context inspector) opens a three-tab inspector:

- **Turn log** — every turn's outcome: proposer (local or OpenAI), writer, event id, exact before→after changes, relevant event ids, token usage, clarifications, rejections, and stops.
- **World** — live typed entity state and semantic-stack activations.
- **Events** — the validated event ledger with described changes, causal sources, and branch targets.

Copy the current view as JSON or download the full context log. The server also keeps its own per-turn log (last 200 in memory at `GET /api/context-log`, appended durably to `logs/context-log.jsonl`); the API key is never logged.

## Useful first actions

The material world begins at zero. Only the five semantic stacks and the world clock exist. A tightly phrased first action may create bounded inferred preconditions—for example, “the last blueberry” establishes one available blueberry immediately before consumption.

Try:

```text
The bird eats the last blueberry.
The bird creates three blueberries.
The bird eats two blueberries.
The bird gives the remaining blueberry to the fox.
The gate blocks the bird.
The bird returns tomorrow. What food remains?
It eats the berry.
Suppose the fox ate the berry.
```

Select any consequence stratum to inspect its Ripple Proof: source event, exact stored changes, and the earlier event that made the later output shift.

## Verification

```bash
npm test
npm run evals
npm run verify
```

The current suite includes 18 engine tests and three independent fixture scenarios covering:

- persistent depletion across unrelated turns;
- exact replay Undo from a seeded initial state;
- pronoun and hypothetical ambiguity;
- negation and quantities;
- insufficient-resource rejection;
- ownership transfer;
- ontology path validation;
- controlled counterfactual twins;
- irrelevant-citation rejection;
- branch state and replay;
- request idempotency;
- inspectable before-and-after evidence.

The latest fixture report is written to `evals/latest-report.json`.

## Project structure

- `world-engine.mjs` — ontology, proposal boundary, validation, ledger, replay, relevance, ripple proof, local rendering.
- `server.mjs` — static server plus optional OpenAI planner and writer.
- `app.mjs` — 3D surface, clarification ritual, mountain construction, water, selection, Undo, and local fallback.
- `index.html` — application shell and restrained interface.
- `tests/world-engine.test.mjs` — deterministic engine tests.
- `evals/ripple-scenarios.json` — independent scenario fixtures.
- `run-evals.mjs` — fixture runner and report writer.

## Known limits

This is a stronger Level 0–1 foundation, not a general natural-language simulator.

- The local parser deliberately supports a bounded action grammar.
- Complex language requires clarification or the optional planner.
- The ontology is extensible but currently small.
- Long multi-hop ecological propagation and scheduled future events are not implemented yet.
- Authentication, a persistent database, durable multi-user sessions, and production billing controls remain outside this prototype.
- The browser needs a normal WebGL-capable environment for the full water rendering.

The system now prefers uncertainty over invented causality. That is intentional.
