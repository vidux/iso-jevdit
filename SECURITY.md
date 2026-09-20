# Security policy

`iso-jevdit` handles two sensitive things: an API credential, and your source code. This document
says what it does with both, what counts as a vulnerability, and how to report one.

## Supported versions

| Version | Supported |
|---|---|
| 0.1.x | Yes — current development line |
| < 0.1 | No |

While the major version is 0, fixes land on the latest minor release only.

## Reporting a vulnerability

**Please do not open a public issue for a security problem.**

Use GitHub's private vulnerability reporting on this repository: **Security → Advisories → Report a
vulnerability**. That opens a private thread with the maintainer and gives you a draft advisory to
collaborate in. If that is unavailable to you, contact the maintainer listed in `package.json`.

Helpful things to include:

- What an attacker achieves, and what they need to start (a malicious `settings.json`? a crafted
  filename? write access to the repository being audited?)
- The smallest reproduction you can manage — a minimal `settings.json`, a file tree, the command
- Version (`iso-jevdit --version`), Node version, and operating system

What to expect:

| | |
|---|---|
| Acknowledgement | within 3 working days |
| Initial assessment | within 10 working days |
| Fix or mitigation plan | agreed with you before any public disclosure |
| Credit | offered in the advisory and `CHANGELOG.md` unless you prefer otherwise |

Please give us a chance to ship a fix before disclosing publicly. If you get no response within 10
working days, escalate by opening a *non-detailed* public issue asking a maintainer to check their
advisories.

## What this tool does with your data

Understanding this is necessary to judge whether a behaviour is a bug.

### Your source code leaves your machine, by design

Chunks of your files are sent to the configured provider — by default OpenRouter, which routes them
to TypeSafe's Jev model. This is the tool's entire purpose and is not a vulnerability. Practical
consequences:

- Do not run it against code you are not permitted to send to a third party.
- Narrow what is sent with `ignoreDirs`, `ignore`, `--checks` or `--changed`.
- `--estimate` shows exactly how many files and tokens would be sent, and makes no API calls at all.
- Provider retention and training policies are the provider's, not ours. Review OpenRouter's terms
  and your account's data settings.

### Credentials

- Stored only in `~/.isojevdit/credentials.json`. Never written to `settings.json`, which is meant to
  be committed.
- Written atomically with mode `600`. On Windows, `fs.chmod` only toggles the read-only bit and
  restricts nobody, so the file's ACL is rewritten to the current user; if that fails the tool warns
  rather than pretending the file is protected.
- **Not encrypted at rest.** A key the tool can decrypt unattended is obfuscated, not protected. This
  matches `gh`, `npm` and the AWS CLI. If you need stronger custody, supply the key through
  `OPENROUTER_API_KEY` from your own secret manager and store nothing.
- Masked to the first 8 and last 4 characters in every output path: confirmations, `--show-config`,
  logs, error messages and the report.
- `--key=<value>` on a command line is recorded by your shell. On Windows, PowerShell writes
  `ConsoleHost_history.txt` in plaintext. The tool warns after every such save; `--key -` reads from
  stdin instead.
- A key found in `settings.json` (hand-edited) is still honoured, with a warning, so it cannot go
  unnoticed.

### The report

`iso-jevdit-report.md` is written into your project and is meant to be committed and shared. It
quotes the code that triggered each finding, so secret-shaped values in those snippets are masked
before anything is written to disk. If you find a way to get an unmasked secret into the report, the
cache, or a log, that is a vulnerability — please report it.

## In scope

Treat these as security issues:

- An API key appearing unmasked anywhere: report, JSON output, cache files, logs, error messages,
  `--show-config`.
- A key being written outside `~/.isojevdit/credentials.json`, or the file being created without
  restricted permissions when the platform allows them.
- Source code being sent to a host other than the configured `baseUrl`.
- Command injection, argument injection or path traversal through any input the tool reads:
  `settings.json` values, file paths, file contents, `.gitignore` patterns, provider responses.
- Writing files outside the project root or the user config directory, through a crafted `report.out`,
  `cache.dir`, `waivers` path or filename.
- Code execution from parsing untrusted input — a repository being audited, a provider response, or a
  `settings.json` from an untrusted source.
- A cache entry from one project being served to another, or a cache poisoned into suppressing
  findings.
- A crash or hang that a crafted repository can trigger reliably (a denial of service against CI).

## Not in scope

These are bugs worth reporting as ordinary issues, but they are not vulnerabilities:

- **False positives and false negatives.** Findings are probabilistic; the model can be wrong. Quality
  problems belong in a normal issue with the code that produced them.
- **The tool sending your code to the provider**, which is its documented purpose.
- **Keys stored unencrypted** in the credentials file, as described above.
- Cost overruns from configuration you chose. `--estimate` and `maxSpendUsd` exist to prevent
  surprises; a specific case where the guard fails to stop a run *is* in scope.
- Vulnerabilities in a dependency with no exploitable path through this tool — report them upstream,
  though a note here is welcome.
- Findings you disagree with on ISO interpretation grounds. Open an issue; the criteria text is
  deliberately reviewable and we would like the argument.

## Hardening a run

If you are auditing sensitive code:

```bash
# See exactly what would be sent, without sending anything
iso-jevdit --estimate .

# Keep the key out of the filesystem and out of shell history
export OPENROUTER_API_KEY="$(your-secret-manager get openrouter)"
iso-jevdit --changed origin/main

# Narrow what leaves the machine
iso-jevdit --ignore-dir infra --ignore '**/*.pem' --checks a8-28-* .
```

Check `.gitignore` covers `iso-jevdit-report.*` if your reports should not be committed, and remember
that `.isojevdit/cache/` holds model answers about your code — `iso-jevdit --init` git-ignores it for
you.
