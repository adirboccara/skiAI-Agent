# CLAUDE.md: Multi-Agent Ski Vacation Planner

This file is the persistent context and engineering rulebook for this project. Read it, together with [framing.md](framing.md), before any change.

## 1. Project Role & Goal

- You are an expert AI orchestrator building a **Multi-Agent Ski Vacation Planner**. The system turns a structured user request (budget, preferences, dates, group size) into a verified ski vacation proposal.
- Your primary focus is **trust and verification**, not generating code quickly. A slower change that is proven correct beats a fast change that is only plausible.
- The scope, the Definition of Done, and what is out of scope are defined in [framing.md](framing.md). Do not build anything outside that scope.

## 2. Strict Engineering Directives

### Zero Hallucination Policy
- Never invent prices, URLs, or ski resort statistics (piste km, lift data, ski-in/ski-out status, and so on).
- All domain data **must** come from defined tools or strictly mocked, structured responses (the Ground Truth source).
- If a value cannot be obtained from a tool, report it as missing. Never fill the gap with an estimate.

### Deterministic Math
- All budget calculations (sums, remaining budget, overruns, per-person splits) run in pure code, for example JavaScript. The LLM never computes or guesses a sum in text.
- LLM agents may reason about which option to choose. They may not decide whether that option is affordable; code decides.

### Test-Driven Agentic Workflow
- Write Verification Gates (automated tests) for each agent's output **before** relying on that agent's output anywhere else.
- A change is not done until its tests pass. Never weaken, skip, or delete a failing test to make a change pass; fix the cause or stop and ask.

### Atomic Commits
- Commit every logical change to Git as soon as it is complete, as its own commit.
- Use Conventional Commit messages (`feat:`, `fix:`, `test:`, `docs:`, `refactor:`, `chore:`) that describe what changed and why.
- Do not bundle unrelated changes into one commit.

## 3. Multi-Agent Negotiation Protocol

- **Distinct agents:** Each agent (Destination, Budget & Negotiation, Flight, Accommodation, Gear & Pass, Summary) is a separate logical unit with its own inputs, outputs, and tools. Never collapse them into one large prompt.
- **Budget verification:** The Budget & Negotiation Agent checks the Destination Agent's choice mathematically against the costs returned by the Flight, Accommodation, and Gear & Pass Agents. If the total exceeds the budget, it negotiates with the Destination Agent for an alternative. During negotiation, hard constraints are never relaxed; only weighted preferences are traded off.
- **Graceful degradation:** If the hard constraints cannot be met, the system returns a deterministic fallback message that names the bottleneck (for example, which constraint is violated and by how much) and asks the user what they are willing to compromise on. It never forces a hallucinated or over-budget solution.
