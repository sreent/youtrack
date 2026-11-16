import type { Project, ProjectMember, ProjectRole, ProjectVisibility, User } from '@a4a/shared';
import { PROJECT_ROLES } from '@a4a/shared/constants';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { del, patch, post } from '../../api/client';
import { keys, useMembers, useUsers } from '../../api/queries';
import { ErrorNote, Loading } from '../../components/States';
import { Avatar } from '../../components/Who';
import { errorText, FormField, Said, Scroll } from '../common/bits';
import { Confirm } from '../common/Confirm';

export const ROLE_NAMES: Record<ProjectRole, string> = { viewer: 'Viewer', member: 'Member', manager: 'Manager' };

const ROLE_WORDS: Record<ProjectRole, string> = {
  viewer: 'reads its issues and comments on them',
  member: 'also changes its issues',
  manager: 'also changes its settings, people, boards and baselines',
};

const VISIBILITY: { id: ProjectVisibility; name: string; about: string }[] = [
  { id: 'open', name: 'Open', about: 'Everyone sees it and works in it. The people below have the role given them; everyone else is a member.' },
  { id: 'members', name: 'Members only', about: 'Only the people below, and administrators, see it at all. To anyone else it doesn’t exist.' },
];

const YOU_MAY: Record<ProjectRole, string> = {
  viewer: 'you read its issues and comment on them',
  member: 'you read, comment on and change its issues',
  manager: 'you change its issues, settings, people, boards and baselines',
};

/** Your own place in the project, in a sentence. */
export function yourRole(project: Project): string {
  const a = project.access;
  if (a.via === 'admin') return 'As an administrator, you may change everything here.';
  const role = ROLE_NAMES[a.role].toLowerCase();
  const why = a.via === 'lead' ? ', as its lead' : a.via === 'open' ? ', as everyone is in an open project' : '';
  if (!a.comment) return `You're a ${role} here${why}, but your account only reads.`;
  return `You're a ${role} here${why}: ${YOU_MAY[a.role]}.`;
}

function useInvalidate(project: Project) {
  const qc = useQueryClient();
  return () =>
    Promise.all([
      qc.invalidateQueries({ queryKey: keys.members(project.key) }),
      qc.invalidateQueries({ queryKey: keys.project(project.key) }),
      qc.invalidateQueries({ queryKey: keys.projects }),
    ]);
}

function Visibility({ project, canEdit }: { project: Project; canEdit: boolean }) {
  const qc = useQueryClient();
  const [choice, setChoice] = useState<ProjectVisibility>(project.visibility);
  const [said, setSaid] = useState<{ text: string; bad?: boolean } | null>(null);
  useEffect(() => setChoice(project.visibility), [project.visibility]);
  const save = useMutation({
    mutationFn: (visibility: ProjectVisibility) => patch<Project>(`/projects/${project.key}`, { visibility }),
    onSuccess: (p) => {
      qc.setQueryData(keys.project(p.key), p);
      void qc.invalidateQueries({ queryKey: keys.projects });
      setSaid({ text: p.visibility === 'members' ? `Only ${p.key}'s people and administrators see it now.` : `Everyone sees ${p.key} now, and works in it.` });
    },
    onError: (e) => setSaid({ text: errorText(e), bad: true }),
  });
  return (
    <form
      className="stack"
      onSubmit={(e) => {
        e.preventDefault();
        save.mutate(choice);
      }}
    >
      <fieldset className="choice-group column" disabled={!canEdit || save.isPending}>
        <legend>Who sees it</legend>
        {VISIBILITY.map((v) => (
          <label key={v.id} className="choice">
            <input type="radio" name={`visibility-${project.key}`} value={v.id} checked={choice === v.id} onChange={() => setChoice(v.id)} />
            <span>
              {v.name}
              <small className="field-help">{v.about}</small>
            </span>
          </label>
        ))}
      </fieldset>
      {canEdit ? (
        <div className="cluster">
          <button type="submit" disabled={choice === project.visibility || save.isPending}>
            {save.isPending ? 'Saving…' : 'Save who sees it'}
          </button>
          <Said text={said?.text} tone={said?.bad ? 'bad' : undefined} />
        </div>
      ) : null}
    </form>
  );
}

function MemberRow({ project, member, canEdit }: { project: Project; member: ProjectMember; canEdit: boolean }) {
  const invalidate = useInvalidate(project);
  const [said, setSaid] = useState<{ text: string; bad?: boolean } | null>(null);
  const u = member.user;
  const name = u.isBot ? u.login : u.name;
  const change = useMutation({
    mutationFn: (role: ProjectRole) => patch<ProjectMember>(`/projects/${project.key}/members/${u.login}`, { role }),
    onSuccess: (m) => {
      setSaid({ text: `${name} is a ${ROLE_NAMES[m.role].toLowerCase()} now.` });
      void invalidate();
    },
    onError: (e) => setSaid({ text: errorText(e), bad: true }),
  });
  const remove = useMutation({
    mutationFn: () => del(`/projects/${project.key}/members/${u.login}`),
    onSuccess: () => void invalidate(),
    onError: (e) => setSaid({ text: errorText(e), bad: true }),
  });
  const listed = member.addedAt !== null;
  return (
    <tr>
      <th scope="row" className="row-head">
        <span className="tw:flex tw:min-w-48 tw:items-center tw:gap-2">
          <Avatar kind={u.isBot ? 'agent' : 'person'} name={name} small />
          <span>
            <span className="item-name">{name}</span>
            <span className="item-about">
              <span className="mono">{u.login}</span>
              {member.lead ? ' · leads it' : ''}
              {u.isBot ? ' · bot' : ''}
            </span>
          </span>
        </span>
      </th>
      <td>
        {member.lead ? (
          <span>
            Manager<span className="item-about">as its lead</span>
          </span>
        ) : canEdit ? (
          <select value={member.role} onChange={(e) => change.mutate(e.target.value as ProjectRole)} aria-label={`Role of ${name} in ${project.key}`} disabled={change.isPending}>
            {PROJECT_ROLES.map((r) => (
              <option key={r} value={r}>
                {ROLE_NAMES[r]}
              </option>
            ))}
          </select>
        ) : (
          ROLE_NAMES[member.role]
        )}
      </td>
      <td className="fit">
        {canEdit && listed && !member.lead ? (
          <Confirm
            small
            label="Take out"
            title={`Take ${name} out of ${project.key}?`}
            about={
              project.visibility === 'members'
                ? `${name} won't see ${project.key} or its issues any more. You can add them again.`
                : `${name} will be a member, as everyone is in an open project. You can add them again.`
            }
            confirm="Take them out"
            onConfirm={() => remove.mutate()}
            disabled={remove.isPending}
          />
        ) : null}
        <Said text={said?.text} tone={said?.bad ? 'bad' : undefined} />
      </td>
    </tr>
  );
}

function AddMember({ project, people, listed }: { project: Project; people: User[]; listed: Set<string> }) {
  const invalidate = useInvalidate(project);
  const choices = people.filter((u) => !u.banned && !listed.has(u.id));
  const [login, setLogin] = useState('');
  const [role, setRole] = useState<ProjectRole>('member');
  const [said, setSaid] = useState<{ text: string; bad?: boolean } | null>(null);
  const add = useMutation({
    mutationFn: () => post<ProjectMember>(`/projects/${project.key}/members`, { user: login, role }),
    onSuccess: (m) => {
      setSaid({ text: `${m.user.isBot ? m.user.login : m.user.name} is a ${ROLE_NAMES[m.role].toLowerCase()} of ${project.key} now.` });
      setLogin('');
      void invalidate();
    },
    onError: (e) => setSaid({ text: errorText(e), bad: true }),
  });
  return (
    <form
      className="stack"
      onSubmit={(e) => {
        e.preventDefault();
        if (login) add.mutate();
      }}
    >
      <fieldset className="form-card adding stack">
        <legend>Add someone</legend>
        <div className="form-fields">
          <FormField label="Person">
            {(id) => (
              <select id={id} value={login} onChange={(e) => setLogin(e.target.value)} required>
                <option value="">Choose someone</option>
                {choices.map((u) => (
                  <option key={u.id} value={u.login}>
                    {u.isBot ? `${u.login} (bot)` : u.name}
                  </option>
                ))}
              </select>
            )}
          </FormField>
          <FormField label="Role" help={`A ${ROLE_NAMES[role].toLowerCase()} ${ROLE_WORDS[role]}.`}>
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
          <button type="submit" className="primary" disabled={!login || add.isPending}>
            {add.isPending ? 'Adding…' : 'Add them'}
          </button>
          <Said text={said?.text} tone={said?.bad ? 'bad' : undefined} />
        </div>
      </fieldset>
    </form>
  );
}

/** Who sees a project, and the role each of its people has in it. */
export function PeopleAndAccess({ project }: { project: Project }) {
  const members = useMembers(project.key);
  const users = useUsers();
  const canEdit = project.access.manage;
  const list = members.data ?? [];
  return (
    <div className="stack">
      <Visibility project={project} canEdit={canEdit} />
      <p className="note section-note">
        Roles: a viewer {ROLE_WORDS.viewer}; a member {ROLE_WORDS.member}; a manager {ROLE_WORDS.manager}. Its lead is a manager, and administrators may do
        everything in every project.
      </p>
      {members.isLoading ? <Loading what="its people" /> : null}
      {members.error ? <ErrorNote error={members.error} /> : null}
      {members.data && !list.length ? (
        <p className="note">{project.visibility === 'members' ? 'Nobody is listed yet, so only administrators see it.' : 'Nobody is listed yet: everyone is a member.'}</p>
      ) : null}
      {list.length ? (
        <Scroll label={`People in ${project.key}`}>
          <table className="figures middle">
            <thead>
              <tr>
                <th scope="col">Person</th>
                <th scope="col">Role</th>
                <th scope="col">
                  <span className="hidden">Change</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {list.map((m) => (
                <MemberRow key={m.user.id} project={project} member={m} canEdit={canEdit} />
              ))}
            </tbody>
          </table>
        </Scroll>
      ) : null}
      {canEdit && users.data ? <AddMember project={project} people={users.data} listed={new Set(list.map((m) => m.user.id))} /> : null}
    </div>
  );
}
