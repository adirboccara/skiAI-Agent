// Multi-agent orchestration pipeline.
//
// The LLM only chooses a resort. Every price and link comes from the Ground
// Truth tools, and every affordability decision is made by the deterministic
// gates in finance.js. If negotiation fails, the fallback is built in code.

import {
  RESORTS,
  getResort,
  getFlight,
  getAccommodations,
  getSkiPass,
  getGearRental,
} from './tools/mocks.js';
import {
  calculateTotal,
  validateConstraints,
  ConstraintViolationError,
  toCents,
  fromCents,
  assertPositiveInteger,
} from './finance.js';

export const OPENROUTER_URL = 'https://openrouter.ai/api/v1/chat/completions';
export const DEFAULT_MODEL = 'meta-llama/llama-3.1-8b-instruct:free';
export const MAX_NEGOTIATION_ROUNDS = 3;

// Thrown when the LLM's reply cannot be used (not JSON, or not a valid choice).
export class LlmResponseError extends Error {
  constructor(message) {
    super(message);
    this.name = 'LlmResponseError';
  }
}

// ---------------------------------------------------------------------------
// LLM integration
// ---------------------------------------------------------------------------

function parseJsonContent(content) {
  // Small models sometimes wrap JSON in a Markdown code fence; strip only that.
  const unfenced = content.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
  try {
    return JSON.parse(unfenced);
  } catch {
    throw new LlmResponseError(`LLM did not return valid JSON: ${content.slice(0, 200)}`);
  }
}

// Sends chat messages to OpenRouter and returns the reply parsed as JSON.
export async function callOpenRouter(
  messages,
  { apiKey = process.env.OPENROUTER_API_KEY, model = DEFAULT_MODEL, fetchImpl = fetch } = {},
) {
  if (!apiKey) {
    throw new Error('OPENROUTER_API_KEY is not set');
  }

  const response = await fetchImpl(OPENROUTER_URL, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model,
      messages,
      response_format: { type: 'json_object' },
      temperature: 0,
    }),
  });

  if (!response.ok) {
    const body = await response.text().catch(() => '');
    throw new Error(`OpenRouter request failed with status ${response.status}: ${body.slice(0, 500)}`);
  }

  const data = await response.json();
  const content = data?.choices?.[0]?.message?.content;
  if (typeof content !== 'string') {
    throw new LlmResponseError('OpenRouter response contained no message content');
  }
  return parseJsonContent(content);
}

// ---------------------------------------------------------------------------
// Destination Agent
// ---------------------------------------------------------------------------

const PREFERENCE_KEYS = [
  'vibe',
  'nightlifeImportance',
  'skiKmImportance',
  'crowdTolerance',
  'requiresSkiInOut',
];

const DESTINATION_SYSTEM_PROMPT = `You are the Destination Agent in a ski vacation planner.
Choose the single resort from "available_resorts" that best matches "user_preferences".
Weigh vibe, nightlife, crowdedness and ski area size. If "requiresSkiInOut" is true, prefer resorts with skiInSkiOutAvailable = true.
"previous_failures" lists resorts already rejected by the budget and constraint checks and why; learn from them.
Use ONLY the data provided. Do not mention or estimate prices, and do not invent facts about resorts.
Respond with JSON only, in exactly this shape:
{"selected_resort_id": "<one id from available_resorts>", "reasoning": "<one or two sentences>"}`;

// Asks the LLM to pick one resort. Throws LlmResponseError if the reply is not
// one of the offered resort ids.
export async function destinationAgent(preferences, resorts, previousFailures, { llm = callOpenRouter } = {}) {
  const userPreferences = Object.fromEntries(
    PREFERENCE_KEYS.filter((key) => preferences[key] !== undefined).map((key) => [key, preferences[key]]),
  );

  const messages = [
    { role: 'system', content: DESTINATION_SYSTEM_PROMPT },
    {
      role: 'user',
      content: JSON.stringify({
        user_preferences: userPreferences,
        available_resorts: resorts,
        previous_failures: previousFailures,
      }),
    },
  ];

  const reply = await llm(messages);
  const selectedResortId = reply?.selected_resort_id;
  if (!resorts.some((resort) => resort.id === selectedResortId)) {
    throw new LlmResponseError(
      `Destination Agent selected "${selectedResortId}", which is not one of the offered resorts`,
    );
  }

  return {
    selectedResortId,
    reasoning: typeof reply.reasoning === 'string' ? reply.reasoning : '',
  };
}

// ---------------------------------------------------------------------------
// Tools + Verification Gates for one resort
// ---------------------------------------------------------------------------

function formatEuros(cents) {
  return `€${fromCents(cents)}`;
}

// Hotels closest to the preferred accommodation level come first; ties (or no
// stated preference) go to the cheaper package.
function byPreferenceThenPrice(preferredLevel) {
  return (a, b) => {
    if (typeof preferredLevel === 'number') {
      const distance = Math.abs(a.hotel.level - preferredLevel) - Math.abs(b.hotel.level - preferredLevel);
      if (distance !== 0) return distance;
    }
    return a.totalCents - b.totalCents;
  };
}

// Phase 2 (tools) and Phase 3 (gates) for a single resort. Returns either
// { ok: true, package } or { ok: false, failure }.
function evaluateResort(userRequest, resortId, budgetCents) {
  const resort = getResort(resortId);
  const flight = getFlight(resortId);
  const hotels = getAccommodations(resortId);
  const skiPass = getSkiPass(resortId);
  const gear = getGearRental(resortId);

  // Gate: hard constraints, checked per hotel.
  const hardConstraints = { requiresSkiInOut: userRequest.requiresSkiInOut === true };
  const validHotels = [];
  const violations = [];
  for (const hotel of hotels) {
    try {
      validateConstraints(hardConstraints, resort, hotel);
      validHotels.push(hotel);
    } catch (err) {
      if (!(err instanceof ConstraintViolationError)) throw err;
      violations.push(err);
    }
  }

  if (validHotels.length === 0) {
    const reasons = [...new Set(violations.map((err) => err.message))].join('; ');
    return {
      ok: false,
      failure: {
        resortId,
        type: 'constraint',
        constraint: violations[0]?.constraint,
        message: `${resort.name}: ${reasons}`,
      },
    };
  }

  // Gate: budget. Totals come only from calculateTotal over tool-provided prices.
  const candidates = validHotels
    .map((hotel) => {
      const total = calculateTotal({
        flightUnitPrice: flight.pricePerPerson,
        accommodationPerRoom: hotel.pricePerRoom,
        passUnitPrice: skiPass.pricePerPerson,
        gearUnitPrice: gear.pricePerPerson,
        groupSize: userRequest.groupSize,
        roomCount: userRequest.roomCount,
      });
      return { hotel, total, totalCents: toCents('total', total) };
    })
    .sort(byPreferenceThenPrice(userRequest.accommodationLevel));

  const affordable = candidates.find((candidate) => candidate.totalCents <= budgetCents);
  if (!affordable) {
    const cheapestCents = Math.min(...candidates.map((candidate) => candidate.totalCents));
    return {
      ok: false,
      failure: {
        resortId,
        type: 'budget',
        message:
          `${resort.name}: cheapest package meeting the hard constraints costs ${formatEuros(cheapestCents)}, ` +
          `but the budget is ${formatEuros(budgetCents)} (over by ${formatEuros(cheapestCents - budgetCents)})`,
      },
    };
  }

  return {
    ok: true,
    package: {
      resort,
      flight: { ...flight, quantity: userRequest.groupSize },
      accommodation: { ...affordable.hotel, quantity: userRequest.roomCount },
      skiPass: { ...skiPass, quantity: userRequest.groupSize },
      gear: { ...gear, quantity: userRequest.groupSize },
      total: affordable.total,
      remainingBudget: fromCents(budgetCents - affordable.totalCents),
    },
  };
}

// ---------------------------------------------------------------------------
// Deterministic fallback
// ---------------------------------------------------------------------------

function buildFallback(userRequest, previousFailures) {
  const compromises = [];
  if (previousFailures.some((failure) => failure.type === 'budget')) {
    compromises.push('increasing your maximum budget');
  }
  if (previousFailures.some((failure) => failure.constraint === 'requiresSkiInOut')) {
    compromises.push('dropping the ski-in/ski-out requirement');
  }
  if (compromises.length === 0) {
    compromises.push('retrying the request (no resort could be evaluated)');
  }

  return {
    status: 'fallback',
    message:
      `Cannot find a package matching your budget of €${userRequest.maxBudget} and hard constraints. ` +
      `Please compromise on: ${compromises.join(' or ')}.`,
    compromises,
    bottlenecks: previousFailures,
  };
}

// ---------------------------------------------------------------------------
// Pipeline
// ---------------------------------------------------------------------------

// Runs the negotiation loop: Destination Agent -> tools -> gates, up to
// maxRounds times. Returns a success proposal or the deterministic fallback.
export async function runPipeline(userRequest, { llm = callOpenRouter, maxRounds = MAX_NEGOTIATION_ROUNDS } = {}) {
  // Reject malformed requests before spending any LLM calls.
  const budgetCents = toCents('maxBudget', userRequest.maxBudget);
  assertPositiveInteger('groupSize', userRequest.groupSize);
  assertPositiveInteger('roomCount', userRequest.roomCount);

  const previousFailures = [];
  const triedResortIds = new Set();

  for (let round = 1; round <= maxRounds; round++) {
    // Resorts that already failed are not offered again.
    const availableResorts = RESORTS.filter((resort) => !triedResortIds.has(resort.id));
    if (availableResorts.length === 0) break;

    // Phase 1: Destination Agent.
    let choice;
    try {
      choice = await destinationAgent(
        userRequest,
        availableResorts,
        previousFailures.map((failure) => failure.message),
        { llm },
      );
    } catch (err) {
      if (!(err instanceof LlmResponseError)) throw err;
      previousFailures.push({ round, type: 'invalid_agent_output', message: err.message });
      continue;
    }
    triedResortIds.add(choice.selectedResortId);

    // Phases 2 and 3: tools and verification gates.
    const result = evaluateResort(userRequest, choice.selectedResortId, budgetCents);
    if (result.ok) {
      return {
        status: 'success',
        ...result.package,
        maxBudget: userRequest.maxBudget,
        destinationReasoning: choice.reasoning,
        negotiationRounds: round,
        previousFailures,
      };
    }
    previousFailures.push({ round, ...result.failure });
  }

  return buildFallback(userRequest, previousFailures);
}
