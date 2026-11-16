import type { Project, ProjectGroup } from '@a4a/shared';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { Link } from 'react-router';
import { del, patch, post } from '../../api/client';
import { keys, useRoles } from '../../api/queries';
import { ErrorNote, Loading } from '../../components/States';
import { errorText, FormField, Said, Scroll } from '../common/bits';
import { Confirm } from '../common/Confirm';
import { aRole, BUILTIN_ROLES, isBuiltinRole, roleHelp } from '../roles/words';
import { groupKeys, useGroups, useProjectGroups } from './api';
import { t } from '../../i18n';

function useInvalidate(project: Project) {
  const qc = useQueryClient();
  return () =>
    Promise.all([
      qc.invalidateQueries({ queryKey: groupKeys.project(project.key) }),
      qc.invalidateQueries({ queryKey: groupKeys.all }),
      qc.invalidateQueries({ queryKey: keys.project(project.key) }),
      qc.invalidateQueries({ queryKey: keys.projects }),
    ]);
}

function GroupRow({ project, row, canEdit }: { project: Project; row: ProjectGroup; canEdit: boolean }) {
  const invalidate = useInvalidate(project);
  const [said, setSaid] = useState<{ text: string; bad?: boolean } | null>(null);
  const g = row.group;
  const roles = useRoles().data ?? BUILTIN_ROLES;
  const change = useMutation({
    mutationFn: (role: string) => patch<ProjectGroup>(`/projects/${project.key}/groups/${g.id}`, { role }),
    onSuccess: (r) => {
      setSaid({ text: t('groups.projectGroups.everyoneInIsAtLeast', { name: g.name, aRole: aRole(r.roleName, isBuiltinRole(r.role)) }) });
      void invalidate();
    },
    onError: (e) => setSaid({ text: errorText(e), bad: true }),
  });
  const remove = useMutation({
    mutationFn: () => del(`/projects/${project.key}/groups/${g.id}`),
    onSuccess: () => void invalidate(),
    onError: (e) => setSaid({ text: errorText(e), bad: true }),
  });
  return (
    <tr>
      <th scope="row" className="row-head">
        <Link to={`/groups/${g.id}`}>{g.name}</Link>
        <span className="item-about">
          {t('count.people', { n: g.size })}
          {g.providerName ? t('groups.projectGroups.fromTheIdentityProvider') : ''}
        </span>
      </th>
      <td>
        {canEdit ? (
          <select value={row.role} onChange={(e) => change.mutate(e.target.value)} aria-label={t('groups.projectGroups.roleOfIn', { name: g.name, key: project.key })} disabled={change.isPending}>
            {roles.map((r) => (
              <option key={r.id} value={r.id}>
                {r.name}
              </option>
            ))}
          </select>
        ) : (
          row.roleName
        )}
      </td>
      <td className="fit">
        {canEdit ? (
          <Confirm
            small
            label={t('groups.projectGroups.takeOut')}
            name={t('groups.projectGroups.takeOut2', { name: g.name })}
            title={t('groups.projectGroups.takeOutOf', { name: g.name, key: project.key })}
            about={
              project.visibility === 'members'
                ? t('groups.projectGroups.itsPeopleLoseTheRole', { key: project.key })
                : t('groups.projectGroups.itsPeopleLoseTheRole2')
            }
            confirm={t('groups.projectGroups.takeItOut')}
            onConfirm={() => remove.mutate()}
            disabled={remove.isPending}
          />
        ) : null}
        <Said text={said?.text} tone={said?.bad ? 'bad' : undefined} />
      </td>
    </tr>
  );
}

function AddGroup({ project, listed }: { project: Project; listed: Set<string> }) {
  const invalidate = useInvalidate(project);
  const groups = useGroups();
  const choices = (groups.data ?? []).filter((g) => !listed.has(g.id));
  const [group, setGroup] = useState('');
  const roles = useRoles().data ?? BUILTIN_ROLES;
  const [role, setRole] = useState<string>('member');
  const [said, setSaid] = useState<{ text: string; bad?: boolean } | null>(null);
  const add = useMutation({
    mutationFn: () => post<ProjectGroup>(`/projects/${project.key}/groups`, { group, role }),
    onSuccess: (r) => {
      setSaid({ text: t('groups.projectGroups.everyoneInIsAtLeast2', { name: r.group.name, aRole: aRole(r.roleName, isBuiltinRole(r.role)), key: project.key }) });
      setGroup('');
      void invalidate();
    },
    onError: (e) => setSaid({ text: errorText(e), bad: true }),
  });
  if (groups.data && !groups.data.length) {
    return <p className="note">{t('groups.projectGroups.thereAreNoGroupsYet')}</p>;
  }
  return (
    <form
      className="stack"
      onSubmit={(e) => {
        e.preventDefault();
        if (group) add.mutate();
      }}
    >
      <fieldset className="form-card adding stack">
        <legend>{t('groups.projectGroups.addAGroup')}</legend>
        <div className="form-fields">
          <FormField label={t('groups.projectGroups.group')}>
            {(id) => (
              <select id={id} value={group} onChange={(e) => setGroup(e.target.value)} required>
                <option value="">{t('groups.projectGroups.chooseAGroup')}</option>
                {choices.map((g) => (
                  <option key={g.id} value={g.id}>
                    {g.name} ({g.size})
                  </option>
                ))}
              </select>
            )}
          </FormField>
          <FormField label={t('groups.projectGroups.itsRole')} help={roleHelp(roles, role, t('groups.projectGroups.everyoneInIt'))}>
            {(id, help) => (
              <select id={id} value={role} onChange={(e) => setRole(e.target.value)} aria-describedby={help}>
                {roles.map((r) => (
                  <option key={r.id} value={r.id}>
                    {r.name}
                  </option>
                ))}
              </select>
            )}
          </FormField>
        </div>
        <div className="cluster">
          <button type="submit" className="primary" disabled={!group || add.isPending}>
            {add.isPending ? t('groups.projectGroups.adding') : t('groups.projectGroups.addTheGroup')}
          </button>
          <Said text={said?.text} tone={said?.bad ? 'bad' : undefined} />
        </div>
      </fieldset>
    </form>
  );
}

/** The groups a project gives roles to: its managers change them, as they change its people. */
export function ProjectGroups({ project }: { project: Project }) {
  const rows = useProjectGroups(project.key);
  const canEdit = project.access.manage;
  const list = rows.data ?? [];
  return (
    <div className="stack">
      <h3>{t('groups.projectGroups.groups')}</h3>
      <p className="note section-note">{t('groups.projectGroups.everyoneInAGroupListed')}</p>
      {rows.isLoading ? <Loading what={t('groups.projectGroups.itsGroups')} /> : null}
      {rows.error ? <ErrorNote error={rows.error} /> : null}
      {rows.data && !list.length ? <p className="note">{t('groups.projectGroups.noGroupHasARole')}</p> : null}
      {list.length ? (
        <Scroll label={t('groups.projectGroups.groupsIn', { key: project.key })}>
          <table className="figures middle">
            <thead>
              <tr>
                <th scope="col">{t('groups.projectGroups.group')}</th>
                <th scope="col">{t('groups.projectGroups.itsRole')}</th>
                <th scope="col">
                  <span className="hidden">{t('groups.projectGroups.change')}</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {list.map((r) => (
                <GroupRow key={r.group.id} project={project} row={r} canEdit={canEdit} />
              ))}
            </tbody>
          </table>
        </Scroll>
      ) : null}
      {canEdit ? <AddGroup project={project} listed={new Set(list.map((r) => r.group.id))} /> : null}
    </div>
  );
}
