/**
 * The validator's allowlists (ARCHITECTURE §11.3 step 1–2): every symbol and
 * every integer the context object actually contains. Nothing here is generic
 * reflection over the object — each `ContextObject` field is decomposed by hand
 * so the allowlist matches exactly what §11.3 lists, no more and no less
 * (CLAUDE.md rule 5: never weaken *or* over-tighten the validator to make a
 * model pass or fail by accident).
 *
 * Reuses `nodeKey.ts`'s key-parsing helpers rather than re-deriving them — this
 * project has exactly one place that understands the `NodeKey` string shape.
 */

import {
  displayNameOf,
  nodeKindOf,
  parseFunctionKey,
  simpleTypeName,
  type ContextObject,
  type NodeKey,
} from '@impact/shared';

export interface Allowlists {
  symbols: ReadonlySet<string>;
  numbers: ReadonlySet<string>;
}

/**
 * Dotted identifier chains — `com.acme.user.UserService`, `UserService.findById`.
 * Exported so `validator.ts` extracts prose candidates with the same shape the
 * allowlist was built from.
 */
const DOTTED_TOKEN_RE = /\b[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)+\b/g;

export function extractDottedTokens(text: string): string[] {
  return text.match(DOTTED_TOKEN_RE) ?? [];
}

export function buildAllowlists(ctx: ContextObject): Allowlists {
  const symbols = new Set<string>();
  const numbers = new Set<string>();

  const addSymbol = (value: string | undefined | null): void => {
    if (value !== undefined && value !== null && value !== '') symbols.add(value);
  };
  const addInteger = (value: number | undefined | null): void => {
    if (value !== undefined && value !== null && Number.isInteger(value)) {
      numbers.add(String(value));
    }
  };
  const addDottedTokensFrom = (text: string | undefined): void => {
    if (text === undefined) return;
    for (const token of extractDottedTokens(text)) symbols.add(token);
  };
  const addFilePath = (filePath: string): void => {
    addSymbol(filePath);
    const slashAt = filePath.lastIndexOf('/');
    addSymbol(slashAt === -1 ? filePath : filePath.slice(slashAt + 1));
  };

  addSymbol(ctx.repo.owner);
  addSymbol(ctx.repo.name);
  addInteger(ctx.repo.prNumber);
  addInteger(ctx.schemaVersion);

  addKeySymbols(ctx.changedMethod.key, symbols);
  addFilePath(ctx.changedMethod.filePath);
  addDottedTokensFrom(ctx.changedMethod.signatureDiff.base);
  addDottedTokensFrom(ctx.changedMethod.signatureDiff.head);
  for (const thrown of ctx.changedMethod.signatureDiff.throwsAdded) {
    addSymbol(thrown);
    addSymbol(simpleTypeName(thrown));
  }

  for (const caller of ctx.affectedBy.directCallers) {
    addKeySymbols(caller.key, symbols);
    addFilePath(caller.callSite.filePath);
    addInteger(caller.hops);
    addInteger(caller.callSite.line);
  }
  addInteger(ctx.affectedBy.directCallerTotal);

  for (const entrypoint of ctx.affectedBy.reachableSurfaces.entrypoints) {
    addKeySymbols(entrypoint.key, symbols);
    addInteger(entrypoint.minHops);
  }
  for (const data of ctx.affectedBy.reachableSurfaces.data) {
    addKeySymbols(data.key, symbols);
  }
  addInteger(ctx.affectedBy.traversal.maxDepth);
  addInteger(ctx.affectedBy.traversal.nodesVisited);

  for (const callee of ctx.nowDependsOn.callees) {
    addKeySymbols(callee.key, symbols);
  }

  for (const commit of ctx.changeHistory.commits) {
    addSymbol(commit.sha);
    addSymbol(commit.authorName);
    addDottedTokensFrom(commit.subject);
    addInteger(commit.insertions);
    addInteger(commit.deletions);
  }

  addInteger(ctx.quality.ambiguousEdgesOnPath);
  addInteger(ctx.quality.parseErrorsInTouchedFiles);
  // quality.unresolvedRate is deliberately excluded — it's a fraction, not an
  // integer, so it never belongs in an *integer* allowlist. The prompt (see
  // prompt.ts) tells the model to describe it qualitatively instead.

  return { symbols, numbers };
}

function addKeySymbols(key: NodeKey, symbols: Set<string>): void {
  const kind = nodeKindOf(key);
  if (kind === null) return;

  switch (kind) {
    case 'fn':
    case 'job':
    case 'unresolved': {
      const parsed = parseFnLikeBody(key);
      if (parsed === null) return;
      symbols.add(parsed.fqcn);
      symbols.add(parsed.className);
      symbols.add(parsed.methodName);
      for (const paramType of parsed.paramTypes) {
        symbols.add(paramType);
        symbols.add(simpleTypeName(paramType));
      }
      symbols.add(displayNameOf(key));
      return;
    }
    case 'route': {
      const body = key.slice('route:'.length);
      symbols.add(body);
      const spaceAt = body.indexOf(' ');
      if (spaceAt > 0) {
        symbols.add(body.slice(0, spaceAt));
        symbols.add(body.slice(spaceAt + 1));
      }
      return;
    }
    case 'entity': {
      const fqcn = key.slice('entity:'.length);
      symbols.add(fqcn);
      const lastDot = fqcn.lastIndexOf('.');
      symbols.add(lastDot === -1 ? fqcn : fqcn.slice(lastDot + 1));
      return;
    }
    case 'table': {
      symbols.add(key.slice('table:'.length));
      return;
    }
    case 'listener': {
      const rest = key.slice('listener:'.length);
      symbols.add(rest);
      const colonAt = rest.indexOf(':');
      if (colonAt > 0) {
        symbols.add(rest.slice(0, colonAt));
        symbols.add(rest.slice(colonAt + 1));
      }
    }
  }
}

/**
 * Parses the `fqcn#method(paramTypes)` body shared by `fn:`, `job:`, and
 * `unresolved:` keys by borrowing `parseFunctionKey`'s parsing of that body —
 * swap in the `fn:` prefix it expects, since the body grammar is identical.
 */
function parseFnLikeBody(key: NodeKey) {
  const colon = key.indexOf(':');
  if (colon <= 0) return null;
  const result = parseFunctionKey(`fn:${key.slice(colon + 1)}`);
  return result.ok ? result.value : null;
}
