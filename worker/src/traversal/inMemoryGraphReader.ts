/**
 * `GraphReader` over plain in-memory arrays — no Mongo, no Docker. What the
 * fixture tests in this directory build, and reusable as-is by the eval
 * harness (M8), which will also want to run traversal against a hand-built
 * graph rather than a live database.
 */

import type {
  EdgeDoc,
  EdgeType,
  FunctionVersionDoc,
  NodeKey,
  SurfaceDoc,
} from '@impact/shared';

import type { GraphReader } from './graphReader.js';

export class InMemoryGraphReader implements GraphReader {
  constructor(
    private readonly edges: EdgeDoc[],
    private readonly functionVersions: FunctionVersionDoc[] = [],
    private readonly surfaces: SurfaceDoc[] = [],
  ) {}

  outgoingEdges(key: NodeKey, types?: EdgeType[]): Promise<EdgeDoc[]> {
    return Promise.resolve(
      this.edges.filter(
        (e) => e.from === key && (types === undefined || types.includes(e.type)),
      ),
    );
  }

  incomingEdges(key: NodeKey, types?: EdgeType[]): Promise<EdgeDoc[]> {
    return Promise.resolve(
      this.edges.filter(
        (e) => e.to === key && (types === undefined || types.includes(e.type)),
      ),
    );
  }

  functionVersion(key: NodeKey): Promise<FunctionVersionDoc | null> {
    return Promise.resolve(
      this.functionVersions.find((f) => f.functionKey === key) ?? null,
    );
  }

  surface(key: NodeKey): Promise<SurfaceDoc | null> {
    return Promise.resolve(this.surfaces.find((s) => s.key === key) ?? null);
  }
}
