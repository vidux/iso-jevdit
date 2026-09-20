import path from 'node:path';

import type { AuditResult } from '../audit/types.js';
import { ensureDir, writeFileAtomic } from '../util/fs.js';
import { maskSecretsInText } from './redact.js';
import { renderMarkdownReport, type MarkdownReportOptions } from './markdown.js';

export interface WrittenReports {
  markdownPath: string;
  jsonPath?: string;
}

function jsonResult(result: AuditResult): unknown {
  return {
    ...result,
    findings: result.findings.map((finding) => ({
      ...finding,
      check: {
        id: finding.check.id,
        title: finding.check.title,
        controls: finding.check.controls,
        severity: finding.check.severity,
        kb: finding.check.kb,
      },
    })),
  };
}

export async function writeReports(opts: MarkdownReportOptions): Promise<WrittenReports> {
  const markdownPath = path.resolve(opts.root, opts.settings.report.out);
  await ensureDir(path.dirname(markdownPath));
  await writeFileAtomic(markdownPath, renderMarkdownReport(opts));

  if (!opts.settings.report.json) return { markdownPath };
  const parsed = path.parse(markdownPath);
  const jsonPath = path.join(parsed.dir, `${parsed.name}.json`);
  const json = maskSecretsInText(`${JSON.stringify(jsonResult(opts.result), null, 2)}\n`);
  await writeFileAtomic(jsonPath, json);
  return { markdownPath, jsonPath };
}