import { describe, expect, it } from 'vitest';

import {
  displayNameOf,
  formatFunctionKey,
  isFunctionKey,
  isNodeKey,
  NODE_KINDS,
  nodeKindOf,
  parseFunctionKey,
} from './nodeKey.js';

describe('nodeKindOf', () => {
  it('reads the prefix of every documented node kind', () => {
    // The example keys from ARCHITECTURE §6.1.
    expect(nodeKindOf('fn:com.acme.user.UserService#findById(java.lang.Long)')).toBe(
      'fn',
    );
    expect(nodeKindOf('route:GET /api/users/{id}')).toBe('route');
    expect(nodeKindOf('job:com.acme.billing.NightlyJob#run()')).toBe('job');
    expect(nodeKindOf('listener:kafka:orders.created')).toBe('listener');
    expect(nodeKindOf('entity:com.acme.user.User')).toBe('entity');
    expect(nodeKindOf('table:user_account')).toBe('table');
    expect(nodeKindOf('unresolved:org.example.Thing#save(java.lang.Object)')).toBe(
      'unresolved',
    );
  });

  it('covers every kind in NODE_KINDS', () => {
    for (const kind of NODE_KINDS) {
      expect(nodeKindOf(`${kind}:whatever`)).toBe(kind);
    }
  });

  it('takes only the first segment, so listener keys with two colons still parse', () => {
    expect(nodeKindOf('listener:rabbit:billing.invoice.created')).toBe('listener');
  });

  it('returns null for unknown prefixes and unprefixed strings', () => {
    expect(nodeKindOf('method:com.acme.Foo#bar()')).toBeNull();
    expect(nodeKindOf('com.acme.Foo#bar()')).toBeNull();
    expect(nodeKindOf('')).toBeNull();
    // A leading colon has no prefix before it.
    expect(nodeKindOf(':fn')).toBeNull();
  });

  it('backs isNodeKey and isFunctionKey', () => {
    expect(isNodeKey('table:user_account')).toBe(true);
    expect(isNodeKey('nonsense')).toBe(false);
    expect(isFunctionKey('fn:com.acme.Foo#bar()')).toBe(true);
    expect(isFunctionKey('entity:com.acme.Foo')).toBe(false);
  });
});

describe('formatFunctionKey', () => {
  it('produces the documented §6.1 form', () => {
    expect(
      formatFunctionKey({
        fqcn: 'com.acme.user.UserService',
        methodName: 'findById',
        paramTypes: ['java.lang.Long'],
      }),
    ).toBe('fn:com.acme.user.UserService#findById(java.lang.Long)');
  });

  it('emits empty parens for a zero-arg method', () => {
    expect(
      formatFunctionKey({ fqcn: 'com.acme.Job', methodName: 'run', paramTypes: [] }),
    ).toBe('fn:com.acme.Job#run()');
  });

  it('joins multiple parameters with no whitespace', () => {
    // Canonical form matters: keys are compared as exact strings and used as
    // Mongo index values, so a stray space would fragment node identity.
    expect(
      formatFunctionKey({
        fqcn: 'com.acme.Svc',
        methodName: 'update',
        paramTypes: ['java.lang.Long', 'java.lang.String', 'int'],
      }),
    ).toBe('fn:com.acme.Svc#update(java.lang.Long,java.lang.String,int)');
  });
});

describe('parseFunctionKey', () => {
  it('round-trips with formatFunctionKey', () => {
    const parts = {
      fqcn: 'com.acme.user.UserService',
      methodName: 'findById',
      paramTypes: ['java.lang.Long'],
    };
    const parsed = parseFunctionKey(formatFunctionKey(parts));

    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.value.fqcn).toBe(parts.fqcn);
    expect(parsed.value.methodName).toBe(parts.methodName);
    expect(parsed.value.paramTypes).toEqual(parts.paramTypes);
    expect(parsed.value.className).toBe('UserService');
  });

  it('handles zero-arg methods', () => {
    const parsed = parseFunctionKey('fn:com.acme.billing.NightlyJob#run()');
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.value.methodName).toBe('run');
    expect(parsed.value.paramTypes).toEqual([]);
  });

  it('handles array and varargs parameter types', () => {
    // Varargs are erased to array types by the parser (§6.1).
    const parsed = parseFunctionKey('fn:com.acme.Fmt#join(java.lang.String[],int)');
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.value.paramTypes).toEqual(['java.lang.String[]', 'int']);
  });

  it('handles nested classes, keeping Outer.Inner as the class name', () => {
    const parsed = parseFunctionKey('fn:com.acme.Outer.Inner#handle(java.lang.Object)');
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.value.fqcn).toBe('com.acme.Outer.Inner');
    // Only the last segment is taken; a nested class is indistinguishable from a
    // package segment in the flat string form. Documented limitation, asserted so
    // it stays a known behaviour rather than a surprise.
    expect(parsed.value.className).toBe('Inner');
  });

  it('handles a class in the default package', () => {
    const parsed = parseFunctionKey('fn:Main#main(java.lang.String[])');
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.value.fqcn).toBe('Main');
    expect(parsed.value.className).toBe('Main');
  });

  it('rejects keys of another kind rather than guessing', () => {
    const parsed = parseFunctionKey('entity:com.acme.user.User');
    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    expect(parsed.error).toContain('not a function key');
  });

  it.each([
    ['fn:com.acme.Foo.bar()', "missing '#'"],
    ['fn:#bar()', "missing '#'"],
    ['fn:com.acme.Foo#bar', 'missing parameter list'],
    ['fn:com.acme.Foo#bar(', 'missing parameter list'],
    ['fn:com.acme.Foo#(java.lang.Long)', 'missing parameter list'],
    ['fn:com.acme.Foo#bar(java.lang.Long,)', 'empty parameter type'],
    ['fn:com.acme.Foo#bar(,int)', 'empty parameter type'],
  ])('returns a typed failure for malformed input: %s', (key, expectedError) => {
    const parsed = parseFunctionKey(key);
    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    expect(parsed.error).toContain(expectedError);
  });

  it('never throws on arbitrary input', () => {
    for (const junk of ['', 'fn:', 'fn', '::::', 'fn:#()', '🙂']) {
      expect(() => parseFunctionKey(junk)).not.toThrow();
    }
  });
});

describe('displayNameOf', () => {
  it('shortens a fully-qualified key for prose and UI', () => {
    expect(displayNameOf('fn:com.acme.user.UserService#findById(java.lang.Long)')).toBe(
      'UserService.findById(Long)',
    );
  });

  it('keeps array suffixes when shortening', () => {
    expect(displayNameOf('fn:com.acme.Fmt#join(java.lang.String[],int)')).toBe(
      'Fmt.join(String[], int)',
    );
  });

  it('renders zero-arg methods', () => {
    expect(displayNameOf('fn:com.acme.billing.NightlyJob#run()')).toBe(
      'NightlyJob.run()',
    );
  });

  it('falls back to the raw key when it cannot be parsed', () => {
    expect(displayNameOf('route:GET /api/users/{id}')).toBe('route:GET /api/users/{id}');
  });
});
