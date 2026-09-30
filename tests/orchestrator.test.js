import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import {
  runPipeline,
  callOpenRouter,
  LlmResponseError,
  OpenRouterHttpError,
  DEFAULT_MODEL,
  OPENROUTER_URL,
} from '../src/orchestrator.js';
import { getResort, getFlight, getAccommodations, getSkiPass, getGearRental } from '../src/tools/mocks.js';

// A fake LLM that returns the given replies in order and records every call.
// An unexpected extra call fails the test.
function scriptedLlm(replies) {
  const calls = [];
  const llm = async (messages) => {
    calls.push(messages);
    if (calls.length > replies.length) throw new Error(`unexpected LLM call #${calls.length}`);
    return replies[calls.length - 1];
  };
  llm.calls = calls;
  return llm;
}

const pick = (id) => ({ selected_resort_id: id, reasoning: `mock reasoning for ${id}` });

// The JSON payload sent to the Destination Agent on a given call.
const payloadOf = (call) => JSON.parse(call[1].content);

const baseRequest = Object.freeze({
  maxBudget: 2000,
  groupSize: 2,
  roomCount: 1,
  requiresSkiInOut: true,
  accommodationLevel: 7,
  vibe: 'young',
  nightlifeImportance: 7,
  skiKmImportance: 5,
  crowdTolerance: 4,
});

describe('runPipeline: success path', () => {
  test('returns a package whose total is computed from tool prices and fits the budget', async () => {
    const llm = scriptedLlm([pick('gudauri')]);
    const result = await runPipeline(baseRequest, { llm });

    assert.equal(result.status, 'success');
    assert.equal(result.resort.id, 'gudauri');
    assert.equal(result.accommodation.id, 'gu-hotel-1'); // the ski-in/ski-out hotel
    // (320 * 2) + (650 * 1) + (150 * 2) + (90 * 2) = 1770
    assert.equal(result.total, 1770);
    assert.ok(result.total <= result.maxBudget);
    assert.equal(result.remainingBudget, 230);
    assert.equal(result.negotiationRounds, 1);
    assert.equal(llm.calls.length, 1);
  });

  test('every price and link in the proposal is traceable to a Ground Truth tool result', async () => {
    const result = await runPipeline(baseRequest, { llm: scriptedLlm([pick('gudauri')]) });

    const { quantity: _f, ...flight } = result.flight;
    const { quantity: _a, ...accommodation } = result.accommodation;
    const { quantity: _p, ...skiPass } = result.skiPass;
    const { quantity: _g, ...gear } = result.gear;

    assert.deepEqual(result.resort, getResort('gudauri'));
    assert.deepEqual(flight, getFlight('gudauri'));
    assert.deepEqual(accommodation, getAccommodations('gudauri').find((h) => h.id === 'gu-hotel-1'));
    assert.deepEqual(skiPass, getSkiPass('gudauri'));
    assert.deepEqual(gear, getGearRental('gudauri'));
    for (const item of [result.flight, result.accommodation, result.skiPass, result.gear]) {
      assert.equal(item.source, 'mock');
    }
  });

  test('without ski-in/ski-out, prefers the hotel closest to the requested level', async () => {
    const request = { ...baseRequest, requiresSkiInOut: false, accommodationLevel: 4 };
    const result = await runPipeline(request, { llm: scriptedLlm([pick('gudauri')]) });

    assert.equal(result.accommodation.id, 'gu-hotel-2');
    // (320 * 2) + (350 * 1) + (150 * 2) + (90 * 2) = 1470
    assert.equal(result.total, 1470);
  });

  test('falls back to a less preferred hotel when the preferred one is over budget', async () => {
    // Level 7 prefers gu-hotel-1 (1770), which exceeds 1500; gu-hotel-2 (1470) fits.
    const request = { ...baseRequest, requiresSkiInOut: false, maxBudget: 1500 };
    const result = await runPipeline(request, { llm: scriptedLlm([pick('gudauri')]) });

    assert.equal(result.accommodation.id, 'gu-hotel-2');
    assert.equal(result.total, 1470);
  });
});

describe('runPipeline: negotiation loop', () => {
  test('a constraint failure is recorded and passed to the next Destination Agent call', async () => {
    const llm = scriptedLlm([pick('la-molina'), pick('gudauri')]);
    const result = await runPipeline(baseRequest, { llm });

    assert.equal(result.status, 'success');
    assert.equal(result.resort.id, 'gudauri');
    assert.equal(result.negotiationRounds, 2);
    assert.equal(result.previousFailures.length, 1);
    assert.equal(result.previousFailures[0].type, 'constraint');
    assert.equal(result.previousFailures[0].constraint, 'requiresSkiInOut');
    assert.match(result.previousFailures[0].message, /La Molina.*does not offer ski-in\/ski-out/);

    const secondPayload = payloadOf(llm.calls[1]);
    assert.deepEqual(secondPayload.previous_failures, [result.previousFailures[0].message]);
    assert.ok(!secondPayload.available_resorts.some((r) => r.id === 'la-molina'), 'failed resort must not be offered again');
  });

  test('a budget failure reports the computed overrun', async () => {
    const request = { ...baseRequest, requiresSkiInOut: false };
    const llm = scriptedLlm([pick('val-thorens'), pick('gudauri')]);
    const result = await runPipeline(request, { llm });

    assert.equal(result.status, 'success');
    const [failure] = result.previousFailures;
    assert.equal(failure.type, 'budget');
    // Cheapest Val Thorens package: (250 * 2) + 1300 + (380 * 2) + (200 * 2) = 2960
    assert.match(failure.message, /Val Thorens: .*costs €2960, but the budget is €2000 \(over by €960\)/);
  });

  test('an unknown resort id from the LLM is retried within the same round', async () => {
    const llm = scriptedLlm([pick('chamonix'), pick('gudauri')]);
    const result = await runPipeline(baseRequest, { llm, retryDelayMs: 0 });

    assert.equal(result.status, 'success');
    assert.equal(result.negotiationRounds, 1);
    assert.deepEqual(result.previousFailures, []);
    assert.equal(result.agentRetries.length, 1);
    assert.match(result.agentRetries[0].message, /chamonix/);
  });

  test('does not send the budget to the Destination Agent', async () => {
    const llm = scriptedLlm([pick('gudauri')]);
    await runPipeline(baseRequest, { llm });

    const payload = payloadOf(llm.calls[0]);
    assert.equal(payload.user_preferences.maxBudget, undefined);
    assert.equal(payload.user_preferences.vibe, 'young');
  });
});

describe('runPipeline: deterministic fallback', () => {
  test('after 3 failed rounds, returns a fallback naming the budget and every bottleneck', async () => {
    const request = { ...baseRequest, maxBudget: 1000 };
    const llm = scriptedLlm([pick('la-molina'), pick('gudauri'), pick('val-thorens')]);
    const result = await runPipeline(request, { llm });

    assert.equal(result.status, 'fallback');
    assert.equal(llm.calls.length, 3);
    assert.match(result.message, /^Cannot find a package matching your budget of €1000 and hard constraints\. Please compromise on: /);
    assert.deepEqual(result.compromises, ['increasing your maximum budget', 'dropping the ski-in/ski-out requirement']);
    assert.deepEqual(result.bottlenecks.map((b) => b.resortId), ['la-molina', 'gudauri', 'val-thorens']);
    assert.equal(result.total, undefined, 'a fallback must not contain a package total');
  });

  test('when the LLM never returns a usable choice, exhausts retries per round and falls back', async () => {
    // 3 rounds x (1 attempt + 2 retries) = 9 unusable replies.
    const llm = scriptedLlm(Array.from({ length: 9 }, (_, i) => [{}, { selected_resort_id: 'nowhere' }, pick('')][i % 3]));
    const result = await runPipeline(baseRequest, { llm, retryDelayMs: 0 });

    assert.equal(result.status, 'fallback');
    assert.equal(llm.calls.length, 9);
    assert.equal(result.bottlenecks.length, 3);
    assert.ok(result.bottlenecks.every((b) => b.type === 'invalid_agent_output'));
    assert.ok(result.bottlenecks.every((b) => /after 3 attempts/.test(b.message)));
  });

  test('rejects a malformed request before calling the LLM', async () => {
    for (const bad of [{ maxBudget: -5 }, { maxBudget: '2000' }, { groupSize: 0 }, { roomCount: 1.5 }]) {
      const llm = scriptedLlm([]);
      await assert.rejects(runPipeline({ ...baseRequest, ...bad }, { llm }));
      assert.equal(llm.calls.length, 0);
    }
  });
});

describe('runPipeline: inner retry loop (API/format failures do not consume negotiation rounds)', () => {
  // A fake fetch that plays back one response per call: { status, content } or { networkError }.
  function sequenceFetch(responses) {
    const requests = [];
    const impl = async () => {
      const next = responses[requests.length];
      requests.push(next);
      if (!next) throw new Error(`unexpected fetch call #${requests.length}`);
      if (next.networkError) throw new TypeError('fetch failed');
      const status = next.status ?? 200;
      const payload = next.body ?? { choices: [{ message: { content: next.content } }] };
      return {
        ok: status >= 200 && status < 300,
        status,
        json: async () => payload,
        text: async () => JSON.stringify(payload),
      };
    };
    impl.requests = requests;
    return impl;
  }

  // Runs the real callOpenRouter against the fake fetch.
  const llmVia = (fetchImpl) => (messages) => callOpenRouter(messages, { apiKey: 'k', fetchImpl });
  const gudauriJson = JSON.stringify(pick('gudauri'));

  test('an empty reply followed by a valid one succeeds in round 1', async () => {
    const fetchImpl = sequenceFetch([{ content: null }, { content: gudauriJson }]);
    const result = await runPipeline(baseRequest, { llm: llmVia(fetchImpl), retryDelayMs: 0 });

    assert.equal(result.status, 'success');
    assert.equal(result.resort.id, 'gudauri');
    assert.equal(result.negotiationRounds, 1, 'the empty reply must not consume a negotiation round');
    assert.deepEqual(result.previousFailures, []);
    assert.equal(fetchImpl.requests.length, 2);
    assert.deepEqual(result.agentRetries, [
      { round: 1, attempt: 1, message: 'OpenRouter response contained no message content' },
    ]);
  });

  test('malformed JSON, a 429 and a network error are each retried', async () => {
    for (const failure of [{ content: 'not json' }, { status: 429, body: { error: 'rate limited' } }, { networkError: true }]) {
      const fetchImpl = sequenceFetch([failure, { content: gudauriJson }]);
      const result = await runPipeline(baseRequest, { llm: llmVia(fetchImpl), retryDelayMs: 0 });

      assert.equal(result.status, 'success');
      assert.equal(result.negotiationRounds, 1);
      assert.equal(fetchImpl.requests.length, 2);
    }
  });

  test('retries do not hide a real negotiation failure in a later round', async () => {
    // Round 1: empty, then La Molina (fails ski-in/ski-out). Round 2: Gudauri.
    const fetchImpl = sequenceFetch([
      { content: '' },
      { content: JSON.stringify(pick('la-molina')) },
      { content: gudauriJson },
    ]);
    const result = await runPipeline(baseRequest, { llm: llmVia(fetchImpl), retryDelayMs: 0 });

    assert.equal(result.status, 'success');
    assert.equal(result.negotiationRounds, 2);
    assert.equal(result.previousFailures.length, 1);
    assert.equal(result.previousFailures[0].resortId, 'la-molina');
  });

  test('persistent transient API errors are fatal after the retries, not a fake budget bottleneck', async () => {
    const rateLimited = { status: 429, body: { error: 'rate limited' } };
    const fetchImpl = sequenceFetch([rateLimited, rateLimited, rateLimited]);

    await assert.rejects(
      runPipeline(baseRequest, { llm: llmVia(fetchImpl), retryDelayMs: 0 }),
      (err) => {
        assert.match(err.message, /Destination Agent unavailable after 3 attempts/);
        assert.ok(err.cause instanceof OpenRouterHttpError);
        return true;
      },
    );
    assert.equal(fetchImpl.requests.length, 3);
  });

  test('non-transient API errors (401, 404) fail immediately without retrying', async () => {
    for (const status of [401, 404]) {
      const fetchImpl = sequenceFetch([{ status, body: { error: 'nope' } }]);
      await assert.rejects(runPipeline(baseRequest, { llm: llmVia(fetchImpl), retryDelayMs: 0 }), OpenRouterHttpError);
      assert.equal(fetchImpl.requests.length, 1);
    }
  });
});

describe('callOpenRouter', () => {
  // A fake fetch that records the request and returns the given reply.
  function fakeFetch({ status = 200, content, body } = {}) {
    const requests = [];
    const impl = async (url, init) => {
      requests.push({ url, init });
      const payload = body ?? { choices: [{ message: { content } }] };
      return {
        ok: status >= 200 && status < 300,
        status,
        json: async () => payload,
        text: async () => JSON.stringify(payload),
      };
    };
    impl.requests = requests;
    return impl;
  }

  test('throws before any request when the API key is missing', async () => {
    const fetchImpl = fakeFetch({ content: '{}' });
    await assert.rejects(callOpenRouter([], { apiKey: '', fetchImpl }), /OPENROUTER_API_KEY/);
    assert.equal(fetchImpl.requests.length, 0);
  });

  test('requests JSON output from the configured model with the bearer key', async () => {
    const fetchImpl = fakeFetch({ content: '{"selected_resort_id":"gudauri"}' });
    const messages = [{ role: 'user', content: 'hi' }];
    const reply = await callOpenRouter(messages, { apiKey: 'test-key', model: DEFAULT_MODEL, fetchImpl });

    assert.deepEqual(reply, { selected_resort_id: 'gudauri' });
    const [{ url, init }] = fetchImpl.requests;
    assert.equal(url, OPENROUTER_URL);
    assert.equal(init.headers.Authorization, 'Bearer test-key');
    const sent = JSON.parse(init.body);
    assert.equal(sent.model, 'nvidia/nemotron-3-super-120b-a12b:free');
    assert.deepEqual(sent.response_format, { type: 'json_object' });
    assert.deepEqual(sent.messages, messages);
  });

  test('accepts JSON wrapped in a Markdown code fence', async () => {
    const fetchImpl = fakeFetch({ content: '```json\n{"selected_resort_id":"gudauri"}\n```' });
    assert.deepEqual(await callOpenRouter([], { apiKey: 'k', fetchImpl }), { selected_resort_id: 'gudauri' });
  });

  test('rejects non-JSON content with LlmResponseError', async () => {
    const fetchImpl = fakeFetch({ content: 'I recommend Gudauri!' });
    await assert.rejects(callOpenRouter([], { apiKey: 'k', fetchImpl }), LlmResponseError);
  });

  test('rejects a response with no message content', async () => {
    const fetchImpl = fakeFetch({ body: { choices: [] } });
    await assert.rejects(callOpenRouter([], { apiKey: 'k', fetchImpl }), LlmResponseError);
  });

  test('surfaces HTTP errors with the status code', async () => {
    const fetchImpl = fakeFetch({ status: 429, body: { error: 'rate limited' } });
    await assert.rejects(callOpenRouter([], { apiKey: 'k', fetchImpl }), /status 429/);
  });
});
