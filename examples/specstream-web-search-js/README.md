# SpecStream Web Search and Extract in E2B Sandbox (TypeScript)

This example runs a search-and-extract agent loop inside an E2B sandbox using [SpecStream](https://specstream.ai). The host script creates an E2B sandbox from the default `base` template, uploads `src/agent.mjs`, and runs it inside the sandbox. The agent calls the SpecStream Search API (`GET /v1/web-search?q=...&speed=fast`) and Extract API (`POST /v1/extract`), iterates until it collects grounded pages, and writes a short sourced Markdown answer to `/home/user/answer.md`.

Your `E2B_API_KEY` stays on your machine, and `SPECSTREAM_API_KEY` is passed only to the agent process inside the sandbox.

## Keys

Set these in `.env` (see `.env.example`):

- `E2B_API_KEY`: get one from the [E2B dashboard](https://e2b.dev/dashboard).
- `SPECSTREAM_API_KEY`: sign up at [specstream.ai](https://specstream.ai) to get $10 of free credit on sign-up, then create an API key under Agents & API in your workspace.

## Setup and run

Requires Node.js 22.19 or newer.

```bash
cp .env.example .env   # then fill in the keys
npm install
npm start
```

You can also pass a custom question:

```bash
npm start -- "What changed in TypeScript 5.9?"
```

## Typecheck and unit tests

The unit tests stub `fetch` and the E2B sandbox so they run offline with no API calls:

```bash
npm run typecheck
npm test
```
