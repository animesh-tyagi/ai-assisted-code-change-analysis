import { describe, expect, it } from 'vitest';

import { fixedScheduleBackoff } from './backoff.js';

describe('fixedScheduleBackoff', () => {
  it('follows the §9.3 schedule: 5s, 30s, 2m', () => {
    expect(fixedScheduleBackoff(1)).toBe(5_000);
    expect(fixedScheduleBackoff(2)).toBe(30_000);
    expect(fixedScheduleBackoff(3)).toBe(120_000);
  });

  it('holds at the last delay for further attempts', () => {
    expect(fixedScheduleBackoff(4)).toBe(120_000);
    expect(fixedScheduleBackoff(10)).toBe(120_000);
  });

  it('never goes below the first delay', () => {
    expect(fixedScheduleBackoff(0)).toBe(5_000);
  });
});
