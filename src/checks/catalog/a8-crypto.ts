import { CODE_LANGUAGES } from '../../scan/extensions.js';
import { a8CryptoKb } from '../kb/a8-crypto.js';
import type { Check } from '../types.js';

export const a8CryptoChecks: Check[] = [
  {
    id: 'a8-24-weak-password-hash',
    title: 'Credentials hashed with a fast or unsalted algorithm',
    controls: ['A.8.24', 'A.5.17'],
    severity: 'high',
    scope: 'chunk',
    languages: [...CODE_LANGUAGES],
    type: 'choice',
    version: 1,
    instructions: {
      question: 'How does the code in `files` derive, store or verify a hash of a credential?',
      focus:
        'Judge only hashing that protects a credential such as a password, passphrase, PIN, or API secret. Ignore hashing used for any other purpose.',
    },
    criteria: {
      violation: {
        what:
          'A credential is hashed or verified with a fast or broken algorithm (MD5, SHA-1, any SHA-2 digest used directly, CRC), with encoding rather than hashing (base64, hex), without a per-credential salt, or with a scheme hand-built from those primitives.',
        not_for: 'Hashing that does not protect a credential.',
        examples: [
          "$stored = md5($password);",
          "hash = hashlib.sha256(password.encode()).hexdigest()",
          "const h = crypto.createHash('sha1').update(pw + PEPPER).digest('hex');",
        ],
      },
      compliant: {
        what:
          'Credential hashing uses a purpose-built password key derivation function - argon2, scrypt, bcrypt, or PBKDF2 with a high iteration count - with a per-credential salt, or delegates to a framework, identity provider or platform API that does so.',
        examples: [
          'password_hash($password, PASSWORD_ARGON2ID)',
          'await bcrypt.compare(plain, user.passwordHash)',
          'Django set_password() / check_password()',
        ],
      },
      not_applicable: {
        what: 'This code does not hash, store or verify credentials.',
        note:
          'Digests computed for cache keys, ETags, checksums, content addressing, deduplication, idempotency keys, sharding, or any non-credential identifier belong here, whatever algorithm they use.',
        examples: [
          "const cacheKey = md5(JSON.stringify(query));",
          "etag = sha1(file_contents)",
          'checksum verification of a downloaded artifact',
        ],
      },
    },
    kb: a8CryptoKb['a8-24-weak-password-hash']!,
  },
];
