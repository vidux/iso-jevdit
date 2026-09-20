# Contributing to iso-jevdit

Thanks for looking. The most valuable contributions right now are **new checks** and **fixture
repositories that expose false positives** — both are described in detail below.

## Before you start

Read [.claude/PLAN.md](.claude/PLAN.md). It is the design of record: the architecture, the decisions
that have already been argued through, and why. If you want to do something it rules out, that is a
fine conversation to have — open an issue and make the case, rather than working around it in a PR.

Then read the one section of [CLAUDE.md](CLAUDE.md) titled *"Jev is not a chat model"*. Everything
else in this repository is ordinary Node tooling; that part is not, and it is easy to write plausible
code that is completely wrong.

## Setup

Node.js 20.3 or newer (`AbortSignal.any` sets the floor).

```bash
git clone <this repository>
cd iso-jevdit
npm install
npm test
```

| Command | What it does |
|---|---|
| `npm run build` | Compile `src/` to `dist/` |
| `npm run dev -- <args>` | Run the CLI from source, e.g. `npm run dev -- --estimate .` |
| `npm test` | Run the test suite. Offline and free. |
| `npm run test:watch` | Same, in watch mode |
| `npm run lint` | Type-check without emitting |
| `node bin/iso-jevdit.mjs --estimate .` | Run the built CLI against this repository |

No API key is needed to build, test, or work on anything except the provider adapter.

## Layout

```
bin/iso-jevdit.mjs      shebang wrapper → dist/cli.js
src/
  cli.ts                flag grammar, dispatch, exit codes
  commands/             one file per CLI action
  config/               schema (zod), layer merging, jsonc, credentials, paths
  providers/            one adapter per provider, plus shipped defaults
  scan/                 extensions, the five ignore layers, discovery, chunking
  checks/
    catalog/            one file per Annex A control family
    kb/                 the prose that appears in the report, one file per family
    resolve.ts          include/exclude, extraChecks, overrides
  jev/                  request building, answer normalisation
  audit/                cost estimate (engine and cache to come)
  report/               redaction (markdown and json to come)
  util/                 logger, tokens, fs, git
test/
  unit/                 the suite
  fixtures/             deliberately vulnerable mini-repositories
```

## Adding a check

This is the highest-value contribution, and the criteria text matters more than the code.

**1. Write the check** in the catalog file for its control family, e.g. `src/checks/catalog/a8-crypto.ts`.
Create the file if the family has none, and export it from `src/checks/catalog/index.ts`.

```ts
{
  id: 'a8-15-missing-security-logging',   // lower-case, hyphenated, starts with the control
  title: 'Security event not logged',
  controls: ['A.8.15'],                   // Annex A 2022 references
  severity: 'medium',
  scope: 'chunk',
  languages: [...CODE_LANGUAGES],         // omit to apply to every file type
  type: 'choice',
  version: 1,                             // bump when instructions or criteria change
  instructions: { question: '...', focus: '...' },
  criteria: { violation: {...}, compliant: {...}, not_applicable: {...} },
  kb: a8LoggingKb['a8-15-missing-security-logging']!,
}
```

**2. Write the knowledge-base entry** in the matching `src/checks/kb/` file. This is what the report
prints, so write it for an auditor and a developer who has never seen the control:

- `requirement` — what the control actually asks for, in its own terms
- `why` — why it matters, mechanically; not "it is a best practice"
- `impact` — what goes wrong when it is missing
- `remediation` — what to do, concretely, including the platform primitive to reach for
- `references` — the Annex A control names

It is reviewed as prose. Vague text here makes the whole report weaker.

**3. Write the criteria carefully.** This is the detection logic:

- **Always include a no-match label** (`not_applicable`), so irrelevant code has somewhere to go
  rather than forcing a choice between two wrong answers.
- **Name the false positive you expect and exclude it.** A criteria value may be an object whose field
  names you choose — the model sees them. `what` / `not_for` / `examples` works well. The crypto check
  uses `not_for` on its `not_applicable` label to claim cache keys and checksums, which is what stops
  `md5($cacheKey)` reading as a credential-hashing violation.
- Give two or three short `examples` per label, drawn from real code.
- Question ids never reach the model, so every question must carry its full meaning in
  `instructions` and `criteria`.

**4. Add a fixture.** Put both a violating and a compliant example in `test/fixtures/`, and add the
expectation to the suite. A check without a compliant example is half-tested: precision matters as
much as recall.

**5. Run `npm test`.** The catalog is validated at import — malformed ids, missing criteria, a
`positiveLabels` entry that is not one of the criteria, a control reference that is not in Annex A
form, or missing knowledge-base text will all fail.

Do not add a check for something source code cannot evidence. Organizational, people and physical
controls belong in the report's out-of-scope appendix, not in the catalog.

## Tests

- **Never hit the network.** The suite must pass offline, with no API key. Provider behaviour is tested
  against recorded responses; add a recording rather than a live call.
- Credential tests must point `ISO_JEVDIT_HOME` at a temporary directory. A test that touches a real
  `~/.isojevdit/` will be rejected.
- Prefer a test that pins a behaviour someone could plausibly break. Several existing tests exist
  because a bug shipped: the overlap that multiplied the request count, the `--changed` paths that were
  relative to the wrong root, the user config directory being mistaken for a project root. Each one
  has a comment saying what it is defending.
- Windows and POSIX both matter. Paths in data structures are posix with forward slashes; paths shown
  to users are native. Do not compare directories with `===` — see `isSameDirectory` in
  `src/config/paths.ts` for why.

## Style

- TypeScript strict, ESM, Node ≥ 20.3. Named exports. No default exports.
- Comment only where the code cannot explain itself: a non-obvious constraint, a platform quirk, a
  unit convention, a "keep in sync with X". One line where one line works. No restating what the next
  line does, and no ceremonial JSDoc on obvious helpers.
- Secrets never reach disk except the credentials file. Everything user-visible goes through
  `src/report/redact.ts`.
- Diagnostics to stderr, results to stdout, so output stays pipeable.
- Exit codes are a documented interface (see the README). Do not invent new ones without updating both
  the README and `src/errors.ts`.
- `iso-jevdit-report.md` is an artifact an auditor reads and a repository keeps: deterministic
  ordering, stable finding ids, no wall-clock noise outside the header.

## Pull requests

- One concern per PR. A new check and a refactor of the chunker are two PRs.
- Say what you changed and why. If it changes what a finding says about someone's code — instructions,
  criteria, thresholds, severities — say that explicitly, and bump the check's `version` so cached
  answers are invalidated.
- `npm run lint && npm test` must pass.
- Add a `CHANGELOG.md` entry under `## [Unreleased]`.
- If an implementation decision contradicts `.claude/PLAN.md`, update the plan in the same PR. A plan
  that disagrees with the code is worse than no plan.

## Reporting bugs

Include the command, the version (`iso-jevdit --version`), your Node version and OS, and — for a
discovery or ignore problem — the output of `iso-jevdit --explain-ignores <path>`, which names the
exact rule that excluded a file.

For a bad finding, include the code that triggered it and the probabilities the run reported. A
disagreement about ISO interpretation is a legitimate issue: the criteria text is meant to be argued
about.

**Security problems do not go in public issues.** See [SECURITY.md](SECURITY.md).

## License

Contributions are accepted under the [MIT License](LICENSE).
