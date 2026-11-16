/**
 * What GitHub and GitLab send, read into one shape. Only what a4a uses is read; everything else
 * in a payload is ignored, so a provider adding fields changes nothing.
 */
import type { PullRequestState, VcsProvider } from '@a4a/shared';
import { z } from 'zod';

export interface Person {
  name: string | null;
  email: string | null;
  login: string | null;
}

export interface Commit {
  sha: string;
  message: string;
  url: string | null;
  at: Date | null;
  author: Person;
}

export type Delivery =
  | { kind: 'ping'; event: string }
  | { kind: 'push'; event: string; repository: string; branch: string | null; deleted: boolean; commits: Commit[] }
  | {
      kind: 'pull_request';
      event: string;
      repository: string;
      number: number;
      title: string;
      body: string;
      url: string | null;
      branch: string | null;
      target: string | null;
      state: PullRequestState;
      author: Person;
      at: Date | null;
    }
  | { kind: 'other'; event: string };

const text = z.string().nullish();
const when = (v: string | null | undefined): Date | null => {
  if (!v) return null;
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? null : d;
};
const branchOf = (ref: string): string | null => (ref.startsWith('refs/heads/') ? ref.slice('refs/heads/'.length) : null);

// GitHub ------------------------------------------------------------------

const GithubPush = z.object({
  ref: z.string(),
  deleted: z.boolean().optional(),
  repository: z.object({ full_name: z.string() }),
  commits: z
    .array(
      z.object({
        id: z.string().min(4).max(64),
        message: z.string(),
        timestamp: text,
        url: text,
        author: z.object({ name: text, email: text, username: text }).nullish(),
      }),
    )
    .default([]),
});

const GithubPullRequest = z.object({
  action: z.string(),
  repository: z.object({ full_name: z.string() }),
  pull_request: z.object({
    number: z.number().int(),
    html_url: text,
    state: z.string(),
    title: z.string(),
    body: text,
    merged: z.boolean().nullish(),
    merged_at: text,
    updated_at: text,
    user: z.object({ login: z.string() }).nullish(),
    head: z.object({ ref: z.string() }).nullish(),
    base: z.object({ ref: z.string() }).nullish(),
  }),
});

function github(event: string, body: unknown): Delivery {
  switch (event) {
    case 'ping':
      return { kind: 'ping', event };
    case 'push': {
      const p = GithubPush.parse(body);
      return {
        kind: 'push',
        event,
        repository: p.repository.full_name,
        branch: branchOf(p.ref),
        deleted: Boolean(p.deleted),
        commits: p.commits.map((c) => ({
          sha: c.id,
          message: c.message,
          url: c.url ?? null,
          at: when(c.timestamp),
          author: { name: c.author?.name ?? null, email: c.author?.email ?? null, login: c.author?.username ?? null },
        })),
      };
    }
    case 'pull_request': {
      const p = GithubPullRequest.parse(body);
      const pr = p.pull_request;
      return {
        kind: 'pull_request',
        event,
        repository: p.repository.full_name,
        number: pr.number,
        title: pr.title,
        body: pr.body ?? '',
        url: pr.html_url ?? null,
        branch: pr.head?.ref ?? null,
        target: pr.base?.ref ?? null,
        state: pr.merged || pr.merged_at ? 'merged' : pr.state === 'closed' ? 'closed' : 'open',
        author: { name: null, email: null, login: pr.user?.login ?? null },
        at: when(pr.updated_at),
      };
    }
    default:
      return { kind: 'other', event };
  }
}

// GitLab ------------------------------------------------------------------

const GitlabPush = z.object({
  object_kind: z.literal('push'),
  ref: z.string(),
  after: text,
  project: z.object({ path_with_namespace: z.string() }),
  commits: z
    .array(
      z.object({
        id: z.string().min(4).max(64),
        message: z.string(),
        timestamp: text,
        url: text,
        author: z.object({ name: text, email: text }).nullish(),
      }),
    )
    .default([]),
});

const GitlabMergeRequest = z.object({
  object_kind: z.literal('merge_request'),
  user: z.object({ name: text, username: text }).nullish(),
  project: z.object({ path_with_namespace: z.string() }),
  object_attributes: z.object({
    iid: z.number().int(),
    title: z.string(),
    description: text,
    state: z.string(),
    action: text,
    url: text,
    source_branch: text,
    target_branch: text,
    updated_at: text,
  }),
});

const DELETED = /^0+$/;

function gitlab(event: string, body: unknown): Delivery {
  const kind = (body as { object_kind?: unknown } | null)?.object_kind;
  if (kind === 'push') {
    const p = GitlabPush.parse(body);
    return {
      kind: 'push',
      event,
      repository: p.project.path_with_namespace,
      branch: branchOf(p.ref),
      deleted: DELETED.test(p.after ?? ''),
      commits: p.commits.map((c) => ({
        sha: c.id,
        message: c.message,
        url: c.url ?? null,
        at: when(c.timestamp),
        author: { name: c.author?.name ?? null, email: c.author?.email ?? null, login: null },
      })),
    };
  }
  if (kind === 'merge_request') {
    const p = GitlabMergeRequest.parse(body);
    const mr = p.object_attributes;
    return {
      kind: 'pull_request',
      event,
      repository: p.project.path_with_namespace,
      number: mr.iid,
      title: mr.title,
      body: mr.description ?? '',
      url: mr.url ?? null,
      branch: mr.source_branch ?? null,
      target: mr.target_branch ?? null,
      state: mr.state === 'merged' ? 'merged' : mr.state === 'closed' ? 'closed' : 'open',
      // The person who acted: the request's author when it's opened.
      author: { name: p.user?.name ?? null, email: null, login: p.user?.username ?? null },
      at: when(mr.updated_at),
    };
  }
  return { kind: 'other', event };
}

/** Read a delivery from its event name (X-GitHub-Event, X-Gitlab-Event) and its JSON body. */
export function readDelivery(provider: VcsProvider, event: string, body: unknown): Delivery {
  return provider === 'github' ? github(event, body) : gitlab(event, body);
}
