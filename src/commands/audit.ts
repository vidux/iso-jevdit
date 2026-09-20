import path from 'node:path';

import { buildEstimate } from '../audit/estimate.js';
import type { Check } from '../checks/types.js';
import type { LoadedConfig } from '../config/load.js';
import { EXIT, IsoJevditError, type ExitCode } from '../errors.js';
import { requireKey, resolveApiKey, type ResolvedProvider } from '../providers/index.js';
import { chunkFiles } from '../scan/chunk.js';
import { discover } from '../scan/discover.js';
import { changedFiles } from '../util/git.js';
import { formatTokens, formatUsd } from '../util/tokens.js';
import { isVerbose, log } from '../util/logger.js';

export interface AuditOptions {
  loaded: LoadedConfig;
  checks: readonly Check[];
  provider: ResolvedProvider;
  estimateOnly: boolean;
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
  const resolution = await resolveApiKey(provider);
  requireKey(provider, resolution);
  log.detail(`credential resolved from ${resolution.describe}`);

  log.warn('the decision engine is not wired up yet, so no report was written.');
  log.info('  Implemented so far: discovery, ignore layers, chunking, packing, cost forecast,');
  log.info('  credential storage, and the check catalog. Next milestone: decisions and the report.');
  log.info('  Everything above is real output from this run - re-run with --estimate to skip this notice.');
  log.blank();
  return EXIT.ok;
}
