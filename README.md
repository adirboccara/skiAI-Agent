# Multi-Agent Ski Vacation Planner

A multi-agent system that turns a structured ski-trip request (budget, group size, ski-in/ski-out, vibe, nightlife, ski area size) into a vacation package that is **verified to fit the budget and the hard constraints**. If no such package exists, it returns a deterministic explanation of the bottleneck instead of an invented one.

Built for the *Agentic Software Engineering* course. The scope and the Definition of Done are defined in [framing.md](framing.md); the engineering rules the project follows are in [CLAUDE.md](CLAUDE.md).

## Core Philosophy: Verification over Trust

A single LLM prompt fails at trip planning because it produces plausible-looking prices and links that come from no real source, and it cannot reliably notice when the budget and the user's demands conflict. This project therefore splits the work by what each part can be trusted with:

| Responsibility | Handled by | Why |
|---|---|---|
| Choosing a resort that fits the vibe, nightlife, crowd and terrain preferences | **LLM** (Destination Agent) | Qualitative judgment is what LLMs are good at |
| Recommending the week to go | **LLM** picks, **code** verifies | The pick must be one of the resort's `optimalSnowWeeks` and, where possible, in the month the user asked for |
| Rejecting off-season timeframes (May to November, "summer", "autumn", "fall") | **Code**, before any LLM call | Our destinations only have snow from December to April; there is nothing for the LLM to decide |
| Prices, links and resort facts | **Tools** ([src/tools/mocks.js](src/tools/mocks.js)) | The Ground Truth source; every record carries `source: 'mock'` |
| Hard constraints (ski-in/ski-out) | **Code** (`validateConstraints` in [src/finance.js](src/finance.js)) | Must be exact; missing data counts as a violation |
| Budget arithmetic | **Code** (`calculateTotal` in [src/finance.js](src/finance.js)) | Computed in integer cents, so there are no floating-point errors |
| Hotel choice within a resort | **Code** (closest to the requested level that fits the budget) | Depends on prices, so it must not be guessed |
| The fallback message when nothing fits | **Code** | Names the real bottleneck; never a hallucinated package |

The LLM never sees the budget or any price and never does arithmetic. It only picks a resort ID from the list it is offered and one of that resort's snow weeks; any other ID or week is rejected and retried. It must also explain its choice as structured reasoning, `resortReasoning` (why this resort fits the vibe and crowd preferences) and `dateReasoning` (why this week), which is returned as `destinationReasoning` and shown in the UI under "Why this trip". Reasoning that is missing or mentions a price is rejected and retried. The text is shown for transparency but never used as a fact.

The Flight, Accommodation, Gear & Pass and Budget & Negotiation agents are deliberately **deterministic tool calls and code, not LLM prompts**, so that no financial value can be hallucinated.

> **Note on data:** all prices, resort statistics, snow weeks and hotels are fixed, illustrative mock data for six resorts (La Molina, Gudauri, Val Thorens, Bansko, Mayrhofen, Ischgl). They are not real offers. The booking links are real vendor search pages for each resort (Google Flights, Booking.com, and Google searches for ski passes and gear rental). They open and work, but they show live prices, which will differ from the mock prices.

## The Dual-Loop Architecture

```
runPipeline(userRequest)
│
├── Outer loop: Business Negotiation (up to 6 rounds, one per resort)
│   │
│   ├── 1. Destination Agent (LLM) picks a resort
│   │      └── Inner loop: API Resilience (1 attempt + up to 2 retries, same round)
│   │
│   ├── 2. Tools fetch resort data, flight, hotels, ski pass and gear prices
│   │
│   ├── 3. Verification Gates
│   │      ├── validateConstraints → fail: record the bottleneck, next round
│   │      └── calculateTotal ≤ maxBudget → fail: record the exact overrun, next round
│   │
│   └── Both gates pass → return the proposal
│
└── All rounds failed → deterministic fallback: the bottlenecks + what to compromise on
```

**Outer loop: Business Negotiation.** Each round, the Destination Agent chooses from the resorts that have not failed yet and receives the list of earlier failures, for example *"Val Thorens: cheapest package meeting the hard constraints costs €4060, but the budget is €2200 (over by €1860)"*. A round is used up only by a real business result: a constraint or budget failure.

**Inner loop: API Resilience.** An empty reply, malformed JSON, an unknown resort ID, an HTTP 429 or 5xx response, or a network error is retried within the same round, with a backoff of 1 s and then 2 s. These errors never use up a negotiation round.
- If the model's output is still unusable after 3 attempts, the round is used up and recorded.
- If the API is still failing after 3 attempts, the run stops with a fatal error. An outage is not a budget problem, so the pipeline does not send a misleading "compromise" message.
- Non-transient errors (a missing key, 401, 404) stop the run immediately.

Every retry is logged in the result's `agentRetries` field, separately from the negotiation failures.

## Getting Started

### Prerequisites

- **Node.js 21.7 or later** (developed on Node 24). The project uses the native `fetch`, `node:test` and `process.loadEnvFile()`.
- An [OpenRouter](https://openrouter.ai) API key. It is needed only for the live run, not for the tests.

### 1. Install

```bash
npm install
```

The only dependency is [Express](https://expressjs.com), which serves the web UI. The core pipeline, the CLI and the test suite use only Node built-ins.

### 2. Configure

Copy the template and add your OpenRouter API key:

```bash
cp .env.example .env        # macOS / Linux / Git Bash
copy .env.example .env      # Windows cmd / PowerShell
```

```ini
OPENROUTER_API_KEY=your_key_here
# Optional: override the default model (must be a free model that supports response_format)
# OPENROUTER_MODEL=nvidia/nemotron-3-super-120b-a12b:free
```

`.env` is git-ignored. The default model is `nvidia/nemotron-3-super-120b-a12b:free`. OpenRouter retires free models regularly; if the run fails with a 404, set `OPENROUTER_MODEL` to another free model that supports `response_format`.

### 3. Run the Verification Gates

```bash
npm test
```

This runs the suite of **119 deterministic tests**. It needs no API key and no network access: the LLM and the network are replaced by scripted fakes. The suite covers:

- **Budget integrity:** exact totals from unit prices × group size and room count, including cent-precision and floating-point cases.
- **Input validation:** missing, negative, non-numeric and sub-cent prices, and invalid group or room counts, are rejected instead of guessed.
- **Hard constraints:** ski-in/ski-out on both the resort and the hotel; missing data counts as a violation.
- **Traceability:** every price and link in a proposal is checked to equal a Ground Truth tool result, and every resort in the mock data is checked for complete, well-formed records.
- **Date recommendation:** weeks outside the resort's `optimalSnowWeeks`, missing weeks, and weeks in the wrong month are retried, never returned.
- **Seasonal gate:** off-season timeframes are rejected before any LLM call, and in-season ones pass.
- **Structured reasoning:** both reasoning fields are returned; missing, empty or price-mentioning reasoning is retried.
- **Negotiation:** constraint and budget failures, feedback to the next round, and no re-offering of failed resorts.
- **Fallback:** infeasible requests produce the deterministic fallback, never a package.
- **Resilience:** retries within a round, fatal errors for persistent outages, and immediate failure on 401/404.
- **Web API:** request validation (400 before any LLM call), proposal and fallback responses, JSON errors for malformed bodies, and 502 for pipeline failures.

### 4. Run the Web UI

```bash
npm start
```

Then open **http://localhost:3000** (set `PORT` in `.env` to use another port). Enter a budget, the group size and rooms, the must-haves and preferences, and select **Plan my trip**. The page shows:

- **How the agents got here:** each negotiation round, with rejected resorts and the exact reason computed by code.
- **The package**, when one fits: resort, flight, hotel, ski pass and gear with unit prices, quantities and links, and the total, budget and amount left over. All of these values come from the server; the browser computes no prices.
- **The fallback**, when nothing fits: the bottleneck and what to compromise on.
- **A warning above the form** for invalid input, including an off-season timeframe such as "July".

The server ([server.js](server.js)) exposes `POST /api/plan`. It validates the request, passes it to `runPipeline`, and returns the result as JSON. Invalid input gets a 400 response with a `code` (`off_season` or `invalid_request`) and never reaches the LLM.

### 5. Run the CLI (optional)

```bash
node run.js
```

This sends a fixed sample request (€2,200 budget, 2 people, 1 room, ski-in/ski-out required, young/party vibe, February) through the pipeline and prints the result as JSON. With the mock data, **Gudauri at €1,770** is the only package that fits: La Molina and Bansko fail ski-in/ski-out, and Val Thorens, Mayrhofen and Ischgl are over budget. The loop allows one round per resort, so the agent can work through every rejected option; if it first chases the nightlife resorts, it gets blocked on budget and can still pivot to Gudauri.

## Project Structure

```
├── framing.md                  Problem statement, Definition of Done, out of scope
├── CLAUDE.md                   Engineering rules for the agentic workflow
├── server.js                   Express server: web UI + POST /api/plan (npm start)
├── run.js                      CLI entry point (node run.js)
├── public/
│   ├── index.html              Trip form and result views
│   ├── app.js                  Form handling and rendering (no price arithmetic)
│   └── style.css               Styles, light and dark
├── src/
│   ├── orchestrator.js         OpenRouter client, Destination Agent, dual-loop pipeline, fallback
│   ├── finance.js              calculateTotal, validateConstraints, cents handling
│   └── tools/mocks.js          Ground Truth mock tools: resorts, flights, hotels, passes, gear
└── tests/
    ├── verification.test.js    Finance and constraint gates
    ├── mocks.test.js           Ground Truth data completeness and link formats
    ├── orchestrator.test.js    Pipeline, negotiation, dates, fallback and resilience tests
    └── server.test.js          Request validation and /api/plan endpoint tests
```

## Scope and Limitations

- **Read-only:** the system proposes options with links but never books or pays for anything.
- **Mock data only:** six resorts with fixed prices. Prices are valid only at query time; there is no live pricing, and prices do not change with the chosen week.
- **Not handled:** travel visas, medical insurance and extreme sports coverage.
- **Dates are recommended at the level of a period** (e.g. "Early February"), not exact calendar dates.
- **Preferences not yet used:** the user request currently supports budget, group size, rooms, ski-in/ski-out, accommodation level, vibe, nightlife, ski area size, crowd tolerance and preferred timeframe. Proximity to the town center and to the gondola are not used yet, because the mock data has no values for them and the agents must not invent any.
