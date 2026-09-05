/**
 * The deterministic fallback (ARCHITECTURE §11.3 step 6): "a plain, slightly
 * wooden true answer beats a fluent false one." Plain string interpolation
 * over `ContextObject` fields only, so the result is allowlist-clean by
 * construction — it can never itself trigger a validator violation, because it
 * never says anything the allowlist wasn't built from.
 */

import { displayNameOf, type ContextObject, type ExplanationSections } from '@impact/shared';

export function buildTemplateSections(ctx: ContextObject): ExplanationSections {
  return {
    whatChanged: whatChanged(ctx),
    whoIsAffected: whoIsAffected(ctx),
    whatToCheck: whatToCheck(ctx),
  };
}

function whatChanged(ctx: ContextObject): string {
  const { changedMethod } = ctx;
  const { signatureDiff } = changedMethod;
  const parts = [
    `${changedMethod.displayName} was ${describeChangeKind(changedMethod.changeKind)} in ${changedMethod.filePath}.`,
  ];
  if (signatureDiff.returnTypeChanged) {
    parts.push(`Return type changed from \`${signatureDiff.base}\` to \`${signatureDiff.head}\`.`);
  }
  if (signatureDiff.paramsChanged) {
    parts.push('Parameters changed.');
  }
  if (signatureDiff.throwsAdded.length > 0) {
    parts.push(`New checked exception(s): ${signatureDiff.throwsAdded.join(', ')}.`);
  }
  if (signatureDiff.visibilityChanged) {
    parts.push('Visibility changed.');
  }
  return parts.join(' ');
}

function describeChangeKind(kind: ContextObject['changedMethod']['changeKind']): string {
  switch (kind) {
    case 'added':
      return 'added';
    case 'removed':
      return 'removed';
    case 'modified':
      return 'modified';
    case 'signature_changed':
      return 'changed with a signature change';
  }
}

function whoIsAffected(ctx: ContextObject): string {
  const { affectedBy } = ctx;
  const parts: string[] = [];

  if (affectedBy.directCallerTotal === 0) {
    parts.push('No direct callers were found in the graph.');
  } else {
    // `directCallerTotal` is the only caller-count fact precomputed by the graph
    // (§10) — this template never derives its own count (e.g. via `.filter().length`)
    // to describe callers, since a template-invented integer would itself fail the
    // validator's numeric allowlist (CLAUDE.md rule 6: nothing numeric is counted
    // ad hoc, not even here). Which callers are signature-incompatible is instead
    // called out per-line below.
    parts.push(
      `${String(affectedBy.directCallerTotal)} direct caller(s) found` +
        (affectedBy.directCallersTruncated ? ' (list truncated below).' : '.'),
    );
    for (const caller of affectedBy.directCallers) {
      const hedge = caller.inferred || caller.edgeConfidence !== 'exact' ? ' (inferred edge)' : '';
      parts.push(
        `${caller.displayName} at ${caller.callSite.filePath}:${String(caller.callSite.line)}` +
          `${hedge}: ${caller.usage}${caller.signatureCompatible ? '' : ' — signature-incompatible'}.`,
      );
    }
  }

  const { entrypoints, data } = affectedBy.reachableSurfaces;
  if (entrypoints.length > 0) {
    const names = entrypoints
      .map((e) => `${displayNameOf(e.key)}${e.viaInferredEdge ? ' (via an inferred edge)' : ''}`)
      .join(', ');
    parts.push(`Reachable entrypoints: ${names}.`);
  }
  if (data.length > 0) {
    const names = data
      .map((d) => `${displayNameOf(d.key)} (${d.access}${d.viaInferredEdge ? ', via an inferred edge' : ''})`)
      .join(', ');
    parts.push(`Data touched: ${names}.`);
  }

  return parts.join(' ');
}

function whatToCheck(ctx: ContextObject): string {
  const parts: string[] = [];
  const { callees } = ctx.nowDependsOn;
  const newCallees = callees.filter((c) => c.isNew);
  if (newCallees.length > 0) {
    parts.push(`New dependencies introduced: ${newCallees.map((c) => displayNameOf(c.key)).join(', ')}.`);
  }

  const { quality } = ctx;
  if (quality.unresolvedRate > 0.05) {
    parts.push('A notable share of calls in the base graph are unresolved.');
  }
  if (quality.ambiguousEdgesOnPath > 0) {
    parts.push(
      `${String(quality.ambiguousEdgesOnPath)} ambiguous edge(s) lie on the affected path — the true callee could not be narrowed to one candidate.`,
    );
  }
  if (quality.parseErrorsInTouchedFiles > 0) {
    parts.push(`${String(quality.parseErrorsInTouchedFiles)} touched file(s) had parse errors.`);
  }
  if (ctx.affectedBy.traversal.depthCapHit) {
    parts.push('The reverse traversal hit its depth cap — some further-removed effects may be missing.');
  }

  if (parts.length === 0) {
    parts.push('No further concerns from the graph.');
  }
  return parts.join(' ');
}
