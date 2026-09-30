# Live Run Evidence: Negotiation Loop and Budget Gate

**Date:** 2026-09-30, after commit `cd2eea4`.
**Model:** `nvidia/nemotron-3-super-120b-a12b:free`, the default, since `.env` sets no `OPENROUTER_MODEL` override.
**Request:** consistent with the sample in [run.js](../run.js):

- €2,200 budget, 2 people, 1 room;
- ski-in/ski-out required;
- young vibe, nightlife 9, ski area 8;
- timeframe "February".

**Provenance:** the human ran the pipeline against the live OpenRouter API and supplied the raw output below. The agent did not execute this run. It verified the output independently, as described under [Verification of the output](#verification-of-the-output).

## Summary

This run shows the Agentic Negotiation Loop working against a live model, with every financial decision made by code.

- **The agent chased the preferences.** Asked for a young, nightlife-heavy trip, the Destination Agent first chose the three highest-nightlife resorts: Val Thorens (nightlife 9), Mayrhofen (9) and Ischgl (10).
- **The budget gate blocked each one.** `calculateTotal` priced the cheapest package that met the hard constraints at each resort from the Ground Truth tools. All three exceeded the €2,200 budget, and each rejection records the exact overrun.
- **The agent pivoted.** Given those failures, the agent chose Gudauri in round 4. It met both gates at €1,770, leaving €430 of the budget.
- **Every LLM output passed its gates on the first attempt.** `agentRetries` is empty: in all 4 rounds, the resort ID, the recommended week and both reasoning fields were accepted without a retry.
- **No price came from the model.** Every price and link in the proposal is a mock tool record (`source: "mock"`), and the model's reasoning contains no price.

This is the scenario that Step 11 (`7b9b8d3`) was designed for. With the original 3-round limit, the same three choices would have ended in the fallback, although a valid package existed.

## Verification of the output

### 1. Arithmetic, recomputed from the Ground Truth

Rule: flight, pass and gear × 2 people; hotel × 1 room; the ski-in/ski-out hotel wherever the constraint requires one.

| Round | Resort | Flight | Hotel | Pass | Gear | Total | vs €2,200 |
|---|---|---|---|---|---|---|---|
| 1 | Val Thorens | 250 × 2 = 500 | 2,400 | 380 × 2 = 760 | 200 × 2 = 400 | **4,060** | over by 1,860 ✗ |
| 2 | Mayrhofen | 220 × 2 = 440 | 1,900 | 330 × 2 = 660 | 160 × 2 = 320 | **3,320** | over by 1,120 ✗ |
| 3 | Ischgl | 230 × 2 = 460 | 2,800 | 400 × 2 = 800 | 190 × 2 = 380 | **4,440** | over by 2,240 ✗ |
| 4 | Gudauri | 320 × 2 = 640 | 650 | 150 × 2 = 300 | 90 × 2 = 180 | **1,770** | 430 left ✓ |

All four totals and all three overruns match the output.

### 2. Deterministic replay

The agent's sequence of choices (Val Thorens, Mayrhofen, Ischgl, Gudauri) was replayed through `runPipeline` with a scripted LLM in place of the live model. The replay produced:

- the same status;
- the same resort and hotel (`gu-hotel-1`);
- the same total and remaining budget;
- the same round count;
- the three rejection messages word for word.

The gate verdicts are therefore a function of the Ground Truth and the code, not of the model.

### 3. Gates on the agent's final reply

| Gate | Value in the output | Result |
|---|---|---|
| Resort ID offered in round 4 | `gudauri` (not tried before) | ✓ |
| Week in Gudauri's `optimalSnowWeeks` | "Early February" | ✓ |
| Week in the requested month (February) | "Early February" | ✓ |
| Month-shift acknowledgement | Not required: no shift | ✓ |
| Both reasoning fields present | Yes | ✓ |
| No price in the reasoning | Scores and km only, no currency | ✓ |
| Every priced item traceable to a tool record | 4 of 4, `source: "mock"` | ✓ |

## Observations

These are recorded as observed, without overclaiming.

- **The pivot was not a price search.** The model never sees prices, only the failure messages. Its round 3 choice (Ischgl, €4,440) was *more* expensive than round 2 (Mayrhofen, €3,320). It worked through the high-nightlife resorts before moving to Gudauri, which ranks lower on nightlife (6) but best on crowds (3). This matches the design: the model argues from preferences, and the code decides affordability.
- **Constraint-failing resorts were never tried.** La Molina and Bansko, which lack ski-in/ski-out, were never chosen, so this run did not exercise the constraint gate. That gate is covered by the automated suite ([tests/orchestrator.test.js](../tests/orchestrator.test.js)), but no live run so far has produced a constraint failure.
- **The model explained its choice from the data.** The resort reasoning cites the mock data correctly: nightlife 6, crowd level 3, 75 km, ski-in/ski-out. It is still shown to users only as labelled reasoning, never used as fact.
- **Not recorded:** wall-clock duration and per-call latency.

## Raw output

Output as supplied by the human, unmodified:

```json
{
  "status": "success",
  "resort": {
    "id": "gudauri",
    "name": "Gudauri",
    "country": "Georgia",
    "vibe": "young",
    "skiInSkiOutAvailable": true,
    "skiKm": 75,
    "nightlifeScore": 6,
    "crowdLevel": 3,
    "optimalSnowWeeks": [
      "Mid January",
      "Early February",
      "Late February",
      "Early March",
      "Mid March",
      "Late March",
      "Early April"
    ],
    "source": "mock"
  },
  "flight": {
    "resortId": "gudauri",
    "airport": "TBS",
    "pricePerPerson": 320,
    "url": "https://www.google.com/travel/flights?q=Flights%20to%20TBS",
    "source": "mock",
    "quantity": 2
  },
  "accommodation": {
    "resortId": "gudauri",
    "id": "gu-hotel-1",
    "name": "Mock Gudauri Slope Hotel",
    "level": 7,
    "hasSkiInOut": true,
    "pricePerRoom": 650,
    "url": "https://www.booking.com/searchresults.html?ss=Gudauri",
    "source": "mock",
    "quantity": 1
  },
  "skiPass": {
    "resortId": "gudauri",
    "pricePerPerson": 150,
    "url": "https://www.google.com/search?q=Gudauri%20ski%20pass",
    "source": "mock",
    "quantity": 2
  },
  "gear": {
    "resortId": "gudauri",
    "pricePerPerson": 90,
    "url": "https://www.google.com/search?q=Gudauri%20ski%20rental",
    "source": "mock",
    "quantity": 2
  },
  "total": 1770,
  "remainingBudget": 430,
  "maxBudget": 2200,
  "recommendedDates": "Early February",
  "destinationReasoning": {
    "resortReasoning": "Gudauri matches your young vibe, offers a lively nightlife scene (score 6), low crowds (level 3), and ample ski terrain (75 km), while providing the required ski-in/ski-out access.",
    "dateReasoning": "Early February falls within your requested February timeframe and offers optimal snow conditions."
  },
  "negotiationRounds": 4,
  "previousFailures": [
    {
      "round": 1,
      "resortId": "val-thorens",
      "type": "budget",
      "message": "Val Thorens: cheapest package meeting the hard constraints costs €4060, but the budget is €2200 (over by €1860)"
    },
    {
      "round": 2,
      "resortId": "mayrhofen",
      "type": "budget",
      "message": "Mayrhofen: cheapest package meeting the hard constraints costs €3320, but the budget is €2200 (over by €1120)"
    },
    {
      "round": 3,
      "resortId": "ischgl",
      "type": "budget",
      "message": "Ischgl: cheapest package meeting the hard constraints costs €4440, but the budget is €2200 (over by €2240)"
    }
  ],
  "agentRetries": []
}
```
