# Prompt Log: Directing the Agent

This log reconstructs the instructions given to the coding agent (Claude Code) during the build, and what the agent did with each one. Quotations are taken from the session; everything else is summarised.

For every step it records:

- **Instruction:** what the human asked for.
- **Agent response:** where the agent followed the instruction, deviated, pushed back, or raised a risk, and why.
- **Result:** the commit.

The log was reconstructed after the build, on 2026-09-30, from the session transcript. The reasoning behind the resulting architecture is in [lessons-learned.md](../lessons-learned.md).

## How the iteration worked

Each step was one instruction, one verified change and one commit, with the exact commit message set by the human. Four kinds of feedback drove the spiral:

| Kind | Examples |
|---|---|
| A gate failed for the wrong reason | Step 3: the test script crashed instead of running the tests |
| A live run failed | Steps 6.1 and 7: retired model (404), shared rate limit (429), empty reply |
| The agent found a risk in its own analysis | Steps 4, 5, 10, 12: coverage gap, floating-point drift, 3-round limit, "may" false positive |
| Human testing of the UI | Steps 13 and 14: "April" returned "Late February"; error box not visible |

"Pushback" below means the agent did not carry out an instruction literally, because doing so would have broken a gate or the Zero Hallucination Policy. Each time, it said so and gave its reason.

## Step log

### Step 0: Vision

**Instruction.** Read the project vision (six agents, a negotiation loop, a deterministic fallback, a spiral methodology), acknowledge it, and write no code until "Let's begin Step 1".

**Agent response.** Acknowledged the architecture and constraints; wrote nothing.

### Step 1: Framing (`a9f7b6b`)

**Instruction.** Write `framing.md` with exactly three sections (Problem Statement, Testable Definition of Done, Out of Scope) and commit with a given message.

**Agent response.** The folder was not a Git repository, so the agent ran `git init` first and said so. It also split the variables into **hard constraints** and **weighted preferences**, which the negotiation step needs in order to know what it may trade off. It added three testability requirements:

- the budget sum is computed from tool values, not LLM text;
- every price and URL must be traceable to a tool call;
- the fallback is tested with known-infeasible inputs.

### Step 2: CLAUDE.md (`76b2918`)

**Instruction.** Write the agent rulebook: role, Zero Hallucination Policy, deterministic math, test-driven workflow, atomic commits, negotiation protocol.

**Agent response.** Added rules the instruction implied but did not state:

- a value no tool can provide is reported as missing, never estimated;
- the LLM may choose, but only code decides affordability;
- a failing test is never weakened, skipped or deleted to get a change through;
- hard constraints are never relaxed during negotiation.

### Step 3: Verification gates and mocks (`0890c8c`)

**Instruction.** Initialise npm with `"test": "node --test tests/"`. Create Ground Truth mocks, Gate A (`calculateTotal` = 1650) and Gate B (ski-in/ski-out rejection), and stubs so the tests "SHOULD FAIL or pass trivially".

**Pushback: the test script.** On Node 24, `node --test tests/` treats `tests/` as a module and crashes before any test runs, which is a false red. The agent changed the script to `node --test "tests/**/*.test.js"` and reported the deviation.

**Hardening.**

- The stubs throw "not implemented", so both gates fail for the right reason.
- Gate B accepts only an explicit `false` or a specific `ConstraintViolationError` naming the constraint, so a generic "not implemented" error cannot pass it.
- The mocks carry `source: 'mock'` and use `example.com` links so they cannot be mistaken for real offers.

**Risk raised.** Should multiplication by group size and rooms happen in the tool, the LLM, or `calculateTotal`? The human decided: *"The deterministic engine (calculateTotal) must handle all arithmetic."*

### Step 4: Make the gates pass (`207022c`)

**Instruction.** Gate A with unit prices × group size and rooms (= 2500). Keep Gate B "as is". Implement the logic without weakening tests.

**Agent response.** The new three-argument signature `validateConstraints(user, resort, hotel)` forced a change to Gate B's *call*. The agent kept the assertion unchanged and passed a resort that *does* offer ski-in/ski-out, so the rejection must come from the hotel.

**Risks raised.**

1. Gate B only tests rejection, so a function that rejects every hotel would pass it.
2. Prices with cents would suffer floating-point drift.

### Step 4.5 and Step 5: Cents, coverage, orchestrator (`9da4a39`, `11c8417`)

**Instruction.**

- 4.5: handle currency in cents and add the missing tests.
- 5: build the OpenRouter client (model `meta-llama/llama-3.1-8b-instruct:free`, JSON mode), the Destination Agent, a 3-round negotiation loop, and the deterministic fallback.

**Agent response.**

- 4.5: sub-cent prices are *rejected* rather than rounded, because rounding would silently alter tool data. The `0.1 + 0.2` test fails without the change.
- **Pushback: missing data.** The Destination Agent was to weigh nightlife and crowds, but the mocks had no such data, so the LLM would have had to invent it. The agent added `nightlifeScore` and `crowdLevel` to the mocks.
- The LLM is injectable (`runPipeline(request, { llm })`), so the negotiation loop is tested with a scripted fake. The agent wrote 17 pipeline tests in the same commit, citing CLAUDE.md's rule that gates come before relying on agent output.
- **Design decision surfaced for review.** Only the Destination Agent calls an LLM. Flight, Accommodation, Gear & Pass and Budget & Negotiation are deterministic code. The agent said this differs from the six-agent framing. The human endorsed it.
- **Risk raised.** Free `:free` models are retired often, and not all providers honour JSON mode. This was confirmed in Step 6.1.

### Step 6: CLI and env (`9672f9f`)

**Instruction.** `run.js` with `process.loadEnvFile()` and a sample request using a nested `preferences: { vibe: "young/party", nightlife: 9, … }` object; `.env.example`; do not run it.

**Pushback: request shape.** The pipeline reads flat fields. The nested object would have been *silently ignored*, so the Destination Agent would have received no preferences. The agent used the flat shape and mapped `"young/party"` to the mock value `"young"`. It omitted `centerProximity`, which has no data behind it.

**Added.** A `.gitignore` for `.env`, because the repository had none and `git add .` would have committed the API key.

### Step 6.1: Live run and model fix (`24038c9`)

**Instruction.** The model had returned 404 (retired). Switch to `google/gemma-2-9b-it:free` or `meta-llama/llama-3.2-3b-instruct:free`, commit, and run `node run.js` live.

**Pushback: model choice.** The agent queried OpenRouter's live model list instead of guessing. *Neither* suggested model was listed, and only 5 of 16 free models supported `response_format`. It chose `google/gemma-4-31b-it:free` and made the model overridable via `OPENROUTER_MODEL`.

**Live results.**

1. Gemma returned HTTP 429 (Google's shared free pool).
2. A rerun with `nvidia/nemotron-3-super-120b-a12b:free` succeeded:
   - round 1: Val Thorens, rejected over budget by €1860;
   - round 2: **empty reply**;
   - round 3: Gudauri accepted at €1770.

**Risk raised.** The empty reply used up a negotiation round. With 3 resorts and 3 rounds, one empty reply could force the fallback although a valid package exists.

### Step 7: Resilience (`5570729`)

**Instruction.** Add an inner retry loop (up to 2 retries) that does not advance the round. When retries run out, "throw a fatal error (or gracefully consume the main round, your architectural choice)". Make Nemotron the default.

**Agent decision: retry classification.** The agent split the offered choice by error type:

- **Bad model output** after 3 attempts consumes the round, as before.
- **Transient API errors** (429, 5xx, network) after 3 attempts are **fatal**. The fallback tells the user to raise the budget or drop ski-in/ski-out, and that is wrong advice when the API is down.
- **Permanent errors** (missing key, 401, 404) are fatal immediately.

**Verification.** The retry tests run through the real `callOpenRouter` with a fake `fetch`. A mutation check (retries disabled) showed the key test catches a regression.

### Step 8: README (`0ba76fc`)

**Instruction.** Write the README: philosophy, dual-loop architecture, getting started, `npm start`.

**Agent response.** The README states plainly that only the Destination Agent is an LLM, that several form fields are unused, and that all data is mock. The agent also flagged that the Summary Agent in the framing is not a separate agent.

### Step 9: Web server and UI (`c470b8e`)

**Instruction.** Express server with `POST /api/plan`, an HTML form, a loading state, result rendering, and `npm start` → `server.js`.

**Agent response.**

- The server validates every field and returns 400 before any LLM call, and 502 on pipeline failure.
- The browser does **no price arithmetic**: it displays the server's values.
- Model text is inserted with `textContent`, never as HTML.
- The README had become false ("zero dependencies", "`npm start` runs the CLI"), so the agent corrected it in the same commit.
- The UI was checked with headless-browser screenshots, which caught a low-contrast dark-mode button before commit.

### Step 10: Destinations, dates, booking links (`51a2092`)

**Instruction.** Add 3 resorts and `optimalSnowWeeks`. Make links "look like realistic vendor links (e.g. `https://www.booking.com/mock-hotel-123`)". Add `preferredTimeframe` and have the agent output `recommendedDates`. Render booking buttons.

**Pushback: booking links.** Mock paths on real vendor domains would open 404 pages during a demo. The agent **asked the human** to choose between:

- working vendor *search* links (Google Flights, Booking.com), with the UI stating that vendor prices differ from the mock prices;
- the literal mock paths.

The human chose working search links.

**Addition beyond the instruction.** `recommendedDates` is LLM text, so the agent gated it in code:

- it must be one of the resort's `optimalSnowWeeks`;
- it must be in the requested month when the resort has weeks in that month.

**Risk raised.** With six resorts and 3 rounds, the sample request has exactly one valid package (Gudauri), and an agent chasing nightlife exhausts the rounds first. The agent proposed:

1. raising the round limit, or
2. pre-filtering infeasible resorts in code,

and recommended option 2.

### Step 11: Negotiation tuning (`7b9b8d3`)

**Instruction.** The human chose option 1, *not* the agent's recommendation: *"If we pre-filter the resorts by budget (Option 2), we completely bypass the negotiation mechanic."* Raise the limit from 3 to 6.

**Agent response.** Implemented it as `MAX_NEGOTIATION_ROUNDS = RESORTS.length`, so it cannot fall out of sync. It added a regression test for the exact risk: three over-budget picks, then Gudauri. A check confirmed the same scenario returns the fallback with 3 rounds and succeeds with 6. The agent also removed a README claim about a "typical run" that it had not observed live.

### Step 12: Seasonal gate and structured reasoning (`3da0381`)

**Instruction.** Reject summer or off-season timeframes before any LLM call with a fixed message. Require `resortReasoning` and `dateReasoning`. Show the error above the form and the reasoning on the ticket.

**Agent response.**

- The gate lives in the orchestrator, so both the CLI and the server get it. The server returns 400 with `code: "off_season"`.
- It covers all of May to November, since the message says the season is December to April, not just the four example months.

**Addition beyond the instruction.** Reasoning that mentions a price (€, $, "euros", …) is rejected, because it is shown to users and prices may come only from tools.

**Risk raised.** Case-insensitive matching means "I may go in February" is rejected because of "may".

### Step 13: Late-season weeks and date shifts (`eea9d6a`)

**Instruction.** A UI test asked for "April" and got "Late February". Extend snow weeks into March and April, and make the agent acknowledge month shifts in `dateReasoning`.

**Agent response.** Traced the root cause to the *data*: Gudauri had no weeks after February, so the month gate was already correct.

**Pushback: enforcement.** An instruction in the prompt alone is not enforced, so the agent added a code check: a shift to another month is accepted only if `dateReasoning` names the requested month. It stated the limit: this is a keyword check, not a check of explanation quality.

### Step 14: Winter theme and error scrolling (`85a1023`)

**Instruction.** The error box is not visible without scrolling, so call `scrollIntoView({ behavior: 'smooth', block: 'center' })`. Apply a winter theme with glassmorphism.

**Agent response: root cause.** The code *already* scrolled to the warning, but then called `focus()` on the timeframe field, which scrolls the page to the field and away from the warning. The fix is `focus({ preventScroll: true })` plus centred scrolling that respects reduced motion. This was measured in a headless browser: after submitting "May" from the bottom of a 390×700 page, the warning sat at 291–409 px.

**Also.**

- Glass panels fall back to solid backgrounds without `backdrop-filter`, or when the user asks for reduced transparency.
- The fake "notch" circles on the ticket became real mask cut-outs.
- A container query fixed item names being squeezed inside the glass panel.

### Audit: Grading self-assessment (`f34b203`)

**Instruction.** Audit the repository against the course criteria (commit history, context files, specifications, prompts, verification gates and results, folder structure, README). Create lessons-learned, and give a "brutally honest" grade band.

**Agent response.** Assessed the project as targeting the **"up to 90"** band. The gaps it listed:

- no persisted gate results;
- a stale `framing.md` and `CLAUDE.md`;
- no prompt log;
- tests written alongside code rather than before it, after Step 4;
- non-atomic commits (`51a2092`);
- a compressed two-hour timeline;
- lessons written at the end.

It rewrote `CLAUDE.md` to match the code (agent charge sheets, error classes, commands) and wrote `lessons-learned.md`, including a *Process lessons* section.

### Step 15: Specification alignment and trail (this commit)

**Instruction.** Rewrite `framing.md` to match the built architecture, create this prompt log, and add a CI workflow running `npm test` "on every push to the main branch".

**Pushback.**

- **Branch name.** The repository's branch is `master`, not `main`, so a `main`-only trigger would never run. The workflow triggers on both, and on pull requests.
- **Persisting results.** The job log alone is not a durable record, so a `test:ci` script also writes a JUnit report, uploaded as a build artifact for each commit.
- **Stated limit.** The repository has no remote yet, so CI will record nothing until it is pushed to GitHub.

**Framing.** The revision keeps the three required sections and a revision note pointing to the original (`a9f7b6b`). Each Definition of Done item now names the test that verifies it. The one item without automated coverage, UI rendering, says so.
