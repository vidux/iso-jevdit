# CLAUDE.md

`iso-jevdit` — an npm CLI that audits a codebase against ISO/IEC 27001:2022 Annex A using
TypeSafe's **Jev** decision model on OpenRouter, and writes `iso-jevdit-report.md`.

**Status.** Working: config + credentials, discovery with the five ignore layers, chunking and
packing, the check catalog (3 of ~36), request/answer plumbing, the OpenRouter adapter, and
`--estimate`. Not built yet: the audit engine (concurrency, cache, localization) and the report.
The design of record is [.claude/PLAN.md](.claude/PLAN.md). Read it before adding code; if an
implementation decision contradicts it, update the plan in the same change.

## The one thing to get right: Jev is not a chat model

Everything else in this repo is ordinary Node tooling. This part is not, and it is easy to write
plausible code that is completely wrong.

- Endpoint is `POST https://openrouter.ai/api/alpha/decisions` — **not** `/v1/chat/completions`.
  There are no `messages`, no `tools`, no `response_format`, no streaming, no system prompt.
- Request is `{ model, state, questions }`. `state` is an arbitrary JSON object (your app's facts —
  here: the code chunk and its metadata). `questions` is a map of key → question spec.
- Question kinds: `choice` (with a `criteria` map of label → what that label means), `noul`
  (returns a probability float), `score` (graded number).
- Response is `{ answers: { <same keys> }, usage }`. A `choice` answer has `type`, `choice`,
  `confidence`, `probabilities`. A `noul` answer has `noul: <float>`. **Jev never returns prose**,
  so it cannot produce a finding description, a remediation, or a line number. All report wording
  comes from our own control knowledge base (`src/checks/kb/`); locations come from chunk ranges
  narrowed by re-asking (`src/jev/localize.ts`).
- The adapter calls the endpoint with plain `fetch`, not `@openrouter/sdk`: on an alpha wire format
  this code has to decide for itself what a malformed response means, and it drops a dependency.
  Everything goes through the `DecisionProvider` interface in `src/providers/` — the engine never
  talks to a vendor directly.
- Model id: `~typesafe/jev-latest` (default, tracks newest) or a pin like `typesafe/jev-1.13`.
- 32,000 token context shared by `state` + `questions`. Input $0.042/M, **output $0.00/M** — asking
  more questions per request is nearly free, re-sending the same `state` is what costs money.
- `instructions` and each `criteria` entry may be a string, a structured object (`what` / `not_for` /
  `examples` is what separates look-alike labels), or null. TypeSafe takes them as-is; OpenRouter
  validates them as strings, so `providers/openrouter.ts` JSON-encodes them at the wire boundary.
- **Gate findings on the probability mass of the violation labels, never on `confidence`.**
  `confidence` only says how concentrated the distribution is, so a confident *compliant* verdict
  carries the same confidence as a confident *violation*. See `jev/answers.ts`.
- Question ids never reach the model, so mangling them is free — but every question must carry its
  full meaning in `instructions` and `criteria`.
- It is an **alpha** endpoint. Validate every response; on an unrecognised shape, record a
  tool-level error for that chunk and keep going. Never abort a run that has already been paid for.

## Commands

```
npm run build          # tsc -> dist/
npm run dev -- <args>  # tsx src/cli.ts
npm test               # vitest, offline (recorded Jev responses)
npm run test:record    # refresh cassettes against the live API (needs OPENROUTER_API_KEY)
npm run lint           # eslint + tsc --noEmit
node bin/iso-jevdit.mjs --estimate .   # cost preflight, makes no API calls
```

## Layout

`bin/` shebang wrapper → `dist/cli.js`. In `src/`: `config/` (zod schema, layer merge, jsonc,
credentials, paths), `providers/` (one adapter per provider + shared defaults), `scan/` (extensions,
ignore layers, discovery, chunking), `checks/` (`catalog/` + `kb/` + `resolve.ts`), `jev/` (request
building, answer normalisation), `audit/` (estimate; engine and cache to come), `report/` (redaction
now, markdown and json to come), `commands/` (one per CLI action), `errors.ts` (exit codes).
One catalog file per Annex A control family, with its prose in the matching `kb/` file — typed
modules rather than loose Markdown, so there is no build-time copy step and no runtime file reads.

## Conventions

- TypeScript strict, ESM, Node >= 20. Named exports.
- **Keys live in `~/.isojevdit/credentials.json` and nowhere else.** `settings.json` is committed
  team config and must never hold one. Secrets never reach the report, the cache, logs or error
  messages — everything passes through `report/redact.ts`, masked to first 8 + last 4.
- Config is provider-keyed: `providers.<name>` carries that provider's baseUrl, model, transport and
  pricing, and top-level `provider` picks the active one. Adding a provider means adding an adapter
  plus its defaults — never a branch in the engine.
- `--provider=openrouter --key=<key>` verifies the key live, writes it atomically (mode 600, plus
  `icacls` on Windows, where `fs.chmod` restricts nobody), and **always prints the file path it saved
  to**. `--key -` reads stdin for people avoiding shell history. `--clear-key [provider]` and
  `--clear-credentials` undo it, print what they removed, and are idempotent. Read precedence:
  `--key` > env (`OPENROUTER_API_KEY`) > credentials file, so CI needs no file.
- Ignoring is five layers, last word wins: shipped skip-list, `.gitignore` stack, `ignoreDirs`
  (bare names or root-relative paths — the knob for `.vscode`, `.config`), `ignore` globs, then
  `unignore` which overrides everything. Dot-directories are skipped unless in `includeDotDirs`.
  Every skipped file is reported with the rule that skipped it; silent exclusion is a bug.
- `iso-jevdit-report.md` is a committed artifact for auditors: deterministic ordering, stable
  finding ids, no wall-clock noise outside the header block.
- Tests never hit the network. Add a cassette instead.
- Comments: see the global policy — only where the code cannot explain itself.
