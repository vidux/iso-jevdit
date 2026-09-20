# iso-jevdit

An npm CLI that audits a codebase against **ISO/IEC 27001:2022 Annex A** and writes a detailed
`iso-jevdit-report.md` you can hand to an auditor.

It works differently from a normal "AI code review" tool. Every verdict comes from
[TypeSafe's **Jev**](https://openrouter.ai/~typesafe/jev-latest), a *decision* model: you give it
state and typed questions, and it returns a typed answer with a probability attached — never prose.
Every sentence in the report comes from a knowledge base that ships with the tool. So the model
decides **whether** a control is violated, and reviewed human text explains **what it means and how
to fix it**. Nothing in the remediation advice is generated on the fly, and nothing can be
hallucinated into it.

```bash
iso-jevdit --provider=openrouter --key=sk-or-v1-...   # store a credential, once
iso-jevdit --estimate .                               # what would this cost? (no API calls)
iso-jevdit .                                          # audit the project
iso-jevdit src/auth/token.php                         # audit a single file
```

---

## Status

**This is version 0.1.1 and the audit engine is still being expanded.** Being straight about it, because a
compliance tool that overstates itself is worse than useless:

| Area | State |
|---|---|
| Configuration, credentials, `--init` | **Working** |
| File discovery, the five ignore layers, `--explain-ignores` | **Working** |
| Chunking, small-file packing, `--estimate` cost forecast | **Working** |
| Check catalog | **Working**, 3 of ~36 checks written |
| Request building, answer parsing, the OpenRouter adapter | **Working** |
| Sending chunks and collecting live run statistics | **Working** |
| Writing Markdown and JSON reports | **Working** |
| Caching and narrowing findings to line ranges | **Not yet** |

Today, `iso-jevdit .` discovers and chunks your code, calls Jev, shows live file/request/finding
statistics, prints a final summary, and writes `iso-jevdit-report.md` plus a JSON sibling. Finding
locations are approximate chunk ranges until localization lands. `--estimate` remains a no-network
cost preflight.

During a run, the live line includes the current folder and file. If OpenRouter returns HTTP 429,
the CLI prints `Rate limit detected`, waits at least 10 seconds (or longer when `Retry-After` asks
for it), and retries. Recoverable status is written atomically to `.isojevdit/last-run.json`, including
the last folder, file, chunk, counters, rate-limit state, and final report paths. If the terminal is
closed or the process is interrupted, that file remains as the last known run state.

Follow [CHANGELOG.md](CHANGELOG.md) for what lands when.

---

## Install

Requires **Node.js 20.3 or newer**.

```bash
# one-off, no install
npx iso-jevdit --estimate .

# project dev dependency (recommended for CI)
npm install --save-dev iso-jevdit

# global
npm install --global iso-jevdit
```

## Getting started

### 1. Get an API key

The default provider is [OpenRouter](https://openrouter.ai/keys). Jev's pricing there is $0.042 per
million input tokens and **$0 for output**, which is what makes this affordable — see
[Cost](#cost) below.

### 2. Store it

```bash
iso-jevdit --provider=openrouter --key=sk-or-v1-...
```

```
Credential saved.
  provider   openrouter
  key        sk-or-v1****************************9f2a
  verified   yes (accepted, no credit limit)
  file       C:\Users\<you>\.isojevdit\credentials.json  (ACL limited to <you>)
```

The key is verified against the provider before it is stored, so a typo fails immediately rather
than halfway through your first audit. See [Credentials](#credentials) for where it lives and why.

### 3. Set the project up (optional but recommended)

```bash
cd my-project
iso-jevdit --init
```

This creates `.isojevdit/` with a commented `settings.json`, a generated `schema.json` for editor
autocomplete, and a `.gitignore` for the cache. Commit `settings.json` — it is team configuration
and contains no secrets.

### 4. Forecast, then run

```bash
iso-jevdit --estimate .
```

```
Scan
  root       /home/you/my-project
  target     .
  files      412 eligible, 186 skipped, 51 not audited types
  chunks     80 (13 packed from 45 files)
  languages  php 41, typescript 28, yaml 11

Forecast  (--estimate: no API calls made)
  provider   openrouter / ~typesafe/jev-latest
  checks     3 selected, 1-3 asked per chunk
  requests   80
  tokens     920.4K input  (state 600.1K + questions 320.3K)
  cost       $0.0387   band $0.0290 - $0.0483
  budget     maxSpendUsd $10.00
```

Happy with the number? Drop `--estimate`.

---

## How it works

```
your code
   │  discovery      which files are auditable, honouring five layers of ignore rules
   ▼
files
   │  chunking       split big files at function boundaries; pack small ones together
   ▼
chunks               one chunk = one or more contiguous file regions
   │  questions      every applicable check becomes a typed question over that chunk
   ▼
Jev                  returns a verdict + a probability for each question
   │  gating         probability ≥ your threshold becomes a finding
   ▼
findings
   │  knowledge base adds requirement, impact and remediation text per control
   ▼
iso-jevdit-report.md
```

Three consequences of using a decision model are worth understanding, because they shape everything:

1. **It returns no prose.** All wording is ours, from `src/checks/kb/`. Remediation advice is
   reviewed like code, and is identical for every user.
2. **It cannot return line numbers.** A verdict applies to a chunk. To narrow it down, the tool
   re-asks the same single question about smaller slices and keeps the ones still flagged. Because
   output tokens are free, that narrowing costs almost nothing.
3. **Questions are nearly free; re-sending code is not.** So the tool asks *every* applicable check
   in one request per chunk rather than one request per check.

---

## Cost

Only input tokens are billed. The block of questions is re-sent with every request, which means
**the number of requests drives the bill, not how much code you have.** Two settings therefore
matter most:

| Setting | Effect |
|---|---|
| `chunk.maxTokens` (default 8000) | Bigger chunks → fewer requests → cheaper. Too big and a single violation can get lost in the volume. |
| `chunk.pack` (default false) | Opt-in cost saving that packs small files together. Keep it off for exact per-file attribution until localization is available. |

For a 400-file, 2.4 MB repository with a full catalog of ~35 checks:

| Configuration | Requests | Input tokens | Cost |
|---|---|---|---|
| No packing, 8K chunks | ~450 | 2.4M | ~$0.10 |
| Packing on, 8K chunks | ~80 | 920K | ~$0.04 |
| Packing on, 24K chunks | ~30 | 720K | ~$0.03 |

Guard rails:

- `--estimate` prints the forecast and makes no API calls.
- `maxSpendUsd` (default `10.0`) aborts before a run can exceed it — exit code 5. Raise it with
  `--max-spend`.
- Token counts are estimates with a ±25% band, because Jev's tokenizer is not published. Runs
  reconcile against the usage each response reports.

---

## Configuration

Settings are read from, in increasing precedence:

1. Built-in defaults
2. `~/.isojevdit/settings.json` (your personal defaults, all projects)
3. `<project>/.isojevdit/settings.json` (committed, shared with your team)
4. `--config <file>`
5. Environment: `ISO_JEVDIT_PROVIDER`, `ISO_JEVDIT_MODEL`, `ISO_JEVDIT_CONCURRENCY`, `ISO_JEVDIT_MAX_SPEND`
6. Command-line flags

Objects merge deeply. Arrays replace, **except** `ignore`, `ignoreDirs`, `unignore`,
`extraExtensions`, `extraChecks` and `includeDotDirs`, which accumulate across layers.

A misspelled key is a warning that names the closest valid key, not an error — your audit still
runs. An out-of-range *value* is always fatal (exit 2).

Comments and trailing commas are allowed in `settings.json`.

### Every setting

`.isojevdit/settings.json`, with defaults shown:

```jsonc
{
  "$schema": "./schema.json",

  // ── Provider ───────────────────────────────────────────────────────────────
  "provider": "openrouter",
  "providers": {
    "openrouter": {
      // No apiKey here, ever. Keys live in ~/.isojevdit/credentials.json.
      "apiKeyEnv": "OPENROUTER_API_KEY",
      "baseUrl": "https://openrouter.ai",
      "model": "~typesafe/jev-latest",
      "headers": {},
      "timeoutMs": 60000,
      "maxRetries": 4
    }
  },

  // ── What to read ───────────────────────────────────────────────────────────
  "extensions": null,            // unset = the shipped list (~60 types); setting it REPLACES that list
  "extraExtensions": [],         // adds to the shipped list, e.g. [".blade.php", ".twig"]
  "filenames": null,             // unset = Dockerfile, Makefile, nginx.conf, docker-compose.yml, ...
  "maxFileSizeKb": 512,
  "followSymlinks": false,

  // ── What to skip (see "Ignore rules" below) ────────────────────────────────
  "ignoreDirs": [],              // ".vscode" matches at any depth; "storage/logs" is root-relative
  "ignore": [],                  // gitignore-style globs, e.g. ["**/*.generated.*"]
  "unignore": [],                // overrides everything above, including .gitignore
  "ignoreDefaults": true,        // false = drop the shipped skip-list entirely
  "includeDotDirs": [],          // adds to [".github", ".gitlab", ".circleci", ".docker"]
  "respectGitignore": true,

  // ── How code is batched ────────────────────────────────────────────────────
  "chunk": {
    "maxTokens": 8000,
    "overlapLines": 20,          // carried into the next chunk so a straddling issue is still visible
    "pack": false,
    "packSameDirOnly": true
  },

  // ── Confidence policy ──────────────────────────────────────────────────────
  "thresholds": {
    "report": 0.6,               // below this, a flagged chunk is discarded
    "high": 0.8,                 // at or above this, a finding keeps its full severity
    "perCheck": {}               // e.g. { "a8-24-weak-password-hash": 0.85 }
  },
  "severityOverrides": {},       // e.g. { "a8-15-missing-security-logging": "low" }

  // ── Which checks ───────────────────────────────────────────────────────────
  "checks": { "include": ["*"], "exclude": [] },
  "extraChecks": [],             // your own checks; see "Writing your own checks"

  // ── Telling the model about your project ───────────────────────────────────
  "prompts": {
    "projectContext": "",        // added to every question's state
    "append": {}                 // extra note for one check: { "<check-id>": "..." }
  },

  // ── Run behaviour ──────────────────────────────────────────────────────────
  "concurrency": 4,
  "maxSpendUsd": 10.0,

  // ── Accepted today, acted on when the audit engine lands ───────────────────
  "localize": { "enabled": true, "slices": 3, "maxDepth": 2, "minLines": 12 },
  "report": {
    "out": "iso-jevdit-report.md",
    "json": true,
    "includePassed": true,
    "includeConfig": true,
    "snippetLines": 6,
    "maxFindingsPerCheck": 50,
    "groupBy": "control",        // "control" | "file" | "severity"
    "timestamp": true            // false keeps committed reports diff-clean
  },
  "cache": { "enabled": true, "dir": ".isojevdit/cache", "ttlDays": 30 },
  "waivers": ".isojevdit/waivers.json",
  "failOn": "high",              // CI gate: "critical"|"high"|"medium"|"low"|"info"|"none"
  "redactSecrets": true
}
```

### Ignore rules

Five layers, applied in order. **The last one to match wins.**

| # | Layer | What it is |
|---|---|---|
| 1 | Shipped skip-list | `node_modules`, `vendor`, `dist`, `build`, `coverage`, `target`, `__pycache__`, lockfiles, `*.min.*`, `*.map`, … Turn off with `ignoreDefaults: false`. |
| 2 | `.gitignore` | Every level: the repository root, nested files, `.git/info/exclude`, and your global excludes file. Negations (`!keep.php`) work. Turn off with `respectGitignore: false` or `--no-gitignore`. |
| 3 | `ignoreDirs` | The simple knob. A bare name (`.vscode`) matches that directory at any depth; a name with a slash (`storage/logs`) is relative to the project root. Matching prunes the whole subtree. |
| 4 | `ignore` | Gitignore-style globs, for finer cuts than a whole directory. |
| 5 | `unignore` | Globs that override **every** rule above, including `.gitignore`. |

```jsonc
{
  "ignoreDirs": [".vscode", ".idea", ".config", "storage/logs"],
  "ignore": ["**/*.generated.php", "tests/snapshots/**"],
  "unignore": ["config/security.php", ".env.example"]
}
```

Two more rules worth knowing:

- **Dot-directories are skipped by default**, because most are editor or tool state. The exceptions
  are CI and container configuration, which is real audit evidence, so `.github`, `.gitlab`,
  `.circleci` and `.docker` are scanned. Add more with `includeDotDirs`. `.git` is never scanned.
- **Naming a file explicitly overrides everything.** `iso-jevdit storage/cache.php` audits that file
  even though `storage/` is gitignored. Naming a *directory* applies the filters normally.

Nothing disappears quietly: every skipped file is counted, and you can always ask why.

```bash
$ iso-jevdit --explain-ignores vendor/lib/Thing.php
vendor/lib/Thing.php: not scanned - directory vendor/ is excluded by defaults rule "vendor"

$ iso-jevdit --explain-ignores src/Auth.php
src/Auth.php: scanned - no rule excludes it; it is audited
```

---

## Credentials

**Keys are stored in `~/.isojevdit/credentials.json` and nowhere else.** `settings.json` is meant to
be committed, so it is never a place for a secret — a separate file outside the project can be kept
out of every repository by construction.

```jsonc
// ~/.isojevdit/credentials.json
{
  "version": 1,
  "openrouter": { "apiKey": "sk-or-v1-...", "savedAt": "...", "lastVerifiedAt": "..." }
}
```

When reading, the first of these wins:

1. `--key` on this run
2. `OPENROUTER_API_KEY` in the environment (so CI needs no file at all)
3. `~/.isojevdit/credentials.json`

Managing them:

```bash
iso-jevdit --provider=openrouter --key=sk-or-...   # save (verifies first)
iso-jevdit --key=sk-or-... --no-verify             # save without the live check (offline)
iso-jevdit --key=sk-or-... --no-save               # use for this run only, store nothing
Get-Content key.txt | iso-jevdit --key -           # read from stdin (PowerShell)
cat key.txt | iso-jevdit --key -                   # read from stdin (bash)
iso-jevdit --clear-key                             # forget the active provider's key
iso-jevdit --clear-key openrouter                  # forget a named provider's key
iso-jevdit --clear-credentials                     # forget everything, delete the file
```

How the key is protected:

- Written atomically with mode `600`. On Windows, `chmod` alone restricts nobody, so the file's ACL
  is also rewritten to your account only.
- Masked to the first 8 and last 4 characters everywhere it is displayed — confirmations,
  `--show-config`, logs, errors, and the report.
- **Not encrypted at rest.** Anything the tool could decrypt unattended would be obfuscation, not
  protection. This is the same posture as `gh`, `npm` and the AWS CLI.
- `--key=...` on a command line lands in your shell history (on Windows, PowerShell writes
  `ConsoleHost_history.txt` in plaintext). The tool says so after every such save. Use `--key -` if
  that matters to you.

---

## Command line

```
iso-jevdit [path]                      file or directory to audit; default is the working directory
```

**Credentials**

| Flag | Meaning |
|---|---|
| `--provider <name>` | Which provider configuration to use (currently `openrouter`) |
| `--key <key\|->` | Store a key; `-` reads it from stdin |
| `--no-save` | Use `--key` for this run only |
| `--no-verify` | Skip the live key check when saving |
| `--clear-key [provider]` | Remove one provider's stored key |
| `--clear-credentials` | Remove every stored key and delete the file |
| `--model <id>` | Override the provider's model |

**Configuration**

| Flag | Meaning |
|---|---|
| `--config <file>` | Extra settings layer, highest file precedence |
| `--show-config` | Print the effective configuration, key masked, and exit |
| `--init` | Scaffold `.isojevdit/` |
| `--list-checks` | List the selected checks and exit |

**Scope**

| Flag | Meaning |
|---|---|
| `--checks <ids>` | Only these check ids or globs, e.g. `--checks a8-*`; repeatable |
| `--exclude-checks <ids>` | Skip these check ids or globs |
| `--ignore <glob>` | Extra ignore pattern for this run; repeatable |
| `--ignore-dir <name\|path>` | Extra ignored directory for this run; repeatable |
| `--no-gitignore` | Ignore the `.gitignore` stack |
| `--explain-ignores <path>` | Say which rule excluded a path, and exit |
| `--changed [ref]` | Only files changed against a git ref (default `HEAD`) |

**Run**

| Flag | Meaning |
|---|---|
| `--estimate` | Forecast files, chunks, tokens and cost; make no API calls |
| `--max-spend <usd>` | Stop before the forecast exceeds this |
| `--threshold <n>` | Override `thresholds.report` (0–1) |
| `--concurrency <n>` | Parallel requests |
| `--chunk-tokens <n>` | Token budget per chunk |

**Output**

| Flag | Meaning |
|---|---|
| `--out <file>` | Markdown report path; the JSON sibling uses the same base name |
| `--verbose` / `-v` | Show per-file detail and retries |
| `--quiet` | Print errors only |
| `--no-color` | Disable color output |
| `--version` | Print the version |
| `--help` / `-h` | Print command help |

Diagnostics go to stderr; results (`--show-config`, `--list-checks`, `--explain-ignores`) go to
stdout, so you can pipe them.

### Exit codes

| Code | Meaning |
|---|---|
| 0 | Clean, or nothing at or above `failOn` |
| 1 | Findings at or above `failOn` |
| 2 | Configuration or usage error |
| 3 | Missing or rejected credential, or a provider failure with no usable result |
| 4 | No auditable files found |
| 5 | Stopped by the spend guard |
| 70 | Internal error |

In CI:

```yaml
- run: npx iso-jevdit --changed origin/main --max-spend 0.50
  env:
    OPENROUTER_API_KEY: ${{ secrets.OPENROUTER_API_KEY }}
```

---

## Checks

Each check asks one narrow question about a chunk of code and maps to one or more Annex A controls.
`iso-jevdit --list-checks` prints what is active.

| ID | Controls | Severity | What it asks about |
|---|---|---|---|
| `a5-17-hardcoded-credentials` | A.5.17 | critical | Passwords, API keys, tokens or private keys written into source |
| `a8-24-weak-password-hash` | A.8.24, A.5.17 | high | Credentials hashed with a fast or unsalted algorithm |
| `a8-28-sql-injection` | A.8.28, A.8.26 | critical | SQL assembled from a value that isn't a bound parameter |

Around 33 more are planned, covering the code-observable part of Annex A: access control, logging
and monitoring, secure configuration, input validation, cryptography, data masking, supply-chain
hygiene, environment separation and secure-development gates. Organizational, people and physical
controls cannot be judged from source code and will be listed as out of scope in the report's
appendix rather than guessed at.

### Confidence and thresholds

Every answer carries a probability. The tool gates on **the probability mass on the check's
violation labels** — not on the model's `confidence` value, which measures how concentrated the
answer distribution is and is therefore just as high for a confident *pass* as a confident *fail*.

- probability < `thresholds.report` (0.6) → discarded
- between `report` and `high` → reported, one severity step lower, tagged low confidence
- ≥ `thresholds.high` (0.8) → reported at full severity

These are policy, not physics. Tune them per check with `thresholds.perCheck` once you have seen how
they behave on your code.

### Cutting false positives

Two configuration hooks, no forking required:

```jsonc
{
  "prompts": {
    // Added to every question. The cheapest way to stop a whole class of false positive.
    "projectContext": "PHP 8.2 payment service. All queries go through App\\Db\\QueryBuilder, which parameterises.",

    // Added to one check's instructions.
    "append": {
      "a8-24-weak-password-hash": "Hashes in App\\Cache are cache keys, not credentials."
    }
  }
}
```

### Writing your own checks

Add to `extraChecks` in `settings.json`. A check needs an id, a title, at least one Annex A control,
instructions, criteria labels, and remediation text — the tool validates all of it and refuses to run
on a malformed check.

```jsonc
{
  "extraChecks": [
    {
      "id": "org-1-no-plaintext-pii-export",
      "title": "Customer PII must not be written to CSV exports",
      "controls": ["A.8.11", "A.5.34"],
      "severity": "high",
      "appliesTo": ["**/export/**"],          // optional path globs
      "languages": ["php"],                   // optional language filter
      "type": "choice",
      "instructions": "Does this code write customer PII to a file or export without masking?",
      "criteria": {
        "violation": "PII fields (name, email, phone, address, national id) reach a file, CSV or stream unmasked.",
        "compliant": "PII is masked or tokenised, or no PII reaches an export here.",
        "not_applicable": "This code does not export data."
      },
      "threshold": 0.75,
      "remediation": "Route exports through App\\Export\\Masker."
    }
  ]
}
```

Guidance that makes a real difference to accuracy:

- **Always include a no-match label** such as `not_applicable`, so the model has somewhere to put
  irrelevant code instead of choosing between two wrong answers.
- **The criteria text is the check.** It is where the control's meaning actually lives — spend your
  effort there, not in the title.
- For labels that are easy to confuse, a criteria value may be an object instead of a string, with
  fields you invent (the model sees the names). `what` / `not_for` / `examples` works well:

```jsonc
"criteria": {
  "violation": {
    "what": "A credential is hashed with a fast digest such as MD5 or SHA-1.",
    "not_for": "Hashing that does not protect a credential.",
    "examples": ["$stored = md5($password);"]
  },
  "not_applicable": {
    "what": "This code does not hash credentials.",
    "note": "Cache keys, ETags and checksums belong here, whatever algorithm they use."
  }
}
```

---

## Scope and limitations

Please read this before putting a report in front of an auditor.

- **This is not a certification, and it is not a conformity assessment.** It produces AI-assisted
  evidence for a human auditor to review. The report says so in its own appendix.
- **It only judges what source code can show.** Management-system clauses 4–10 and the
  organizational, people and physical controls of Annex A are out of reach and are never claimed.
- **Findings are probabilistic.** Expect both false positives and false negatives, and treat the
  thresholds as your policy. Nothing here replaces a review.
- **Your source code is sent to the configured provider.** Chunks of your files travel to
  OpenRouter, which routes them to TypeSafe's model. Do not run this against code you are not
  permitted to send to a third party. Use `ignoreDirs`, `ignore` and `--checks` to narrow what
  leaves your machine, and `--estimate` to see exactly how much would be sent.
- **No static analysis is performed.** There is no parser, no data-flow analysis and no CVE lookup.
  Dependency checks judge pinning and provenance hygiene, not vulnerability identity.

## Troubleshooting

**"no auditable files found" (exit 4)** — everything under the target is ignored or of a type that
is not audited. Run `--explain-ignores <path>` on a file you expected to be scanned.

**A file you expected is missing** — most often an extension that is not in the audited set. Add it
with `extraExtensions`, or name the file directly, which bypasses every filter.

**"no credential for provider" (exit 3)** — save one with `--provider=openrouter --key=<key>`, or set
`OPENROUTER_API_KEY`.

**The forecast is higher than you want** — raise `chunk.maxTokens`, confirm `chunk.pack` is on, cut
scope with `ignoreDirs` or `--checks`, or audit only what changed with `--changed`.

**A warning about chunks exceeding the context** — `prompts.projectContext` plus a chunk cannot
exceed the model's 32,000-token window. Shorten the context or lower `chunk.maxTokens`.

**Windows: the key file could not be locked down** — the ACL rewrite failed. The file is still mode
600, but check who can read `~/.isojevdit/`.

## Documentation

- [CHANGELOG.md](CHANGELOG.md) — what changed, and what is coming
- [CONTRIBUTING.md](CONTRIBUTING.md) — development setup, and how to add a check
- [SECURITY.md](SECURITY.md) — reporting a vulnerability, and how this tool handles your data
- [.claude/PLAN.md](https://github.com/vidux/iso-jevdit/blob/main/.claude/PLAN.md) — the full design of record, including decisions and trade-offs

## Support

- Questions and bug reports: [github.com/vidux/iso-jevdit/issues](https://github.com/vidux/iso-jevdit/issues)
- Security problems: see [SECURITY.md](SECURITY.md) — please do not open a public issue

## License

[MIT](LICENSE) © [vidux](https://github.com/vidux)
