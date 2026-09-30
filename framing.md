# Framing: Multi-Agent Ski Vacation Planner

## 1. Problem Statement

Planning a ski vacation is a **constraint satisfaction problem**. Many variables interact, and each one constrains the others:

- **Hard constraints:** maximum overall budget, ski-in/ski-out requirement, travel dates, group size and number of rooms.
- **Weighted preferences:** nightlife, vibe (young/party vs. family-oriented), size of the ski area (km of pistes), accommodation level, proximity to the town center and to the gondola, and tolerance for crowds.

These variables span separate logistical domains: **flights, accommodation, ski pass, and gear rental**. Each domain has its own data sources and pricing. A choice in one domain changes what is feasible in the others. For example, a ski-in/ski-out hotel in a large resort may use up the budget that would otherwise pay for the flight.

A standard single-prompt LLM fails at this task for two reasons:

1. **It hallucinates numbers and URLs.** It produces plausible-looking prices and booking links that are not grounded in any real data source, so its "total cost" cannot be trusted.
2. **It cannot negotiate compromises logically.** When the budget conflicts with the user's demands, a single prompt has no explicit mechanism to detect the conflict, find which constraint causes it, and trade off preferences. It tends to either ignore the budget or quietly drop requirements.

This project addresses both failures with a **multi-agent architecture**. Specialized agents (Destination, Budget & Negotiation, Flight, Accommodation, Gear & Pass, Summary) each own one domain. All financial data comes from tool calls, and the budget is enforced by deterministic code, not by the model's judgment.

## 2. Testable Definition of Done

The project is done when all of the following are true and verified:

1. **Orchestration:** The system accepts a structured user request (the form inputs) and routes it through the specialized agents: Destination → Budget & Negotiation (with a negotiation loop back to Destination when needed) → Flight, Accommodation, Gear & Pass → Summary.

2. **Budget Verification Gate:** An automated test suite proves mathematically that every final proposed package satisfies:

   ```
   Flight Cost + Accommodation Cost + Ski Pass Cost + Gear Cost <= Maximum Budget
   ```

   The tests compute this sum from the tool-returned values, not from the LLM's text. A package that violates the inequality fails the test suite.

3. **Zero hallucinated financial data:** Every price and every link in the final proposal is obtained **exclusively** through structured tool calling against the Ground Truth source (a database/API, or a strictly defined mock of one). Tests verify that each price and URL in the output can be traced to a tool-call result. Any value that cannot be traced fails the test suite.

4. **Deterministic fallback:** If the requested parameters cannot be satisfied within the budget, the system triggers a deterministic fallback that:
   - states the specific bottleneck (for example, "the cheapest ski-in/ski-out option exceeds the budget by €X"), and
   - asks the user which constraint they are willing to compromise on.

   Tests cover this path with inputs that are known to be infeasible, and they assert that the fallback is triggered and that no invalid package is proposed.

## 3. Out of Scope

- **Booking or purchasing:** The system is read-only. It proposes options with links but never books or pays for tickets, hotels, passes, or gear.
- **Travel visas, medical insurance, and extreme sports coverage:** The system does not handle these.
- **Real-time dynamic pricing:** Prices are valid only at the moment of the query. The system does not track or update price changes after it produces a proposal.
