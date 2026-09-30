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
// One round per resort (6 today), so the agent can work through every
// over-budget or constraint-failing option before the fallback triggers.
export const MAX_NEGOTIATION_ROUNDS = RESORTS.length;
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
  'preferredTimeframe',
];

const DESTINATION_SYSTEM_PROMPT = `You are the Destination Agent in a ski vacation planner.
Choose the single resort from "available_resorts" that best matches "user_preferences".
Weigh vibe, nightlife, crowdedness and ski area size. If "requiresSkiInOut" is true, prefer resorts with skiInSkiOutAvailable = true.
If "preferredTimeframe" is given, prefer resorts whose optimalSnowWeeks match it.
Then recommend when to go: copy exactly ONE entry from the chosen resort's "optimalSnowWeeks", the one closest to "preferredTimeframe" (or the best one if no timeframe is given).
"previous_failures" lists resorts already rejected by the budget and constraint checks and why; learn from them.
Use ONLY the data provided. Do not mention or estimate prices, and do not invent facts about resorts or dates.
Explain your choice in two parts:
- "resortReasoning": why this resort fits the user's vibe, nightlife and crowd preferences, citing the resort's data.
- "dateReasoning": why this week was chosen, relative to "preferredTimeframe" and the resort's optimalSnowWeeks.
  If the week is in a different month than the user's "preferredTimeframe", you MUST name the requested month and acknowledge the compromise,
  e.g. "You requested April, but the best snow here ends earlier. The closest recommended time is Mid March."
Respond with JSON only, in exactly this shape:
{"selected_resort_id": "<one id from available_resorts>", "recommendedDates": "<one entry from that resort's optimalSnowWeeks>", "reasoning": {"resortReasoning": "<one or two sentences>", "dateReasoning": "<one sentence>"}}`;

const MONTHS = [
  'january', 'february', 'march', 'april', 'may', 'june',
  'july', 'august', 'september', 'october', 'november', 'december',
];

// Our destinations' ski season runs December to April; any other month, or a
// named off-season, is rejected before the LLM is called.
const OFF_SEASON_WORDS = [
  'may', 'june', 'july', 'august', 'september', 'october', 'november',
  'summer', 'autumn', 'fall',
];

export const OFF_SEASON_MESSAGE =
  'These months are outside the ski season for our destinations. Please select a timeframe between December and April.';

// Thrown when the requested timeframe is outside the ski season.
export class OffSeasonError extends Error {
  constructor(offSeasonWords) {
    super(OFF_SEASON_MESSAGE);
    this.name = 'OffSeasonError';
    this.offSeasonWords = offSeasonWords;
  }
}

function wordsIn(text) {
  return String(text).toLowerCase().match(/[a-z]+/g) ?? [];
}

// Month names mentioned in free text, e.g. "late Jan or February" -> ['february'].
// Only full month names count, so the check never guesses at abbreviations.
function monthsIn(text) {
  const words = wordsIn(text);
  return MONTHS.filter((month) => words.includes(month));
}

// Deterministic seasonal gate. Returns the off-season words found in the
// timeframe (e.g. ['july']); an empty array means the timeframe is in season.
export function findOffSeasonWords(preferredTimeframe) {
  if (!preferredTimeframe) return [];
  const words = wordsIn(preferredTimeframe);
  return OFF_SEASON_WORDS.filter((word) => words.includes(word));
}

// Reasoning is shown to users, so it may not state prices: those come only from tools.
const PRICE_MENTION = /[€$£]|\b(eur|euros?|usd|dollars?|gbp|pounds?)\b/i;

// Validates the agent's structured reasoning. Returns an error message or null.
export function checkReasoning(reasoning) {
  for (const field of ['resortReasoning', 'dateReasoning']) {
    const text = reasoning?.[field];
    if (typeof text !== 'string' || text.trim() === '') {
      return `Destination Agent reply is missing reasoning.${field}`;
    }
    if (PRICE_MENTION.test(text)) {
      return `Destination Agent reasoning.${field} mentions a price, which only the tools may provide`;
    }
  }
  return null;
}

// Deterministic gate on the agent's date pick: it must be one of the resort's
// optimalSnowWeeks, and when the user named a month that the resort has good
// weeks in, it must be in that month. Returns an error message or null.
export function checkRecommendedDates(recommendedDates, resort, preferredTimeframe) {
  if (!resort.optimalSnowWeeks.includes(recommendedDates)) {
    return `Destination Agent recommended "${recommendedDates}" for ${resort.name}, which is not one of its optimalSnowWeeks`;
  }
  if (preferredTimeframe) {
    const wanted = monthsIn(preferredTimeframe);
    const resortHasWantedMonth = resort.optimalSnowWeeks.some((week) => monthsIn(week).some((m) => wanted.includes(m)));
    if (resortHasWantedMonth && !monthsIn(recommendedDates).some((m) => wanted.includes(m))) {
      return `Destination Agent recommended "${recommendedDates}" for ${resort.name}, but the user asked for "${preferredTimeframe}" and the resort has good snow then`;
    }
  }
  return null;
}

// When the recommended week is outside the months the user asked for, the
// dateReasoning must name at least one requested month, so the shift is
// acknowledged rather than silent. Returns an error message or null.
export function checkDateShiftAcknowledged(dateReasoning, recommendedDates, preferredTimeframe) {
  const wanted = monthsIn(preferredTimeframe ?? '');
  if (wanted.length === 0) return null;
  if (monthsIn(recommendedDates).some((month) => wanted.includes(month))) return null;
  if (monthsIn(dateReasoning).some((month) => wanted.includes(month))) return null;
  return `Destination Agent moved the trip from "${preferredTimeframe}" to "${recommendedDates}" without acknowledging the requested month in dateReasoning`;
}

// Asks the LLM to pick one resort and a week to go, with structured reasoning.
// Throws LlmResponseError if the resort is not one of the offered ids, or the
// dates or reasoning fail their checks.
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
  const resort = resorts.find((candidate) => candidate.id === selectedResortId);
  if (!resort) {
    throw new LlmResponseError(
      `Destination Agent selected "${selectedResortId}", which is not one of the offered resorts`,
    );
  }

  const datesProblem = checkRecommendedDates(reply.recommendedDates, resort, preferences.preferredTimeframe);
  if (datesProblem) throw new LlmResponseError(datesProblem);

  const reasoningProblem = checkReasoning(reply.reasoning);
  if (reasoningProblem) throw new LlmResponseError(reasoningProblem);

  const shiftProblem = checkDateShiftAcknowledged(
    reply.reasoning.dateReasoning,
    reply.recommendedDates,
    preferences.preferredTimeframe,
  );
  if (shiftProblem) throw new LlmResponseError(shiftProblem);

  return {
    selectedResortId,
    recommendedDates: reply.recommendedDates,
    reasoning: {
      resortReasoning: reply.reasoning.resortReasoning.trim(),
      dateReasoning: reply.reasoning.dateReasoning.trim(),
    },
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
  const offSeasonWords = findOffSeasonWords(userRequest.preferredTimeframe);
  if (offSeasonWords.length > 0) throw new OffSeasonError(offSeasonWords);

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
        recommendedDates: choice.recommendedDates,
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
