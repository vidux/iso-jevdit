import { CODE_LANGUAGES } from '../../scan/extensions.js';
import { a8SecureCodingKb } from '../kb/a8-secure-coding.js';
import type { Check } from '../types.js';

export const a8SecureCodingChecks: Check[] = [
  {
    id: 'a8-28-sql-injection',
    title: 'SQL statement built from an external value',
    controls: ['A.8.28', 'A.8.26'],
    severity: 'critical',
    scope: 'chunk',
    languages: [...CODE_LANGUAGES, 'sql'],
    type: 'choice',
    version: 1,
    instructions: {
      question: 'How do the SQL statements in `files` incorporate values that could come from outside the program?',
      focus:
        'An external value is anything the program did not define as a constant here: a request parameter, a form field, a header, a path segment, a file, a queue message, a database row, or another service.',
    },
    criteria: {
      violation: {
        what:
          'A SQL statement is assembled by concatenation, interpolation, string formatting or a template literal from a value that is not a constant defined in this code, and that value is not passed to the database as a bound parameter.',
        examples: [
          '$db->query("SELECT * FROM users WHERE email = \'" . $_GET[\'email\'] . "\'");',
          'cursor.execute(f"DELETE FROM sessions WHERE id = {session_id}")',
          'db.raw(`UPDATE orders SET total = ${body.total} WHERE id = ${body.id}`)',
        ],
      },
      compliant: {
        what:
          'Every externally influenced value reaches SQL as a bound or prepared parameter, or through a query builder or ORM call that parameterises it. Any dynamic table or column name is chosen from a fixed allow-list defined in this code.',
        examples: [
          '$stmt = $db->prepare("SELECT * FROM users WHERE email = ?"); $stmt->execute([$email]);',
          'cursor.execute("DELETE FROM sessions WHERE id = %s", (session_id,))',
          'knex("orders").where({ id }).update({ total })',
        ],
      },
      not_applicable: {
        what: 'This code contains no SQL statement and builds no SQL fragment.',
        not_for: 'Code that does build SQL - that belongs in violation or compliant.',
      },
    },
    kb: a8SecureCodingKb['a8-28-sql-injection']!,
  },
];
