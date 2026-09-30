# CLAUDE.md: Multi-Agent Ski Vacation Planner

This file is the persistent context and engineering rulebook for any coding agent working on this project. Read it before any change, together with:

- [framing.md](framing.md): problem statement, Definition of Done, out of scope;
- [lessons-learned.md](lessons-learned.md): why the architecture is the way it is, and what went wrong before.

## 1. Project Role & Goal

- You are an expert AI orchestrator building a **Multi-Agent Ski Vacation Planner**. The system turns a structured user request (budget, group, must-haves, preferences, timeframe) into a verified ski vacation proposal, or a deterministic explanation of why none fits.
- Your primary focus is **trust and verification**, not generating code quickly. A slower change that is proven correct beats a fast change that is only plausible.
- Do not build anything outside the scope in [framing.md](framing.md). If the scope must change, update framing.md **first**, in its own commit.

## 2. Strict Engineering Directives

### Zero Hallucination Policy
- Never invent prices, URLs, or ski resort statistics (piste km, snow weeks, ski-in/ski-out status, and so on).
- All domain data **must** come from the Ground Truth tools in [src/tools/mocks.js](src/tools/mocks.js). Every record carries `source: 'mock'`.
- If a value cannot be obtained from a tool, report it as missing or throw. Never fill the gap with an estimate.
- LLM-written text is never treated as a fact. It is shown to users only as labelled reasoning, and it may not mention prices.

### Deterministic Math
- All money arithmetic runs in [src/finance.js](src/finance.js), in integer cents. The LLM never computes, sees or guesses a price or a sum, and neither does the browser.
- LLM agents may reason about which option to choose. They may not decide whether it is affordable or allowed; code decides.

### Test-Driven Agentic Workflow
- Write the verification gate (test) **before** relying on any agent output, and commit it red first when practical.
- A change is not done until `npm test` passes. Never weaken, skip or delete a failing test to make a change pass; fix the cause or stop and ask.
- Check that a new test can fail: disable the behaviour once and confirm the test goes red.
- UI changes are verified in a real browser (headless screenshots at desktop and 390 px width, light and dark), not by reading the CSS.

### Atomic Commits
- One logical change per commit, committed as soon as it is complete. Use Conventional Commits (`feat:`, `fix:`, `test:`, `docs:`, `refactor:`, `style:`, `chore:`).
- Do not bundle unrelated features. Put the reason and the gate result (for example "tests: 124/124 pass") in the commit body.
- When a failure drives a change (a live-run error, a UI bug), add an entry to [lessons-learned.md](lessons-learned.md) in the same commit.

## 3. Architecture

Only the Destination Agent is an LLM. Every other "agent" is a deterministic tool call or code, so that no financial value can be hallucinated.

```
POST /api/plan (server.js) → parsePlanRequest: input + seasonal gate (400 before any LLM call)
  └─ runPipeline (src/orchestrator.js)
       Outer loop: Business Negotiation, up to MAX_NEGOTIATION_ROUNDS (one per resort)
         1. Destination Agent (LLM)
              Inner loop: API Resilience, 1 attempt + MAX_AGENT_RETRIES, same round
         2. Tools: getResort, getFlight, getAccommodations, getSkiPass, getGearRental
         3. Gates: validateConstraints → calculateTotal ≤ maxBudget
         pass → proposal | fail → record the bottleneck, next round
       All rounds failed → deterministic fallback (bottlenecks + compromises)
```

### Agent charge sheets

| Agent | Kind | Location | Input | Output | Gates on its output |
|---|---|---|---|---|---|
| **Destination** | LLM (OpenRouter) | `DESTINATION_SYSTEM_PROMPT`, `destinationAgent` in [src/orchestrator.js](src/orchestrator.js) | User preferences (no budget), resorts not yet tried, previous failures | `selected_resort_id`, `recommendedDates`, `reasoning { resortReasoning, dateReasoning }` | ID in offered list; week in resort's `optimalSnowWeeks`; week in requested month when the resort has one; both reasoning fields present; no price in reasoning; month shift acknowledged |
| **Flight** | Tool | `getFlight` in [src/tools/mocks.js](src/tools/mocks.js) | Resort ID | Airport, price per person, search URL | Unknown resort throws; traceability test |
| **Accommodation** | Tool + code | `getAccommodations`; hotel choice in `evaluateResort` | Resort ID, accommodation level | Hotel closest to the level that fits the budget | `validateConstraints` per hotel |
| **Gear & Pass** | Tool | `getSkiPass`, `getGearRental` | Resort ID | Price per person, search URL | Traceability test |
| **Budget & Negotiation** | Code | `evaluateResort`, `runPipeline` | Tool records, group size, rooms, budget | Accepted package, or a failure with the exact overrun | `calculateTotal` in cents; Gate A |
| **Fallback / Summary** | Code | `buildFallback`, the success object in `runPipeline` | Recorded failures, or the accepted package | Fallback message + compromises, or the proposal | Fallback tests: no total in a fallback |

### Error classes (do not merge them)

| Situation | Handling |
|---|---|
| Bad model output (empty, not JSON, fails a gate) | Retried within the round; after 3 attempts the round is consumed and recorded |
| Transient API error (429, 5xx, network) | Retried within the round; after 3 attempts **fatal** (an outage is not a budget problem) |
| Permanent API error (missing key, 401, 404) | Fatal immediately |
| Invalid or off-season input | HTTP 400 before any LLM call |

## 4. Commands

```bash
npm test          # all verification gates; no API key or network needed
npm start         # web UI at http://localhost:3000
node run.js       # CLI: one sample request, prints JSON
```

Configuration lives in `.env` (git-ignored): `OPENROUTER_API_KEY`, optional `OPENROUTER_MODEL`, optional `PORT`. OpenRouter retires free models often. On a 404, check the live model list for a free model that supports `response_format` before changing the default.

## 5. File Map

| Path | Purpose |
|---|---|
| `src/finance.js` | `calculateTotal`, `validateConstraints`, cents handling |
| `src/orchestrator.js` | OpenRouter client, Destination Agent prompt and gates, seasonal gate, dual-loop pipeline, fallback |
| `src/tools/mocks.js` | Ground Truth: 6 resorts, flights, hotels, passes, gear, snow weeks, search links |
| `server.js` | Express server, request validation, `POST /api/plan` |
| `public/` | Web UI; displays server values only, no arithmetic, model text via `textContent` |
| `run.js` | CLI entry point |
| `tests/` | `verification`, `orchestrator`, `mocks` and `server` test suites |
