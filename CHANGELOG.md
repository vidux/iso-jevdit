# Changelog

All notable changes to `iso-jevdit` are recorded here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project uses
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

While the major version is 0, the CLI surface and the `settings.json` schema may change in a minor
release. Anything that would change a *finding* — a check's instructions, criteria or threshold — is
called out explicitly, because it changes what your report says about your code.

## [Unreleased]

### Planned next

- Cache answers by content hash so an unchanged re-run costs nothing.
- Narrowing a chunk verdict to a line range by re-asking the same question about smaller slices.
- The remaining ~33 checks, and the thresholds tuned against fixture repositories.
- Repository-scope checks (supply-chain hygiene, CI gates, environment separation), waivers with
  expiry.

## [0.1.3] — 2026-09-20

### Changed

- The live terminal status is constrained to the current terminal width, dynamically shortens its
  progress bar, and truncates long paths in the middle so updates remain on one line instead of
  wrapping and accumulating in the console.
- Progress output places run counters before the current folder and file so both status and active
  location remain visible on narrow terminals.

### Fixed

- Existing `iso-jevdit-report.md` and `iso-jevdit-report.json` files are now reliably replaced by
  each new audit, including Windows filesystems that return `EEXIST` during an atomic rename.

## [0.1.2] — 2026-09-20

### Added

- Concurrent audit execution through the OpenRouter Decisions endpoint, with probability-mass
  gating, token and actual-cost accounting, partial error handling, and the configured `failOn` CI
  exit gate.
- Live terminal progress showing the current folder and file, processed files, clean and affected
  files, chunks, and request counts.
- Markdown and JSON reports with an executive summary, severity counts, control coverage, evidence,
  reviewed remediation, clean checks, tool errors, scope totals, methodology, and effective config.
- Atomic recovery state at `.isojevdit/last-run.json`, recording the last folder, file, chunk,
  counters, provider status, and final report paths if a terminal closes or a run is interrupted.
- `--out <file>` for selecting the Markdown report path; the JSON sibling uses the same base name.

### Changed

- HTTP 429 responses now print a visible rate-limit notice, wait at least 10 seconds (or longer when
  `Retry-After` requires it), and retry the same request within the configured retry limit.
- The default spending guard is now `$10` (`maxSpendUsd: 10`).
- Small-file packing is disabled by default so a packed-chunk verdict is not attributed to unrelated
  files before localization is available. It remains available with `chunk.pack: true`.
- The report records only skipped-file counts instead of listing every skipped path.
- The generated `--init` settings and README now reflect the current engine, report, recovery,
  spending, and no-packing defaults.

### Fixed

- A packed request could report every member file as evidence for one positive verdict, producing
  misleading locations such as a credential finding on a file containing no credential. Disabling
  packing by default prevents that attribution problem until the localization pass is implemented.

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

[unreleased]: https://github.com/vidux/iso-jevdit/compare/v0.1.3...HEAD
[0.1.3]: https://github.com/vidux/iso-jevdit/compare/v0.1.2...v0.1.3
[0.1.2]: https://github.com/vidux/iso-jevdit/compare/v0.1.0...v0.1.2
[0.1.0]: https://github.com/vidux/iso-jevdit/releases/tag/v0.1.0
