import { describe, expect, it } from 'vitest';

import { buildAuthenticatedCloneUrl, redactToken } from './clone.js';

describe('buildAuthenticatedCloneUrl', () => {
  it('embeds the token as an x-access-token basic-auth user', () => {
    expect(
      buildAuthenticatedCloneUrl('animesh-tyagi', 'observability-final', 'ghs_secret'),
    ).toBe(
      'https://x-access-token:ghs_secret@github.com/animesh-tyagi/observability-final.git',
    );
  });
});

describe('redactToken', () => {
  it('strips every occurrence of the token from an Error message', () => {
    const err = new Error(
      "fatal: could not read from 'https://x-access-token:ghs_secret@github.com/o/r.git'",
    );
    const redacted = redactToken(err, 'ghs_secret');
    expect(redacted.message).not.toContain('ghs_secret');
    expect(redacted.message).toContain('***');
  });

  it('handles a non-Error thrown value', () => {
    const redacted = redactToken('plain string with ghs_secret inside', 'ghs_secret');
    expect(redacted.message).not.toContain('ghs_secret');
  });
});
