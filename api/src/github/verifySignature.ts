/**
 * `X-Hub-Signature-256` verification (ARCHITECTURE §9.1 step 2). No library —
 * this is exactly what `crypto.timingSafeEqual` is for, per the architecture
 * doc's own wording.
 */

import { createHmac, timingSafeEqual } from 'node:crypto';

export function verifyGithubSignature(
  secret: string,
  rawBody: Buffer,
  signatureHeader: string | undefined,
): boolean {
  if (signatureHeader === undefined) return false;

  const expected = `sha256=${createHmac('sha256', secret).update(rawBody).digest('hex')}`;
  const expectedBuf = Buffer.from(expected, 'utf8');
  const actualBuf = Buffer.from(signatureHeader, 'utf8');

  // Different lengths would make timingSafeEqual throw rather than return
  // false — check first so a malformed header is just a rejection, not a 500.
  if (expectedBuf.length !== actualBuf.length) return false;

  return timingSafeEqual(expectedBuf, actualBuf);
}
