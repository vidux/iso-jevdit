export const EXIT = {
  ok: 0,
  findings: 1,
  config: 2,
  credential: 3,
  noFiles: 4,
  spend: 5,
} as const;

export type ExitCode = (typeof EXIT)[keyof typeof EXIT];

export class IsoJevditError extends Error {
  readonly exitCode: ExitCode;
  /** Extra lines printed under the message, e.g. the two ways to supply a key. */
  readonly hints: string[];

  constructor(message: string, exitCode: ExitCode, hints: string[] = []) {
    super(message);
    this.name = 'IsoJevditError';
    this.exitCode = exitCode;
    this.hints = hints;
  }
}

export function configError(message: string, hints: string[] = []): IsoJevditError {
  return new IsoJevditError(message, EXIT.config, hints);
}

export function credentialError(message: string, hints: string[] = []): IsoJevditError {
  return new IsoJevditError(message, EXIT.credential, hints);
}
