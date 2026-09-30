import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import {
  runPipeline,
  callOpenRouter,
  LlmResponseError,
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

  test('an unknown resort id from the LLM counts as a failed round, not a crash', async () => {
    const llm = scriptedLlm([pick('chamonix'), pick('gudauri')]);
    const result = await runPipeline(baseRequest, { llm });

    assert.equal(result.status, 'success');
    assert.equal(result.previousFailures[0].type, 'invalid_agent_output');
    assert.match(result.previousFailures[0].message, /chamonix/);
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

  test('when the LLM never returns a usable choice, still falls back deterministically', async () => {
    const llm = scriptedLlm([{}, { selected_resort_id: 'nowhere' }, pick('')]);
    const result = await runPipeline(baseRequest, { llm });

    assert.equal(result.status, 'fallback');
    assert.equal(result.bottlenecks.length, 3);
    assert.ok(result.bottlenecks.every((b) => b.type === 'invalid_agent_output'));
  });

  test('rejects a malformed request before calling the LLM', async () => {
    for (const bad of [{ maxBudget: -5 }, { maxBudget: '2000' }, { groupSize: 0 }, { roomCount: 1.5 }]) {
      const llm = scriptedLlm([]);
      await assert.rejects(runPipeline({ ...baseRequest, ...bad }, { llm }));
      assert.equal(llm.calls.length, 0);
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
    const reply = await callOpenRouter(messages, { apiKey: 'test-key', fetchImpl });

    assert.deepEqual(reply, { selected_resort_id: 'gudauri' });
    const [{ url, init }] = fetchImpl.requests;
    assert.equal(url, OPENROUTER_URL);
    assert.equal(init.headers.Authorization, 'Bearer test-key');
    const sent = JSON.parse(init.body);
    assert.equal(sent.model, DEFAULT_MODEL);
    assert.equal(sent.model, 'meta-llama/llama-3.1-8b-instruct:free');
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
