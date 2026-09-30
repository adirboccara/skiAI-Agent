# Lessons Learned: Multi-Agent Ski Vacation Planner

This file records the architectural decisions made while building the planner, what triggered each one, and the evidence behind it. Each entry points to the commit where the change landed, so every claim can be checked against the history (`git show <hash>`).

It was written on 2026-09-30, after the last feature commit (`85a1023`), from the development session and the repository history. It was not kept as a running log during development; see [Process lessons](#process-lessons).

## Timeline

| Step | Commit | What changed | What triggered it |
|---|---|---|---|
| 1 | `a9f7b6b` | [framing.md](framing.md): problem, Definition of Done, out of scope | Start of the spiral |
| 2 | `76b2918` | [CLAUDE.md](CLAUDE.md): engineering rules | Start of the spiral |
| 3 | `0890c8c` | Verification gates written against stubs (red) | Test-first |
| 4 | `207022c` | `calculateTotal` and `validateConstraints` implemented (green) | Gates A and B |
| 4.5 | `9da4a39` | Money in integer cents; 27 gate tests | `0.1 + 0.2` drift; coverage gap found in review |
| 5 | `11c8417` | Orchestrator, Destination Agent, negotiation loop, fallback | — |
| 6 | `9672f9f` | CLI entry point, `.env` handling | First live run |
| 6.1 | `24038c9` | New default model, `OPENROUTER_MODEL` override | Live run: HTTP 404, model retired |
| 7 | `5570729` | Inner retry loop, error classification | Live run: empty reply used up a negotiation round |
| 8 | `0ba76fc` | README | — |
| 9 | `c470b8e` | Express server, web UI, API tests | — |
| 10 | `51a2092` | Six resorts, date recommendation, booking links | Scope expansion |
| 11 | `7b9b8d3` | One negotiation round per resort | Analysis: 3 rounds could not reach the only valid resort |
| 12 | `3da0381` | Seasonal gate, structured reasoning | Scope expansion |
| 13 | `eea9d6a` | March/April snow weeks, date-shift acknowledgement | UI test: "April" returned "Late February" |
| 14 | `85a1023` | Winter theme, error auto-scroll fix | UX report: error box not visible |

## Architectural decisions

### 1. The LLM chooses; code decides

**Context.** The framing identified two failures of a single-prompt planner: invented prices, and no reliable way to notice that the budget conflicts with the user's demands.

**Decision.** Only one component is an LLM: the Destination Agent, which picks a resort and a week. Everything that touches money or a hard constraint is deterministic code:

- `calculateTotal` ([src/finance.js](src/finance.js)) does every multiplication and sum.
- `validateConstraints` enforces ski-in/ski-out, treating missing data as a violation.
- Hotel selection within a resort, the budget comparison and the fallback message are all code.

The LLM never receives the budget or any price.

**Evidence.** Gate A (`0890c8c` red, `207022c` green). The traceability test in [tests/orchestrator.test.js](tests/orchestrator.test.js) asserts that every price and link in a proposal deep-equals a Ground Truth tool record. A test asserts that `maxBudget` is absent from the Destination Agent's payload.

**Consequence.** The Flight, Accommodation, Gear & Pass and Budget & Negotiation "agents" described in the framing became deterministic tool calls, not LLM prompts. This removes the hallucination risk for financial data. It also means the framing's six-agent description no longer matches the code (see [Process lessons](#process-lessons)).

### 2. Money is integer cents; tool data is never silently altered

**Context.** Floating-point arithmetic gives `0.1 + 0.2 = 0.30000000000000004`.

**Decision.** `calculateTotal` converts every price to integer cents, sums, and converts back. A price with more than two decimals is rejected, not rounded, because rounding would silently change Ground Truth data.

**Evidence.** `9da4a39`. The `0.1 + 0.2 === 0.3` test fails without the change and passes with it.

### 3. Deterministic mock tools as the Ground Truth

**Decision.** [src/tools/mocks.js](src/tools/mocks.js) is the only source of prices, hotels, resort statistics and snow weeks. Every record carries `source: 'mock'`. An unknown resort throws an error instead of returning a guess.

**Links.** They pointed to `example.com` at first. In Step 10 two options were considered:

- realistic-looking paths on real vendor domains (e.g. `booking.com/mock-hotel-123`), which would open 404 pages;
- real vendor search pages for each resort, which work but show live prices.

The second was chosen, and the UI states that vendor prices differ from the mock prices.

**Evidence.** [tests/mocks.test.js](tests/mocks.test.js) checks every resort has complete, well-formed records and https links.

### 4. Two loops: business negotiation and API resilience

**Context.** The first successful live run (Step 6.1, model `nvidia/nemotron-3-super-120b-a12b:free`) produced:

| Round | Agent picked | Result |
|---|---|---|
| 1 | Val Thorens | Budget failure: €4060 vs €2200 budget, over by €1860 |
| 2 | — | `OpenRouter response contained no message content` |
| 3 | Gudauri | Accepted, €1770, €430 left |

The empty reply in round 2 used up a negotiation round. With 3 resorts and 3 rounds, one empty reply at the wrong moment would have forced the fallback although Gudauri fit.

**Decision.** Split the loops (`5570729`):

- **Outer loop, business negotiation.** Only a real business result (a constraint or budget failure) consumes a round.
- **Inner loop, API resilience.** Up to 2 retries per round, with 1 s and 2 s backoff, for empty replies, malformed JSON, invalid choices, HTTP 429/5xx and network errors.

Errors are classified:

- The model's output still bad after 3 attempts: the round is consumed and recorded.
- The API still failing after 3 attempts: fatal error. An outage is not a budget problem, so the fallback must not tell the user to "increase your budget".
- Non-transient errors (missing key, 401, 404): fatal immediately.

Retries are logged separately in `agentRetries` and are never fed back to the LLM as negotiation failures.

**Evidence.** Tests in [tests/orchestrator.test.js](tests/orchestrator.test.js) run through the real `callOpenRouter` with a fake `fetch`. A manual mutation check (retries disabled) confirmed the key test catches a regression: the empty reply consumed round 1 again.

### 5. Free-model churn is an operational risk, not a code bug

**Context.** The first live run failed with HTTP 404: `meta-llama/llama-3.1-8b-instruct:free` had been retired. The two suggested replacements were also not listed.

**Decision.** Query OpenRouter's live model list instead of guessing (5 of 16 free models supported `response_format`). Make the model overridable via `OPENROUTER_MODEL` without a code change. The default later moved to Nemotron after `google/gemma-4-31b-it:free` returned HTTP 429 from Google's shared free pool.

**Evidence.** `24038c9`, `5570729`.

### 6. Enough negotiation rounds to show the compromise, without pre-filtering

**Context.** With six resorts, the sample request (€2,200, ski-in/ski-out, nightlife 9) has exactly one valid package, Gudauri. The three nightlife resorts are all over budget. With 3 rounds, an agent that chases nightlife first always ends in the fallback.

**Options.**

1. Raise the round limit.
2. Pre-filter resorts in code so the agent only sees feasible ones.

Option 2 is more robust, but the agent would never experience a budget failure, which removes the negotiation mechanic the project exists to demonstrate.

**Decision.** Option 1: `MAX_NEGOTIATION_ROUNDS = RESORTS.length`, which is 6 (`7b9b8d3`).

**Evidence.** A test scripts Ischgl, Val Thorens and Mayrhofen before Gudauri. It returns the fallback with 3 rounds and succeeds in round 4 with 6.

**Cost.** Up to 6 LLM calls per run, or 18 in the worst case with retries.

### 7. Every LLM output is gated by code before it is used

The Destination Agent's reply is free text from a model. Each field is checked deterministically; a failing reply is retried, never returned:

| Field | Gate | Commit |
|---|---|---|
| `selected_resort_id` | Must be one of the resorts offered this round | `11c8417` |
| `recommendedDates` | Must be one of that resort's `optimalSnowWeeks` | `51a2092` |
| `recommendedDates` | If the user named a month the resort has weeks in, the pick must be in that month | `51a2092` |
| `reasoning` | Must be `{ resortReasoning, dateReasoning }`, both non-empty | `3da0381` |
| `reasoning` | Must not mention a price (€, $, "euros", …) | `3da0381` |
| `dateReasoning` | If the week is in a different month than requested, must name the requested month | `eea9d6a` |

**Limit.** The last gate is a keyword check: it proves the requested month is mentioned, not that the compromise is well explained. The prompt asks for the explanation; code only enforces the minimum.

### 8. Reject what the LLM cannot fix before calling it

**Decision.** A timeframe naming May–November, "summer", "autumn" or "fall" is rejected before any LLM call, with a fixed message (`3da0381`). The API returns HTTP 400 with `code: "off_season"`. Input validation (budget, group size, rooms, vibe, scores) also runs before the pipeline, so bad input never costs an API call.

**Known false positive.** Matching ignores case, so "I may go in February" is rejected because of "may".

### 9. The data, not the agent, caused the "April → Late February" result

**Context.** A UI test asked for April and got "Late February".

**Root cause.** Gudauri's mock data had no weeks after February, so "Late February" was the closest legal pick. The month gate from decision 7 was already correct.

**Decision.** Extend the mock snow weeks into March and April, and require the agent to acknowledge any month shift (`eea9d6a`). A regression test asks for April at Gudauri and requires "Early April".

### 10. The UI displays; it never computes

**Decision.** The browser does no money arithmetic. Every figure (unit prices, quantities, total, budget, remaining) comes from the server. Model-written text is inserted with `textContent`, never as HTML. Only https links become buttons. Each negotiation round is shown with the code's rejection reason, and the agent's reasoning is labelled "never used for any price or check".

### 11. Measure UI behaviour; don't eyeball it

**Context.** The off-season warning appeared at the top of the form, but users at the bottom of the page did not see it.

**Root cause.** The code already scrolled to the warning, but then called `focus()` on the timeframe field. By default that scrolls the page to the field, away from the warning.

**Fix.** Scroll the warning to the center, then `focus({ preventScroll: true })` (`85a1023`).

**Evidence.** Verified with a headless-browser script on a 390×700 viewport. From the bottom of the page, after submitting "May", the warning's bounding box was 291–409 px, inside the 700 px viewport. Headless screenshots throughout Steps 9–14 also caught three layout bugs before commit:

- low button contrast in dark mode;
- an unstyled text input;
- the ticket squeezing item names inside the glass panel, fixed with a container query.

## Process lessons

These are the weaknesses in how the project was run, recorded so they are not repeated.

1. **The specification drifted.** [framing.md](framing.md) still describes six agents, including a Summary Agent, and treats travel dates as a hard constraint. It does not mention the web UI, date recommendation, the seasonal gate or the booking links. Features were added in Steps 9–14 without updating the framing first. [CLAUDE.md](CLAUDE.md) had the same drift until it was rewritten alongside this file.
2. **Test-first held only at the start.** Steps 3–4 are a genuine red → green sequence. From Step 5 on, tests landed in the same commit as the code, so the history cannot show they were written first.
3. **Some commits are not atomic.** `51a2092` combines three features (destinations, dates, booking UI), as its own message says. `c470b8e` and later feature commits also carry README updates. `0ba76fc` says "finalize project for submission", but six feature commits follow it.
4. **Gate results are not persisted.** The suite is reproducible with `npm test`, but there is no CI and no recorded test output per commit. The one live run is documented only in this file (decision 4), and no live run has been made since the retry loop, dates, reasoning or seasonal gate were added.
5. **Lessons were written at the end.** This file was reconstructed after the fact. A running log, updated when each failure happened, would be stronger evidence.

## Open risks

- No live LLM run since Step 6.1. The stricter reply format may raise the retry rate on free models.
- A negotiation of up to 6 rounds × 3 attempts on a slow free model may take longer than the "up to a minute" the UI promises.
- Travel dates, and proximity to the town centre and gondola, are not modelled as data. Dates are recommended as periods ("Early February"), not calendar dates, and prices do not vary by week.
