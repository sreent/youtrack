import type { Issue, IssueField, Suggestion } from '@a4a/shared';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useId, useState } from 'react';
import { post } from '../../api/client';
import { useIssue, useMe } from '../../api/queries';
import { ago, IssueLink } from '../../components/Badges';
import { Icon } from '../../components/Icon';
import { ErrorNote } from '../../components/States';
import { Avatar } from '../../components/Who';
import { Linked } from '../common/bits';

/** A field's value as the server compares it with a suggestion: logins, names, presentations. */
function present(f: IssueField): string | null {
  const v = f.value;
  if (v === null || v === undefined) return null;
  if (Array.isArray(v)) {
    const parts = v.map((x) => ('login' in x ? x.login : x.name));
    return parts.length ? parts.join(', ') : null;
  }
  if (typeof v === 'object') {
    if ('login' in v) return v.login;
    if ('presentation' in v) return v.presentation;
    if ('name' in v) return v.name;
  }
  return String(v);
}

/** What was there before an agent's value, as the history says it. */
function before(field: string, value: string | null): string {
  if (value) return value;
  return field.toLowerCase() === 'assignee' ? 'Unassigned' : 'Not set';
}

const CONFIDENCE: Record<'low' | 'medium' | 'high', string> = { low: 'unsure', medium: 'fairly sure', high: 'sure' };
const RANK: Record<Suggestion['status'], number> = { pending: 0, partially_applied: 1, applied: 2, dismissed: 2 };

/** Pending, or partly accepted with more to decide. */
export function isOpen(s: Suggestion): boolean {
  return s.status === 'pending' || s.status === 'partially_applied';
}

/**
 * A triage suggestion as Ocean's ApprovalCard: the agent by its mark and name, what it would change
 * (each value it worked out dashed, until a person accepts it), issues it looks like, why, and the
 * person's yes or no. What is still open is read against the issue as it is now, so a value
 * accepted already (here, or one at a time on the issue's page) shows as accepted. Applying or
 * dismissing re-reads the issue and the lists that show it.
 *
 * `compact` is for the issue's own page, whose field panel shows each value with its own Accept:
 * it leaves the issue and the field values out, and keeps the summary, the tags (with a way to add
 * them), the issues it looks like, and Dismiss. It shows nothing once there's nothing left.
 */
export function SuggestionCard({
  suggestion,
  compact,
  onDone,
  summary,
  issue: given,
  level,
}: {
  suggestion: Suggestion;
  compact?: boolean;
  /** Called once the suggestion is decided: applied in full, or dismissed. */
  onDone?: () => void;
  /** The issue's summary, when the page knows it (the Decide page does). */
  summary?: string;
  /** The issue as it is now, when the page has it; otherwise it's read (from the cache on its page). */
  issue?: Pick<Issue, 'fields' | 'tags'>;
  /** Its title's heading level: 3 under a page's section (the default), 2 where it is a section (compact's default). */
  level?: 2 | 3;
}) {
  const qc = useQueryClient();
  const me = useMe();
  const titleId = useId();
  const read = useIssue(given ? undefined : suggestion.issueId);
  const issue = given ?? read.data;
  // The answer to the last apply or dismiss, until the lists catch up with it.
  const [answer, setAnswer] = useState<Suggestion | null>(null);
  const s = answer && answer.id === suggestion.id && RANK[answer.status] > RANK[suggestion.status] ? answer : suggestion;
  const [unticked, setUnticked] = useState<Set<string>>(() => new Set());
  const [said, setSaid] = useState<string | null>(null);
  const p = s.payload;
  const open = isOpen(s);

  const now = issue ? new Map(issue.fields.map((f) => [f.name, present(f)])) : null;
  const has = issue ? new Set(issue.tags.map((t) => t.name.toLowerCase())) : null;
  // Fields it would change: open while the issue isn't at the suggested value.
  const fields = p.fields
    .filter((f) => f.value !== f.current)
    .map((f) => {
      const value = now ? (now.get(f.name) ?? null) : f.current;
      return { ...f, now: value, open: value !== f.value };
    });
  const tags = p.tags.map((t) => ({ ...t, open: has ? !has.has(t.name.toLowerCase()) : true }));
  const openFields = compact ? [] : fields.filter((f) => f.open);
  const openTags = tags.filter((t) => t.open);
  const items = [...openFields.map((f) => `field:${f.name}`), ...openTags.map((t) => `tag:${t.name}`)];
  const picked = items.filter((k) => !unticked.has(k));
  const choosing = items.length > 1;
  const accepted = fields.filter((f) => !f.open).length + tags.filter((t) => !t.open).length;

  const toggle = (key: string) =>
    setUnticked((u) => {
      const next = new Set(u);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });

  const refresh = () => {
    void qc.invalidateQueries({ queryKey: ['issues', 'one', suggestion.issueId] });
    void qc.invalidateQueries({ queryKey: ['ai', 'suggestions'] });
    void qc.invalidateQueries({ queryKey: ['issues', 'list'] });
    void qc.invalidateQueries({ queryKey: ['events'] });
  };

  const apply = useMutation({
    mutationFn: () => {
      // Compact never applies a field: those are accepted in the field panel, one at a time.
      const everything = !compact && picked.length === items.length;
      const body = everything
        ? {}
        : {
            fields: picked.filter((k) => k.startsWith('field:')).map((k) => k.slice(6)),
            tags: picked.filter((k) => k.startsWith('tag:')).map((k) => k.slice(4)),
          };
      return post<Suggestion>(`/suggestions/${suggestion.id}/apply`, body);
    },
    onSuccess: (next) => {
      const n = picked.length;
      setAnswer(next);
      setUnticked(new Set());
      if (compact) setSaid(`You added ${n === 1 ? 'the tag' : `${n} tags`}.`);
      else if (next.status === 'applied')
        setSaid(n === items.length && !accepted ? 'You applied it.' : `You applied ${n === 1 ? 'the last of it' : 'the rest'}.`);
      else setSaid(`You applied ${n}. The rest stays open.`);
      refresh();
      if (next.status === 'applied') onDone?.();
    },
  });
  const dismiss = useMutation({
    mutationFn: () => post<Suggestion>(`/suggestions/${suggestion.id}/dismiss`),
    onSuccess: (next) => {
      setAnswer(next);
      setSaid(accepted || s.status === 'partially_applied' ? 'You dismissed the rest. What you accepted stays.' : 'You dismissed it. Nothing changed.');
      refresh();
      onDone?.();
    },
  });
  const busy = apply.isPending || dismiss.isPending;
  const error = apply.error ?? dismiss.error;

  if (compact && !open && !said && !p.duplicates.length && !p.tags.length) return null;

  const tagWords = openTags.length === 1 ? 'a tag' : 'tags';
  const likeWords = `${p.duplicates.length === 1 ? 'an issue' : 'issues'} like this one`;
  const title = compact
    ? openTags.length && p.duplicates.length
      ? `triage suggests ${tagWords}, and found ${likeWords}`
      : openTags.length
        ? `triage suggests ${tagWords}`
        : p.duplicates.length
          ? `triage found ${likeWords}`
          : 'triage suggests changes'
    : null;
  const about = [compact ? null : summary, ago(s.createdAt), accepted && open ? `${accepted} of ${fields.length + tags.length} accepted` : null]
    .filter(Boolean)
    .join(' · ');

  let resolved: string | null = null;
  if (!said && !open) {
    const who = s.resolvedBy ? (s.resolvedBy.id === me.data?.id ? 'You' : s.resolvedBy.name) : 'Someone';
    const when = s.resolvedAt ? ` ${ago(s.resolvedAt)}` : '';
    resolved = s.status === 'dismissed' ? `${who} dismissed it${when}.` : `${who} applied it${when}.`;
  }

  const pick = (key: string, label: React.ReactNode, aria?: string) =>
    choosing && open ? (
      <label className="approval-pick">
        <input type="checkbox" checked={!unticked.has(key)} onChange={() => toggle(key)} disabled={busy} aria-label={aria} />
        {label}
      </label>
    ) : (
      label
    );

  const showFields = !compact && fields.length > 0;
  const Heading = (level ?? (compact ? 2 : 3)) === 2 ? 'h2' : 'h3';
  const hasWell = showFields || tags.length > 0 || p.duplicates.length > 0;

  return (
    <section className={compact ? 'approval compact' : 'approval'} aria-labelledby={titleId}>
      <div className="approval-stripe changes" />
      <div className="approval-body">
        <div className="who">
          <Avatar kind="agent" name="triage" small={compact} />
          <span>
            <Heading className="approval-title" id={titleId}>
              {title ?? (
                <>
                  triage {fields.length || tags.length ? 'suggests changes to' : 'found issues like'} <IssueLink id={s.issueId} />
                </>
              )}
            </Heading>
            <span className="who-about">{about}</span>
          </span>
        </div>

        {compact && p.summary ? (
          <p className="approval-summary">
            <Linked text={p.summary} />
          </p>
        ) : null}
        {compact && open && openFields.length === 0 && fields.some((f) => f.open) ? (
          <p className="approval-note">Its values are dashed in the fields: accept each one you agree with.</p>
        ) : null}

        {hasWell ? (
          <dl className="approval-changes">
            {showFields
              ? fields.map((f) => {
                  const key = `field:${f.name}`;
                  return (
                    <div className="pair" key={key}>
                      <dt>{f.open ? pick(key, f.name) : f.name}</dt>
                      <dd className="approval-stack">
                        {f.open ? (
                          <>
                            <span>
                              <del>{before(f.name, f.now)}</del> → <ins className="proposed">{f.value}</ins>
                            </span>
                            <span className="approval-reason">
                              <span className="source inferred">{CONFIDENCE[f.confidence]}</span> <Linked text={f.reason} />
                            </span>
                          </>
                        ) : (
                          <span>
                            <span className="approval-accepted">{f.value}</span> <span className="approval-state">accepted</span>
                          </span>
                        )}
                      </dd>
                    </div>
                  );
                })
              : null}
            {tags.length ? (
              <div className="pair">
                <dt>{tags.length === 1 ? 'Tag' : 'Tags'}</dt>
                <dd className="approval-stack">
                  {tags.map((t) => {
                    const key = `tag:${t.name}`;
                    return (
                      <span key={key} className="approval-tag">
                        {t.open ? (
                          <>
                            {pick(key, <ins className="proposed">{t.name}</ins>, `Tag ${t.name}`)} <span className="approval-state">to add</span>
                          </>
                        ) : (
                          <>
                            <span className="chip">{t.name}</span> <span className="approval-state">added</span>
                          </>
                        )}
                      </span>
                    );
                  })}
                </dd>
              </div>
            ) : null}
            {p.duplicates.map((d) => (
              <div className="pair" key={`dup:${d.issue}`}>
                <dt>{d.verdict === 'duplicate' ? 'Same as' : 'Related to'}</dt>
                <dd className="approval-stack">
                  <span>
                    <IssueLink id={d.issue} /> {d.summary}
                  </span>
                  <span className="approval-reason">
                    <Linked text={d.reason} />
                  </span>
                </dd>
              </div>
            ))}
          </dl>
        ) : null}

        {!compact && p.summary ? (
          <p className="approval-why">
            <strong>Why: </strong>
            <Linked text={p.summary} />
          </p>
        ) : null}

        {open ? (
          <>
            {choosing && picked.length === 0 ? <p className="approval-note">Tick what to {compact ? 'add' : 'apply'}, or dismiss it.</p> : null}
            {!compact && !items.length ? (
              <p className="approval-note">There's nothing here left to apply. Open the issues it found, then dismiss it.</p>
            ) : null}
            <div className={compact ? 'cluster' : 'approval-actions'}>
              {items.length ? (
                <button type="button" className={compact ? undefined : 'primary'} disabled={busy || picked.length === 0} onClick={() => apply.mutate()}>
                  {apply.isPending
                    ? 'Applying…'
                    : compact
                      ? picked.length === 1
                        ? 'Add the tag'
                        : `Add ${picked.length} tags`
                      : picked.length < items.length
                        ? `Apply ${picked.length} of ${items.length}`
                        : accepted
                          ? 'Apply the rest'
                          : 'Apply'}
                </button>
              ) : null}
              <button type="button" disabled={busy} onClick={() => dismiss.mutate()}>
                {dismiss.isPending ? 'Dismissing…' : compact && fields.some((f) => f.open) ? 'Dismiss all of it' : 'Dismiss'}
              </button>
            </div>
            {said ? (
              <p className="approval-done" role="status">
                {said}
              </p>
            ) : null}
          </>
        ) : (
          <p className="approval-done" role="status">
            {said ?? resolved}
          </p>
        )}
        {error ? (
          <ErrorNote error={error} />
        ) : null}
        {compact ? null : (
          <p className="approval-signed">
            <Icon name="audit" />
            {open ? `What you apply goes in ${s.issueId}'s history as your change.` : `It's in ${s.issueId}'s history.`}
          </p>
        )}
      </div>
    </section>
  );
}
