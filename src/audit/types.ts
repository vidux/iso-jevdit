import type { Check, Severity } from '../checks/types.js';
import type { NormalizedAnswer } from '../jev/answers.js';
import type { ChunkFile } from '../scan/chunk.js';

export interface FindingLocation extends ChunkFile {
  approximate: boolean;
}

export interface Finding {
  id: string;
  check: Check;
  severity: Severity;
  probability: number;
  lowConfidence: boolean;
  answer: NormalizedAnswer;
  locations: FindingLocation[];
}

export interface ToolError {
  chunkId: string;
  paths: string[];
  message: string;
}

export interface AuditStats {
  totalFiles: number;
  processedFiles: number;
  filesOk: number;
  filesWithIssues: number;
  totalChunks: number;
  processedChunks: number;
  totalRequests: number;
  completedRequests: number;
  failedRequests: number;
  findings: number;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
}

export interface AuditResult {
  findings: Finding[];
  toolErrors: ToolError[];
  stats: AuditStats;
  assessedCheckIds: string[];
  startedAt: string;
  completedAt: string;
  durationMs: number;
}