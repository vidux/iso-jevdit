import { colors } from './logger.js';

const FRAME_MS = 80;
const BAR_WIDTH = 24;
const MIN_BAR_WIDTH = 6;

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
    const columns = Math.max(20, (process.stderr.columns ?? 120) - 1);
    if (total === undefined || total <= 0) {
      const suffix = ` ${done}`;
      return `${c.cyan(fitText(label, columns - suffix.length))}${c.dim(suffix)}`;
    }
    const ratio = Math.max(0, Math.min(1, done / total));
    const count = `${done}/${total}`;
    const barWidth = Math.max(MIN_BAR_WIDTH, Math.min(BAR_WIDTH, Math.floor(columns * 0.2)));
    const filled = Math.round(ratio * barWidth);
    const bar = '█'.repeat(filled) + '░'.repeat(barWidth - filled);
    const suffix = ` ${bar} ${count}`;
    return `${c.cyan(fitText(label, columns - suffix.length))}${c.dim(suffix)}`;
  }

  private paint(line: string): void {
    // Pad to the previous width so a shorter line cannot leave characters behind.
    const padding = Math.max(0, this.lastWidth - stripAnsi(line).length);
    process.stderr.write(`\r${line}${' '.repeat(padding)}`);
    this.lastWidth = stripAnsi(line).length;
  }

  /** Prints an important event above the live line, then allows progress painting to continue. */
  notice(line: string): void {
    if (!this.enabled || this.finished) return;
    process.stderr.write(`\r${' '.repeat(this.lastWidth)}\r${line}\n`);
    this.lastWidth = 0;
    this.lastPaint = 0;
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

/** Keeps both ends visible because progress labels put counters first and the active file last. */
export function fitText(text: string, width: number): string {
  if (width <= 0) return '';
  if (text.length <= width) return text.padEnd(width);
  if (width <= 3) return '.'.repeat(width);
  const left = Math.ceil((width - 3) / 2);
  const right = Math.floor((width - 3) / 2);
  return `${text.slice(0, left)}...${text.slice(text.length - right)}`;
}
