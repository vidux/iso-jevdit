import type { KbEntry } from '../types.js';

export const a8SecureCodingKb: Record<string, KbEntry> = {
  'a8-28-sql-injection': {
    requirement:
      'Secure coding principles must be applied to software development. Among them: data and code must stay separated, so a value supplied by a caller is never able to change the structure of a statement the program executes.',
    why:
      'When a query is assembled by concatenating or interpolating a value, the database parses that value as part of the statement. A value containing SQL syntax therefore becomes SQL. Escaping and input filtering are partial defences that depend on getting every character class, encoding and context right; parameter binding removes the ambiguity entirely because the value is transported separately from the statement text.',
    impact:
      'An attacker reads or modifies any data the database user can reach, which typically includes the whole application schema: credentials, personal data, financial records. Depending on the engine and privileges it can extend to writing files, running commands, or destroying data - and the same flaw is the usual route to a full authentication bypass.',
    remediation:
      'Bind every external value as a parameter (prepared statements, or the parameter API of your query builder or ORM). Where an identifier such as a table or column name must be dynamic, validate it against an allow-list of known names rather than interpolating it. Keep the database account limited to the rights the application actually needs, so a missed case is contained.',
    references: ['ISO/IEC 27001:2022 Annex A 8.28 Secure coding', 'ISO/IEC 27001:2022 Annex A 8.26 Application security requirements'],
  },
};
