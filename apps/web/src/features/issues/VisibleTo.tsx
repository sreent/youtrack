import type { IssueDetail, VisibleTo as VisibleToDto } from '@a4a/shared';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { put } from '../../api/client';
import { keys, useUsers } from '../../api/queries';
import { UserWho } from '../../components/Who';
import { FormField } from '../../components/Form';
import { errorText, Said } from '../common/bits';
import { useGroups } from '../groups/api';
import { t, tr } from '../../i18n';

/** Who besides the few who always see it, as people's and groups' names: "Erin Hall, Security". */
export function audience(v: VisibleToDto): string {
  const names = [...v.users.map((u) => u.name), ...v.groups.map((g) => g.name)];
  return names.length ? names.join(', ') : t('issues.visibleTo.nobodyElse');
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
export function LimitPicker({ value, onChange, always }: { value: Limit; onChange: (v: Limit) => void; always?: string }) {
  const users = useUsers();
  const groups = useGroups();
  const people = (users.data ?? []).filter((u) => !u.banned && !u.isBot);
  const chosen = (e: React.ChangeEvent<HTMLSelectElement>) => [...e.target.selectedOptions].map((o) => o.value);
  const size = (n: number) => Math.min(6, Math.max(3, n));
  return (
    <fieldset className="stack tight">
      <legend>{t('issues.visibleTo.whoElseSeesIt')}</legend>
      <div className="form-fields">
        <FormField label={t('issues.visibleTo.people')}>
          {(id) => (
            <select id={id} multiple size={size(people.length)} value={value.users} onChange={(e) => onChange({ ...value, users: chosen(e) })}>
              {people.map((u) => (
                <option key={u.id} value={u.login}>
                  {u.name}
                </option>
              ))}
            </select>
          )}
        </FormField>
        {groups.data?.length ? (
          <FormField label={t('issues.visibleTo.groups')}>
            {(id) => (
              <select id={id} multiple size={size(groups.data.length)} value={value.groups} onChange={(e) => onChange({ ...value, groups: chosen(e) })}>
                {groups.data.map((g) => (
                  <option key={g.id} value={g.id}>
                    {g.name}
                  </option>
                ))}
              </select>
            )}
          </FormField>
        ) : null}
      </div>
      {always ? <p className="field-help">{always}</p> : null}
    </fieldset>
  );
}

/** Who sees an issue, on its page; whoever may change it may limit it, or lift the limit. */
export function VisibleToCard({ issue, canEdit }: { issue: IssueDetail; canEdit: boolean }) {
  const qc = useQueryClient();
  const [editing, setEditing] = useState<Limit | null>(null);
  const [said, setSaid] = useState<{ text: string; bad?: boolean } | null>(null);
  const key = issue.project.key;
  const always = t('issues.visibleTo.itsReporterItsAssigneeS', { key: key });
  const save = useMutation({
    mutationFn: (visibleTo: Limit | null) => put<IssueDetail>(`/issues/${issue.id}/visibility`, { visibleTo, expectedVersion: issue.version }),
    onSuccess: (next) => {
      qc.setQueryData(keys.issue(issue.id), next);
      void qc.invalidateQueries({ queryKey: keys.issue(issue.id) });
      setEditing(null);
      setSaid({ text: next.visibleTo ? t('issues.visibleTo.itSLimitedToNow', { audience: audience(next.visibleTo) }) : t('issues.visibleTo.everyoneWhoSeesSeesIt', { key: key }) });
    },
    onError: (e) => setSaid({ text: errorText(e), bad: true }),
  });
  const v = issue.visibleTo;
  return (
    <section className="card side-card" aria-labelledby="visible-title">
      <h2 id="visible-title">{t('issues.visibleTo.visibleTo')}</h2>
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
          <p className="note">{v.users.length || v.groups.length ? t('issues.visibleTo.andNoOneElseBut', { always: always }) : t('issues.visibleTo.onlyThoseWhoAlwaysSee', { always: always })}</p>
        </>
      ) : (
        <p className="note">{tr('issues.visibleTo.everyoneWhoSees', { key: key })}</p>
      )}
      {editing ? (
        <form
          className="stack"
          onSubmit={(e) => {
            e.preventDefault();
            save.mutate(editing);
          }}
        >
          <LimitPicker value={editing} onChange={setEditing} />
          <div className="cluster">
            <button type="submit" className="primary" disabled={save.isPending}>
              {save.isPending ? t('issues.visibleTo.saving') : t('issues.visibleTo.limitItToThem')}
            </button>
            <button type="button" onClick={() => setEditing(null)}>{t('issues.visibleTo.cancel')}</button>
          </div>
        </form>
      ) : canEdit ? (
        <div className="cluster">
          <button type="button" onClick={() => setEditing(limitOf(v) ?? { users: [], groups: [] })}>
            {v ? t('issues.visibleTo.changeWho') : t('issues.visibleTo.limitWhoSeesIt')}
          </button>
          {v ? (
            <button type="button" onClick={() => save.mutate(null)} disabled={save.isPending}>{t('issues.visibleTo.letEveryoneSeeIt')}</button>
          ) : null}
        </div>
      ) : null}
      <Said text={said?.text} tone={said?.bad ? 'bad' : undefined} />
    </section>
  );
}
