import { createHmac } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import { verifyGithubSignature } from './verifySignature.js';

const SECRET = 'shh';

function sign(body: string): string {
  return `sha256=${createHmac('sha256', SECRET).update(body).digest('hex')}`;
}

describe('verifyGithubSignature', () => {
  it('accepts a correctly signed body', () => {
    const body = Buffer.from('{"hello":"world"}');
    expect(verifyGithubSignature(SECRET, body, sign(body.toString()))).toBe(true);
  });

  it('rejects a body signed with the wrong secret', () => {
    const body = Buffer.from('{"hello":"world"}');
    const wrongSignature = `sha256=${createHmac('sha256', 'other-secret').update(body).digest('hex')}`;
    expect(verifyGithubSignature(SECRET, body, wrongSignature)).toBe(false);
  });

  it('rejects a tampered body', () => {
    const original = Buffer.from('{"hello":"world"}');
    const signature = sign(original.toString());
    const tampered = Buffer.from('{"hello":"mallory"}');
    expect(verifyGithubSignature(SECRET, tampered, signature)).toBe(false);
  });

  it('rejects a missing signature header', () => {
    expect(verifyGithubSignature(SECRET, Buffer.from('{}'), undefined)).toBe(false);
  });

  it('rejects a malformed signature header without throwing', () => {
    expect(verifyGithubSignature(SECRET, Buffer.from('{}'), 'not-a-signature')).toBe(
      false,
    );
  });
});
