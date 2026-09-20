# Changelog

All notable changes to `iso-jevdit` are recorded here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project uses
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

While the major version is 0, the CLI surface and the `settings.json` schema may change in a minor
release. Anything that would change a *finding* — a check's instructions, criteria or threshold — is
called out explicitly, because it changes what your report says about your code.

## [Unreleased]

### Planned next

- The audit engine: send chunks, run requests concurrently, cache answers by content hash so an
  unchanged re-run costs nothing.
- `iso-jevdit-report.md` and its JSON sibling, with evidence, ISO clause mapping, remediation from the
  knowledge base, and the scope, methodology and configuration appendices.
- Narrowing a chunk verdict to a line range by re-asking the same question about smaller slices.
- The remaining ~33 checks, and the thresholds tuned against fixture repositories.
- Repository-scope checks (supply-chain hygiene, CI gates, environment separation), waivers with
  expiry, and `--fail-on` as a CI gate.

## [0.1.0] — 2026-09-20

First development release. Everything up to and including the cost forecast works; the engine that
sends chunks and the report writer do not exist yet, so `iso-jevdit <path>` stops after the forecast
and says so. See the status table in [README.md](README.md).

### Added

- **Configuration.** `.isojevdit/settings.json` with six precedence layers (defaults, user file,
  project file, `--config`, environment, flags), comment and trailing-comma tolerance, a generated
  JSON Schema for editor autocomplete, and unknown-key warnings that name the closest valid key
  instead of failing the run.
- **Credential storage.** `iso-jevdit --provider=<name> --key=<key>` verifies the key with the
  provider and stores it in `~/.isojevdit/credentials.json`, never in `settings.json`. Written
  atomically with mode 600, plus an ACL rewrite on Windows where `chmod` restricts nobody. `--key -`
  reads from stdin to keep keys out of shell history. `--clear-key` and `--clear-credentials` undo it
  and report exactly what they removed.
- **File discovery** with five ignore layers, last match winning: the shipped skip-list, the full
  `.gitignore` stack (every level, plus `.git/info/exclude` and your global excludes), `ignoreDirs`,
  `ignore` globs, and `unignore` which overrides everything. Dot-directories are skipped apart from
  CI and container configuration. An explicitly named file bypasses every filter.
- **`--explain-ignores <path>`**, which names the exact layer and rule that excluded a path.
- **Chunking** that splits large files at top-level boundaries with configurable overlap, and packs
  small files from the same directory into one request — the single biggest cost saving.
- **`--estimate`**, a cost and token forecast that makes no API calls, plus a `maxSpendUsd` guard that
  stops a run before it can exceed its budget.
- **The check catalog**, with 3 of ~36 checks written: `a5-17-hardcoded-credentials`,
  `a8-24-weak-password-hash`, `a8-28-sql-injection`. Each carries reviewed knowledge-base prose
  (requirement, why it matters, impact, remediation, references). Malformed checks fail at import.
- **Custom checks** through `extraChecks`, and two hooks for cutting false positives without forking
  the catalog: `prompts.projectContext` and `prompts.append`.
- **The OpenRouter adapter** for the alpha Decisions endpoint, with retry and backoff that honours
  `Retry-After`, and defensive response validation.
- **`--list-checks`**, **`--show-config`** (key masked) and **`--init`**.
- Secret redaction on every output path, masking keys to the first 8 and last 4 characters.

### Notes on design

- Findings are gated on the probability mass of a check's violation labels, not on the model's
  `confidence` value. Confidence measures how concentrated the answer distribution is, so it is just
  as high for a confident pass as for a confident fail.
- All report wording comes from the shipped knowledge base, never from the model. Jev returns typed
  decisions only, so remediation advice is reviewed text rather than generated text.
- The adapter speaks the wire format directly instead of using a generated SDK, because an alpha
  endpoint needs its own validation and retry policy.

[unreleased]: https://github.com/vidux/iso-jevdit/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/vidux/iso-jevdit/releases/tag/v0.1.0
