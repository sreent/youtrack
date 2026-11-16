import type { Project, ProjectGroup, ProjectRole } from '@a4a/shared';
import { PROJECT_ROLES } from '@a4a/shared/constants';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { Link } from 'react-router';
import { del, patch, post } from '../../api/client';
import { keys } from '../../api/queries';
import { ErrorNote, Loading } from '../../components/States';
import { errorText, FormField, Said, Scroll } from '../common/bits';
import { Confirm } from '../common/Confirm';
import { ROLE_NAMES, ROLE_WORDS } from '../projects/PeopleAndAccess';
import { groupKeys, useGroups, useProjectGroups } from './api';

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
  const change = useMutation({
    mutationFn: (role: ProjectRole) => patch<ProjectGroup>(`/projects/${project.key}/groups/${g.id}`, { role }),
    onSuccess: (r) => {
      setSaid({ text: `Everyone in ${g.name} is at least a ${ROLE_NAMES[r.role].toLowerCase()} now.` });
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
          {g.size} {g.size === 1 ? 'person' : 'people'}
          {g.providerName ? ' · from the identity provider' : ''}
        </span>
      </th>
      <td>
        {canEdit ? (
          <select value={row.role} onChange={(e) => change.mutate(e.target.value as ProjectRole)} aria-label={`Role of ${g.name} in ${project.key}`} disabled={change.isPending}>
            {PROJECT_ROLES.map((r) => (
              <option key={r} value={r}>
                {ROLE_NAMES[r]}
              </option>
            ))}
          </select>
        ) : (
          ROLE_NAMES[row.role]
        )}
      </td>
      <td className="fit">
        {canEdit ? (
          <Confirm
            small
            label="Take out"
            name={`Take out ${g.name}`}
            title={`Take ${g.name} out of ${project.key}?`}
            about={
              project.visibility === 'members'
                ? `Its people lose the role it gives them in ${project.key}; those with no other way in won't see it any more. You can add the group again.`
                : `Its people lose the role it gives them; in an open project, those with no other role are members. You can add the group again.`
            }
            confirm="Take it out"
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
  const [role, setRole] = useState<ProjectRole>('member');
  const [said, setSaid] = useState<{ text: string; bad?: boolean } | null>(null);
  const add = useMutation({
    mutationFn: () => post<ProjectGroup>(`/projects/${project.key}/groups`, { group, role }),
    onSuccess: (r) => {
      setSaid({ text: `Everyone in ${r.group.name} is at least a ${ROLE_NAMES[r.role].toLowerCase()} of ${project.key} now.` });
      setGroup('');
      void invalidate();
    },
    onError: (e) => setSaid({ text: errorText(e), bad: true }),
  });
  if (groups.data && !groups.data.length) {
    return <p className="note">There are no groups yet. Administrators make them under Administration.</p>;
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
        <legend>Add a group</legend>
        <div className="form-fields">
          <FormField label="Group">
            {(id) => (
              <select id={id} value={group} onChange={(e) => setGroup(e.target.value)} required>
                <option value="">Choose a group</option>
                {choices.map((g) => (
                  <option key={g.id} value={g.id}>
                    {g.name} ({g.size})
                  </option>
                ))}
              </select>
            )}
          </FormField>
          <FormField label="Its role" help={`Everyone in it is at least a ${ROLE_NAMES[role].toLowerCase()}, who ${ROLE_WORDS[role]}.`}>
            {(id, help) => (
              <select id={id} value={role} onChange={(e) => setRole(e.target.value as ProjectRole)} aria-describedby={help}>
                {PROJECT_ROLES.map((r) => (
                  <option key={r} value={r}>
                    {ROLE_NAMES[r]}
                  </option>
                ))}
              </select>
            )}
          </FormField>
        </div>
        <div className="cluster">
          <button type="submit" className="primary" disabled={!group || add.isPending}>
            {add.isPending ? 'Adding…' : 'Add the group'}
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
      <h3>Groups</h3>
      <p className="note section-note">Everyone in a group listed here has at least its role. Someone’s role is the highest of their own and their groups’.</p>
      {rows.isLoading ? <Loading what="its groups" /> : null}
      {rows.error ? <ErrorNote error={rows.error} /> : null}
      {rows.data && !list.length ? <p className="note">No group has a role here.</p> : null}
      {list.length ? (
        <Scroll label={`Groups in ${project.key}`}>
          <table className="figures middle">
            <thead>
              <tr>
                <th scope="col">Group</th>
                <th scope="col">Its role</th>
                <th scope="col">
                  <span className="hidden">Change</span>
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
