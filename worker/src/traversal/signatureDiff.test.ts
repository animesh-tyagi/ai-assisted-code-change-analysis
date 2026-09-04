import { describe, expect, it } from 'vitest';

import type { FunctionFacts } from './changeDetection.js';
import { buildSignatureDiff, isSignatureCompatible } from './signatureDiff.js';

const KEY = 'fn:com.acme.user.UserService#findById(java.lang.Long)';

function facts(overrides: Partial<FunctionFacts> = {}): FunctionFacts {
  return {
    filePath: 'src/main/java/com/acme/user/UserService.java',
    bodyHash: 'sha256:aaa',
    returnType: 'com.acme.user.User',
    paramNames: ['id'],
    modifiers: ['public'],
    ...overrides,
  };
}

describe('buildSignatureDiff', () => {
  it('renders base/head signatures with simple type names and flags a return-type change', () => {
    const diff = buildSignatureDiff(
      KEY,
      facts({ returnType: 'com.acme.user.User' }),
      facts({ returnType: 'java.util.Optional' }),
    );
    expect(diff.base).toBe('public User findById(Long id)');
    expect(diff.head).toBe('public Optional findById(Long id)');
    expect(diff.returnTypeChanged).toBe(true);
    expect(diff.paramsChanged).toBe(false);
    expect(diff.throwsAdded).toEqual([]); // no `throws` data available (see module doc)
    expect(diff.visibilityChanged).toBe(false);
  });

  it('leaves base empty for an added function', () => {
    const diff = buildSignatureDiff(KEY, null, facts());
    expect(diff.base).toBe('');
    expect(diff.head).not.toBe('');
    expect(diff.returnTypeChanged).toBe(false);
  });

  it('leaves head empty for a removed function', () => {
    const diff = buildSignatureDiff(KEY, facts(), null);
    expect(diff.head).toBe('');
    expect(diff.base).not.toBe('');
  });

  it('flags a visibility change', () => {
    const diff = buildSignatureDiff(
      KEY,
      facts({ modifiers: ['public'] }),
      facts({ modifiers: ['protected'] }),
    );
    expect(diff.visibilityChanged).toBe(true);
  });
});

describe('isSignatureCompatible', () => {
  it('is always false for a removed change', () => {
    const diff = buildSignatureDiff(KEY, facts(), null);
    expect(isSignatureCompatible('removed', diff)).toBe(false);
  });

  it('is false when the return type changed', () => {
    const diff = buildSignatureDiff(
      KEY,
      facts({ returnType: 'A' }),
      facts({ returnType: 'B' }),
    );
    expect(isSignatureCompatible('signature_changed', diff)).toBe(false);
  });

  it('is true for a plain body-only modification', () => {
    const diff = buildSignatureDiff(KEY, facts(), facts());
    expect(isSignatureCompatible('modified', diff)).toBe(true);
  });
});
