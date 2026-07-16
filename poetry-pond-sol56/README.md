# Poetry Pond with GPT-5.6 Sol context

This version keeps the real 3D water, physical stack, live reflection, and ripple shader. The mountain is the visible conversation record. OpenAI manages semantic continuity through the Responses API while the browser keeps the exact visible strata.

## Start on macOS or Linux

```bash
cd poetry-pond-sol56
export OPENAI_API_KEY="your-project-key"
npm start
```

Open `http://127.0.0.1:8787`.

To choose another model:

```bash
export OPENAI_MODEL="gpt-5.6-sol"
```

## Start on Windows PowerShell

```powershell
cd poetry-pond-sol56
$env:OPENAI_API_KEY="your-project-key"
npm start
```

Open `http://127.0.0.1:8787`.

## Context behavior

- The first request starts with no previous response ID.
- Every completed OpenAI turn returns a response ID.
- The next turn sends that ID as `previous_response_id`.
- The server repeats the pond instructions every turn.
- The visible context summary and latest strata are also sent so local fallback turns remain part of the next OpenAI response.
- Undo rewinds the visual stack and restores the latest remaining OpenAI response ID.
- Start a new pond clears both visual history and the response-chain pointer.
- Stop keeps visible partial strata but does not advance to an unseen OpenAI response.

## API-key safety

The key is read only by `server.mjs` from `OPENAI_API_KEY`. It is never placed in the HTML, browser storage, exported mountain JSON, or network requests from the browser.

## Offline behavior

Opening `index.html` directly or running the server without a key leaves the complete local generator active. The visual and interaction engine still works.
