# Framing: Multi-Agent Ski Vacation Planner

> **Revision note.** The original framing (commit `a9f7b6b`) planned six LLM agents, including a separate Summary Agent. This revision (Step 15) aligns the specification with the architecture that was built and verified. The reasons for each change are recorded in [lessons-learned.md](lessons-learned.md), and the instructions that drove them are in [docs/prompt-log.md](docs/prompt-log.md). To compare with the original: `git diff a9f7b6b -- framing.md`.

## 1. Problem Statement

Planning a ski vacation is a **constraint satisfaction problem**. Many variables interact, and each one constrains the others:

- **Hard constraints** (a package that violates one is never proposed): maximum overall budget, ski-in/ski-out requirement, group size and number of rooms, and a travel timeframe inside the ski season (December to April).
- **Weighted preferences** (traded off during negotiation): vibe (young/lively vs. family), nightlife, size of the ski area, tolerance for crowds, accommodation level, and the preferred timeframe within the season.

These variables span separate logistical domains: **flights, accommodation, ski pass and gear rental**, each with its own prices. A choice in one domain changes what is feasible in the others. For example, a ski-in/ski-out hotel in a large resort may use up the budget that would otherwise pay for the flight.

A standard single-prompt LLM fails at this task for two reasons:

1. **It hallucinates numbers and URLs.** It produces plausible-looking prices and booking links that come from no real data source, so its "total cost" cannot be trusted.
2. **It cannot negotiate compromises logically.** When the budget conflicts with the user's demands, a single prompt has no explicit mechanism to detect the conflict, find which constraint causes it, and trade off preferences. It tends to either ignore the budget or quietly drop requirements.

**Approach.** The planner splits the work by what each part can be trusted with:

- **One LLM agent, the Destination Agent,** makes the qualitative choices: which resort fits the preferences, and which of that resort's best snow weeks to recommend. It never sees the budget or any price.
- **Deterministic tools** ([src/tools/mocks.js](src/tools/mocks.js)) are the only source of prices, links, hotels and resort facts. The Flight, Accommodation and Gear & Pass roles are tool calls, not LLM prompts.
- **Deterministic code** does all arithmetic (in integer cents), enforces the hard constraints, runs the budget negotiation, checks every field of the agent's reply, and builds the final proposal or the fallback. There is no separate Summary Agent: the pipeline returns the proposal as structured JSON, which the web UI displays.
- **Two loops** keep failures apart:
  - the outer **business negotiation loop** gives one round per resort, and only a constraint or budget failure uses up a round;
  - the inner **API resilience loop** retries unusable model replies and transient API errors within the same round.

## 2. Testable Definition of Done

The project is done when all of the following are true and verified. Automated gates run with `npm test` (no API key needed) and in CI ([.github/workflows/test.yml](.github/workflows/test.yml)).

1. **Orchestration.** A structured request flows through:
   - input validation and the seasonal gate;
   - the Destination Agent;
   - the tools;
   - the constraint and budget gates;
   - then either a proposal, or another negotiation round with the failure fed back.

   The loop allows one round per resort, and a resort that has failed is not offered again.
   *Verified by:* [tests/orchestrator.test.js](tests/orchestrator.test.js) (success, negotiation, pivot after three budget failures).

2. **Budget Verification Gate.** Every proposed package satisfies

   ```
   Flight Cost + Accommodation Cost + Ski Pass Cost + Gear Cost <= Maximum Budget
   ```

   computed by `calculateTotal` from tool-returned unit prices × group size or room count, in integer cents. Invalid prices (missing, negative, non-numeric, sub-cent) are rejected, not guessed.
   *Verified by:* [tests/verification.test.js](tests/verification.test.js), including the floating-point case `0.1 + 0.2 = 0.3`.

3. **Zero hallucinated financial data.**
   - Every price and link in a proposal equals a Ground Truth tool record exactly.
   - The LLM never receives the budget or prices.
   - Agent reasoning that mentions a price is rejected.

   *Verified by:* the traceability, payload and reasoning tests in [tests/orchestrator.test.js](tests/orchestrator.test.js), and [tests/mocks.test.js](tests/mocks.test.js).

4. **Hard constraints.** Ski-in/ski-out is enforced for both the resort and the hotel. Missing data counts as a violation.
   *Verified by:* [tests/verification.test.js](tests/verification.test.js).

5. **Seasonal gate.** A timeframe naming May to November, "summer", "autumn" or "fall" is rejected before any LLM call, with the fixed message *"These months are outside the ski season for our destinations. Please select a timeframe between December and April."* The API answers HTTP 400 with `code: "off_season"`.
   *Verified by:* the seasonal-gate tests in [tests/orchestrator.test.js](tests/orchestrator.test.js) and [tests/server.test.js](tests/server.test.js).

6. **Date recommendation.** The agent returns `recommendedDates`, and code accepts it only if:
   - it is one of the chosen resort's `optimalSnowWeeks`;
   - it is in the requested month when the resort has weeks in that month;
   - when it is in a different month, `dateReasoning` names the requested month.

   *Verified by:* the date tests in [tests/orchestrator.test.js](tests/orchestrator.test.js).

7. **Explainability.** A proposal carries structured reasoning: `resortReasoning` (why the resort fits the vibe and crowd preferences) and `dateReasoning` (why this week). Both must be present, or the reply is retried. Each rejected round records the exact reason computed by code.
   *Verified by:* the reasoning tests in [tests/orchestrator.test.js](tests/orchestrator.test.js).

8. **API resilience.** Empty, malformed or invalid replies, HTTP 429/5xx and network errors are retried up to twice within a round without consuming it.
   - Unusable output after 3 attempts consumes the round.
   - Transient API errors after 3 attempts are fatal.
   - Missing key, 401 and 404 are fatal immediately.

   An API outage never produces a budget "compromise" message.
   *Verified by:* the inner-retry tests in [tests/orchestrator.test.js](tests/orchestrator.test.js).

9. **Deterministic fallback.** If no resort satisfies the hard constraints within the budget, the system returns a fallback built by code that:
   - names the budget and every bottleneck (which constraint failed, or the exact overrun);
   - lists what to compromise on (increasing the budget, dropping ski-in/ski-out).

   A fallback never contains a package total.
   *Verified by:* the fallback tests in [tests/orchestrator.test.js](tests/orchestrator.test.js) and [tests/server.test.js](tests/server.test.js).

10. **Web UI.** `npm start` serves a form and result view at `http://localhost:3000`. The page shows:
    - each negotiation round with its code-computed reason;
    - the package with the recommended week, "Why this trip" reasoning and booking buttons;
    - the fallback with its compromises;
    - input and off-season errors in a warning above the form, scrolled into view.

    The browser performs no price arithmetic and inserts model text as plain text only.
    *Verified by:* [tests/server.test.js](tests/server.test.js) for the API contract. Rendering was checked with headless-browser screenshots at desktop and 390 px width, light and dark, during development. These visual checks are manual and not part of the automated suite.

## 3. Out of Scope

- **Booking or purchasing:** the system is read-only. It proposes options with links but never books or pays for anything.
- **Live data:** prices, hotels, resort statistics and snow weeks are fixed mock data for six resorts. Booking buttons open live vendor search pages, whose prices will differ from the mock prices. There is no real-time pricing.
- **Calendar dates and date-dependent pricing:** dates are recommended as periods (e.g. "Early February"), and prices do not change with the chosen week.
- **Proximity to the town centre and to the gondola:** not modelled, because the mock data has no values for them and the agents may not invent any.
- **Travel visas, medical insurance and extreme sports coverage.**
- **Currencies other than EUR, user accounts, and saved trips.**
