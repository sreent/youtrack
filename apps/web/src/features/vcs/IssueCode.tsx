import type { IssueDetail, IssueVcs, PullRequestState, VcsCommit } from '@a4a/shared';
import { useQuery } from '@tanstack/react-query';
import { get } from '../../api/client';
import { keys } from '../../api/queries';
import { Badge } from '../../components/Badges';
import { ErrorNote, Loading } from '../../components/States';
import { whenRead } from '../common/format';
import { IssueBuilds } from '../builds/Builds';

/** Under the issue's own key, so the live feed refreshes it with the issue. */
export const useIssueVcs = (id: string) => useQuery({ queryKey: keys.issueSub(id, 'vcs'), queryFn: () => get<IssueVcs>(`/issues/${id}/vcs`) });

/** How a pull request stands, in Ocean's grammar: open waits on review; merged went well; closed unmerged isn't needed. */
const STATE: Record<PullRequestState, { tone: 'warn' | 'good' | 'idle'; word: string }> = {
  open: { tone: 'warn', word: 'open' },
  merged: { tone: 'good', word: 'merged' },
  closed: { tone: 'idle', word: 'closed' },
};

/** Only what the provider gave as http(s) becomes a link. */
const safe = (url: string | null): string | null => (url && /^https?:\/\//i.test(url) ? url : null);

function Ref({ href, children, className }: { href: string | null; children: React.ReactNode; className: string }) {
  const url = safe(href);
  return url ? (
    <a className={className} href={url} target="_blank" rel="noreferrer noopener">
      {children}
    </a>
  ) : (
    <span className={className}>{children}</span>
  );
}

function author(c: Pick<VcsCommit, 'author'>): string {
  return c.author.user?.name ?? c.author.name ?? c.author.login ?? 'someone';
}

function Command({ commit }: { commit: VcsCommit }) {
  if (!commit.command) return null;
  // The badge says whether; the words say what it changed, or why not.
  const why = (commit.note ?? '').replace(/^Not applied:\s*/i, '');
  return (
    <p className="code-command">
      <code>#{commit.command}</code>
      {commit.applied ? <Badge tone="good">applied</Badge> : <Badge tone="bad">not applied</Badge>}
      {commit.applied ? <span>as {author(commit)}: {why}</span> : why ? <span>{why}</span> : null}
    </p>
  );
}

/** Ocean's Commits: what in version control mentions the issue, newest first, and what a commit's command did. */
export function IssueCode({ issue }: { issue: IssueDetail }) {
  const vcs = useIssueVcs(issue.id);
  const sources = [...new Set([...(vcs.data?.pullRequests ?? []), ...(vcs.data?.commits ?? [])].map((x) => x.repository))];
  return (
    <section className="card" aria-labelledby="code-title">
      <div className="section-head">
        <h2 id="code-title">Commits and pull requests</h2>
        {sources.length ? <span className="note">From {sources.join(', ')}</span> : null}
      </div>
      {vcs.isLoading ? <Loading what="its commits" /> : null}
      {vcs.error ? <ErrorNote error={vcs.error} /> : null}
      {vcs.data && !vcs.data.commits.length && !vcs.data.pullRequests.length ? (
        <p className="note">
          None yet. Mention <span className="issue-id">{issue.id}</span> in a commit message, or in a pull request's title, branch or description, and it shows here.
        </p>
      ) : null}
      {vcs.data && (vcs.data.commits.length || vcs.data.pullRequests.length) ? (
        <ul className="code-list">
          {vcs.data.pullRequests.map((p) => (
            <li key={p.id}>
              <p className="code-line">
                <Ref className="code-title" href={p.url}>
                  {p.title}
                </Ref>
                <span className="code-ref">#{p.number}</span>
                <Badge tone={STATE[p.state].tone}>{STATE[p.state].word}</Badge>
              </p>
              <p className="item-about">
                {p.branch ? (
                  <>
                    <span className="mono">{p.branch}</span>
                    {p.target ? (
                      <>
                        {' '}
                        into <span className="mono">{p.target}</span>
                      </>
                    ) : null}{' '}
                    ·{' '}
                  </>
                ) : null}
                {p.author.login || p.author.name ? `opened by ${p.author.user?.name ?? p.author.login ?? p.author.name} · ` : ''}
                {p.repository}
                {p.at ? (
                  <>
                    {' '}
                    · <time dateTime={p.at}>{whenRead(p.at)}</time>
                  </>
                ) : null}
              </p>
            </li>
          ))}
          {vcs.data.commits.map((c) => (
            <li key={c.id}>
              <p className="code-line">
                <Ref className="code-ref" href={c.url}>
                  <span className="hidden">Commit </span>
                  {c.sha.slice(0, 7)}
                </Ref>
                <span className="code-title">{c.title}</span>
              </p>
              <p className="item-about">
                {author(c)}
                {c.branch ? (
                  <>
                    {' '}
                    · on <span className="mono">{c.branch}</span>
                  </>
                ) : null}
                {c.at ? (
                  <>
                    {' '}
                    · <time dateTime={c.at}>{whenRead(c.at)}</time>
                  </>
                ) : null}
              </p>
              <Command commit={c} />
            </li>
          ))}
        </ul>
      ) : null}
      <IssueBuilds issue={issue} />
    </section>
  );
}
