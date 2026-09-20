import type { KbEntry } from '../types.js';

export const a5Kb: Record<string, KbEntry> = {
  'a5-17-hardcoded-credentials': {
    requirement:
      'Authentication information must be allocated, stored and transmitted under a controlled process. A credential written into source code is outside that process: it cannot be rotated on a schedule, cannot be revoked for one person, and its distribution follows the code rather than an access decision.',
    why:
      'Source code is copied far more widely than the systems it authenticates against - to every developer machine, every CI runner, every fork, every backup, and to the full history of the repository. A credential committed once stays readable in history even after it is deleted from the current files.',
    impact:
      'Anyone with read access to the repository or its history holds a working credential. Rotation requires a code change and redeploy, so the usual response to a suspected leak is slow enough that an attacker keeps access. Loss of the repository - a leaked archive, a mis-set visibility flag, a compromised laptop - becomes loss of the systems it authenticates to.',
    remediation:
      'Read the value from the environment or a secret manager at run time and fail closed when it is absent. Replace the literal with a placeholder in any example or template file. Then rotate the exposed credential, because it must be assumed compromised, and purge it from history if the repository has been shared.',
    references: ['ISO/IEC 27001:2022 Annex A 5.17 Authentication information', 'ISO/IEC 27001:2022 Annex A 8.24 Use of cryptography'],
  },
};
