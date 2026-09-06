import { describe, expect, it } from 'vitest';

import { parseFullName } from './events.js';

describe('parseFullName', () => {
  it('splits owner and name on the first slash', () => {
    expect(parseFullName('animesh-tyagi/observability-final')).toEqual({
      owner: 'animesh-tyagi',
      name: 'observability-final',
    });
  });

  it('throws on a full_name with no slash', () => {
    expect(() => parseFullName('no-slash-here')).toThrow(/malformed/);
  });
});
