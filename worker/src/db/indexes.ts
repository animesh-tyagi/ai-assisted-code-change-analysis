/**
 * Index creation for the §7 collections the worker owns.
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

    // The `explanations` cache (§11.2 D-cache) — identical context object, prompt
    // version, and model never pays for a second generation.
    db
      .collection('explanations')
      .createIndex(
        { contextHash: 1, promptVersion: 1, model: 1 },
        { unique: true, name: 'contextHash_promptVersion_model' },
      ),

    // M6 — webhook/queue orchestration (§9).
    db
      .collection('installations')
      .createIndex(
        { githubInstallationId: 1 },
        { unique: true, name: 'githubInstallationId' },
      ),

    // The analysis unit is `(repoId, baseSha, headSha)` (D9); a PR lookup also
    // needs `prNumber` — sparse because `prNumber` is absent on a `push` trigger.
    db
      .collection('analyses')
      .createIndex(
        { repoId: 1, baseSha: 1, headSha: 1 },
        { unique: true, name: 'repoId_baseSha_headSha' },
      ),
    db
      .collection('analyses')
      .createIndex(
        { repoId: 1, prNumber: 1, headSha: 1 },
        { sparse: true, name: 'repoId_prNumber_headSha' },
      ),
    db
      .collection('analyses')
      .createIndex({ status: 1, updatedAt: -1 }, { name: 'status_updatedAt' }),

    // `_id` is GitHub's own delivery UUID (§9.1's O(1) redelivery dedupe), so no
    // extra index is needed for that lookup. TTL 30 days (§7).
    db
      .collection('webhookDeliveries')
      .createIndex(
        { receivedAt: 1 },
        { expireAfterSeconds: 30 * 24 * 60 * 60, name: 'receivedAt_ttl' },
      ),
  ]);
}
