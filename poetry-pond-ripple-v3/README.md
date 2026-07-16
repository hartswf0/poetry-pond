# Poetry Pond — Ripple V3

Ripple V3 fully integrates the real OpenAI Responses API with both GPT-5.6 Sol and GPT-5.6 Luna while preserving the causal foundation from V2.

The governing contract remains:

```text
participant action
→ typed event proposal
→ ontology and before-value validation
→ accepted world change
→ bounded causal retrieval
→ literary rendering
→ inspectable ripple proof
```

OpenAI never owns world truth. The local event ledger, entity state, validation, replay Undo, branch state, and ripple magnitude remain authoritative.

## Dual-model architecture

### Local engine first

The deterministic parser handles supported actions without spending API tokens. Pronouns, hypotheticals, unsupported actions, and impossible quantities remain visible as uncertainty rather than silently entering the ledger.

### GPT-5.6 Luna

Luna handles high-volume, cost-sensitive work:

- routine unsupported-language event proposals;
- exactly three concise consequence strata;
- the therefore stratum;
- optional branch wording.

Luna receives only the accepted event, touched entity state, and a bounded set of verified prior events. It does not receive the full transcript.

### GPT-5.6 Sol

Sol is reserved for work where deeper reasoning can change correctness:

- difficult event interpretation;
- escalation after a low-confidence or rejected Luna proposal;
- multi-hop causal review over deterministic candidate events.

Sol may only choose among supplied eligible event IDs. It cannot add causal sources or mutate state.

### Routing policies

The interface exposes three policies:

- Efficient — local first, Luna routine, Sol only when complexity requires it.
- Deep — prefer Sol for unsupported language and complex causal review; Luna still renders concise strata.
- Luna — use Luna only, with local validation and local fallback.

The default is Efficient.

## Token engineering

### No growing hidden response chain

Every API call is stateless and uses `store: false`. The application sends a bounded, explicit context pack built from the authoritative world. Undo therefore never has to rewind an opaque model conversation.

### Context packs

The planner receives only:

- the current line and mask;
- the compact ontology;
- mentioned and recently touched entities;
- a small number of recent typed events.

The Sol causal reviewer receives only:

- the current accepted event;
- up to twelve deterministic candidate events;
- verified causal edges among those candidates.

The Luna writer receives only:

- the accepted event;
- up to six verified relevant events;
- touched resulting entity state;
- the exact allowed event IDs.

Context arrays are progressively trimmed before a request is allowed to cross its token ceiling.

### Real token preflight

For Sol requests and calls approaching their input budget, the server calls:

```text
POST /v1/responses/input_tokens
```

This produces the exact input-token count before the generation request. Set `OPENAI_TOKEN_PREFLIGHT=always` to count every call or `never` to use the conservative local estimator only.

### Prompt caching

Every request uses:

- a stable `prompt_cache_key` for its route;
- static developer instructions before dynamic context;
- `prompt_cache_options` with a 30-minute minimum TTL.

The usage log records cached tokens and cache-write tokens so cache behavior can be evaluated rather than assumed.

### Hard budgets

Defaults:

```text
Luna planner input: 3,200 tokens
Sol planner input: 6,200 tokens
Sol review input: 5,200 tokens
Luna writer input: 2,800 tokens
Maximum API calls per turn: 3
Maximum Sol calls per turn: 1
Maximum projected API cost per turn: $0.075
```

A request that cannot fit is skipped. The deterministic local engine continues instead.

### Usage accounting

Each successful API call records:

- model and route;
- exact or estimated preflight tokens;
- input and output tokens;
- cached-input tokens;
- cache-write tokens;
- reasoning tokens;
- latency;
- response ID;
- estimated cost.

The drawer shows aggregate calls, input/output tokens, cache-hit percentage, and estimated cost. Export includes the complete routing and usage ledger.

## Install and run

Requires Node.js 20 or newer.

```bash
cd poetry-pond-ripple-v3
cp .env.example .env
```

Put your project API key into `.env`:

```text
OPENAI_API_KEY=your-project-api-key
```

Then run:

```bash
npm run verify
npm start
```

Open:

```text
http://127.0.0.1:8787
```

The server automatically loads `.env`. The API key never enters the browser.

## Useful tests

```bash
npm test
npm run evals
npm run verify
```

The suite now includes the V2 causal-engine tests plus routing, cost, cache-usage, token-budget, context-packing, ambiguity, and Sol-reservation tests.

## OpenAI request paths

All generation uses:

```text
POST https://api.openai.com/v1/responses
```

Token preflight uses:

```text
POST https://api.openai.com/v1/responses/input_tokens
```

Model defaults:

```text
GPT-5.6 Sol:  gpt-5.6-sol
GPT-5.6 Luna: gpt-5.6-luna
```

## What remains local and authoritative

OpenAI cannot:

- create accepted events without validation;
- overwrite entity state;
- bypass before-value checks;
- decide Undo;
- choose arbitrary causal IDs;
- set water-ripple strength;
- mutate satellite stacks outside the ledger;
- convert ambiguity into fact.

The model produces proposals and language. The engine manufactures consequence.

## Production limits

This remains a research prototype. Production deployment still needs:

- authenticated users and sessions;
- durable server-side storage;
- durable idempotency keys;
- per-user budgets and quotas;
- centralized telemetry;
- project-level spend alerts;
- concurrency locks;
- deployment secrets management;
- browser and device testing for the WebGL surface.
