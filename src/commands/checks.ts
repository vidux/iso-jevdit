import type { Check } from '../checks/types.js';
import { EXIT, type ExitCode } from '../errors.js';
import { out } from '../util/logger.js';

function pad(text: string, width: number): string {
  return text.length >= width ? text : text + ' '.repeat(width - text.length);
}

export function runListChecks(checks: readonly Check[]): ExitCode {
  const rows = checks.map((check) => ({
    id: check.id,
    controls: check.controls.join(' '),
    severity: check.severity,
    scope: check.scope,
    languages: check.languages ? `${check.languages.length} languages` : 'all files',
    source: check.source === 'config' ? 'settings.json' : 'catalog',
    title: check.title,
  }));

  const widths = {
    id: Math.max(2, ...rows.map((r) => r.id.length)),
    controls: Math.max(8, ...rows.map((r) => r.controls.length)),
    severity: 8,
    scope: 5,
  };

  out(
    [
      pad('ID', widths.id),
      pad('CONTROLS', widths.controls),
      pad('SEVERITY', widths.severity),
      pad('SCOPE', widths.scope),
      'TITLE',
    ].join('  '),
  );

  for (const row of rows) {
    out(
      [
        pad(row.id, widths.id),
        pad(row.controls, widths.controls),
        pad(row.severity, widths.severity),
        pad(row.scope, widths.scope),
        row.title,
      ].join('  '),
    );
  }

  const fromConfig = rows.filter((r) => r.source === 'settings.json').length;
  out('');
  out(`${rows.length} check${rows.length === 1 ? '' : 's'} selected${fromConfig > 0 ? ` (${fromConfig} from settings.json)` : ''}.`);
  return EXIT.ok;
}
