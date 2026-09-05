/**
 * Installation access tokens (ARCHITECTURE §7's `installations` note, D7): no
 * token is ever stored in Mongo — a short-lived one is minted on demand from
 * the App's private key and cached in Redis with a TTL shorter than its
 * 1-hour life.
 *
 * The JWT-signing/token-minting mechanics themselves are `@octokit/auth-app`
 * (a credential-minting path is exactly where an official library beats
 * hand-rolled RS256 JWT signing — see DECISIONS.md's M6 planning note) via
 * `createGithubAppAuth`. The caching logic is factored out into
 * `mintInstallationToken`, which takes an `InstallationAuthFn` rather than
 * calling `@octokit/auth-app` directly — the same interface-seam pattern as
 * `TypeSolver`/`LLMProvider`/`GraphReader` elsewhere in this project, so the
 * cache-hit/cache-miss behavior is unit-testable without real GitHub
 * credentials.
 */

import { createAppAuth } from '@octokit/auth-app';
import type { Redis } from 'ioredis';

/** Shorter than GitHub's 1-hour installation-token life (§7). */
const TOKEN_CACHE_TTL_SECONDS = 50 * 60;

export type InstallationAuthFn = (
  githubInstallationId: number,
) => Promise<{ token: string }>;

export interface GithubAppAuthConfig {
  appId: string;
  privateKey: string;
}

export function createGithubAppAuth(config: GithubAppAuthConfig): InstallationAuthFn {
  const auth = createAppAuth({ appId: config.appId, privateKey: config.privateKey });
  return async (githubInstallationId: number) => {
    const result = await auth({
      type: 'installation',
      installationId: githubInstallationId,
    });
    return { token: result.token };
  };
}

function tokenCacheKey(githubInstallationId: number): string {
  return `githubToken:${String(githubInstallationId)}`;
}

/** Never logs the token — only its cache key (the installation id) is loggable. */
export async function mintInstallationToken(
  redis: Redis,
  authFn: InstallationAuthFn,
  githubInstallationId: number,
): Promise<string> {
  const cacheKey = tokenCacheKey(githubInstallationId);
  const cached = await redis.get(cacheKey);
  if (cached !== null) return cached;

  const { token } = await authFn(githubInstallationId);
  await redis.set(cacheKey, token, 'EX', TOKEN_CACHE_TTL_SECONDS);
  return token;
}
