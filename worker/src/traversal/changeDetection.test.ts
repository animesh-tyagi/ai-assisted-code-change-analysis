import { describe, expect, it } from 'vitest';

import type { FunctionFacts } from './changeDetection.js';
import { detectChangedFunctions } from './changeDetection.js';

function facts(overrides: Partial<FunctionFacts> = {}): FunctionFacts {
  return {
    filePath: 'src/main/java/com/acme/Foo.java',
    bodyHash: 'sha256:aaa',
    returnType: 'void',
    paramNames: ['x'],
    modifiers: ['public'],
    ...overrides,
  };
}

describe('detectChangedFunctions', () => {
  it('classifies a head-only key as added', () => {
    const changes = detectChangedFunctions(new Map(), new Map([['fn:A#a()', facts()]]));
    expect(changes).toEqual([{ functionKey: 'fn:A#a()', changeKind: 'added' }]);
  });

  it('classifies a base-only key as removed', () => {
    const changes = detectChangedFunctions(new Map([['fn:A#a()', facts()]]), new Map());
    expect(changes).toEqual([{ functionKey: 'fn:A#a()', changeKind: 'removed' }]);
  });

  it('classifies a return-type difference as signature_changed, even with an identical bodyHash', () => {
    const base = new Map([['fn:A#a()', facts({ returnType: 'void' })]]);
    const head = new Map([['fn:A#a()', facts({ returnType: 'java.lang.String' })]]);
    expect(detectChangedFunctions(base, head)).toEqual([
      { functionKey: 'fn:A#a()', changeKind: 'signature_changed' },
    ]);
  });

  it('classifies a bodyHash-only difference as modified', () => {
    const base = new Map([['fn:A#a()', facts({ bodyHash: 'sha256:aaa' })]]);
    const head = new Map([['fn:A#a()', facts({ bodyHash: 'sha256:bbb' })]]);
    expect(detectChangedFunctions(base, head)).toEqual([
      { functionKey: 'fn:A#a()', changeKind: 'modified' },
    ]);
  });

  it('drops a key that is identical on both sides', () => {
    const base = new Map([['fn:A#a()', facts()]]);
    const head = new Map([['fn:A#a()', facts()]]);
    expect(detectChangedFunctions(base, head)).toEqual([]);
  });

  it('handles several keys independently in one call', () => {
    const base = new Map([
      ['fn:A#a()', facts()],
      ['fn:B#b()', facts()],
    ]);
    const head = new Map([
      ['fn:A#a()', facts()], // unchanged
      ['fn:C#c()', facts()], // added
    ]);
    const changes = detectChangedFunctions(base, head);
    expect(changes).toHaveLength(2);
    expect(changes).toContainEqual({ functionKey: 'fn:B#b()', changeKind: 'removed' });
    expect(changes).toContainEqual({ functionKey: 'fn:C#c()', changeKind: 'added' });
  });
});
