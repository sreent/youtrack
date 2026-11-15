import type { IssueDetail, IssueLink, IssueRef, Tone } from '@a4a/shared';
import { useQueryClient } from '@tanstack/react-query';
import { useEffect, useId, useMemo, useState } from 'react';
import { Link } from 'react-router';
import { del, get, post } from '../../api/client';
import { keys, useLinkTypes } from '../../api/queries';
import { Badge } from '../../components/Badges';
import { errorText, useStateTones } from './api';
import { isOption } from './fields';

function RefBadge({ issue, tones }: { issue: IssueRef; tones: Map<string, Tone> }) {
  if (!issue.state) return null;
  return <Badge tone={tones.get(issue.state) ?? null}>{issue.state}</Badge>;
}

/** An issue as others refer to it: its id, summary and how it stands. */
function refOf(i: IssueDetail): IssueRef {
  const state = i.fields.find((f) => f.type === 'state')?.value;
  return { id: i.id, summary: i.summary, resolved: i.resolvedAt !== null, state: isOption(state) ? state.name : null };
}

const READABLE_ID = /^[A-Za-z][A-Za-z0-9]*-\d+$/;

/** Ocean's IssueLinks: an issue's links grouped by what they say, and a way to add one. */
export function IssueLinks({ issue }: { issue: IssueDetail }) {
  const id = useId();
  const qc = useQueryClient();
  const types = useLinkTypes();
  const tones = useStateTones();
  const [adding, setAdding] = useState(false);
  const [relation, setRelation] = useState('relates to');
  const [target, setTarget] = useState('');
  const [found, setFound] = useState<{ for: string; issue: IssueRef | null; error?: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const phrases = useMemo(() => {
    const out: string[] = [];
    for (const t of types.data ?? []) {
      out.push(t.outward);
      if (t.directed && t.inward !== t.outward) out.push(t.inward);
    }
    return [...new Set(out)];
  }, [types.data]);

  const groups = useMemo(() => {
    const m = new Map<string, IssueLink[]>();
    for (const l of issue.links) m.set(l.phrase, [...(m.get(l.phrase) ?? []), l]);
    return [...m.entries()];
  }, [issue.links]);

  // Find the issue as its id is typed, so the person sees what they're linking to.
  const wanted = target.trim().toUpperCase();
  useEffect(() => {
    if (!READABLE_ID.test(wanted)) {
      setFound(null);
      return;
    }
    let live = true;
    const timer = setTimeout(() => {
      get<IssueDetail>(`/issues/${wanted}`)
        .then((i) => live && setFound({ for: wanted, issue: refOf(i) }))
        .catch(() => live && setFound({ for: wanted, issue: null, error: `There's no issue ${wanted} you can see` }));
    }, 250);
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [wanted]);

  const refresh = () =>
    Promise.all([qc.invalidateQueries({ queryKey: keys.issue(issue.id) }), qc.invalidateQueries({ queryKey: ['issues', 'one'] }), qc.invalidateQueries({ queryKey: ['plan'] })]);

  const link = async () => {
    setBusy(true);
    setError(null);
    try {
      await post(`/issues/${issue.id}/links`, { relation, issue: wanted });
      await refresh();
      setTarget('');
      setAdding(false);
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  };
  const unlink = async (l: IssueLink) => {
    setError(null);
    try {
      await del(`/links/${l.id}`);
      await refresh();
    } catch (e) {
      setError(errorText(e));
    }
  };

  const ready = found?.for === wanted && found.issue !== null && wanted !== issue.id;

  return (
    <section className="card issue-links-box" aria-labelledby={`${id}-title`}>
      <div className="issue-links">
        <div className="issue-links-head">
          <h2 id={`${id}-title`}>Links</h2>
          <button type="button" aria-expanded={adding} aria-controls={`${id}-add`} onClick={() => setAdding((a) => !a)}>
            Add link
          </button>
        </div>
        {adding ? (
          <fieldset className="link-add" id={`${id}-add`}>
            <legend>A link from {issue.id}</legend>
            <div className="link-add-fields">
              <label>
                What it says
                <select value={relation} onChange={(e) => setRelation(e.target.value)}>
                  {phrases.map((p) => (
                    <option key={p}>{p}</option>
                  ))}
                </select>
              </label>
              <label>
                To
                <input
                  type="text"
                  value={target}
                  placeholder="BACK-46"
                  autoFocus
                  aria-describedby={found ? `${id}-found` : undefined}
                  onChange={(e) => setTarget(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' && ready) {
                      e.preventDefault();
                      void link();
                    }
                  }}
                />
              </label>
            </div>
            {found && found.for === wanted ? (
              found.issue ? (
                <p className="link-found" id={`${id}-found`}>
                  <span className="issue-id">{found.issue.id}</span>
                  <span>{found.issue.summary}</span>
                  <RefBadge issue={found.issue} tones={tones} />
                </p>
              ) : (
                <p className="a4-error" id={`${id}-found`}>
                  {found.error}
                </p>
              )
            ) : null}
            {wanted === issue.id ? <p className="a4-error">An issue can’t link to itself.</p> : null}
            <div className="link-add-actions">
              <button type="button" onClick={() => setAdding(false)}>
                Cancel
              </button>
              <button type="button" className="primary" disabled={!ready || busy} onClick={() => void link()}>
                {busy ? 'Linking…' : 'Link it'}
              </button>
            </div>
          </fieldset>
        ) : null}
        {error ? (
          <p className="a4-error" role="alert">
            {error}
          </p>
        ) : null}
        {groups.length === 0 && !adding ? <p className="note">No links yet. A link says how this issue stands to another: what it depends on, what it duplicates, what it’s part of.</p> : null}
        {groups.map(([phrase, links]) => (
          <div className="link-group" key={phrase}>
            <h3 className="label">
              {phrase} · {links.length}
            </h3>
            <ul className="link-list">
              {links.map((l) => (
                <li key={l.id} className={l.issue.resolved ? 'resolved' : undefined}>
                  <span className="issue-id">{l.issue.id}</span>
                  <Link to={`/issues/${l.issue.id}`}>{l.issue.summary}</Link>
                  <span className="a4-row">
                    <RefBadge issue={l.issue} tones={tones} />
                    <button type="button" className="link" aria-label={`Unlink ${l.issue.id}`} onClick={() => void unlink(l)}>
                      Unlink
                    </button>
                  </span>
                </li>
              ))}
            </ul>
          </div>
        ))}
      </div>
    </section>
  );
}
