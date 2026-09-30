# Deploying to Render

These steps deploy the web UI and API from this GitHub repository to a free Render web service. The result is a public URL a grader can open directly. Render details were checked against Render's documentation on 2026-09-30.

## What the app needs

- **Node.js 24.** Pinned by `"engines": { "node": "24.x" }` in `package.json`; Render reads it automatically.
- **The port.** The server listens on `process.env.PORT` (fallback 3000), which Render sets for you.
- **One secret: `OPENROUTER_API_KEY`.** Without it the page loads, but every "Plan my trip" fails with *"Planning failed: OPENROUTER_API_KEY is not set"*. The `.env` file is not in the repository (it is git-ignored), so the key must be added in Render.

## Steps

1. Sign in at [render.com](https://render.com) with your GitHub account.
2. Click **New +** → **Web Service**, and select the `skiAI-Agent` repository. If it is not listed, grant Render access to it on GitHub.
3. Fill in the settings:
   - **Branch:** `main`
   - **Runtime / Language:** Node
   - **Build Command:** `npm ci`
   - **Start Command:** `npm start`
   - **Instance Type:** Free
4. Under **Environment Variables**, add:
   - `OPENROUTER_API_KEY` = your OpenRouter key. **This step is required.**
   - Optional: `OPENROUTER_MODEL`, only to override the default model (`nvidia/nemotron-3-super-120b-a12b:free`).
   - Do **not** set `PORT`; Render provides it.
5. Click **Create Web Service** and wait for the build log to end with `Ski planner running at http://localhost:<port>`. The "localhost" in that line is normal: it is the internal address.
6. Open the URL Render shows (`https://<service-name>.onrender.com`) and test it:
   - Plan the default trip (€2,200, February). Expect a result after up to a minute.
   - Enter "July" as the timeframe. The "Outside the ski season" warning should appear immediately, because no LLM call is made.

Each later push to `main` redeploys automatically.

## Before sending the URL to a grader

- **Wake the service first.** Free services spin down after 15 minutes without traffic and take about a minute to start again. Open the URL shortly before the grader will, or tell them the first load may take a minute.
- **Protect your key.** Anyone with the URL can make the app call OpenRouter with your key. Use a separate OpenRouter key for this deployment, with a credit limit if your account offers one, and delete it after grading.
- **Expect some free-model variation.** A planning request can take up to a minute on free models. If OpenRouter retires the default model, the app reports an HTTP 404 error. Fix it by setting `OPENROUTER_MODEL` in Render to another free model that supports `response_format`, with no code change.
- **Free-tier limits:** 750 free instance hours per workspace per month, and one instance.

## Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| "Planning failed: OPENROUTER_API_KEY is not set" | Key missing in Render | Add it under Environment → save → the service redeploys |
| "Planning failed: … status 401" | Wrong or revoked key | Replace the key |
| "Planning failed: … status 404" | Model retired | Set `OPENROUTER_MODEL` to a current free model |
| "Destination Agent unavailable after 3 attempts … 429" | Free model rate-limited upstream | Wait and retry, or switch `OPENROUTER_MODEL` |
| First page load takes about a minute | Service was asleep | Normal on the free tier |
