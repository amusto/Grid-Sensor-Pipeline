/**
 * Synthetic case ID generator for stubbed channel adapters.
 *
 * Format: `MOCK-{system}-{epochMs}-{hash6}`
 *
 *   - `MOCK-` prefix makes stub IDs visually distinct from real
 *     external system IDs in logs and the cases table.
 *   - `{system}` identifies which adapter generated it.
 *   - `{epochMs}` is monotonic per millisecond; helps with debugging
 *     and visual sort order.
 *   - `{hash6}` adds 6 hex chars of randomness so concurrent calls
 *     in the same millisecond don't collide.
 *
 * Real adapters (email via SNS in P9.2; future SES) produce their own
 * IDs from the underlying service response. This generator is only
 * invoked from stubbed adapters where no upstream ID exists.
 */

import { randomBytes } from 'node:crypto';
import type { CaseSystem } from './types';

export const generateMockCaseId = (system: CaseSystem): string => {
  const epochMs = Date.now();
  const hash6 = randomBytes(3).toString('hex'); // 3 bytes -> 6 hex chars
  return `MOCK-${system}-${epochMs}-${hash6}`;
};
