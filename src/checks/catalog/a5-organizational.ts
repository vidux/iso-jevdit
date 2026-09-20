import { a5Kb } from '../kb/a5-organizational.js';
import type { Check } from '../types.js';

export const a5Checks: Check[] = [
  {
    id: 'a5-17-hardcoded-credentials',
    title: 'Credential written into source code',
    controls: ['A.5.17'],
    severity: 'critical',
    scope: 'chunk',
    type: 'choice',
    version: 1,
    instructions: {
      question: 'Does the code in `files` contain credential material written directly into the source?',
      focus:
        'Credential material means a value that authenticates or signs: a password, API key, bearer or access token, private key, signing or encryption secret, or a connection string carrying a password.',
    },
    criteria: {
      violation: {
        what:
          'Credential material appears as a literal value in this code, in a form that would authenticate against a real system.',
        examples: [
          'const PAYMENTS_KEY = "acmepay_live_7Qk2Rv9TbN4wXyJ3mHs6Zd";',
          "define('DB_PASSWORD', 'Pr0d!pass2024');",
          'ssh_key = """-----BEGIN RSA PRIVATE KEY-----\\nMIIEow..."""',
        ],
      },
      compliant: {
        what:
          'Credential material is read from an environment variable, a secret manager, a key vault, or configuration held outside the source.',
        note:
          'A literal that is plainly a placeholder, an example, a documented default with no access, or an empty string belongs here too.',
        examples: [
          'const key = process.env.STRIPE_SECRET_KEY;',
          "password = os.environ['DB_PASSWORD']",
          'DB_PASSWORD=changeme   # in a .env.example template',
        ],
      },
      not_applicable: {
        what: 'This code contains no credential material of any kind.',
      },
    },
    kb: a5Kb['a5-17-hardcoded-credentials']!,
  },
];
