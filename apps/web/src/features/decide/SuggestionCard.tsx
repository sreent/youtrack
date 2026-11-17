import type { Issue, IssueField, Suggestion } from '@a4a/shared';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useId, useState } from 'react';
import { post } from '../../api/client';
import { useIssue, useMe } from '../../api/queries';
import { ago, agoSaid, IssueLink } from '../../components/Badges';
import { Icon } from '../../components/Icon';
import { ErrorNote } from '../../components/States';
import { Avatar } from '../../components/Who';
import { Linked } from '../common/bits';
import { t, t as tx, tr } from '../../i18n';

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
  return field.toLowerCase() === 'assignee' ? tx('decide.suggestionCard.unassigned') : tx('decide.suggestionCard.notSet');
}

const CONFIDENCE: Record<'low' | 'medium' | 'high', string> = { low: tx('decide.suggestionCard.unsure'), medium: tx('decide.suggestionCard.fairlySure'), high: tx('decide.suggestionCard.sure') };
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
      if (compact) setSaid(tx('decide.suggestionCard.youAdded', { v: n === 1 ? tx('decide.suggestionCard.theTag') : tx('decide.suggestionCard.tags2', { n: n }) }));
      else if (next.status === 'applied')
        setSaid(n === items.length && !accepted ? tx('decide.suggestionCard.youAppliedIt') : tx('decide.suggestionCard.youApplied', { v: n === 1 ? tx('decide.suggestionCard.theLastOfIt') : tx('decide.suggestionCard.theRest') }));
      else setSaid(tx('decide.suggestionCard.youAppliedTheRestStays', { n: n }));
      refresh();
      if (next.status === 'applied') onDone?.();
    },
  });
  const dismiss = useMutation({
    mutationFn: () => post<Suggestion>(`/suggestions/${suggestion.id}/dismiss`),
    onSuccess: (next) => {
      setAnswer(next);
      setSaid(accepted || s.status === 'partially_applied' ? tx('decide.suggestionCard.youDismissedTheRestWhat') : tx('decide.suggestionCard.youDismissedItNothingChanged'));
      refresh();
      onDone?.();
    },
  });
  const busy = apply.isPending || dismiss.isPending;
  const error = apply.error ?? dismiss.error;

  if (compact && !open && !said && !p.duplicates.length && !p.tags.length) return null;

  const likeWords = tx(p.duplicates.length === 1 ? 'decide.suggestionCard.anIssueLikeThisOne' : 'decide.suggestionCard.issuesLikeThisOne');
  const title = compact
    ? openTags.length && p.duplicates.length
      ? tx('decide.suggestionCard.triageSuggestsTagsAndFound', { n: openTags.length, likeWords: likeWords })
      : openTags.length
        ? tx('decide.suggestionCard.triageSuggestsTags', { n: openTags.length })
        : p.duplicates.length
          ? tx('decide.suggestionCard.triageFound', { likeWords: likeWords })
          : tx('decide.suggestionCard.triageSuggestsChanges')
    : null;
  const about = [compact ? null : summary, ago(s.createdAt), accepted && open ? tx('decide.suggestionCard.acceptedOf', { accepted: accepted, total: fields.length + tags.length }) : null]
    .filter(Boolean)
    .join(' · ');

  let resolved: string | null = null;
  if (!said && !open) {
    const who = s.resolvedBy ? (s.resolvedBy.id === me.data?.id ? tx('decide.suggestionCard.you') : s.resolvedBy.name) : tx('decide.suggestionCard.someone');
    // The time is a value of the sentence, so a language puts it where it goes.
    const when = s.resolvedAt ? agoSaid(s.resolvedAt) : null;
    resolved =
      s.status === 'dismissed'
        ? when ? t('decide.suggestionCard.whoDismissedItWhen', { who: who, when: when }) : t('decide.suggestionCard.whoDismissedIt', { who: who })
        : when ? t('decide.suggestionCard.whoAppliedItWhen', { who: who, when: when }) : t('decide.suggestionCard.whoAppliedIt', { who: who });
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
                <>{tr(fields.length || tags.length ? 'decide.suggestionCard.triageSuggestsChangesTo' : 'decide.suggestionCard.triageFoundIssuesLike', { el: <IssueLink id={s.issueId} /> })}</>
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
          <p className="approval-note">{tx('decide.suggestionCard.itsValuesAreDashedIn')}</p>
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
                            <span className="approval-accepted">{f.value}</span> <span className="approval-state">{tx('decide.suggestionCard.accepted')}</span>
                          </span>
                        )}
                      </dd>
                    </div>
                  );
                })
              : null}
            {tags.length ? (
              <div className="pair">
                <dt>{tags.length === 1 ? tx('decide.suggestionCard.tag') : tx('decide.suggestionCard.tags')}</dt>
                <dd className="approval-stack">
                  {tags.map((t) => {
                    const key = `tag:${t.name}`;
                    return (
                      <span key={key} className="approval-tag">
                        {t.open ? (
                          <>
                            {pick(key, <ins className="proposed">{t.name}</ins>, tx('decide.suggestionCard.tag2', { name: t.name }))} <span className="approval-state">{tx('decide.suggestionCard.toAdd')}</span>
                          </>
                        ) : (
                          <>
                            <span className="chip">{t.name}</span> <span className="approval-state">{tx('decide.suggestionCard.added')}</span>
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
                <dt>{d.verdict === 'duplicate' ? tx('decide.suggestionCard.sameAs') : tx('decide.suggestionCard.relatedTo')}</dt>
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
            <strong>{tx('decide.suggestionCard.why')}</strong>
            <Linked text={p.summary} />
          </p>
        ) : null}

        {open ? (
          <>
            {choosing && picked.length === 0 ? <p className="approval-note">{tr(compact ? 'decide.suggestionCard.tickWhatToAdd' : 'decide.suggestionCard.tickWhatToApply')}</p> : null}
            {!compact && !items.length ? (
              <p className="approval-note">{tx('decide.suggestionCard.thereSNothingHereLeft')}</p>
            ) : null}
            <div className={compact ? 'cluster' : 'approval-actions'}>
              {items.length ? (
                <button type="button" className={compact ? undefined : 'primary'} disabled={busy || picked.length === 0} onClick={() => apply.mutate()}>
                  {apply.isPending
                    ? tx('decide.suggestionCard.applying')
                    : compact
                      ? picked.length === 1
                        ? tx('decide.suggestionCard.addTheTag')
                        : tx('decide.suggestionCard.addTags', { length: picked.length })
                      : picked.length < items.length
                        ? tx('decide.suggestionCard.applyOf', { length: picked.length, length2: items.length })
                        : accepted
                          ? tx('decide.suggestionCard.applyTheRest')
                          : tx('decide.suggestionCard.apply')}
                </button>
              ) : null}
              <button type="button" disabled={busy} onClick={() => dismiss.mutate()}>
                {dismiss.isPending ? tx('decide.suggestionCard.dismissing') : compact && fields.some((f) => f.open) ? tx('decide.suggestionCard.dismissAllOfIt') : tx('decide.suggestionCard.dismiss')}
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
            {open ? tx('decide.suggestionCard.whatYouApplyGoesIn', { issueId: s.issueId }) : tx('decide.suggestionCard.itSInSHistory', { issueId: s.issueId })}
          </p>
        )}
      </div>
    </section>
  );
}
