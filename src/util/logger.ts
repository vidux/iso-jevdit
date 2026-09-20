import pc from 'picocolors';

export type LogLevel = 'quiet' | 'normal' | 'verbose';

let level: LogLevel = 'normal';
// Diagnostics go to stderr, so that is the stream whose TTY-ness decides colour.
let c = pc.createColors(pc.isColorSupported && (Boolean(process.stderr.isTTY) || Boolean(process.env.FORCE_COLOR)));

export function configureLogger(opts: { level?: LogLevel; color?: boolean }): void {
  if (opts.level) level = opts.level;
  if (opts.color !== undefined) c = pc.createColors(opts.color);
}

export function colors(): ReturnType<typeof pc.createColors> {
  return c;
}

// Diagnostics go to stderr so stdout stays machine-readable.
function write(line: string): void {
  process.stderr.write(`${line}\n`);
}

export const log = {
  error(msg: string): void {
    write(`${c.red('error')}  ${msg}`);
  },
  warn(msg: string): void {
    if (level !== 'quiet') write(`${c.yellow('warning')}  ${msg}`);
  },
  info(msg: string): void {
    if (level !== 'quiet') write(msg);
  },
  success(msg: string): void {
    if (level !== 'quiet') write(`${c.green(msg)}`);
  },
  detail(msg: string): void {
    if (level === 'verbose') write(c.dim(msg));
  },
  kv(label: string, value: string): void {
    if (level !== 'quiet') write(`  ${c.dim(label.padEnd(10))} ${value}`);
  },
  blank(): void {
    if (level !== 'quiet') write('');
  },
};

/** Results the user might pipe or redirect. */
export function out(text: string): void {
  process.stdout.write(`${text}\n`);
}

export function isVerbose(): boolean {
  return level === 'verbose';
}
