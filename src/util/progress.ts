import { colors } from './logger.js';

const FRAME_MS = 80;
const BAR_WIDTH = 24;

/**
 * A single line that rewrites itself on a terminal, and stays silent when output is piped or quiet -
 * a progress bar in a CI log is noise, and in a redirected file it is corruption.
 */
export class Progress {
  private readonly enabled: boolean;
  private lastPaint = 0;
  private lastWidth = 0;
  private finished = false;

  constructor(enabled = Boolean(process.stderr.isTTY)) {
    this.enabled = enabled;
  }

  update(label: string, done: number, total?: number, force = false): void {
    if (!this.enabled || this.finished) return;
    const now = Date.now();
    if (!force && now - this.lastPaint < FRAME_MS) return;
    this.lastPaint = now;
    this.paint(this.compose(label, done, total));
  }

  private compose(label: string, done: number, total?: number): string {
    const c = colors();
    if (total === undefined || total <= 0) {
      return `${c.cyan(label)} ${c.dim(String(done))}`;
    }
    const ratio = Math.max(0, Math.min(1, done / total));
    const filled = Math.round(ratio * BAR_WIDTH);
    const bar = '█'.repeat(filled) + '░'.repeat(BAR_WIDTH - filled);
    return `${c.cyan(label)} ${c.dim(bar)} ${done}/${total}`;
  }

  private paint(line: string): void {
    // Pad to the previous width so a shorter line cannot leave characters behind.
    const padding = Math.max(0, this.lastWidth - stripAnsi(line).length);
    process.stderr.write(`\r${line}${' '.repeat(padding)}`);
    this.lastWidth = stripAnsi(line).length;
  }

  /** Clears the line and stops accepting updates. */
  done(): void {
    if (!this.enabled || this.finished) return;
    this.finished = true;
    process.stderr.write(`\r${' '.repeat(this.lastWidth)}\r`);
  }
}

// eslint-disable-next-line no-control-regex
const ANSI = /\u001b\[[0-9;]*m/g;

export function stripAnsi(text: string): string {
  return text.replace(ANSI, '');
}
