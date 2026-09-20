import { createHash } from 'node:crypto';

import { demoteSeverity, severityRank, type Check } from '../checks/types.js';
import type { Settings } from '../config/schema.js';
import { normalizeAnswer, positiveProbability } from '../jev/answers.js';
import { planRequests } from '../jev/request.js';
import { estimateCostUsd, type DecisionProvider, type ProviderEvent } from '../providers/types.js';
import type { Chunk } from '../scan/chunk.js';
import type { AuditResult, AuditStats, Finding, ToolError } from './types.js';

export interface EngineProgress {
  stats: Readonly<AuditStats>;
  currentChunk?: string;
  currentFolder?: string;
  currentFiles?: string[];
  providerEvent?: ProviderEvent;
}

export interface RunEngineOptions {
  chunks: readonly Chunk[];
  files: readonly string[];
  checks: readonly Check[];
  settings: Settings;
  provider: DecisionProvider;
  onProgress?: (progress: EngineProgress) => void;
}

function findingId(check: Check, locations: Finding['locations']): string {
  const first = locations[0]!;
  const digest = createHash('sha1').update(first.content.replace(/\s+/g, ' ').trim()).digest('hex').slice(0, 9);
  return `${check.id}@${first.path}#${digest}`;
}

function compareFindings(a: Finding, b: Finding): number {
  return (
    a.check.controls[0]!.localeCompare(b.check.controls[0]!) ||
    severityRank(a.severity) - severityRank(b.severity) ||
    a.locations[0]!.path.localeCompare(b.locations[0]!.path) ||
    a.locations[0]!.startLine - b.locations[0]!.startLine ||
    a.id.localeCompare(b.id)
  );
}

export async function runEngine(opts: RunEngineOptions): Promise<AuditResult> {
  const started = Date.now();
  const startedAt = new Date(started).toISOString();
  const plansByChunk = opts.chunks.map((chunk) => planRequests(chunk, opts.checks, opts.settings, opts.provider.contextTokens));
  const stats: AuditStats = {
    totalFiles: opts.files.length,
    processedFiles: 0,
    filesOk: 0,
    filesWithIssues: 0,
    totalChunks: opts.chunks.length,
    processedChunks: 0,
    totalRequests: plansByChunk.reduce((sum, plans) => sum + plans.length, 0),
    completedRequests: 0,
    failedRequests: 0,
    findings: 0,
    inputTokens: 0,
    outputTokens: 0,
    costUsd: 0,
  };
  const findings: Finding[] = [];
  const toolErrors: ToolError[] = [];
  const assessedCheckIds = new Set<string>();
  const filesWithIssues = new Set<string>();
  const remainingChunks = new Map<string, number>(opts.files.map((file) => [file, 0]));
  for (const chunk of opts.chunks) {
    for (const file of new Set(chunk.files.map((entry) => entry.path))) {
      remainingChunks.set(file, (remainingChunks.get(file) ?? 0) + 1);
    }
  }

  const notify = (chunk?: Chunk, providerEvent?: ProviderEvent): void => {
    const currentFiles = chunk ? [...new Set(chunk.files.map((file) => file.path))] : undefined;
    const currentFolder = currentFiles?.[0]?.includes('/') ? currentFiles[0].slice(0, currentFiles[0].lastIndexOf('/')) : '.';
    opts.onProgress?.({
      stats,
      ...(chunk ? { currentChunk: chunk.id } : {}),
      ...(currentFolder ? { currentFolder } : {}),
      ...(currentFiles ? { currentFiles } : {}),
      ...(providerEvent ? { providerEvent } : {}),
    });
  };
  notify();

  let nextChunk = 0;
  const worker = async (): Promise<void> => {
    for (;;) {
      const index = nextChunk++;
      const chunk = opts.chunks[index];
      if (!chunk) return;
      const plans = plansByChunk[index]!;

      for (const plan of plans) {
        for (const binding of plan.bindings) assessedCheckIds.add(binding.check.id);
        try {
          const response = await opts.provider.decide({
            model: opts.provider.model,
            state: plan.state,
            questions: plan.questions,
          }, { onEvent: (event) => notify(chunk, event) });
          stats.completedRequests += 1;
          stats.inputTokens += response.usage.inputTokens;
          stats.outputTokens += response.usage.outputTokens;
          stats.costUsd += estimateCostUsd(response.usage, opts.provider.pricing);

          for (const binding of plan.bindings) {
            try {
              if (!(binding.key in response.answers)) throw new Error(`response omitted answer "${binding.key}"`);
              const answer = normalizeAnswer(response.answers[binding.key], binding.check);
              const probability = positiveProbability(answer, binding.check);
              const threshold = binding.check.threshold ?? opts.settings.thresholds.report;
              if (probability < threshold) continue;

              const lowConfidence = probability < opts.settings.thresholds.high;
              const locations = chunk.files.map((file) => ({ ...file, approximate: true }));
              const finding: Finding = {
                id: findingId(binding.check, locations),
                check: binding.check,
                severity: lowConfidence ? demoteSeverity(binding.check.severity) : binding.check.severity,
                probability,
                lowConfidence,
                answer,
                locations,
              };
              findings.push(finding);
              for (const location of locations) filesWithIssues.add(location.path);
            } catch (err) {
              toolErrors.push({ chunkId: chunk.id, paths: chunk.files.map((file) => file.path), message: (err as Error).message });
            }
          }
        } catch (err) {
          stats.failedRequests += 1;
          toolErrors.push({ chunkId: chunk.id, paths: chunk.files.map((file) => file.path), message: (err as Error).message });
        }
        notify(chunk);
      }

      stats.processedChunks += 1;
      for (const file of new Set(chunk.files.map((entry) => entry.path))) {
        const remaining = Math.max(0, (remainingChunks.get(file) ?? 1) - 1);
        remainingChunks.set(file, remaining);
        if (remaining === 0) stats.processedFiles += 1;
      }
      stats.filesWithIssues = filesWithIssues.size;
      stats.filesOk = stats.processedFiles - [...filesWithIssues].filter((file) => remainingChunks.get(file) === 0).length;
      stats.findings = findings.length;
      notify(chunk);
    }
  };

  await Promise.all(Array.from({ length: Math.min(opts.settings.concurrency, Math.max(1, opts.chunks.length)) }, () => worker()));
  stats.filesWithIssues = filesWithIssues.size;
  stats.filesOk = Math.max(0, stats.processedFiles - stats.filesWithIssues);
  stats.findings = findings.length;
  findings.sort(compareFindings);
  toolErrors.sort((a, b) => a.chunkId.localeCompare(b.chunkId) || a.message.localeCompare(b.message));

  const completed = Date.now();
  return {
    findings,
    toolErrors,
    stats,
    assessedCheckIds: [...assessedCheckIds].sort(),
    startedAt,
    completedAt: new Date(completed).toISOString(),
    durationMs: completed - started,
  };
}