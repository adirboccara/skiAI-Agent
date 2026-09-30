import { describe, test, before, after } from 'node:test';
import assert from 'node:assert/strict';

import { createApp, parsePlanRequest, RequestValidationError } from '../server.js';

const validBody = Object.freeze({
  maxBudget: 2200,
  groupSize: 2,
  roomCount: 1,
  requiresSkiInOut: true,
  vibe: 'young',
  nightlifeImportance: 9,
  skiKmImportance: 8,
});

describe('parsePlanRequest', () => {
  test('keeps only the fields the pipeline uses', () => {
    const request = parsePlanRequest({ ...validBody, injected: 'ignore me', maxBudgetOverride: 1e9 });
    assert.deepEqual(request, validBody);
  });

  test('trims preferredTimeframe and drops it when blank', () => {
    assert.equal(parsePlanRequest({ ...validBody, preferredTimeframe: '  Late January ' }).preferredTimeframe, 'Late January');
    assert.ok(!('preferredTimeframe' in parsePlanRequest({ ...validBody, preferredTimeframe: '   ' })));
  });

  const invalid = {
    'a non-object body': null,
    'an array body': [],
    'a string budget': { ...validBody, maxBudget: '2200' },
    'a zero budget': { ...validBody, maxBudget: 0 },
    'a negative budget': { ...validBody, maxBudget: -1 },
    'a sub-cent budget': { ...validBody, maxBudget: 100.005 },
    'zero people': { ...validBody, groupSize: 0 },
    'fractional rooms': { ...validBody, roomCount: 1.5 },
    'more rooms than people': { ...validBody, roomCount: 3 },
    'a non-boolean ski-in/ski-out flag': { ...validBody, requiresSkiInOut: 'yes' },
    'an unknown vibe': { ...validBody, vibe: 'party' },
    'a preference score above 10': { ...validBody, nightlifeImportance: 11 },
    'a fractional preference score': { ...validBody, crowdTolerance: 4.5 },
    'a non-string timeframe': { ...validBody, preferredTimeframe: 2 },
    'a timeframe over 60 characters': { ...validBody, preferredTimeframe: 'x'.repeat(61) },
  };
  for (const [name, body] of Object.entries(invalid)) {
    test(`rejects ${name}`, () => {
      assert.throws(() => parsePlanRequest(body), RequestValidationError);
    });
  }
});

describe('POST /api/plan', () => {
  let server;
  let baseUrl;
  let llmCalls;
  let nextReplies;

  before(async () => {
    const llm = async () => {
      llmCalls++;
      const reply = nextReplies.shift();
      if (reply instanceof Error) throw reply;
      return reply;
    };
    server = createApp({ llm }).listen(0);
    await new Promise((resolve) => server.once('listening', resolve));
    baseUrl = `http://127.0.0.1:${server.address().port}`;
  });

  after(() => new Promise((resolve) => server.close(resolve)));

  async function post(body, { raw = false } = {}) {
    llmCalls = 0;
    const response = await fetch(`${baseUrl}/api/plan`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: raw ? body : JSON.stringify(body),
    });
    return { status: response.status, body: await response.json() };
  }

  const reply = (id, recommendedDates) => ({
    selected_resort_id: id,
    recommendedDates,
    reasoning: { resortReasoning: `${id} fits`, dateReasoning: `${recommendedDates} has good snow` },
  });

  test('returns the pipeline proposal for a valid request', async () => {
    nextReplies = [reply('gudauri', 'Early February')];
    const { status, body } = await post({ ...validBody, preferredTimeframe: 'February' });

    assert.equal(status, 200);
    assert.equal(body.status, 'success');
    assert.equal(body.resort.id, 'gudauri');
    assert.equal(body.recommendedDates, 'Early February');
    assert.deepEqual(body.destinationReasoning, {
      resortReasoning: 'gudauri fits',
      dateReasoning: 'Early February has good snow',
    });
    assert.equal(body.total, 1770);
    assert.equal(body.maxBudget, 2200);
  });

  test('returns the deterministic fallback when nothing fits', async () => {
    nextReplies = [
      reply('la-molina', 'Late January'),
      reply('gudauri', 'Mid January'),
      reply('val-thorens', 'Mid January'),
      reply('bansko', 'Mid January'),
      reply('mayrhofen', 'Late January'),
      reply('ischgl', 'Late January'),
    ];
    const { status, body } = await post({ ...validBody, maxBudget: 500 });

    assert.equal(status, 200);
    assert.equal(body.status, 'fallback');
    assert.match(body.message, /budget of €500/);
  });

  test('rejects invalid input with 400 before calling the LLM', async () => {
    nextReplies = [];
    const { status, body } = await post({ ...validBody, roomCount: 5 });

    assert.equal(status, 400);
    assert.match(body.error, /roomCount/);
    assert.equal(llmCalls, 0);
  });

  test('rejects an off-season timeframe with a 400 off_season error before calling the LLM', async () => {
    nextReplies = [];
    const { status, body } = await post({ ...validBody, preferredTimeframe: 'late July' });

    assert.equal(status, 400);
    assert.equal(body.code, 'off_season');
    assert.equal(body.error, 'These months are outside the ski season for our destinations. Please select a timeframe between December and April.');
    assert.equal(llmCalls, 0);
  });

  test('other invalid input is reported with the invalid_request code', async () => {
    const { body } = await post({ ...validBody, vibe: 'party' });
    assert.equal(body.code, 'invalid_request');
  });

  test('rejects malformed JSON with a JSON 400', async () => {
    const { status, body } = await post('{"maxBudget": ', { raw: true });

    assert.equal(status, 400);
    assert.match(body.error, /valid JSON/);
  });

  test('reports a pipeline failure as 502 with the reason', async () => {
    nextReplies = [new Error('OPENROUTER_API_KEY is not set')];
    const { status, body } = await post(validBody);

    assert.equal(status, 502);
    assert.match(body.error, /^Planning failed: OPENROUTER_API_KEY is not set/);
  });

  test('serves the web UI', async () => {
    const response = await fetch(`${baseUrl}/`);
    assert.equal(response.status, 200);
    assert.match(await response.text(), /<form id="plan-form"/);
  });
});
