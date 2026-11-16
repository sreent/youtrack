/**
 * What GitHub, GitLab, Bitbucket (Cloud and Data Center), Gitea and Forgejo send, read into one
 * shape. Only what a4a uses is read; everything else in a payload is ignored, so a provider adding
 * fields changes nothing.
 *
 * The shapes assumed are those the providers document for their webhooks (D33 says which).
 * Gitea and Forgejo send GitHub's shapes, so they are read as GitHub's.
 */
import type { PullRequestState, VcsProvider } from '@a4a/shared';
import { z } from 'zod';

export interface Person {
  name: string | null;
  email: string | null;
  /** How the provider names their account, to show. */
  login: string | null;
  /**
   * What a login an administrator recorded is matched against: only identifiers the provider
   * vouches for (a username it matched to the account, an account id), never a free-form name.
   */
  match: string[];
}

export interface Commit {
  sha: string;
  message: string;
  url: string | null;
  at: Date | null;
  author: Person;
}

/** One branch (or tag) a push moved. */
export interface PushRef {
  /** Null for a tag. */
  branch: string | null;
  deleted: boolean;
  commits: Commit[];
  /**
   * Commits the delivery leaves out, for a4a to read from the provider when it has a token: from
   * (excluded) to (included). Bitbucket Data Center sends none; Bitbucket Cloud, the latest five.
   * `from` is null for a new branch.
   */
  more: { from: string | null; to: string } | null;
}

export type Delivery =
  | { kind: 'ping'; event: string }
  | { kind: 'push'; event: string; repository: string; refs: PushRef[]; pusher: Person | null }
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
  | {
      /** A GitHub Actions run, which a build source may take as a build (D46). */
      kind: 'workflow_run';
      event: string;
      action: string;
      repository: string;
      /** The run's id and its attempt: a re-run is the same run again. */
      runId: string;
      workflow: string | null;
      /** The workflow's file, e.g. .github/workflows/ci.yml. */
      path: string | null;
      number: number | null;
      branch: string | null;
      headSha: string;
      headAt: Date | null;
      headMessage: string;
      conclusion: string | null;
      url: string | null;
      at: Date | null;
    }
  | { kind: 'other'; event: string };

const text = z.string().nullish();
/** A link a4a will show: http(s) only, so a payload can't hand the page a javascript: URL. */
export const link = (v: string | null | undefined): string | null => (v && /^https?:\/\/[^\s]+$/i.test(v) && v.length <= 2000 ? v : null);
export const when = (v: string | number | null | undefined): Date | null => {
  if (v === null || v === undefined || v === '') return null;
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? null : d;
};
const branchOf = (ref: string): string | null => (ref.startsWith('refs/heads/') ? ref.slice('refs/heads/'.length) : null);
const ZEROS = /^0+$/;
const present = (...values: (string | null | undefined)[]): string[] => values.filter((v): v is string => Boolean(v?.trim())).map((v) => v.trim());

/** "Anna Schmidt <anna@example.com>", as git writes an author. */
export function parseRawAuthor(raw: string | null | undefined): { name: string | null; email: string | null } {
  const m = /^\s*(.*?)\s*<([^<>]*)>\s*$/.exec(raw ?? '');
  if (!m) return { name: raw?.trim() || null, email: null };
  return { name: m[1] || null, email: m[2]?.trim() || null };
}

// GitHub, and Gitea and Forgejo ---------------------------------------------

const GithubPush = z.object({
  ref: z.string(),
  deleted: z.boolean().optional(),
  after: text,
  repository: z.object({ full_name: z.string() }),
  pusher: z.object({ name: text, email: text, login: text, username: text }).nullish(),
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
    .nullish(),
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

const GithubWorkflowRun = z.object({
  action: z.string(),
  repository: z.object({ full_name: z.string() }),
  workflow_run: z.object({
    id: z.number().int(),
    run_attempt: z.number().int().nullish(),
    run_number: z.number().int().nullish(),
    name: text,
    path: text,
    head_branch: text,
    head_sha: z.string().min(4).max(64),
    conclusion: text,
    html_url: text,
    updated_at: text,
    head_commit: z.object({ message: text, timestamp: text }).nullish(),
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
        pusher: p.pusher ? { name: p.pusher.name ?? null, email: p.pusher.email ?? null, login: p.pusher.login ?? p.pusher.username ?? null, match: [] } : null,
        refs: [
          {
            branch: branchOf(p.ref),
            deleted: Boolean(p.deleted) || ZEROS.test(p.after ?? ''),
            more: null,
            commits: (p.commits ?? []).map((c) => ({
              sha: c.id,
              message: c.message,
              url: link(c.url),
              at: when(c.timestamp),
              // The username is the account the provider matched the commit's email to, by its own
              // verified emails: it vouches for that, not for who typed the email.
              author: { name: c.author?.name ?? null, email: c.author?.email ?? null, login: c.author?.username ?? null, match: present(c.author?.username) },
            })),
          },
        ],
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
        url: link(pr.html_url),
        branch: pr.head?.ref ?? null,
        target: pr.base?.ref ?? null,
        state: pr.merged || pr.merged_at ? 'merged' : pr.state === 'closed' ? 'closed' : 'open',
        // The account that opened it, signed in at the provider.
        author: { name: null, email: null, login: pr.user?.login ?? null, match: present(pr.user?.login) },
        at: when(pr.updated_at),
      };
    }
    case 'workflow_run': {
      const p = GithubWorkflowRun.parse(body);
      const run = p.workflow_run;
      return {
        kind: 'workflow_run',
        event,
        action: p.action,
        repository: p.repository.full_name,
        runId: `${run.id}.${run.run_attempt ?? 1}`,
        workflow: run.name ?? null,
        path: run.path ?? null,
        number: run.run_number ?? null,
        branch: run.head_branch ?? null,
        headSha: run.head_sha,
        headAt: when(run.head_commit?.timestamp),
        headMessage: run.head_commit?.message ?? '',
        conclusion: run.conclusion ?? null,
        url: link(run.html_url),
        at: when(run.updated_at),
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
  user_name: text,
  user_username: text,
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

function gitlab(event: string, body: unknown): Delivery {
  const kind = (body as { object_kind?: unknown } | null)?.object_kind;
  if (kind === 'push') {
    const p = GitlabPush.parse(body);
    return {
      kind: 'push',
      event,
      repository: p.project.path_with_namespace,
      pusher: p.user_username ? { name: p.user_name ?? null, email: null, login: p.user_username, match: [] } : null,
      refs: [
        {
          branch: branchOf(p.ref),
          deleted: ZEROS.test(p.after ?? ''),
          more: null,
          // GitLab names no account for a commit's author: only their name and email.
          commits: p.commits.map((c) => ({
            sha: c.id,
            message: c.message,
            url: link(c.url),
            at: when(c.timestamp),
            author: { name: c.author?.name ?? null, email: c.author?.email ?? null, login: null, match: [] },
          })),
        },
      ],
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
      url: link(mr.url),
      branch: mr.source_branch ?? null,
      target: mr.target_branch ?? null,
      state: mr.state === 'merged' ? 'merged' : mr.state === 'closed' ? 'closed' : 'open',
      // The person who acted, signed in: the request's author when it's opened.
      author: { name: p.user?.name ?? null, email: null, login: p.user?.username ?? null, match: present(p.user?.username) },
      at: when(mr.updated_at),
    };
  }
  return { kind: 'other', event };
}

// Bitbucket Cloud -----------------------------------------------------------

/** An Atlassian account: its nickname isn't unique, so only its account id and UUID are matched. */
const BbAccount = z.object({ display_name: text, nickname: text, account_id: text, uuid: text }).nullish();
type BbAccountT = z.infer<typeof BbAccount>;
const BbRef = z.object({ type: z.string(), name: z.string(), target: z.object({ hash: z.string() }).nullish() });

export const BitbucketCommit = z.object({
  hash: z.string().min(4).max(64),
  message: z.string().nullish(),
  date: text,
  author: z.object({ raw: text, user: BbAccount }).nullish(),
  links: z.object({ html: z.object({ href: text }).nullish() }).nullish(),
});

const BitbucketPush = z.object({
  repository: z.object({ full_name: z.string() }),
  actor: BbAccount,
  push: z.object({
    changes: z
      .array(
        z.object({
          new: BbRef.nullable(),
          old: BbRef.nullable(),
          truncated: z.boolean().nullish(),
          commits: z.array(BitbucketCommit).nullish(),
        }),
      )
      .default([]),
  }),
});

const BitbucketPullRequest = z.object({
  repository: z.object({ full_name: z.string() }),
  pullrequest: z.object({
    id: z.number().int(),
    title: z.string(),
    description: text,
    state: z.string(),
    author: BbAccount,
    source: z.object({ branch: z.object({ name: z.string() }).nullish() }).nullish(),
    destination: z.object({ branch: z.object({ name: z.string() }).nullish() }).nullish(),
    links: z.object({ html: z.object({ href: text }).nullish() }).nullish(),
    updated_on: text,
  }),
});

function bitbucketAccount(a: BbAccountT): Person {
  return { name: a?.display_name ?? null, email: null, login: a?.nickname ?? null, match: present(a?.account_id, a?.uuid) };
}

/** A commit as Bitbucket Cloud's deliveries and its API both give it. */
export function bitbucketCommit(c: z.infer<typeof BitbucketCommit>): Commit {
  const raw = parseRawAuthor(c.author?.raw);
  // Bitbucket names an account when it matched the commit's email to one of its own confirmed emails.
  const user = c.author?.user ? bitbucketAccount(c.author.user) : null;
  return {
    sha: c.hash,
    message: c.message ?? '',
    url: link(c.links?.html?.href),
    at: when(c.date),
    author: { name: raw.name ?? user?.name ?? null, email: raw.email, login: user?.login ?? null, match: user?.match ?? [] },
  };
}

const BITBUCKET_PR_EVENTS = new Set(['pullrequest:created', 'pullrequest:updated', 'pullrequest:fulfilled', 'pullrequest:rejected']);

function bitbucket(event: string, body: unknown): Delivery {
  if (event === 'repo:push') {
    const p = BitbucketPush.parse(body);
    return {
      kind: 'push',
      event,
      repository: p.repository.full_name,
      pusher: p.actor ? bitbucketAccount(p.actor) : null,
      refs: p.push.changes.map((change) => {
        const to = change.new?.target?.hash ?? null;
        return {
          branch: change.new ? (change.new.type === 'branch' ? change.new.name : null) : (change.old?.type === 'branch' ? change.old.name : null),
          deleted: change.new === null,
          commits: (change.commits ?? []).map(bitbucketCommit),
          // It sends the latest five; with more, it says it truncated them.
          more: change.truncated && to ? { from: change.old?.target?.hash ?? null, to } : null,
        };
      }),
    };
  }
  if (BITBUCKET_PR_EVENTS.has(event)) {
    const p = BitbucketPullRequest.parse(body);
    const pr = p.pullrequest;
    const state = pr.state.toUpperCase();
    return {
      kind: 'pull_request',
      event,
      repository: p.repository.full_name,
      number: pr.id,
      title: pr.title,
      body: pr.description ?? '',
      url: link(pr.links?.html?.href),
      branch: pr.source?.branch?.name ?? null,
      target: pr.destination?.branch?.name ?? null,
      state: state === 'MERGED' ? 'merged' : state === 'DECLINED' || state === 'SUPERSEDED' ? 'closed' : 'open',
      author: bitbucketAccount(pr.author),
      at: when(pr.updated_on),
    };
  }
  return { kind: 'other', event };
}

// Bitbucket Data Center ------------------------------------------------------

/** A Bitbucket Data Center user; its `name` is the username, and `slug` that name in URLs. */
export const DcUser = z.object({ name: text, emailAddress: text, displayName: text, slug: text, id: z.number().nullish() });
const DcRepository = z.object({ slug: z.string(), project: z.object({ key: z.string() }) });
type DcRepositoryT = z.infer<typeof DcRepository>;

const DcRefsChanged = z.object({
  repository: DcRepository,
  actor: DcUser.nullish(),
  changes: z
    .array(
      z.object({
        ref: z.object({ id: z.string(), displayId: text, type: text }).nullish(),
        refId: text,
        fromHash: text,
        toHash: text,
        type: z.string(),
      }),
    )
    .default([]),
});

const DcRefOf = z.object({ id: z.string(), displayId: text, repository: DcRepository.nullish() });
const DcPullRequest = z.object({
  pullRequest: z.object({
    id: z.number().int(),
    title: z.string(),
    description: text,
    state: z.string(),
    updatedDate: z.number().nullish(),
    fromRef: DcRefOf,
    /** The pull request lives in the repository it targets. */
    toRef: DcRefOf.extend({ repository: DcRepository }),
    author: z.object({ user: DcUser.nullish() }).nullish(),
    links: z.object({ self: z.array(z.object({ href: text })).nullish() }).nullish(),
  }),
});

/** "PROJ/repository": how Bitbucket Data Center names a repository in its clone URLs. */
export const dcRepositoryName = (r: DcRepositoryT): string => `${r.project.key}/${r.slug}`;

/** A Data Center user, signed in there: their username is what a recorded login matches. */
export function dcUser(u: z.infer<typeof DcUser> | null | undefined): Person {
  return { name: u?.displayName ?? u?.name ?? null, email: u?.emailAddress ?? null, login: u?.slug ?? u?.name ?? null, match: present(u?.slug, u?.name) };
}

const DC_PR_EVENTS = new Set(['pr:opened', 'pr:modified', 'pr:from_ref_updated', 'pr:merged', 'pr:declined', 'pr:deleted']);

function bitbucketDc(event: string, body: unknown): Delivery {
  if (event === 'diagnostics:ping') return { kind: 'ping', event };
  if (event === 'repo:refs_changed') {
    const p = DcRefsChanged.parse(body);
    return {
      kind: 'push',
      event,
      repository: dcRepositoryName(p.repository),
      pusher: p.actor ? dcUser(p.actor) : null,
      refs: p.changes.map((change) => {
        const refId = change.ref?.id ?? change.refId ?? '';
        const isBranch = change.ref?.type ? change.ref.type.toUpperCase() === 'BRANCH' : refId.startsWith('refs/heads/');
        const deleted = change.type.toUpperCase() === 'DELETE';
        const to = change.toHash && !ZEROS.test(change.toHash) ? change.toHash : null;
        const from = change.fromHash && !ZEROS.test(change.fromHash) ? change.fromHash : null;
        return {
          branch: isBranch ? (change.ref?.displayId ?? branchOf(refId)) : null,
          deleted,
          // Its deliveries name the commits a push moved, not what they say: a4a reads them.
          commits: [],
          more: !deleted && to ? { from: change.type.toUpperCase() === 'ADD' ? null : from, to } : null,
        };
      }),
    };
  }
  if (DC_PR_EVENTS.has(event)) {
    const p = DcPullRequest.parse(body);
    const pr = p.pullRequest;
    const state = pr.state.toUpperCase();
    return {
      kind: 'pull_request',
      event,
      repository: dcRepositoryName(pr.toRef.repository),
      number: pr.id,
      title: pr.title,
      body: pr.description ?? '',
      url: link(pr.links?.self?.[0]?.href),
      branch: pr.fromRef.displayId ?? branchOf(pr.fromRef.id),
      target: pr.toRef.displayId ?? branchOf(pr.toRef.id),
      state: state === 'MERGED' ? 'merged' : state === 'DECLINED' || event === 'pr:deleted' ? 'closed' : 'open',
      author: dcUser(pr.author?.user),
      at: when(pr.updatedDate ?? null),
    };
  }
  return { kind: 'other', event };
}

/** Read a delivery from its event name (X-GitHub-Event, X-Gitlab-Event, X-Event-Key, X-Gitea-Event) and its JSON body. */
export function readDelivery(provider: VcsProvider, event: string, body: unknown): Delivery {
  switch (provider) {
    case 'github':
    case 'gitea':
      return github(event, body);
    case 'gitlab':
      return gitlab(event, body);
    case 'bitbucket':
      return bitbucket(event, body);
    case 'bitbucket-dc':
      return bitbucketDc(event, body);
  }
}
