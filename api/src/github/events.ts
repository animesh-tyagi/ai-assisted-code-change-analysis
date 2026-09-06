/**
 * Hand-typed subset of the GitHub webhook payloads this app actually reads —
 * matches the project's existing style for wire contracts
 * (`shared/src/parserWire.ts`) rather than pulling in `@octokit/webhooks` just
 * for types. Only the fields the webhook route touches are declared.
 *
 * Two repository shapes exist in GitHub's webhooks, and the difference
 * matters here:
 *
 *  - `installation` / `installation_repositories` carry a *minimal* repo
 *    object (`id`, `full_name`) — no `default_branch`, no nested `owner`.
 *  - `push` / `pull_request` carry the *full* repository object, which does
 *    have `default_branch` and `owner.login`.
 *
 * So a repo's `defaultBranch` is not reliably known until its first `push` or
 * `pull_request` event; see `github/repos.ts` for how that's handled.
 */

export const ZERO_SHA = '0000000000000000000000000000000000000000';

export function parseFullName(fullName: string): { owner: string; name: string } {
  const idx = fullName.indexOf('/');
  if (idx === -1) {
    throw new Error(`malformed repository full_name: ${fullName}`);
  }
  return { owner: fullName.slice(0, idx), name: fullName.slice(idx + 1) };
}

export interface GithubMinimalRepo {
  id: number;
  full_name: string;
}

export interface GithubRepository {
  id: number;
  name: string;
  full_name: string;
  default_branch: string;
  owner: { login: string };
}

export interface GithubInstallation {
  id: number;
  account: { login: string; type: string };
  repository_selection: string;
}

export interface InstallationEventPayload {
  action: string;
  installation: GithubInstallation;
  repositories?: GithubMinimalRepo[];
}

export interface InstallationRepositoriesEventPayload {
  action: 'added' | 'removed';
  installation: GithubInstallation;
  repository_selection: string;
  repositories_added?: GithubMinimalRepo[];
  repositories_removed?: GithubMinimalRepo[];
}

export interface PushEventPayload {
  ref: string;
  before: string;
  after: string;
  repository: GithubRepository;
  installation?: { id: number };
}

export interface PullRequestEventPayload {
  /** Only `opened`/`synchronize`/`reopened` trigger analysis; every other action is ignored. */
  action: string;
  number: number;
  pull_request: {
    base: { sha: string };
    head: { sha: string };
  };
  repository: GithubRepository;
  installation?: { id: number };
}
