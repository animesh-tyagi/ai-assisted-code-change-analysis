/** Test-only mirror of `verifyGithubSignature`'s HMAC scheme, for signing fixture payloads. */

import { createHmac } from 'node:crypto';

export function signBody(secret: string, body: string): string {
  return `sha256=${createHmac('sha256', secret).update(body).digest('hex')}`;
}
