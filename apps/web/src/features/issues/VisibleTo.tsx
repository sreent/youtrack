import type { IssueDetail, VisibleTo as VisibleToDto } from '@a4a/shared';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { put } from '../../api/client';
import { keys, useUsers } from '../../api/queries';
import { UserWho } from '../../components/Who';
import { errorText, Said } from '../common/bits';
import { useGroups } from '../groups/api';

/** Who besides the few who always see it, as people's and groups' names: "Erin Hall, Security". */
export function audience(v: VisibleToDto): string {
  const names = [...v.users.map((u) => u.name), ...v.groups.map((g) => g.name)];
  return names.length ? names.join(', ') : 'nobody else';
}

/** What a limit asks for: logins and group ids. */
export interface Limit {
  users: string[];
  groups: string[];
}

export const limitOf = (v: VisibleToDto | null): Limit | null => (v ? { users: v.users.map((u) => u.login), groups: v.groups.map((g) => g.id) } : null);

/**
 * Whom to limit an issue or a comment to (D37): people and groups, chosen from lists. `always`
 * says who sees it whatever is chosen.
 */
export function LimitPicker({ value, onChange, always, idPrefix }: { value: Limit; onChange: (v: Limit) => void; always: string; idPrefix: string }) {
  const users = useUsers();
  const groups = useGroups();
  const people = (users.data ?? []).filter((u) => !u.banned && !u.isBot);
  const chosen = (e: React.ChangeEvent<HTMLSelectElement>) => [...e.target.selectedOptions].map((o) => o.value);
  return (
    <fieldset className="stack tight">
      <legend>Who else sees it</legend>
      <div className="form-fields">
        <div className="field">
          <label htmlFor={`${idPrefix}-people`}>People</label>
          <select id={`${idPrefix}-people`} multiple size={Math.min(6, Math.max(3, people.length))} value={value.users} onChange={(e) => onChange({ ...value, users: chosen(e) })}>
            {people.map((u) => (
              <option key={u.id} value={u.login}>
                {u.name}
              </option>
            ))}
          </select>
        </div>
        <div className="field">
          <label htmlFor={`${idPrefix}-groups`}>Groups</label>
          <select id={`${idPrefix}-groups`} multiple size={Math.min(6, Math.max(3, groups.data?.length ?? 0))} value={value.groups} onChange={(e) => onChange({ ...value, groups: chosen(e) })}>
            {(groups.data ?? []).map((g) => (
              <option key={g.id} value={g.id}>
                {g.name}
              </option>
            ))}
          </select>
        </div>
      </div>
      <p className="field-help">{always}</p>
    </fieldset>
  );
}

/** Who sees an issue, on its page; whoever may change it may limit it, or lift the limit. */
export function VisibleToCard({ issue, canEdit }: { issue: IssueDetail; canEdit: boolean }) {
  const qc = useQueryClient();
  const [editing, setEditing] = useState<Limit | null>(null);
  const [said, setSaid] = useState<{ text: string; bad?: boolean } | null>(null);
  const key = issue.project.key;
  const always = `Its reporter, its assignee, ${key}'s managers and administrators always see it.`;
  const save = useMutation({
    mutationFn: (visibleTo: Limit | null) => put<IssueDetail>(`/issues/${issue.id}/visibility`, { visibleTo, expectedVersion: issue.version }),
    onSuccess: (next) => {
      qc.setQueryData(keys.issue(issue.id), next);
      void qc.invalidateQueries({ queryKey: keys.issue(issue.id) });
      setEditing(null);
      setSaid({ text: next.visibleTo ? `Only ${audience(next.visibleTo)} see it now, besides those who always do.` : `Everyone who sees ${key} sees it now.` });
    },
    onError: (e) => setSaid({ text: errorText(e), bad: true }),
  });
  const v = issue.visibleTo;
  return (
    <section className="card side-card" aria-labelledby="visible-title">
      <h2 id="visible-title">Visible to</h2>
      {v ? (
        <>
          <ul className="plain">
            {v.users.map((u) => (
              <li key={u.id}>
                <UserWho user={u} small />
              </li>
            ))}
            {v.groups.map((g) => (
              <li key={g.id}>{g.name}</li>
            ))}
          </ul>
          <p className="note">{v.users.length || v.groups.length ? `And no one else but those who always see it. ${always}` : `Only those who always see it. ${always}`}</p>
        </>
      ) : (
        <p className="note">Everyone who sees {key}.</p>
      )}
      {editing ? (
        <form
          className="stack"
          onSubmit={(e) => {
            e.preventDefault();
            save.mutate(editing);
          }}
        >
          <LimitPicker value={editing} onChange={setEditing} always={always} idPrefix="issue-limit" />
          <div className="cluster">
            <button type="submit" className="primary" disabled={save.isPending}>
              {save.isPending ? 'Saving…' : 'Limit it to them'}
            </button>
            <button type="button" onClick={() => setEditing(null)}>
              Cancel
            </button>
          </div>
        </form>
      ) : canEdit ? (
        <div className="cluster">
          <button type="button" onClick={() => setEditing(limitOf(v) ?? { users: [], groups: [] })}>
            {v ? 'Change who' : 'Limit who sees it'}
          </button>
          {v ? (
            <button type="button" onClick={() => save.mutate(null)} disabled={save.isPending}>
              Let everyone see it
            </button>
          ) : null}
        </div>
      ) : null}
      <Said text={said?.text} tone={said?.bad ? 'bad' : undefined} />
    </section>
  );
}
