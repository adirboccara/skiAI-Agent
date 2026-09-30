// CLI entry point: runs the orchestration pipeline once against a sample request.
// Usage: copy .env.example to .env, set OPENROUTER_API_KEY, then `node run.js`.

import { runPipeline } from './src/orchestrator.js';

// Load .env if present. A missing file is fine when the key is already set in
// the shell; callOpenRouter reports clearly if the key is missing altogether.
try {
  process.loadEnvFile();
} catch (err) {
  if (err.code !== 'ENOENT') throw err;
}

const userRequest = {
  maxBudget: 2200, // EUR, excluding spending money
  requiresSkiInOut: true,
  groupSize: 2,
  roomCount: 1,
  vibe: 'young', // mock resorts use 'young' (young/party) or 'family'
  nightlifeImportance: 9,
  skiKmImportance: 8,
  preferredTimeframe: 'February',
};

try {
  const result = await runPipeline(userRequest);
  console.log(JSON.stringify(result, null, 2));
} catch (err) {
  console.error('Fatal error while running the pipeline:');
  console.error(err);
  process.exitCode = 1;
}
