// Multi-agent orchestration pipeline.
//
// The LLM only chooses a resort. Every price and link comes from the Ground
// Truth tools, and every affordability decision is made by the deterministic
// gates in finance.js. If negotiation fails, the fallback is built in code.

import { setTimeout as sleep } from 'node:timers/promises';
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
// OpenRouter retires free models regularly; override with OPENROUTER_MODEL
// (in .env) without a code change. The default must support response_format.
export const DEFAULT_MODEL = 'nvidia/nemotron-3-super-120b-a12b:free';
export const MAX_NEGOTIATION_ROUNDS = 3;
// Extra Destination Agent attempts within one round. API/format flakiness is
// retried here so it does not consume a negotiation round.
export const MAX_AGENT_RETRIES = 2;
export const DEFAULT_RETRY_DELAY_MS = 1000;

// Thrown when the LLM's reply cannot be used (empty, not JSON, or not a valid choice).
export class LlmResponseError extends Error {
  constructor(message) {
    super(message);
    this.name = 'LlmResponseError';
  }
}

// Thrown when OpenRouter answers with a non-2xx status.
export class OpenRouterHttpError extends Error {
  constructor(status, message) {
    super(message);
    this.name = 'OpenRouterHttpError';
    this.status = status;
  }
}

// Thrown when the request to OpenRouter fails before any response arrives.
export class OpenRouterNetworkError extends Error {
  constructor(message, options) {
    super(message, options);
    this.name = 'OpenRouterNetworkError';
  }
}

// Rate limits, server errors and network failures may succeed on retry;
// auth errors, unknown models and bad requests will not.
function isTransientApiError(err) {
  return (
    err instanceof OpenRouterNetworkError ||
    (err instanceof OpenRouterHttpError && (err.status === 429 || err.status >= 500))
  );
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
  {
    apiKey = process.env.OPENROUTER_API_KEY,
    model = process.env.OPENROUTER_MODEL || DEFAULT_MODEL,
    fetchImpl = fetch,
  } = {},
) {
  if (!apiKey) {
    throw new Error('OPENROUTER_API_KEY is not set');
  }

  let response;
  try {
    response = await fetchImpl(OPENROUTER_URL, {
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
  } catch (err) {
    throw new OpenRouterNetworkError(`OpenRouter request failed: ${err.message}`, { cause: err });
  }

  if (!response.ok) {
    const body = await response.text().catch(() => '');
    throw new OpenRouterHttpError(
      response.status,
      `OpenRouter request failed with status ${response.status}: ${body.slice(0, 500)}`,
    );
  }

  const data = await response.json();
  const content = data?.choices?.[0]?.message?.content;
  if (typeof content !== 'string' || content.trim() === '') {
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

// Calls the Destination Agent, retrying API/format failures within the same
// negotiation round. Returns { choice } on success, or { error } when the LLM
// kept returning unusable output (the caller then consumes the round). Throws
// on non-transient API errors, or when transient API errors outlast the
// retries: an unreachable API is a system failure, not a budget bottleneck.
async function chooseDestinationWithRetry(round, preferences, resorts, previousFailures, options) {
  const { llm, maxRetries, retryDelayMs, retryLog } = options;

  for (let attempt = 1; ; attempt++) {
    try {
      return { choice: await destinationAgent(preferences, resorts, previousFailures, { llm }) };
    } catch (err) {
      const isBadOutput = err instanceof LlmResponseError;
      if (!isBadOutput && !isTransientApiError(err)) throw err;

      retryLog.push({ round, attempt, message: err.message });
      if (attempt > maxRetries) {
        if (isBadOutput) return { error: err, attempts: attempt };
        throw new Error(`Destination Agent unavailable after ${attempt} attempts: ${err.message}`, { cause: err });
      }
      if (retryDelayMs > 0) await sleep(retryDelayMs * attempt);
    }
  }
}

// Runs the negotiation loop: Destination Agent -> tools -> gates, up to
// maxRounds times. Returns a success proposal or the deterministic fallback.
export async function runPipeline(
  userRequest,
  {
    llm = callOpenRouter,
    maxRounds = MAX_NEGOTIATION_ROUNDS,
    maxRetries = MAX_AGENT_RETRIES,
    retryDelayMs = DEFAULT_RETRY_DELAY_MS,
  } = {},
) {
  // Reject malformed requests before spending any LLM calls.
  const budgetCents = toCents('maxBudget', userRequest.maxBudget);
  assertPositiveInteger('groupSize', userRequest.groupSize);
  assertPositiveInteger('roomCount', userRequest.roomCount);

  const previousFailures = [];
  const agentRetries = [];
  const triedResortIds = new Set();

  for (let round = 1; round <= maxRounds; round++) {
    // Resorts that already failed are not offered again.
    const availableResorts = RESORTS.filter((resort) => !triedResortIds.has(resort.id));
    if (availableResorts.length === 0) break;

    // Phase 1: Destination Agent (with inner retries).
    const { choice, error, attempts } = await chooseDestinationWithRetry(
      round,
      userRequest,
      availableResorts,
      previousFailures.map((failure) => failure.message),
      { llm, maxRetries, retryDelayMs, retryLog: agentRetries },
    );
    if (error) {
      previousFailures.push({
        round,
        type: 'invalid_agent_output',
        message: `${error.message} (after ${attempts} attempts)`,
      });
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
        agentRetries,
      };
    }
    previousFailures.push({ round, ...result.failure });
  }

  return { ...buildFallback(userRequest, previousFailures), agentRetries };
}
