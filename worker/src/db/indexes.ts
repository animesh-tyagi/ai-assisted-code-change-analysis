/**
 * Index creation for the six §7 collections this milestone owns.
 *
 * `createIndex` is idempotent — calling this on every worker start is cheap and
 * keeps the indexes versioned in application code rather than a separate
 * migration step, per `docker-compose.yml`'s own note that M3 owns this.
 */

import type { Db } from 'mongodb';

export async function ensureIndexes(db: Db): Promise<void> {
  await Promise.all([
    db
      .collection('repos')
      .createIndex(
        { provider: 1, githubRepoId: 1 },
        { unique: true, name: 'provider_githubRepoId' },
      ),

    db
      .collection('graphVersions')
      .createIndex(
        { repoId: 1, sha: 1, kind: 1 },
        { unique: true, name: 'repoId_sha_kind' },
      ),
    db
      .collection('graphVersions')
      .createIndex({ repoId: 1, status: 1 }, { name: 'repoId_status' }),

    db
      .collection('functions')
      .createIndex({ repoId: 1, key: 1 }, { unique: true, name: 'repoId_key' }),

    db
      .collection('functionVersions')
      .createIndex(
        { graphVersionId: 1, functionKey: 1 },
        { unique: true, name: 'graphVersionId_functionKey' },
      ),
    db
      .collection('functionVersions')
      .createIndex({ repoId: 1, functionKey: 1 }, { name: 'repoId_functionKey' }),

    db
      .collection('surfaces')
      .createIndex(
        { graphVersionId: 1, key: 1 },
        { unique: true, name: 'graphVersionId_key' },
      ),

    // Forward traversal.
    db
      .collection('edges')
      .createIndex(
        { graphVersionId: 1, from: 1, type: 1 },
        { name: 'graphVersionId_from_type' },
      ),
    // Reverse traversal — the hot path (§10).
    db
      .collection('edges')
      .createIndex(
        { graphVersionId: 1, to: 1, type: 1 },
        { name: 'graphVersionId_to_type' },
      ),
    db
      .collection('edges')
      .createIndex(
        { graphVersionId: 1, from: 1, to: 1, type: 1 },
        { unique: true, name: 'graphVersionId_from_to_type' },
      ),
  ]);
}
