import type { KbEntry } from '../types.js';

export const a8CryptoKb: Record<string, KbEntry> = {
  'a8-24-weak-password-hash': {
    requirement:
      'Rules for the effective use of cryptography must be defined and implemented, including the choice of algorithm for each purpose. Storing credentials calls for a deliberately slow, salted password key derivation function - not a general-purpose digest.',
    why:
      'MD5, SHA-1 and the SHA-2 family are built to be fast, which is exactly wrong for credentials: commodity hardware computes billions of those digests per second, so an attacker holding the hash file recovers common passwords in minutes. Without a per-user salt, identical passwords produce identical hashes, so one cracked entry reveals every account that shares it and precomputed tables apply directly.',
    impact:
      'A stolen credential store yields usable plaintext passwords rather than useless digests. Because people reuse passwords, the damage extends past this system to the accounts your users hold elsewhere, which is also what turns a contained breach into a reportable one.',
    remediation:
      'Use argon2id, scrypt, or bcrypt, or PBKDF2-HMAC-SHA256 with a high iteration count, each with a unique per-user salt and a work factor tuned to current hardware. Prefer the platform primitive (PHP password_hash/password_verify, Node argon2/bcrypt, Python passlib) over anything hand-rolled. Verify with a constant-time comparison, and rehash on next successful login when the work factor changes.',
    references: ['ISO/IEC 27001:2022 Annex A 8.24 Use of cryptography', 'ISO/IEC 27001:2022 Annex A 5.17 Authentication information'],
  },
};
