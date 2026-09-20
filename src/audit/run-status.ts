import path from 'node:path';

import type { EngineProgress } from './engine.js';
import { RUN_STATUS_FILE_NAME, projectConfigDir } from '../config/paths.js';
import { ensureDir, writeFileAtomic } from '../util/fs.js';

export type RunPhase = 'running' | 'rate-limited' | 'completed' | 'failed';

export interface RunStatus {
  version: 1;
  status: RunPhase;
  startedAt: string;
  updatedAt: string;
  completedAt?: string;
  root: string;
  target: string;
  provider: string;
  model: string;
  currentFolder?: string;
  currentFiles?: string[];
  currentChunk?: string;
  message?: string;
  stats: EngineProgress['stats'];
  reportPath?: string;
  jsonPath?: string;
}

export interface RunStatusJournalOptions {
  root: string;
  target: string;
  provider: string;
  model: string;
  startedAt: string;
  initialStats: EngineProgress['stats'];
}

export class RunStatusJournal {
  readonly filePath: string;
  private state: RunStatus;
  private pending: Promise<void> = Promise.resolve();

  constructor(opts: RunStatusJournalOptions) {
    this.filePath = path.join(projectConfigDir(opts.root), RUN_STATUS_FILE_NAME);
    this.state = {
      version: 1,
      status: 'running',
      startedAt: opts.startedAt,
      updatedAt: opts.startedAt,
      root: opts.root,
      target: opts.target,
      provider: opts.provider,
      model: opts.model,
      stats: { ...opts.initialStats },
    };
  }

  update(progress: EngineProgress): void {
    const event = progress.providerEvent;
    this.state = {
      ...this.state,
      status: event?.type === 'rate-limit' ? 'rate-limited' : 'running',
      updatedAt: new Date().toISOString(),
      stats: { ...progress.stats },
      ...(progress.currentFolder ? { currentFolder: progress.currentFolder } : {}),
      ...(progress.currentFiles ? { currentFiles: [...progress.currentFiles] } : {}),
      ...(progress.currentChunk ? { currentChunk: progress.currentChunk } : {}),
      ...(event ? { message: `${event.type}: waiting ${Math.ceil(event.waitMs / 1000)}s before retry ${event.attempt}/${event.maxRetries}` } : { message: undefined }),
    };
    this.queueWrite();
  }

  complete(reportPath: string, jsonPath?: string): void {
    const now = new Date().toISOString();
    this.state = {
      ...this.state,
      status: 'completed',
      updatedAt: now,
      completedAt: now,
      reportPath,
      ...(jsonPath ? { jsonPath } : {}),
      message: 'Audit completed and reports were written.',
    };
    this.queueWrite();
  }

  fail(message: string): void {
    this.state = { ...this.state, status: 'failed', updatedAt: new Date().toISOString(), message };
    this.queueWrite();
  }

  async flush(): Promise<void> {
    await this.pending;
  }

  private queueWrite(): void {
    const snapshot = JSON.stringify(this.state, null, 2) + '\n';
    this.pending = this.pending.then(async () => {
      await ensureDir(path.dirname(this.filePath));
      await writeFileAtomic(this.filePath, snapshot);
    });
  }
}