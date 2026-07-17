# Poetry Pond

A text that remembers what the reader did.

Every build in this repository is one attempt at the same contract, from the
"Coaxing the Ripples" deck (Marttila · Hartsoe · Bolter — the rubric lives here
as `coaxing_ripples_editable_highlighter_clean.pptx`):

```
action → stored change → later output shifts → reader can detect it
```

Miss one link and the ripple fails. If the berry returns untouched, the system forgot.

## Start here

Open **[index.html](index.html)** — the shared index of every build, with earned
status badges (verified / graded / ungraded) and API-capability badges.

Serve the static builds from the repo root:

```bash
python3 -m http.server 8931
# → http://localhost:8931/index.html
```

## The typed causal-world line

Every build works **straight from the browser**: open it from any static host
(this repo on GitHub Pages, or `python3 -m http.server`), paste an OpenAI key
into its settings panel, and the page calls OpenAI directly — the key stays in
that browser's localStorage. Without a key, everything runs on the fully local
typed engine.

Each also has an optional **full mode** on Node 20+ (no dependencies): run the
server and the same settings panel hands the key to the local server instead
(memory + `.runtime-config.json`, git-ignored), never returned to the browser.
V3's Luna/Sol routing, token budgets, and preflight live server-side; its
browser mode runs the Luna tier.

| Build | Port | Verify | Run |
|---|---|---|---|
| [poetry-pond-ripple-v3](poetry-pond-ripple-v3/) — dual-model (Luna/Sol) routing | 8789 | 27 tests · 3 evals · 7 routing fixtures | `cd poetry-pond-ripple-v3 && npm run verify && npm start` |
| [poetry-pond-ripple-v2](poetry-pond-ripple-v2/) — typed causal foundation | 8787 | 18 tests · 3 evals | `cd poetry-pond-ripple-v2 && npm run verify && npm start` |
| [poetry-pond-sol56](poetry-pond-sol56/) — server-backed predecessor | 8788 | — | `cd poetry-pond-sol56 && npm start` |

## Everything else

Single-file HTML builds: the graded RCC 3D field engines (in-app API key,
stored in the page's own settings), the FÚTBOLMAS Spain–Argentina consequence
line (fully local), the Thunder Rigs matchday builds (in-app AI config), and
the lineage of therefore-engines and early ponds. See the index for the map.

The blueberry test, everywhere: *the bird eats the last blueberry; the bird
returns tomorrow; if the berry returns untouched, the system forgot.*
