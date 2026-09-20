import path from 'node:path';

import { runEngine } from '../audit/engine.js';
import { buildEstimate } from '../audit/estimate.js';
import { RunStatusJournal } from '../audit/run-status.js';
import type { AuditStats } from '../audit/types.js';
import { severityAtLeast, type Check } from '../checks/types.js';
import type { LoadedConfig } from '../config/load.js';
import { EXIT, IsoJevditError, type ExitCode } from '../errors.js';
import { createProvider, requireKey, resolveApiKey, type ResolvedProvider } from '../providers/index.js';
import { writeReports } from '../report/write.js';
import { chunkFiles } from '../scan/chunk.js';
import { discover } from '../scan/discover.js';
import { changedFiles, gitInfo } from '../util/git.js';
import { formatTokens, formatUsd } from '../util/tokens.js';
import { isQuiet, isVerbose, log } from '../util/logger.js';
import { Progress } from '../util/progress.js';

export interface AuditOptions {
  loaded: LoadedConfig;
  checks: readonly Check[];
  provider: ResolvedProvider;
  estimateOnly: boolean;
  version: string;
  key?: string;
  changedRef?: string;
}

export async function runAudit(opts: AuditOptions): Promise<ExitCode> {
  const { loaded, provider } = opts;
  const { settings } = loaded;

  let limitTo: Set<string> | undefined;
  if (opts.changedRef) {
    const changed = await changedFiles(loaded.root, opts.changedRef);
    if (!changed) {
      throw new IsoJevditError(`could not list files changed against "${opts.changedRef}"`, EXIT.config, [
        'Is this a git repository, and is the ref valid?',
      ]);
    }
    limitTo = new Set(changed);
    log.detail(`--changed ${opts.changedRef}: ${limitTo.size} changed paths`);
  }

  const discovery = await discover({
    root: loaded.root,
    targetPath: loaded.targetPath,
    targetIsFile: loaded.targetIsFile,
    settings,
    ...(limitTo ? { limitTo } : {}),
  });

  if (discovery.files.length === 0) {
    const hint = limitTo
      ? 'Nothing changed against that ref, or the changed files are not auditable types.'
      : 'Everything under the target is ignored or of a type that is not audited. Try --explain-ignores <path>.';
    throw new IsoJevditError('no auditable files found', EXIT.noFiles, [hint]);
  }

  const { chunks, skips: readSkips } = await chunkFiles(discovery.files, {
    settings,
    explicitFile: discovery.explicitFile,
  });

  const estimate = buildEstimate({
    chunks,
    checks: opts.checks,
    settings,
    contextTokens: provider.defaults.contextTokens,
    pricing: provider.defaults.pricing,
  });

  const skippedTotal =
    discovery.counts.ignoredDirs + discovery.counts.ignoredFiles + discovery.counts.tooLarge + readSkips.length;
  const packedFiles = chunks.filter((c) => c.packed).reduce((sum, c) => sum + c.files.length, 0);

  log.blank();
  log.info('Scan');
  log.kv('root', loaded.root);
  log.kv('target', path.relative(loaded.root, loaded.targetPath) || '.');
  log.kv('files', `${discovery.files.length} eligible, ${skippedTotal} skipped, ${discovery.counts.notEligible} not audited types`);
  log.kv(
    'chunks',
    `${estimate.chunks}${estimate.packedChunks > 0 ? ` (${estimate.packedChunks} packed from ${packedFiles} files)` : ''}`,
  );
  log.kv(
    'languages',
    estimate.byLanguage
      .slice(0, 6)
      .map((l) => `${l.language} ${l.chunks}`)
      .join(', '),
  );
  if (estimate.skippedChunks > 0) {
    log.kv('unasked', `${estimate.skippedChunks} chunks have no applicable check`);
  }

  log.blank();
  log.info(`Forecast  ${opts.estimateOnly ? '(--estimate: no API calls made)' : ''}`.trimEnd());
  log.kv('provider', `${provider.name} / ${provider.model}`);
  log.kv('checks', `${opts.checks.length} selected, ${estimate.minChecksPerChunk}-${estimate.maxChecksPerChunk} asked per chunk`);
  log.kv('requests', String(estimate.requests));
  log.kv(
    'tokens',
    `${formatTokens(estimate.inputTokens)} input  (state ${formatTokens(estimate.stateTokens)} + questions ${formatTokens(estimate.questionTokens)})`,
  );
  log.kv('cost', `${formatUsd(estimate.costUsd)}   band ${formatUsd(estimate.lowUsd)} - ${formatUsd(estimate.highUsd)}`);
  log.kv('budget', `maxSpendUsd ${formatUsd(settings.maxSpendUsd)}`);

  if (estimate.oversizedChunks > 0) {
    log.blank();
    log.warn(
      `${estimate.oversizedChunks} chunk(s) carry more than the ${provider.defaults.contextTokens}-token context allows, so those requests would be rejected.`,
    );
    log.info(`  Lower chunk.maxTokens (now ${settings.chunk.maxTokens}) or shorten prompts.projectContext.`);
  }

  if (isVerbose()) {
    log.blank();
    log.detail('Skipped:');
    for (const skip of discovery.skips.slice(0, 40)) {
      log.detail(`  ${skip.path}  ${skip.layer ? `[${skip.layer}] ${skip.rule ?? ''}` : (skip.detail ?? skip.kind)}`);
    }
    for (const skip of readSkips.slice(0, 20)) {
      log.detail(`  ${skip.path}  [${skip.kind}] ${skip.detail ?? ''}`);
    }
    if (discovery.counts.skipRecordsOmitted > 0) {
      log.detail(`  ... and ${discovery.counts.skipRecordsOmitted} more`);
    }
  }
  log.blank();

  if (opts.estimateOnly) return EXIT.ok;

  if (estimate.costUsd > settings.maxSpendUsd) {
    throw new IsoJevditError(
      `the forecast (${formatUsd(estimate.costUsd)}) exceeds maxSpendUsd (${formatUsd(settings.maxSpendUsd)})`,
      EXIT.spend,
      ['Raise it with --max-spend <usd>, or narrow the scan with --changed, --checks or ignoreDirs.'],
    );
  }

  // Fail on a missing credential here, where the message is actionable, rather than mid-run.
  const resolution = await resolveApiKey(provider, opts.key);
  const key = requireKey(provider, resolution);
  log.detail(`credential resolved from ${resolution.describe}`);

  const decisionProvider = createProvider(provider, key);
  const auditableFiles = [...new Set(chunks.flatMap((chunk) => chunk.files.map((file) => file.path)))];
  const progress = new Progress(Boolean(process.stderr.isTTY) && !isQuiet());
  const startedAt = new Date().toISOString();
  const initialStats: AuditStats = {
    totalFiles: auditableFiles.length,
    processedFiles: 0,
    filesOk: 0,
    filesWithIssues: 0,
    totalChunks: chunks.length,
    processedChunks: 0,
    totalRequests: estimate.requests,
    completedRequests: 0,
    failedRequests: 0,
    findings: 0,
    inputTokens: 0,
    outputTokens: 0,
    costUsd: 0,
  };
  const journal = new RunStatusJournal({
    root: loaded.root,
    target: loaded.targetPath,
    provider: provider.name,
    model: provider.model,
    startedAt,
    initialStats,
  });
  journal.update({ stats: initialStats });
  await journal.flush();

  let result;
  try {
    result = await runEngine({
      chunks,
      files: auditableFiles,
      checks: opts.checks,
      settings,
      provider: decisionProvider,
      onProgress: (event) => {
        journal.update(event);
        if (event.providerEvent?.type === 'rate-limit') {
          progress.notice(
            `Rate limit detected. Waiting ${Math.ceil(event.providerEvent.waitMs / 1000)} seconds, then retrying ` +
              `(${event.providerEvent.attempt}/${event.providerEvent.maxRetries}).`,
          );
        }
        const currentFile = event.currentFiles?.join(', ') ?? 'preparing';
        progress.update(
          `Audit  folder ${event.currentFolder ?? '.'}  file ${currentFile}  files ${event.stats.processedFiles}/${event.stats.totalFiles}  ok ${event.stats.filesOk}  issues ${event.stats.filesWithIssues}  requests ${event.stats.completedRequests + event.stats.failedRequests}/${event.stats.totalRequests}`,
          event.stats.processedChunks,
          event.stats.totalChunks,
          Boolean(event.providerEvent),
        );
      },
    });
  } catch (err) {
    progress.done();
    journal.fail((err as Error).message);
    await journal.flush();
    throw err;
  }
  progress.done();

  const reports = await writeReports({
    result,
    settings,
    checks: opts.checks,
    provider,
    root: loaded.root,
    targetPath: loaded.targetPath,
    discovery,
    readSkips,
    git: await gitInfo(loaded.root),
    version: opts.version,
  });
  journal.complete(reports.markdownPath, reports.jsonPath);
  await journal.flush();

  log.blank();
  log.info('Summary');
  log.kv('files', `${result.stats.processedFiles}/${result.stats.totalFiles} processed`);
  log.kv('clean', String(result.stats.filesOk));
  log.kv('issues', `${result.stats.filesWithIssues} files, ${result.stats.findings} findings`);
  log.kv('requests', `${result.stats.completedRequests}/${result.stats.totalRequests} completed, ${result.stats.failedRequests} failed`);
  log.kv('usage', `${formatTokens(result.stats.inputTokens)} input, ${formatTokens(result.stats.outputTokens)} output`);
  log.kv('cost', formatUsd(result.stats.costUsd));
  log.kv('report', reports.markdownPath);
  if (reports.jsonPath) log.kv('json', reports.jsonPath);
  log.kv('status', journal.filePath);
  if (result.stats.findings === 0) log.success('No findings crossed the configured threshold.');
  else log.warn(`${result.stats.findings} finding(s) need review.`);
  if (result.toolErrors.length > 0) log.warn(`${result.toolErrors.length} tool error(s) are recorded in the report.`);
  log.blank();

  if (result.stats.totalRequests > 0 && result.stats.completedRequests === 0) return EXIT.credential;
  const failOn = settings.failOn;
  if (failOn !== 'none') {
    if (result.findings.some((finding) => severityAtLeast(finding.severity, failOn))) return EXIT.findings;
  }
  return EXIT.ok;
}
