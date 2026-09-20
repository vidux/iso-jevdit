# iso-jevdit — implementation plan

An npm CLI that audits a codebase against **ISO/IEC 27001:2022 Annex A** using TypeSafe's **Jev**
decision model (via OpenRouter's alpha Decisions endpoint) and writes a detailed
`iso-jevdit-report.md`.

```
iso-jevdit --provider=openrouter --key=sk-or-v1-...   # store credentials, once
iso-jevdit                                            # audit cwd
iso-jevdit src/auth/token.php                         # audit one file
iso-jevdit ./packages/api --out api-audit.md          # audit a folder
iso-jevdit --clear-credentials                        # remove stored keys
```

## 1. Scope

**In scope.** Recursive discovery of non-ignored source files by extension; a shipped catalog of
code-observable Annex A checks; per-chunk decisions from Jev with calibrated probabilities;
thresholds, ignore paths, extra checks and extra prompt context configurable per project in
`.isojevdit/settings.json`; a Markdown report with evidence, ISO clause mapping, remediation and a
scope/methodology appendix; a JSON sibling for CI.

**Out of scope.** Certification, management-system clauses 4–10, organizational/people/physical
controls (an appendix names them as not-assessable-from-code), runtime/DAST, dependency CVE lookups
against a vulnerability database (we judge *pinning and provenance hygiene*, not CVE identity), and
autofix. The tool produces **AI-assisted evidence for a human auditor**, and the report says so.

## 2. Decisions of record

| # | Decision | Why |
|---|---|---|
| 1 | **Report prose comes from a built-in control KB**, never from a model | Jev emits no text at all; a KB makes remediation advice reviewable, versioned, and impossible to hallucinate |
| 2 | **Every eligible chunk is sent to Jev** — no local regex prefilter gate | Max recall; recall must not be capped by hand-written patterns. Cost is controlled by packing, caching and `--estimate` instead |
| 3 | **Code-observable control subset** (~36 checks) | Only claims what source can evidence; the rest is listed in a coverage appendix |
| 4 | **TypeScript → `dist/`, ESM, Node ≥ 20** | Typed question/answer specs catch catalog mistakes at build time |
| 5 | **Provider-keyed config behind an adapter interface** | `--provider` selects a config set; new providers are new adapters, not new branches |
| 6 | **Keys live only in `~/.isojevdit/credentials.json`**, never in `settings.json` | `settings.json` is meant to be committed; a separate user-level file can never enter a repo |
| 7 | **Findings are gated on probability mass, not `confidence`** | TypeSafe's docs are explicit that `confidence` measures how concentrated the distribution is - a confident *compliant* scores as high as a confident *violation* |
| 8 | **Criteria may be structured objects** (`what` / `not_for` / `examples`) | The documented way to separate labels a model confuses; `not_for` is what stops md5-for-cache-keys reading as a crypto violation |
| 9 | **The adapter uses plain `fetch`, not `@openrouter/sdk`** | An alpha wire format needs its own validation and retry policy, and it removes a dependency from a security tool |
| 10 | **KB prose lives in typed `kb/*.ts` modules**, not loose Markdown | No build-time copy step, no runtime file reads, and the reporter gets structured fields instead of parsed headings |

## 3. The model (facts that constrain the design)

`POST https://openrouter.ai/api/alpha/decisions`, `Authorization: Bearer <key>`. Not
chat-completions: no `messages`, no `tools`, no `response_format`, no streaming.

```ts
const res = await openrouter.alpha.decisions.create({
  decisionsRequest: {
    model: '~typesafe/jev-latest',
    state: { /* arbitrary JSON: our code chunk + metadata */ },
    questions: {
      support: {
        type: 'choice',
        instructions: 'Compare assistant_answer against help_center_excerpts. Which one describes it?',
        criteria: {
          supported: 'The answer addresses customer_question, and every fact ... is stated in the excerpts.',
          unsupported: 'The answer states at least one fact ... the excerpts do not contain ...',
          declined: 'The answer says the excerpts do not cover the question ...',
        },
      },
    },
  },
});
const a = res.answers.support;   // { type:'choice', choice, confidence, probabilities }
```

- Question kinds: `choice` (labels defined by `criteria`), `noul` (answer is `{ noul: <0..1> }`),
  `score` (graded number). A `choice` takes up to 255 labels.
- `instructions` and each `criteria` entry may be a string, a structured object whose field names the
  model also sees, or null. OpenRouter validates both as strings, so `providers/openrouter.ts`
  JSON-encodes structured values at the wire boundary; a null definition becomes the label name.
- Question ids are never shown to the model, so mangling them is free - and every question must carry
  its full meaning in `instructions` and `criteria`.
- Native TypeSafe is `POST https://api.typesafe.ai/v1/systemone` with the same shape, which is what
  the planned `typesafe` provider will use.
- **32,000 token context, shared by `state` + `questions`.** Input **$0.042/M**, output **$0.00/M**.
- Consequences that shape everything below:
  1. No prose → §9 KB supplies all wording.
  2. No line numbers → §11 localization narrows by re-asking sub-slices.
  3. Output is free, input is not → ask *many* questions over *one* state; the question block, not
     the code, is the dominant cost (§8.3).
  4. Alpha endpoint → validate responses, degrade per-chunk, never lose a paid run (§16).

## 4. Pipeline

```
target path
   ↓  scan/discover.ts      gitignore stack, ignore config, extension map, size/binary filters
files[]
   ↓  scan/chunk.ts         boundary-aware split + small-file packing, token budget
chunks[]                    (a chunk = one or more contiguous file regions)
   ↓  checks/catalog        applicable checks per chunk (language/glob filter)
   ↓  audit/cache.ts        content-hash lookup; hit → reuse answers, $0
   ↓  jev/request.ts        build { state, questions } (all checks that fit)
   ↓  providers/*           adapter call, retry/backoff, usage accounting
answers[]
   ↓  audit/findings.ts     threshold gate, dedupe across overlap, stable ids, waivers
   ↓  jev/localize.ts       narrow positives to a line window (re-ask sub-slices)
findings[]
   ↓  report/markdown.ts    KB text + evidence + ISO mapping   → iso-jevdit-report.md
   ↓  report/json.ts        machine sibling                    → iso-jevdit-report.json
exit code
```

### Module layout

```
bin/iso-jevdit.mjs            shebang → dist/cli.js
src/
  cli.ts                      arg parse, subcommand dispatch, exit codes
  commands/audit.ts           the default action
  commands/credentials.ts     --provider, --key, --show-config, --clear-key, --clear-credentials
  commands/init.ts            scaffold .isojevdit/{settings.json,schema.json,.gitignore}
  commands/checks.ts          --list-checks
  errors.ts                   exit codes + the error type that carries them
  config/schema.ts            zod schema + shipped defaults + JSON Schema emit
  config/load.ts              resolution chain, deep merge, unknown-key warnings
  config/jsonc.ts             comments and trailing commas in settings.json
  config/paths.ts             ISO_JEVDIT_HOME, credentials/settings paths, project root search
  config/credentials.ts       ~/.isojevdit/credentials.json: read, atomic write, clear
  providers/types.ts          DecisionProvider interface
  providers/openrouter.ts     alpha decisions adapter (fetch), retry/backoff, wire encoding
  providers/defaults.ts       per-provider baseUrl / model / context / pricing / key-check URL
  providers/index.ts          registry + resolve(activeProvider)
  scan/extensions.ts          default extension + bare-filename map
  scan/ignore.ts              ignore layering: shipped skips, config, gitignore stack, unignore
  scan/discover.ts            walker
  scan/chunk.ts               chunker + packer + token estimator
  checks/types.ts             Check, Severity, Scope, QuestionSpec
  checks/catalog/a5-*.ts      one file per control family
  checks/catalog/a8-*.ts
  checks/repo.ts              repo-scope state builder (manifests, CI, Dockerfile)
  checks/kb/<family>.ts       what / why / impact / remediation / references, as typed modules
  checks/resolve.ts           include/exclude, extraChecks, severity and threshold overrides
  jev/request.ts              state+questions assembly, key mangling, batching
  jev/answers.ts              defensive normalisation + the positive-probability gate
  jev/localize.ts             narrowing pass
  audit/estimate.ts           cost/token forecast, shared by --estimate and the spend guard
  audit/engine.ts             orchestration, concurrency pool, progress, budget guard
  audit/cache.ts              content-hash cache
  audit/findings.ts           gate, dedupe, merge, stable ids, waiver matching
  report/markdown.ts
  report/json.ts
  report/redact.ts            secret masking (applies to report, cache, logs)
  util/{tokens,logger,git,fs}.ts
test/fixtures/                deliberately vulnerable mini-repos per check
test/cassettes/               recorded Jev responses; tests are offline
```

## 5. Provider layer

```ts
export interface DecisionProvider {
  readonly name: string;
  readonly contextTokens: number;
  readonly pricing: { inputPerMTok: number; outputPerMTok: number };
  verifyKey(key: string): Promise<{ ok: boolean; detail?: string }>;
  decide(
    req: { model: string; state: unknown; questions: Record<string, QuestionSpec> },
    opts: { signal: AbortSignal },
  ): Promise<{ answers: Record<string, RawAnswer>; usage: Usage }>;
}
```

`openrouter` is the only adapter in v1: `alpha.decisions.create`, plus `X-Title: iso-jevdit` for
attribution, and `GET /api/v1/key` for `verifyKey`. Shipped defaults per provider live in
`providers/defaults.ts`, so a user who supplies a key needs nothing else:

| provider | baseUrl | default model | transport | context | $/Mtok in / out |
|---|---|---|---|---|---|
| `openrouter` | `https://openrouter.ai` | `~typesafe/jev-latest` | `decisions` | 32000 | 0.042 / 0.00 |
| `typesafe` *(planned)* | TypeSafe native API | `jev-latest` | `decisions` | 32000 | tbd |
| *any chat model* *(planned)* | — | — | `chat-emulated` | — | — |

`transport: 'chat-emulated'` is the extension point for providers with no decisions endpoint: same
`QuestionSpec` in, `choice` + `probabilities` reconstructed from a structured-output response, with
the report marking such runs as **emulated confidence — not calibrated**. No engine code changes.

## 6. Configuration

### 6.1 Resolution order (later wins)

1. Shipped defaults (`config/schema.ts`)
2. User level: `~/.isojevdit/settings.json`
3. Project level: `<scan root>/.isojevdit/settings.json` (nearest ancestor containing `.isojevdit/`)
4. `--config <file>`
5. Environment: `ISO_JEVDIT_PROVIDER`, `ISO_JEVDIT_MODEL`, `ISO_JEVDIT_CONCURRENCY`, …
6. CLI flags

Credentials are **not** part of this chain — see §6.3.

Objects deep-merge. Arrays replace, except `extraExtensions` / `ignore` / `ignoreDirs` / `unignore` /
`extraChecks`, which append. Unknown keys are a **warning naming the nearest valid key** (typo
protection), not an error; `--strict-config` promotes them to errors. Invalid values are always fatal
(exit 2) with the JSON path and the accepted range.

### 6.2 `.isojevdit/settings.json`

Committed, shared with the team, contains no secrets.

```jsonc
{
  "$schema": "./schema.json",

  "provider": "openrouter",
  "providers": {
    "openrouter": {
      // no apiKey here - credentials live in ~/.isojevdit/credentials.json (6.3)
      "apiKeyEnv": "OPENROUTER_API_KEY",   // env var consulted before the credentials file
      "baseUrl": "https://openrouter.ai",
      "model": "~typesafe/jev-latest",
      "headers": {},
      "timeoutMs": 60000,
      "maxRetries": 4
    }
  },

  "extensions": [".php", ".js", ".mjs", ".ts", ".h"],   // replaces the shipped list
  "extraExtensions": [".blade.php", ".twig"],           // appends to it
  "filenames": ["Dockerfile", "docker-compose.yml", ".gitlab-ci.yml"],

  "ignoreDirs": [".vscode", ".idea", ".config", "storage/logs", "docs/generated"],
  "ignore": ["vendor/**", "**/*.min.js", "**/__snapshots__/**", "**/*.generated.*"],
  "unignore": ["config/security.php", ".github/workflows/**"],
  "ignoreDefaults": true,
  "includeDotDirs": [".github", ".gitlab", ".circleci", ".docker"],
  "respectGitignore": true,
  "maxFileSizeKb": 512,
  "followSymlinks": false,

  "chunk": { "maxTokens": 8000, "overlapLines": 20, "pack": true, "packSameDirOnly": true },
  "localize": { "enabled": true, "slices": 3, "maxDepth": 2, "minLines": 12 },
  "concurrency": 4,
  "maxSpendUsd": 1.0,

  "thresholds": {
    "report": 0.60,                                     // below this, a positive is discarded
    "high": 0.80,                                       // confidence that earns full severity
    "perCheck": { "a8-24-weak-password-hash": 0.85 }
  },
  "severityOverrides": { "a8-15-missing-security-logging": "low" },

  "checks": { "include": ["*"], "exclude": ["a8-6-*"] },
  "extraChecks": [
    {
      "id": "org-1-no-plaintext-pii-export",
      "title": "Customer PII must not be written to CSV exports",
      "controls": ["A.8.11", "A.5.34"],
      "severity": "high",
      "scope": "chunk",
      "appliesTo": ["**/*.php", "**/export/**"],
      "type": "choice",
      "instructions": "Does this code write customer PII to a file or export without masking?",
      "criteria": {
        "violation": "PII fields (name, email, phone, address, national id) reach a file/CSV/stream unmasked.",
        "compliant": "PII is masked, tokenised, or no PII reaches an export here.",
        "not_applicable": "This code does not export data."
      },
      "threshold": 0.75,
      "remediation": "Route exports through App\\Export\\Masker."
    }
  ],

  "prompts": {
    "projectContext": "PHP 8.2 payment service; PII lives in the customers table; auth is in src/Auth.",
    "append": { "a8-28-sql-injection": "Queries built by QueryBuilder are parameterised." }
  },

  "report": {
    "out": "iso-jevdit-report.md",
    "json": true,
    "includePassed": true,
    "includeConfig": true,
    "snippetLines": 6,
    "maxFindingsPerCheck": 50,
    "groupBy": "control",
    "timestamp": true
  },

  "cache": { "enabled": true, "dir": ".isojevdit/cache", "ttlDays": 30 },
  "waivers": ".isojevdit/waivers.json",
  "failOn": "high",
  "redactSecrets": true
}
```

`prompts.projectContext` is injected into every `state` as a `project_context` field, and
`prompts.append[checkId]` is concatenated onto that check's `instructions` — the two hooks that let a
project correct the tool's false positives without forking the catalog.

### 6.3 Credentials — `~/.isojevdit/credentials.json`

One user-level file, outside every repository, holding one entry per provider:

```jsonc
{
  "version": 1,
  "openrouter": {
    "apiKey": "sk-or-v1-...",
    "savedAt": "2026-09-20T02:47:11Z",
    "lastVerifiedAt": "2026-09-20T02:47:12Z",
    "label": "personal"
  }
}
```

`--provider` selects the config set for the run. It does not persist that choice while only one
provider exists: persisting it means patching a commented settings.json, which needs a
comment-preserving writer rather than a re-serialise.

**Saving.** `iso-jevdit --provider=openrouter --key=sk-or-v1-...`:

1. Resolve the provider (default `provider` from config, or `--provider`).
2. `verifyKey()` against the provider's key endpoint, so a typo fails now, not at the first audit.
   `--no-verify` skips it for offline setup.
3. Write atomically: `credentials.json.tmp` → `chmod 600` → rename. Create `~/.isojevdit/` with mode
   700 if missing.
4. On Windows, `fs.chmod` only toggles the read-only bit and does **not** restrict other users, so
   also run `icacls <file> /inheritance:r /grant:r "%USERNAME%":F`. If that fails, warn rather than
   abort.
5. Print where it went, always — the confirmation is the feature:

```
Credential saved.
  provider   openrouter
  key        sk-or-v1-****************************9f2a
  verified   yes (credits available)
  file       C:\Users\<you>\.isojevdit\credentials.json  (permissions restricted to you)

  Note: --key was passed on the command line, so it is in your shell history
        (PowerShell: PSReadLine's ConsoleHost_history.txt, in plaintext).
        Next time: Get-Content key.txt | iso-jevdit --key -
```

6. If a target path was also given, the audit then continues in the same invocation. `--no-save` uses
   the key for that run only and writes nothing.

`--key -` reads the key from stdin, which keeps it out of shell history and CI logs.

**Clearing.**

```
iso-jevdit --clear-key                 # active provider's entry
iso-jevdit --clear-key openrouter      # a named provider's entry
iso-jevdit --clear-credentials         # every entry, then delete the file
```

Both report exactly what was removed and from which path, are idempotent (exit 0 with "nothing
stored" when already empty), and never touch `settings.json`:

```
Credential cleared.
  provider   openrouter
  file       C:\Users\<you>\.isojevdit\credentials.json
  remaining  none (file removed)
```

**Reading.** Precedence: `--key` → env (`apiKeyEnv`, default `OPENROUTER_API_KEY`) → this file. Env
first means CI needs no file at all. A key found in `settings.json` (a hand-edited legacy layout) is
still honoured, with a warning naming the file and suggesting `--key` to migrate it. No key → exit 3:

```
No credential for provider "openrouter".
  Save one:  iso-jevdit --provider=openrouter --key=<key>
  Or set:    OPENROUTER_API_KEY
```

**Masking.** `report/redact.ts` runs on every sink — report, `--show-config`, logs, cache, error
messages — and prints keys as first 8 + last 4 only. No encryption at rest: anything the tool can
decrypt unattended is obfuscation, and the docs say so plainly (same posture as `gh`, `npm` and the
AWS CLI). `credentials.json` is the seam where a `store: "keychain"` backend can be added later
without touching callers.

## 7. File discovery

Shipped extension list (configurable): `.php .phtml .js .mjs .cjs .jsx .ts .mts .cts .tsx .vue
.svelte .py .rb .go .rs .java .kt .kts .scala .cs .c .h .cpp .hpp .cc .hh .m .mm .swift .pl .sh
.bash .zsh .ps1 .sql .yml .yaml .json .toml .ini .conf .env.example .tf .hcl .xml .gradle .cmake`,
plus bare filenames `Dockerfile Makefile docker-compose.yml .htaccess nginx.conf` and
`.github/workflows/*.yml`.

### 7.1 Ignore layering

Applied in this order, last word wins:

1. **Shipped skip-list** (`ignoreDefaults: true`): `.git`, `node_modules`, `vendor`, `dist`, `build`,
   `out`, `coverage`, `.venv`, `target`, `__pycache__`, lockfiles, `*.min.*`, `*.map`. Setting
   `ignoreDefaults: false` drops all of it and hands full control to the config.
2. **`.gitignore` stack** when `respectGitignore` — every level, not just the root: root file, nested
   `.gitignore` files, `.git/info/exclude`, and the global `core.excludesFile`, via the `ignore`
   package. Negations (`!keep.php`) inside those files work.
3. **`ignoreDirs`** — the simple knob, for people who do not want to write globs. Each entry is
   either a bare directory name matched at any depth (`.vscode`, `.idea`, `.config`, `node_modules`)
   or a path relative to the scan root (`storage/logs`, `docs/generated`). Matching a directory prunes
   the whole subtree, so the walker never descends into it.
4. **`ignore`** — full glob patterns for finer cuts (`**/*.min.js`, `tests/snapshots/**`).
5. **`unignore`** — globs that override *any* of the above, including `.gitignore`. This is how a
   generated-but-security-relevant file, or a gitignored `.env.example`, gets audited anyway.
   A directory is also kept walkable when an unignore pattern could match something inside it
   (`unignore: ['storage/**']` has to stop `storage/` being pruned, or the walker would never reach
   the file to un-ignore it). Name-based rules are re-checked against every directory on a file's
   path, so walking into an excluded tree cannot leak the rest of its files.

Dot-directories are skipped by default, because most (`.vscode`, `.idea`, `.cache`, `.pytest_cache`)
are editor or tool state. The exceptions are audit-relevant CI config, so `includeDotDirs` defaults to
`[".github", ".gitlab", ".circleci", ".docker"]` and is extensible; `.git` can never be re-included.

### 7.2 Other filters

- Binary guard: NUL byte in the first 8 KB. Minified guard: mean line length > 400 chars.
- `maxFileSizeKb` skips giants.
- Every skipped file is counted and listed in the report's scope appendix **with the rule that
  skipped it** (`ignoreDirs: .vscode`, `gitignore: /storage`, `maxFileSizeKb`), so nothing disappears
  silently and a surprising ignore is traceable to its source. `--explain-ignores <path>` answers
  "why was this file not scanned?" for one path.
- **An explicitly named file path is always audited**, even if ignored or oversized — an explicit
  argument outranks every filter. A named *directory* is walked with filters applied.

## 8. Chunking, packing, cost

### 8.1 Chunking

Split at the outermost syntactic boundary a cheap heuristic can find: blank line at brace depth 0, or
a line matching a per-language top-level declaration pattern (`function`, `class`, `def`, `func`,
`public`, …). No parser. Never split mid-string-literal (track quote state). Each chunk records
`path`, `language`, `startLine`, `endLine`; `overlapLines: 20` of trailing context carries into the
next chunk so a straddling violation is visible in at least one of them (dedupe in §12 removes the
double report).

### 8.2 Packing small files

Files smaller than the budget are packed into one composite chunk — same language, same directory
when `packSameDirOnly`, budget-bounded:

```json
{ "files": [ { "path": "src/auth/hash.php",    "start_line": 1, "content": "..." },
             { "path": "src/auth/session.php", "start_line": 1, "content": "..." } ] }
```

The question set is asked **once** over the pack; localization (§11) resolves which member file
triggered. Risk: Jev may reason across two unrelated files; mitigated by same-directory packing and
by localization having to confirm the positive on the single file alone.

### 8.3 Cost model

Output is free, so cost = input tokens. The question block (~35 checks × instructions + criteria ≈
4K tokens) is re-sent with every request, which makes **requests**, not code volume, the cost driver:

| repo | code tokens | chunk budget | requests | input tokens | cost |
|---|---|---|---|---|---|
| 400 files, 2.4 MB, no packing | 600K | 8K | ~450 (one per file) | 600K + 450×4K = **2.4M** | **$0.10** |
| same, packing on | 600K | 8K | ~80 | 600K + 80×4K = **920K** | **$0.039** |
| same, chunk budget 24K | 600K | 24K | ~30 | 600K + 30×4K = **720K** | **$0.030** |

So bigger chunks and packing are both strictly cheaper. The counter-pressure is **dilution** — a
single violation inside 24K tokens of code is easier for the model to miss than inside 4K. Default
`8000` is the starting compromise; M5 measures recall against chunk size on the fixture repos and
sets the shipped default from data.

Token estimation is `chars / 3.8` (Jev's tokenizer is not published); `--estimate` prints the band as
±25%, and the run reconciles against `usage` from each response, printing real spend at the end.

## 9. Check catalog

Each check is:

```ts
interface Check {
  id: string;                     // 'a8-24-weak-password-hash' — stable, appears in the report
  title: string;
  controls: string[];             // ['A.8.24', 'A.5.33'] — Annex A 2022 references
  severity: Severity;             // critical | high | medium | low | info
  scope: 'chunk' | 'repo';
  appliesTo?: string[];           // globs and/or language ids; omitted = all
  type: 'choice' | 'noul' | 'score';
  instructions: string;
  criteria?: Record<string, string>;   // required for 'choice'
  positiveLabels?: string[];      // labels that count as a violation (default ['violation'])
  threshold?: number;             // overrides thresholds.report
  kb: string;                     // path to checks/kb/<id>.md
  version: number;                // bump invalidates cache entries for this check
}
```

Default shape is `type: 'choice'` with three criteria — `violation` / `compliant` /
`not_applicable` — because the criteria text is where the control's meaning is actually encoded, and
`not_applicable` gives the model somewhere to put irrelevant code instead of guessing. `noul` is used
for cheap binary screens, `score` for graded posture (e.g. logging coverage).

### Chunk-scope checks (~30)

| id | control | what it asks about |
|---|---|---|
| `a5-14-insecure-transfer` | A.5.14 | `http://` endpoints, ftp/telnet, unverified TLS on outbound calls |
| `a5-15-missing-authorization` | A.5.15 | route/handler reachable with no authorization check |
| `a5-17-hardcoded-credentials` | A.5.17 | literal passwords, API keys, private keys, tokens in source |
| `a5-23-insecure-cloud-config` | A.5.23 | public buckets, `*` IAM actions/principals in IaC |
| `a5-28-audit-trail-integrity` | A.5.28 | security events mutable/deletable without trace |
| `a5-33-record-protection` | A.5.33 | records of legal/business value stored unprotected |
| `a5-34-pii-handling` | A.5.34 | PII collected/stored without minimisation or protection |
| `a8-2-privileged-access` | A.8.2 | hardcoded admin/root escalation, container running as root |
| `a8-3-object-level-access` | A.8.3 | IDOR — record fetched by id with no ownership/tenant check |
| `a8-3-mass-assignment` | A.8.3 | request payload bound wholesale to a model |
| `a8-4-source-and-debug-exposure` | A.8.4 | debug endpoints, exposed `.git`/backup files, prod source maps |
| `a8-5-weak-authentication` | A.8.5 | JWT `alg: none`/unverified, no expiry, weak session handling |
| `a8-5-password-policy` | A.8.5 | no length/complexity/breach check where credentials are set |
| `a8-6-unbounded-resource-use` | A.8.6 | unpaginated/unlimited query or unbounded allocation |
| `a8-7-unsafe-file-upload` | A.8.7 | upload accepted without type/size checks or scanning |
| `a8-8-deprecated-insecure-api` | A.8.8 | known-dangerous APIs, deprecated crypto/platform calls |
| `a8-9-insecure-default-config` | A.8.9 | `debug=true`, permissive CORS, cookie flags, missing headers |
| `a8-10-missing-deletion-path` | A.8.10 | data retained with no deletion/erasure path |
| `a8-11-unmasked-data-display` | A.8.11 | full PII/PAN/secret rendered where masking is expected |
| `a8-12-information-leakage` | A.8.12 | stack traces / internal detail returned to the client |
| `a8-12-secrets-in-logs` | A.8.12 | credentials, tokens or PII passed to a logger |
| `a8-15-missing-security-logging` | A.8.15 | auth failure, privilege change or admin action not logged |
| `a8-16-swallowed-errors` | A.8.16 | empty catch / error discarded, defeating monitoring |
| `a8-20-network-exposure` | A.8.20 | bind to `0.0.0.0`, TLS verification disabled, SSRF-able fetch |
| `a8-21-weak-protocol-config` | A.8.21 | obsolete TLS versions or weak cipher suites configured |
| `a8-24-weak-password-hash` | A.8.24 | md5/sha1/unsalted/fast hash used for credentials |
| `a8-24-weak-crypto-primitive` | A.8.24 | ECB, static IV, hardcoded key, `Math.random` for secrets |
| `a8-26-missing-input-validation` | A.8.26 | untrusted input crosses a boundary unvalidated; CSRF absent |
| `a8-27-trust-boundary-violation` | A.8.27 | client-supplied value trusted for authz/price/tenant |
| `a8-28-sql-injection` | A.8.28 | query built by concatenation/interpolation |
| `a8-28-command-injection` | A.8.28 | shell/exec built from untrusted input |
| `a8-28-unsafe-deserialization` | A.8.28 | `eval`, `unserialize`, pickle, unsafe YAML on untrusted data |
| `a8-28-path-traversal` | A.8.28 | filesystem path built from request input |
| `a8-28-xss-sink` | A.8.28 | unescaped output into HTML/DOM |
| `a8-33-production-data-in-tests` | A.8.33 | real PII or live credentials in fixtures/seeds |

### Repo-scope checks (~6)

State is a synthesized fact object (manifests, lockfile pinning, CI workflow files, Dockerfile
directives, presence of security tests, env-file inventory) rather than a code chunk:

| id | control | what it asks about |
|---|---|---|
| `a5-21-supply-chain-hygiene` | A.5.21 | unpinned deps, no lockfile, install scripts, `curl \| bash` in CI |
| `a8-9-config-management` | A.8.9 | config drift, no single source of truth, secrets in committed env files |
| `a8-13-backup-evidence` | A.8.13 | backup/restore scripting absent, or writing unencrypted dumps |
| `a8-25-secure-sdlc-gates` | A.8.25 | no review/security gate in CI, no dependency or secret scanning |
| `a8-29-security-testing` | A.8.29 | no tests covering auth/authz/crypto paths |
| `a8-31-environment-separation` | A.8.31 | production credentials or hosts referenced from dev/test config |

Every check needs `checks/kb/<id>.md`: **What this control requires / Why it matters / Typical impact
/ Remediation / References (Annex A + clause)**. The KB is the report's voice, so it gets reviewed as
prose, not as code.

## 10. Question construction

```ts
state = {
  project_context?: string,        // prompts.projectContext
  language: 'php',
  files: [{ path, start_line, content }],   // one entry, or several when packed
}
```

Question keys must be stable identifiers, so `a8-24-weak-password-hash` →
`q_a8_24_weak_password_hash`, with a reverse map back to the check. Batching: pack as many applicable
questions into one request as the budget allows — `estimate(state) + estimate(questions) ≤
contextTokens × 0.9`. With an 8K chunk and a 4K question block, all ~30 chunk checks fit in **one**
request; when they do not, split into the fewest requests possible over the same state (§8.3 explains
why fewer is cheaper). `checks.include/exclude`, `appliesTo` and language filtering all shrink the
block before batching.

## 11. Localization (turning a chunk verdict into a line range)

Jev cannot report a line. For each positive above threshold:

1. Split the chunk into `slices` (3 by default) on the same boundary heuristic — for a packed chunk,
   slices are the member files.
2. Re-ask **only that one question** against each slice (cheap: one question ≈ 130 tokens, output
   free).
3. Keep slices still positive; recurse to `localize.maxDepth` (default 2) or until a slice is under
   `minLines` (default 12).
4. Report the narrowed range. If every slice comes back negative, keep the parent range and mark the
   finding `location: approximate` — an honest degradation, visible in the report.

Cost is bounded by the number of positives, which in a healthy repo is small. `localize.enabled:
false` falls back to chunk-range reporting.

## 12. Findings

- **Gate:** the signal is the **probability mass on the check's positive labels**, not `confidence`
  (decision 7). A finding is raised when that mass ≥ threshold (per-check, else
  `thresholds.report`); at or above `thresholds.high` it keeps the catalog severity, between the two
  it is demoted one step and tagged `low confidence`. `confidence` and the full `probabilities` map
  are recorded alongside, for the report's evidence block and for `--explain`. When no distribution
  comes back, fall back to the winning label plus its `confidence`.
- **Dedupe:** same check + overlapping or adjacent line ranges in the same file → one finding,
  highest confidence wins, ranges union. This is what makes `overlapLines` safe.
- **Stable id:** `<check-id>@<path>#<sha1(normalized-snippet)[0..8]>` — survives line shifts, so two
  runs are diffable and waivers keep matching after unrelated edits.
- **Waivers:** `.isojevdit/waivers.json` entries `{ id, reason, approvedBy, expires }` move a finding
  to a *Waived* section instead of dropping it. An expired waiver is reported as active **and**
  flagged — auditors need to see lapsed acceptances.
- **Errors are findings too:** a chunk that failed validation or exhausted retries becomes an
  `info`-level `tool-error` entry, so the report's coverage claim stays truthful.

## 13. `iso-jevdit-report.md`

1. **Header** — tool + catalog version, provider, resolved model, run date, target, git commit/branch
   if available, files/chunks scanned, duration, token usage, actual cost.
2. **Executive summary** — counts by severity; controls assessed / with findings / clean; the single
   worst finding named.
3. **Control coverage table** — Control | Checks run | Findings | Worst severity | Status.
4. **Findings**, grouped by `report.groupBy` (control → severity by default). Each one: finding id,
   check title, severity + confidence, every location as `path:start-end` with a fenced snippet
   (`snippetLines` of context, secrets masked), then the KB's what/why/impact/remediation, the Annex A
   references, and the per-label probability table.
5. **Clean controls** (`includePassed`) — assessed, no finding above threshold.
6. **Waived findings** — with reason, approver, expiry, and lapse warnings.
7. **Appendix A — Scope**: files scanned; files skipped, each with the rule that skipped it; the
   effective ignore layers in force.
8. **Appendix B — Controls not assessable from source**, the honest complement of §9.
9. **Appendix C — Methodology and limitations**: how decisions are made, what a confidence number is,
   that `thresholds` are the operator's policy, and that this is AI-assisted evidence gathering for a
   human auditor — not a conformity assessment.
10. **Appendix D — Effective configuration** (`includeConfig`), secrets masked, credentials file
    referenced by path only.

Determinism: findings sort by (control, severity, path, start line, id). Only the header carries
timestamps, and `report.timestamp: false` removes them so committed reports diff cleanly.
`iso-jevdit-report.json` mirrors the whole thing for CI.

## 14. CLI

```
iso-jevdit [path]                      file or directory; default cwd

  --provider <name>                    select/persist provider config set (default openrouter)
  --key <key|->                        save to ~/.isojevdit/credentials.json, then continue
                                         '-' reads the key from stdin (keeps it out of history)
  --no-save                            use --key for this run only, store nothing
  --no-verify                          skip the live key check when saving
  --clear-key [provider]               remove one provider's stored credential
  --clear-credentials                  remove every stored credential and delete the file
  --model <id>                         override the provider's model
  --config <file>                      extra config layer, highest file precedence
  --show-config                        print the effective merged config (masked) and exit

  --out <file>                         report path (default iso-jevdit-report.md)
  --format md|json|both                default both when report.json is true
  --include-passed / --no-include-passed
  --group-by control|file|severity

  --checks <ids>                       comma list or glob; repeatable
  --exclude-checks <ids>
  --threshold <n>                      override thresholds.report
  --severity <min>                     drop findings below this severity

  --ignore <glob>                      extra ignore pattern for this run; repeatable
  --ignore-dir <name|path>             extra ignored directory for this run; repeatable
  --no-gitignore                       ignore the .gitignore stack
  --explain-ignores <path>             say which rule excluded a path, and exit

  --changed [ref]                      only files changed vs ref (default HEAD)
  --concurrency <n>
  --chunk-tokens <n>
  --no-cache   --cache-dir <dir>   --clear-cache
  --estimate                           preflight only: files, chunks, tokens, cost band; no API calls
  --max-spend <usd>                    abort before exceeding (default maxSpendUsd)
  --yes                                skip the spend confirmation prompt
  --explain <path>                     dump every check's probabilities for a file (threshold tuning)

  --init                               scaffold .isojevdit/
  --list-checks                        id, control, severity, scope
  --fail-on <severity|none>            CI gate (default high)
  --verbose   --quiet   --no-color   --version   --help
```

Exit codes: `0` clean, or nothing at/above `--fail-on`; `1` findings at/above `--fail-on`; `2` config
or usage error; `3` missing/invalid credential or provider failure with no usable result; `4` no
eligible files found; `5` aborted on the spend guard.

## 15. Caching and incremental runs

Cache key: `sha256(provider + model + check.id + check.version + normalized state + prompts hash)`.
Entries hold the raw answers plus usage, under `.isojevdit/cache/` (git-ignored by `--init`), pruned
by `cache.ttlDays`. An unchanged re-run therefore costs $0 and still produces a full report —
essential given decision 2. `--changed [ref]` narrows discovery to files touched since a git ref for
per-PR CI; the report header states that the run was incremental and against what.

## 16. Resilience and cost safety

- Spend guard: an `--estimate`-style preflight runs before every audit. Over `maxSpendUsd`, prompt on
  a TTY; exit 5 in CI unless `--yes` or a raised limit.
- Retry 429/5xx/network with exponential backoff + jitter, honour `Retry-After`, cap `maxRetries`.
  Persistent failure marks the chunk `tool-error` and the run continues.
- Response validation is defensive at the adapter boundary (alpha endpoint): unknown answer shape,
  missing key, or out-of-range probability → per-chunk error, never a crash.
- **Partial report always.** SIGINT, budget stop and fatal errors all flush what has been decided so
  far, with a banner saying the run was incomplete and what was left unscanned. A paid run never ends
  with nothing on disk.
- Concurrency pool (default 4) with a progress line: files, chunks, requests, tokens, spend.

## 17. Testing

- `vitest`. Unit: config merge/precedence, credential save/clear round-trip and permissions, the
  five-layer ignore resolution (incl. negations, nested gitignores, dot-dir policy), chunk boundaries
  and pack budgets, token estimator, question key mangling, dedupe/merge, waiver expiry, redaction,
  exit codes.
- Fixtures: small deliberately vulnerable repos per language (`test/fixtures/php-shop`, `ts-api`,
  `py-svc`) with an expected-findings manifest, each carrying a `.vscode/` and `.config/` directory to
  prove they are skipped.
- **Cassettes**: recorded Jev responses keyed by request hash; the default suite is offline and free.
  `npm run test:record` refreshes them against the live API and is never run in CI.
- Credential tests run against a temp `HOME` so a developer's real `~/.isojevdit/` is never touched.
- Golden report snapshot proves determinism and diff stability.
- Recall/precision harness over the fixtures reports per-check precision, recall and the chosen chunk
  size — the artifact that justifies the shipped thresholds.

## 18. Milestones

| M | Deliverable | Done when |
|---|---|---|
| M0 **done** | Scaffold: package.json, tsconfig, vitest, `bin/`, `--version/--help` | `npx .` prints help; build and lint clean |
| M1 **done** | Config layer + provider registry + `--provider/--key/--clear-key/--clear-credentials/--show-config/--init` | key round-trips through `~/.isojevdit/credentials.json` with restricted permissions, save and clear both print the path, precedence unit-tested against a temp HOME |
| M2 **done** | Discovery + ignore layers + chunking + packing + `--estimate` | on a fixture, `.vscode`/`.config` are skipped, `--explain-ignores` names the rule, and the file/chunk/token/cost table prints with zero API calls |
| M3 *adapter done* | OpenRouter adapter + engine + cache, **3 checks only** | real findings from `test/fixtures/php-shop`; cached re-run costs $0; cassettes recorded |
| M4 | Findings model + Markdown/JSON reporters + KB for those 3 checks | `iso-jevdit-report.md` survives a read-aloud review; golden snapshot stable |
| M5 | Full catalog (~36) + KB + threshold/chunk-size tuning from the recall harness | precision/recall table committed; shipped defaults justified by it |
| M6 | Localization pass | fixture findings land within ±12 lines of truth, or are marked approximate |
| M7 | Repo-scope checks + waivers + `--changed` + `--fail-on` | a CI-shaped run on a fixture gates correctly |
| M8 | Docs (README, settings reference, sample report), publish dry-run | `npm pack` contents reviewed; README example reproduces the sample report |

## 19. Risks

| Risk | Mitigation |
|---|---|
| Alpha endpoint changes shape | Adapter boundary + response validation + cassette drift test in `test:record` |
| Probability calibration unknown per check | M5 harness sets per-check thresholds from fixture data; `--explain` lets users retune |
| Dilution: violations missed in large chunks | Chunk size chosen by measured recall, not by cost alone; `chunk.maxTokens` configurable |
| Cost surprises on big repos | Preflight estimate, `maxSpendUsd`, cache, `--changed` |
| False positives erode trust | `prompts.append` + `not_applicable` label + waivers + probabilities shown in the report |
| Report read as certification | Appendix C framing; no "compliant" verdict is ever printed at repo level |
| Key committed to a repo | Structurally impossible: credentials live only in `~/.isojevdit/credentials.json`, and a key found in `settings.json` is warned about |
| Key leaked through shell history | `--key -` reads stdin; a `--key=` save prints the history warning |
| Secret leaked into a committed report | `report/redact.ts` on every sink, masking to first 8 + last 4 |
| Over-broad ignores hide real risk | Skipped files are listed with their reason in Appendix A, and `--explain-ignores` traces one path |
| Tokenizer unknown → estimates drift | ±25% band, reconcile with `usage`, print actual spend |

## 20. Dependencies

Runtime: `@openrouter/sdk`, `zod`, `ignore`, `picocolors`, `commander` (or a hand-rolled parser if the
flag surface stays this small). Dev: `typescript`, `tsx`, `vitest`, `eslint`, `@types/node`.
Deliberately no glob library — the walker needs per-directory gitignore stacking anyway, and
`ignore` + a small matcher covers `ignore`/`unignore`. No keychain native module in v1 (see §6.3).
Node ≥ 20 for stable `fs.promises`, `AbortSignal.timeout` and built-in `fetch`.

## 21. Open questions

1. Does the Decisions endpoint cap question count or `state` size below the 32K context? Probe in M3
   and record the real limit in `providers/defaults.ts`.
2. Is `~typesafe/jev-latest` accepted verbatim as a model id, or must the `~` form be resolved first?
   M3 verifies; if it must be resolved, pin `typesafe/jev-1.13` as the default and keep `latest`
   opt-in.
3. Which endpoint `verifyKey` should use for a decisions-only key, if `GET /api/v1/key` does not
   reflect alpha access. Fall back to a one-question probe against the cheapest model.
4. Whether `score` questions add anything over `choice` + probabilities for graded posture checks —
   decide with data in M5, and drop the kind from the catalog if not.
