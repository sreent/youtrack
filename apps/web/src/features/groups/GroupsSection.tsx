import type { GroupDetail, SetupStatus } from '@a4a/shared';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { Link } from 'react-router';
import { post } from '../../api/client';
import { useSetupStatus } from '../../api/queries';
import { ErrorNote, Loading } from '../../components/States';
import { errorText, FormField, Said, Scroll } from '../common/bits';
import { comesFrom, groupKeys, useGroups } from './api';
import { t } from '../../i18n';

/** The identity provider's name, for words about groups that come from it. */
export function providerNameOf(status: SetupStatus | undefined): string | null {
  const names = [status?.signIn.sso?.name, status?.signIn.saml?.name].filter((n): n is string => Boolean(n));
  return names.length === 1 ? names[0]! : null;
}

function AddGroup({ provider }: { provider: string | null }) {
  const qc = useQueryClient();
  const blank = { name: '', description: '', providerName: '' };
  const [form, setForm] = useState(blank);
  const [said, setSaid] = useState<{ text: string; bad?: boolean } | null>(null);
  const add = useMutation({
    mutationFn: () => post<GroupDetail>('/groups', { name: form.name.trim(), description: form.description.trim(), providerName: form.providerName.trim() || null }),
    onSuccess: (g) => {
      setSaid({ text: g.providerName ? t('groups.groupsSection.isMadePeopleJoinIt', { name: g.name }) : t('groups.groupsSection.isMadePutPeopleIn', { name: g.name }) });
      setForm(blank);
      void qc.invalidateQueries({ queryKey: groupKeys.all });
    },
    onError: (e) => setSaid({ text: errorText(e), bad: true }),
  });
  const set = (k: keyof typeof blank) => (e: React.ChangeEvent<HTMLInputElement>) => setForm((f) => ({ ...f, [k]: e.target.value }));
  return (
    <form
      className="stack"
      onSubmit={(e) => {
        e.preventDefault();
        add.mutate();
      }}
    >
      <fieldset className="form-card adding stack">
        <legend>{t('groups.groupsSection.makeAGroup')}</legend>
        <div className="form-fields">
          <FormField label={t('groups.groupsSection.name')}>{(id) => <input id={id} value={form.name} onChange={set('name')} required maxLength={80} />}</FormField>
          <FormField label={t('groups.groupsSection.whatItSFor')}>{(id) => <input id={id} value={form.description} onChange={set('description')} maxLength={500} />}</FormField>
          <FormField
            label={t('groups.groupsSection.itsNameAtTheIdentity')}
            help={t('groups.groupsSection.optionalWithItSaysWho', { v: provider ?? 'the identity provider' })}
          >
            {(id, help) => <input id={id} aria-describedby={help} value={form.providerName} onChange={set('providerName')} maxLength={200} className="mono" placeholder={t('groups.groupsSection.none')} />}
          </FormField>
        </div>
        <div className="cluster">
          <button type="submit" className="primary" disabled={!form.name.trim() || add.isPending}>
            {add.isPending ? t('groups.groupsSection.makingIt') : t('groups.groupsSection.makeTheGroup')}
          </button>
          <Said text={said?.text} tone={said?.bad ? 'bad' : undefined} />
        </div>
      </fieldset>
    </form>
  );
}

/** Administration's groups: each with how many are in it, where they come from, and how many projects give it a role. */
export function GroupsSection() {
  const groups = useGroups();
  const status = useSetupStatus();
  const provider = providerNameOf(status.data);
  const list = groups.data ?? [];
  return (
    <section className="card" aria-labelledby="groups">
      <div className="section-head">
        <h2 id="groups">{t('groups.groupsSection.groups')}</h2>
        <span className="note">
          {list.length} {list.length === 1 ? 'group' : 'groups'}
        </span>
      </div>
      <p className="note section-note">{t('groups.groupsSection.aProjectCanGiveA')}</p>
      {groups.isLoading ? <Loading what="groups" /> : null}
      {groups.error ? <ErrorNote error={groups.error} /> : null}
      {groups.data && !list.length ? <p className="note">{t('groups.groupsSection.noGroupsYet')}</p> : null}
      {list.length ? (
        <Scroll label={t('groups.groupsSection.tableOfGroups')}>
          <table className="figures middle">
            <thead>
              <tr>
                <th scope="col">{t('groups.groupsSection.group')}</th>
                <th scope="col" className="num">{t('groups.groupsSection.people')}</th>
                <th scope="col">{t('groups.groupsSection.whereItsPeopleComeFrom')}</th>
                <th scope="col" className="num">{t('groups.groupsSection.projects')}</th>
              </tr>
            </thead>
            <tbody>
              {list.map((g) => (
                <tr key={g.id}>
                  <th scope="row" className="row-head">
                    <Link to={`/groups/${g.id}`}>{g.name}</Link>
                    {g.description ? <span className="item-about">{g.description}</span> : null}
                  </th>
                  <td className="num">{g.size}</td>
                  <td>{comesFrom(g, provider)}</td>
                  <td className="num">{g.projects}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </Scroll>
      ) : null}
      <AddGroup provider={provider} />
    </section>
  );
}
