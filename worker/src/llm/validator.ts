/**
 * The post-generation validator (ARCHITECTURE §11.3, D6, CLAUDE.md rule 5).
 *
 * Extracts candidate symbols/numbers from the generated prose and rejects
 * anything absent from the allowlists `allowlist.ts` built from the context
 * object. This catches invented symbols and invented numbers; it deliberately
 * does **not** catch a wrong relationship between two symbols that both
 * legitimately appear (§11.4) — a `Class.method(...)` or bare dotted mention is
 * checked by requiring every dot-separated segment to appear *somewhere* in the
 * allowlist, not as an exact adjacent pair. That is the documented gap, not a
 * bug introduced here.
 *
 * Candidate categories are exactly §11.3 step 3's list — no more, no less:
 * Java-style dotted names, `ClassName.method(...)` forms, `METHOD /path`
 * routes, `snake_case` table names, file paths, and integers.
 */

import type { ExplanationSections, ValidationViolation } from '@impact/shared';

import { extractDottedTokens, type Allowlists } from './allowlist.js';

const INTEGER_RE = /\b\d+\b/g;
const FILE_PATH_RE = /\b[\w/-]+\.java\b/g;
const CALL_FORM_RE = /\b[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)+\([^()]*\)/g;
const ROUTE_RE = /\b(GET|POST|PUT|DELETE|PATCH|HEAD|OPTIONS)\s+(\/[^\s,;.)]*)/g;
const SNAKE_CASE_RE = /\b[a-z][a-z0-9]*(?:_[a-z0-9]+)+\b/g;

/** Blank out a regex's matches (same length, so surrounding text is untouched) so a later, broader regex doesn't re-match the same span. */
function blank(text: string, re: RegExp): string {
  return text.replace(re, (match) => ' '.repeat(match.length));
}

/**
 * A dotted token is allowed either verbatim (the allowlist carries whole FQCNs
 * and display names, e.g. `java.io.IOException`, `FooService.findById(Long)`)
 * or, failing that, if every dot-separated segment individually appears
 * *somewhere* in the allowlist (e.g. a bare `FooService.findById` mention,
 * whose class name and method name were allowlisted separately). The
 * per-segment fallback is what leaves the documented §11.4 gap open — it
 * cannot tell a correct pairing of two real symbols from an incorrect one.
 */
function isAllowedToken(token: string, symbols: ReadonlySet<string>): boolean {
  if (symbols.has(token)) return true;
  return token.split('.').every((segment) => symbols.has(segment));
}

export function validateOutput(
  sections: ExplanationSections,
  allowlists: Allowlists,
): ValidationViolation[] {
  const violations: ValidationViolation[] = [];
  for (const section of ['whatChanged', 'whoIsAffected', 'whatToCheck'] as const) {
    violations.push(...findViolations(section, sections[section], allowlists));
  }
  return violations;
}

function findViolations(
  section: keyof ExplanationSections,
  text: string,
  { symbols, numbers }: Allowlists,
): ValidationViolation[] {
  const violations: ValidationViolation[] = [];
  let remaining = text;

  for (const match of text.match(FILE_PATH_RE) ?? []) {
    if (!symbols.has(match)) {
      violations.push({ kind: 'symbol', token: match, section });
    }
  }
  remaining = blank(remaining, FILE_PATH_RE);

  for (const match of remaining.match(CALL_FORM_RE) ?? []) {
    const parenAt = match.indexOf('(');
    const prefix = match.slice(0, parenAt);
    if (!isAllowedToken(prefix, symbols)) {
      violations.push({ kind: 'symbol', token: match, section });
    }
  }
  remaining = blank(remaining, CALL_FORM_RE);

  for (const match of remaining.match(ROUTE_RE) ?? []) {
    const spaceAt = match.indexOf(' ');
    const httpMethod = match.slice(0, spaceAt);
    const routePath = match.slice(spaceAt + 1);
    if (!symbols.has(httpMethod) || !symbols.has(routePath)) {
      violations.push({ kind: 'symbol', token: match, section });
    }
  }
  remaining = blank(remaining, ROUTE_RE);

  for (const token of extractDottedTokens(remaining)) {
    if (!isAllowedToken(token, symbols)) {
      violations.push({ kind: 'symbol', token, section });
    }
  }

  for (const token of remaining.match(SNAKE_CASE_RE) ?? []) {
    if (!symbols.has(token)) {
      violations.push({ kind: 'symbol', token, section });
    }
  }

  for (const token of text.match(INTEGER_RE) ?? []) {
    if (!numbers.has(token)) {
      violations.push({ kind: 'number', token, section });
    }
  }

  return violations;
}
