// Web server: serves the UI from public/ and exposes POST /api/plan.
// Usage: npm start, then open http://localhost:3000

import express from 'express';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { runPipeline, findOffSeasonWords, OFF_SEASON_MESSAGE } from './src/orchestrator.js';
import { toCents } from './src/finance.js';

const PUBLIC_DIR = fileURLToPath(new URL('./public', import.meta.url));
const VIBES = ['young', 'family'];
const SCORE_FIELDS = ['nightlifeImportance', 'skiKmImportance', 'crowdTolerance', 'accommodationLevel'];
const MAX_TIMEFRAME_LENGTH = 60;

// Thrown when the client sends a request the pipeline must not see.
export class RequestValidationError extends Error {
  constructor(message, code = 'invalid_request') {
    super(message);
    this.name = 'RequestValidationError';
    this.code = code;
  }
}

// Validates the request body and returns only the fields the pipeline uses.
// Everything is checked here so that any error from runPipeline afterwards is
// a system failure, not bad input.
export function parsePlanRequest(body) {
  if (body === null || typeof body !== 'object' || Array.isArray(body)) {
    throw new RequestValidationError('Request body must be a JSON object');
  }
  const { maxBudget, groupSize, roomCount, requiresSkiInOut, vibe } = body;

  try {
    toCents('maxBudget', maxBudget);
  } catch (err) {
    throw new RequestValidationError(err.message);
  }
  if (maxBudget === 0) {
    throw new RequestValidationError('maxBudget must be greater than 0');
  }
  if (!Number.isInteger(groupSize) || groupSize < 1) {
    throw new RequestValidationError('groupSize must be a positive integer');
  }
  if (!Number.isInteger(roomCount) || roomCount < 1 || roomCount > groupSize) {
    throw new RequestValidationError('roomCount must be an integer between 1 and groupSize');
  }
  if (typeof requiresSkiInOut !== 'boolean') {
    throw new RequestValidationError('requiresSkiInOut must be true or false');
  }
  if (!VIBES.includes(vibe)) {
    throw new RequestValidationError(`vibe must be one of: ${VIBES.join(', ')}`);
  }

  const request = { maxBudget, groupSize, roomCount, requiresSkiInOut, vibe };

  const { preferredTimeframe } = body;
  if (preferredTimeframe !== undefined) {
    if (typeof preferredTimeframe !== 'string' || preferredTimeframe.trim().length > MAX_TIMEFRAME_LENGTH) {
      throw new RequestValidationError(`preferredTimeframe must be text of at most ${MAX_TIMEFRAME_LENGTH} characters`);
    }
    if (preferredTimeframe.trim()) request.preferredTimeframe = preferredTimeframe.trim();
    if (findOffSeasonWords(preferredTimeframe).length > 0) {
      throw new RequestValidationError(OFF_SEASON_MESSAGE, 'off_season');
    }
  }

  for (const field of SCORE_FIELDS) {
    const value = body[field];
    if (value === undefined) continue;
    if (!Number.isInteger(value) || value < 1 || value > 10) {
      throw new RequestValidationError(`${field} must be an integer from 1 to 10`);
    }
    request[field] = value;
  }
  return request;
}

// `llm` can be injected for tests; by default runPipeline calls OpenRouter.
export function createApp({ llm } = {}) {
  const app = express();
  app.use(express.static(PUBLIC_DIR));
  app.use(express.json({ limit: '10kb' }));

  app.post('/api/plan', async (req, res) => {
    let request;
    try {
      request = parsePlanRequest(req.body);
    } catch (err) {
      if (!(err instanceof RequestValidationError)) throw err;
      return res.status(400).json({ error: err.message, code: err.code });
    }

    try {
      const result = await runPipeline(request, llm ? { llm } : {});
      res.json(result);
    } catch (err) {
      console.error(err);
      res.status(502).json({ error: `Planning failed: ${err.message}` });
    }
  });

  // Malformed JSON bodies get a JSON error, not Express's HTML page.
  app.use((err, req, res, next) => {
    if (err.type === 'entity.parse.failed' || err.type === 'entity.too.large') {
      return res.status(err.status).json({ error: 'Request body must be valid JSON under 10 KB' });
    }
    next(err);
  });

  return app;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    process.loadEnvFile();
  } catch (err) {
    if (err.code !== 'ENOENT') throw err;
  }
  const port = Number(process.env.PORT) || 3000;
  createApp().listen(port, () => {
    console.log(`Ski planner running at http://localhost:${port}`);
  });
}
