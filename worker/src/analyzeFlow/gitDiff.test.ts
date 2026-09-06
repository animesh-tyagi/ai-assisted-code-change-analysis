import { describe, expect, it } from 'vitest';

import { extractMethodDiff, parseNameStatusOutput } from './gitDiff.js';

describe('parseNameStatusOutput', () => {
  it('extracts paths from modify/add/delete lines', () => {
    const out =
      'M\tsrc/main/java/com/acme/UserService.java\nA\tsrc/main/java/com/acme/New.java\n';
    expect(parseNameStatusOutput(out)).toEqual([
      'src/main/java/com/acme/UserService.java',
      'src/main/java/com/acme/New.java',
    ]);
  });

  it('takes the new path for a rename', () => {
    const out = 'R100\told/Path.java\tnew/Path.java\n';
    expect(parseNameStatusOutput(out)).toEqual(['new/Path.java']);
  });

  it('ignores blank lines', () => {
    expect(parseNameStatusOutput('\n\n')).toEqual([]);
  });
});

const DIFF_HEADER = [
  'diff --git a/Foo.java b/Foo.java',
  'index abc123..def456 100644',
  '--- a/Foo.java',
  '+++ b/Foo.java',
].join('\n');

describe('extractMethodDiff', () => {
  it('returns empty for a diff with no ranges (both null)', () => {
    expect(extractMethodDiff(`${DIFF_HEADER}\n@@ -1,5 +1,5 @@\n`, null, null)).toBe('');
  });

  it('keeps a hunk overlapping the base range', () => {
    const diff = [
      DIFF_HEADER,
      '@@ -1,3 +1,3 @@',
      ' unrelated',
      '@@ -40,10 +40,12 @@',
      '-old line',
      '+new line',
    ].join('\n');
    const result = extractMethodDiff(diff, { start: 41, end: 55 }, null);
    expect(result).toContain('@@ -40,10 +40,12 @@');
    expect(result).not.toContain('@@ -1,3 +1,3 @@');
    expect(result).toContain('-old line');
    expect(result).toContain('+new line');
  });

  it('keeps a hunk overlapping the head range even when the base range misses it', () => {
    const diff = [DIFF_HEADER, '@@ -1,3 +100,5 @@', '+added method'].join('\n');
    const result = extractMethodDiff(
      diff,
      { start: 1, end: 3 },
      { start: 100, end: 104 },
    );
    expect(result).toContain('+added method');
  });

  it('drops a hunk that overlaps neither range', () => {
    const diff = [DIFF_HEADER, '@@ -200,3 +200,3 @@', ' far away'].join('\n');
    const result = extractMethodDiff(diff, { start: 1, end: 10 }, { start: 1, end: 10 });
    expect(result).not.toContain('far away');
  });

  it('caps total output at capLines', () => {
    const manyLines = Array.from({ length: 300 }, (_, i) => ` line${String(i)}`);
    const diff = [DIFF_HEADER, '@@ -1,300 +1,300 @@', ...manyLines].join('\n');
    const result = extractMethodDiff(diff, { start: 1, end: 300 }, null, 50);
    expect(result.split('\n')).toHaveLength(50);
  });

  it('handles a hunk header with no explicit length (defaults to 1)', () => {
    const diff = [DIFF_HEADER, '@@ -10 +10 @@', '-x', '+y'].join('\n');
    const result = extractMethodDiff(diff, { start: 10, end: 10 }, null);
    expect(result).toContain('-x');
  });
});
