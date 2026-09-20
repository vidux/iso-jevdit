import path from 'node:path';

import type { AuditResult, Finding } from '../audit/types.js';
import { SEVERITIES, type Check, type Severity } from '../checks/types.js';
import type { Settings } from '../config/schema.js';
import type { ResolvedProvider } from '../providers/index.js';
import type { DiscoveryResult } from '../scan/discover.js';
import type { ReadSkip } from '../scan/chunk.js';
import type { GitInfo } from '../util/git.js';
import { formatTokens, formatUsd } from '../util/tokens.js';
import { maskSecretsInText } from './redact.js';

export interface MarkdownReportOptions {
  result: AuditResult;
  settings: Settings;
  checks: readonly Check[];
  provider: ResolvedProvider;
  root: string;
  targetPath: string;
  discovery: DiscoveryResult;
  readSkips: readonly ReadSkip[];
  git: GitInfo | null;
  version: string;
}

function countBySeverity(findings: readonly Finding[]): Record<Severity, number> {
  return Object.fromEntries(SEVERITIES.map((severity) => [severity, findings.filter((finding) => finding.severity === severity).length])) as Record<Severity, number>;
}

function pct(value: number): string {
  return `${(value * 100).toFixed(1)}%`;
}

function duration(ms: number): string {
  if (ms < 1000) return `${ms} ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)} s`;
  return `${Math.floor(ms / 60_000)}m ${Math.round((ms % 60_000) / 1000)}s`;
}

function fenceFor(content: string): string {
  return content.includes('```') ? '````' : '```';
}

function findingMarkdown(finding: Finding, snippetLines: number): string[] {
  const lines = [
    `### ${finding.check.title}`,
    '',
    `- **Finding ID:** \`${finding.id}\``,
    `- **Severity:** ${finding.severity}${finding.lowConfidence ? ' (reduced: probability below the high-confidence threshold)' : ''}`,
    `- **Violation probability:** ${pct(finding.probability)}`,
    `- **Controls:** ${finding.check.controls.join(', ')}`,
    '',
    '**Evidence**',
    '',
  ];

  for (const location of finding.locations) {
    lines.push(`\`${location.path}:${location.startLine}-${location.endLine}\`${location.approximate ? ' *(approximate chunk range)*' : ''}`);
    if (snippetLines > 0) {
      const content = maskSecretsInText(location.content.split(/\r?\n/).slice(0, snippetLines).join('\n'));
      const fence = fenceFor(content);
      lines.push('', fence, content, fence);
    }
    lines.push('');
  }

  lines.push(
    '**Control requirement**',
    '',
    finding.check.kb.requirement,
    '',
    '**Why it matters**',
    '',
    finding.check.kb.why,
    '',
    '**Typical impact**',
    '',
    finding.check.kb.impact,
    '',
    '**Remediation**',
    '',
    finding.check.kb.remediation,
    '',
  );

  const probabilities = Object.entries(finding.answer.probabilities).sort((a, b) => b[1] - a[1]);
  if (probabilities.length > 0) {
    lines.push('| Model label | Probability |', '|---|---:|');
    for (const [label, probability] of probabilities) lines.push(`| ${label} | ${pct(probability)} |`);
    lines.push('');
  }

  if (finding.check.kb.references.length > 0) {
    lines.push(`**References:** ${finding.check.kb.references.join('; ')}`, '');
  }
  return lines;
}

export function renderMarkdownReport(opts: MarkdownReportOptions): string {
  const { result } = opts;
  const counts = countBySeverity(result.findings);
  const assessed = opts.checks.filter((check) => result.assessedCheckIds.includes(check.id));
  const checksWithFindings = new Set(result.findings.map((finding) => finding.check.id));
  const controls = [...new Set(assessed.flatMap((check) => check.controls))].sort();
  const controlsWithFindings = new Set(result.findings.flatMap((finding) => finding.check.controls));
  const worst = result.findings[0];
  const lines = [
    '# ISO/IEC 27001:2022 Annex A Source Audit',
    '',
    '> AI-assisted evidence for human review. This report is not certification or a conformity assessment.',
    '',
    '## Run details',
    '',
    `| Item | Value |`,
    `|---|---|`,
    `| Tool | iso-jevdit ${opts.version} |`,
    `| Provider / model | ${opts.provider.name} / ${opts.provider.model} |`,
    `| Target | \`${path.relative(opts.root, opts.targetPath) || '.'}\` |`,
    ...(opts.settings.report.timestamp ? [`| Completed | ${result.completedAt} |`] : []),
    `| Duration | ${duration(result.durationMs)} |`,
    `| Files processed | ${result.stats.processedFiles} / ${result.stats.totalFiles} |`,
    `| Chunks processed | ${result.stats.processedChunks} / ${result.stats.totalChunks} |`,
    `| Requests | ${result.stats.completedRequests} completed, ${result.stats.failedRequests} failed |`,
    `| Usage | ${formatTokens(result.stats.inputTokens)} input, ${formatTokens(result.stats.outputTokens)} output |`,
    `| Cost | ${formatUsd(result.stats.costUsd)} |`,
    ...(opts.git ? [`| Git | \`${opts.git.branch}@${opts.git.shortCommit}\`${opts.git.dirty ? ' (working tree dirty)' : ''} |`] : []),
    '',
    '## Executive summary',
    '',
    `- **${result.stats.filesWithIssues}** file(s) with findings; **${result.stats.filesOk}** file(s) had no finding above the configured threshold.`,
    `- **${result.findings.length}** finding(s): ${SEVERITIES.map((severity) => `${counts[severity]} ${severity}`).join(', ')}.`,
    `- **${controls.length}** Annex A control(s) assessed; **${controlsWithFindings.size}** had findings; **${Math.max(0, controls.length - controlsWithFindings.size)}** had none above threshold.`,
    ...(worst ? [`- Highest-priority finding: **${worst.check.title}** (${worst.severity}, ${pct(worst.probability)}).`] : ['- No finding crossed the configured report threshold.']),
    ...(result.toolErrors.length > 0 ? [`- **Coverage warning:** ${result.toolErrors.length} tool error(s) occurred; review the errors section before relying on coverage.`] : []),
    '',
    '## Control coverage',
    '',
    '| Control | Checks run | Findings | Worst severity | Status |',
    '|---|---:|---:|---|---|',
  ];

  for (const control of controls) {
    const controlChecks = assessed.filter((check) => check.controls.includes(control));
    const findings = result.findings.filter((finding) => finding.check.controls.includes(control));
    lines.push(`| ${control} | ${controlChecks.length} | ${findings.length} | ${findings[0]?.severity ?? '—'} | ${findings.length > 0 ? 'Review' : 'No finding above threshold'} |`);
  }

  lines.push('', '## Findings', '');
  if (result.findings.length === 0) lines.push('No findings crossed the configured report threshold.', '');
  for (const finding of result.findings) lines.push(...findingMarkdown(finding, opts.settings.report.snippetLines));

  if (result.toolErrors.length > 0) {
    lines.push('## Tool errors and coverage gaps', '');
    for (const error of result.toolErrors) {
      lines.push(`- \`${error.chunkId}\` (${error.paths.join(', ')}): ${maskSecretsInText(error.message)}`);
    }
    lines.push('');
  }

  if (opts.settings.report.includePassed) {
    lines.push('## Checks with no finding above threshold', '');
    const clean = assessed.filter((check) => !checksWithFindings.has(check.id));
    if (clean.length === 0) lines.push('None.', '');
    else lines.push(...clean.map((check) => `- \`${check.id}\` — ${check.title}`), '');
  }

  lines.push(
    '## Appendix A — Scope',
    '',
    `Eligible files: ${opts.discovery.files.length}. Discovery skips: ${opts.discovery.counts.ignoredFiles} ignored files, ${opts.discovery.counts.ignoredDirs} ignored directories, ${opts.discovery.counts.tooLarge} oversized files, and ${opts.discovery.counts.notEligible} files of non-audited types.`,
    '',
  );
  const skipLines = [
    ...opts.discovery.skips.map((skip) => `- \`${skip.path}\` — ${skip.layer ? `${skip.layer}: ${skip.rule ?? skip.kind}` : (skip.detail ?? skip.kind)}`),
    ...opts.readSkips.map((skip) => `- \`${skip.path}\` — ${skip.kind}${skip.detail ? `: ${skip.detail}` : ''}`),
  ];
  lines.push(...(skipLines.length > 0 ? skipLines : ['No eligible file was skipped after discovery.']), '');

  lines.push(
    '## Appendix B — Controls not assessable from source',
    '',
    'Management-system clauses 4–10 and organizational, people, and physical controls that require policy, interviews, operational records, or physical inspection were not assessed. Their absence from findings is not evidence of conformity.',
    '',
    '## Appendix C — Methodology and limitations',
    '',
    '- Source regions were sent to the configured decision provider with typed control questions.',
    '- Findings are gated on probability mass assigned to violation labels, not on distribution concentration (`confidence`).',
    '- Report wording and remediation come from the built-in control knowledge base, not generated model prose.',
    '- Locations are chunk ranges and are marked approximate until localization is enabled.',
    '- Probabilistic judgments can produce false positives and false negatives; a qualified reviewer must verify every result.',
    '- This is source-code evidence gathering only. It is not DAST, dependency-CVE analysis, certification, or a conformity assessment.',
    '',
  );

  if (opts.settings.report.includeConfig) {
    const safeSettings = structuredClone(opts.settings);
    for (const provider of Object.values(safeSettings.providers)) delete provider.apiKey;
    const config = maskSecretsInText(JSON.stringify(safeSettings, null, 2));
    lines.push('## Appendix D — Effective configuration', '', '```json', config, '```', '');
  }

  return `${lines.join('\n').trimEnd()}\n`;
}