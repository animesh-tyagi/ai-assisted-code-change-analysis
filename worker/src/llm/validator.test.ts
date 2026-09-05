import type { ExplanationSections } from '@impact/shared';
import { describe, expect, it } from 'vitest';

import type { Allowlists } from './allowlist.js';
import { validateOutput } from './validator.js';

function allowlists(): Allowlists {
  return {
    symbols: new Set([
      'FooService',
      'findById',
      'FooService.findById(Long)',
      'GET',
      '/api/foos/{id}',
      'foo',
      'src/main/java/com/acme/service/FooService.java',
      'FooService.java',
    ]),
    numbers: new Set(['412', '1', '28']),
  };
}

function sections(overrides: Partial<ExplanationSections> = {}): ExplanationSections {
  return {
    whatChanged: 'FooService.findById(Long) in FooService.java was changed.',
    whoIsAffected: 'It is reachable via GET /api/foos/{id} and touches the foo table.',
    whatToCheck: 'PR #412 has 1 direct caller.',
    ...overrides,
  };
}

describe('validateOutput', () => {
  it('passes clean output that only references allowlisted symbols and numbers', () => {
    expect(validateOutput(sections(), allowlists())).toEqual([]);
  });

  it('rejects an invented class.method(...) call form', () => {
    const violations = validateOutput(
      sections({ whatChanged: 'com.acme.FakeService.doStuff() was also touched.' }),
      allowlists(),
    );
    expect(violations).toContainEqual({
      kind: 'symbol',
      token: 'com.acme.FakeService.doStuff()',
      section: 'whatChanged',
    });
  });

  it('rejects an invented bare dotted name', () => {
    const violations = validateOutput(
      sections({ whatChanged: 'See com.acme.NoSuchClass for details.' }),
      allowlists(),
    );
    expect(violations.some((v) => v.token === 'com.acme.NoSuchClass')).toBe(true);
  });

  it('rejects an invented route', () => {
    const violations = validateOutput(
      sections({ whoIsAffected: 'Also reachable via POST /api/bar.' }),
      allowlists(),
    );
    expect(violations).toContainEqual({
      kind: 'symbol',
      token: 'POST /api/bar',
      section: 'whoIsAffected',
    });
  });

  it('rejects an invented snake_case table name', () => {
    const violations = validateOutput(
      sections({ whoIsAffected: 'It also writes to the shadow_ledger table.' }),
      allowlists(),
    );
    expect(violations).toContainEqual({
      kind: 'symbol',
      token: 'shadow_ledger',
      section: 'whoIsAffected',
    });
  });

  it('rejects an invented file path', () => {
    const violations = validateOutput(
      sections({ whatChanged: 'Also touched src/main/java/com/acme/OtherFile.java.' }),
      allowlists(),
    );
    expect(violations).toContainEqual({
      kind: 'symbol',
      token: 'src/main/java/com/acme/OtherFile.java',
      section: 'whatChanged',
    });
  });

  it('rejects an invented integer', () => {
    const violations = validateOutput(
      sections({ whatToCheck: 'There are 99 direct callers.' }),
      allowlists(),
    );
    expect(violations).toContainEqual({ kind: 'number', token: '99', section: 'whatToCheck' });
  });
});
