import type { Project, ProjectMember, ProjectVisibility, User } from '@a4a/shared';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { del, patch, post } from '../../api/client';
import { keys, useMembers, useRoles, useUsers } from '../../api/queries';
import { ErrorNote, Loading } from '../../components/States';
import { Avatar } from '../../components/Who';
import { errorText, FormField, Said, Scroll } from '../common/bits';
import { Confirm } from '../common/Confirm';
import { ProjectGroups } from '../groups/ProjectGroups';
import { aRole, BUILTIN_ROLES, isBuiltinRole, permissionWords, roleHelp, roleLabel, roleNamed } from '../roles/words';
import { sentences, t, tr } from '../../i18n';
import type { ReactNode } from 'react';

const VISIBILITY: { id: ProjectVisibility; name: string; about: string }[] = [
  { id: 'open', name: t('projects.peopleAndAccess.open'), about: t('projects.peopleAndAccess.everyoneSeesItAndWorks') },
  { id: 'members', name: t('projects.peopleAndAccess.membersOnly'), about: t('projects.peopleAndAccess.onlyThePeopleBelowAnd') },
];

const YOU_MAY = {
  viewer: t('projects.peopleAndAccess.youReadItsIssuesAnd'),
  member: t('projects.peopleAndAccess.youReadCommentOnAnd'),
  manager: t('projects.peopleAndAccess.youChangeItsIssuesSettings'),
};

/** Your own place in the project, in a sentence. */
export function yourRole(project: Project): string {
  const a = project.access;
  if (a.via === 'admin') return t('projects.peopleAndAccess.asAnAdministratorYouMay');
  const role = aRole(a.role, a.roleName);
  const named = roleNamed(a.role);
  const why =
    a.via === 'lead'
      ? t('projects.peopleAndAccess.asItsLead')
      : a.via === 'guest'
        ? t('projects.peopleAndAccess.asAGuestTheProject')
        : a.via === 'open'
        ? t('projects.peopleAndAccess.asEveryoneIsInAn')
        : a.via === 'group'
          ? t('projects.peopleAndAccess.asOneOf', { v: a.group ?? t('projects.peopleAndAccess.aGroup') })
          : '';
  if (a.via === 'guest') return t('projects.peopleAndAccess.youReReadingAsA', { key: project.key });
  if (!isBuiltinRole(a.role))
    return a.permissions.length
      ? t('projects.peopleAndAccess.youAreRoleHereYouMay', { role: role, named, why: why, permissionWords: permissionWords(a.permissions) })
      : t('projects.peopleAndAccess.youAreRoleHereNothing', { role: role, named, why: why });
  if (!a.comment) return t('projects.peopleAndAccess.youAreRoleHereBut', { role: role, named, why: why });
  return t('projects.peopleAndAccess.youAreRoleHere', { role: role, named, why: why, v: YOU_MAY[a.role as keyof typeof YOU_MAY] });
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
      setSaid({ text: p.visibility === 'members' ? t('projects.peopleAndAccess.onlySPeopleAndAdministrators', { key: p.key }) : t('projects.peopleAndAccess.everyoneSeesNowAndWorks', { key: p.key }) });
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
        <legend>{t('projects.peopleAndAccess.whoSeesIt')}</legend>
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
            {save.isPending ? t('projects.peopleAndAccess.saving') : t('projects.peopleAndAccess.saveWhoSeesIt')}
          </button>
          <Said text={said?.text} tone={said?.bad ? 'bad' : undefined} />
        </div>
      ) : null}
      <Guests project={project} />
    </form>
  );
}

/** Whether anyone may read an open project without signing in (D37): administrators decide. */
function Guests({ project }: { project: Project }) {
  const qc = useQueryClient();
  const [said, setSaid] = useState<{ text: string; bad?: boolean } | null>(null);
  const admin = project.access.via === 'admin';
  const save = useMutation({
    mutationFn: (guestAccess: boolean) => patch<Project>(`/projects/${project.key}`, { guestAccess }),
    onSuccess: (p) => {
      qc.setQueryData(keys.project(p.key), p);
      void qc.invalidateQueries({ queryKey: keys.projects });
      setSaid({ text: p.guestAccess ? t('projects.peopleAndAccess.anyoneMayReadNowSigned', { key: p.key }) : t('projects.peopleAndAccess.onlyPeopleWhoSignIn', { key: p.key }) });
    },
    onError: (e) => setSaid({ text: errorText(e), bad: true }),
  });
  if (!admin && !project.guestAccess) return null;
  return (
    <div className="stack tight">
      <label className="choice">
        <input
          type="checkbox"
          checked={project.guestAccess}
          disabled={!admin || save.isPending || (project.visibility !== 'open' && !project.guestAccess)}
          onChange={(e) => save.mutate(e.target.checked)}
        />
        <span>{tr('projects.peopleAndAccess.openToGuests', { v: project.visibility === 'open'
              ? t('projects.peopleAndAccess.anyoneMayReadItsIssues', { v: admin ? '' : t('projects.peopleAndAccess.administratorsDecideThis') })
              : t('projects.peopleAndAccess.onlyAnOpenProjectCan'), t0: (c: ReactNode) => <small className="field-help">{c}</small> })}</span>
      </label>
      <Said text={said?.text} tone={said?.bad ? 'bad' : undefined} />
    </div>
  );
}

function MemberRow({ project, member, canEdit }: { project: Project; member: ProjectMember; canEdit: boolean }) {
  const invalidate = useInvalidate(project);
  const [said, setSaid] = useState<{ text: string; bad?: boolean } | null>(null);
  const roles = useRoles().data ?? BUILTIN_ROLES;
  const u = member.user;
  const name = u.isBot ? u.login : u.name;
  const change = useMutation({
    mutationFn: (role: string) => patch<ProjectMember>(`/projects/${project.key}/members/${u.login}`, { role }),
    onSuccess: (m) => {
      setSaid({ text: t('projects.peopleAndAccess.isRoleNow', { name: name, role: aRole(m.role, m.roleName), named: roleNamed(m.role) }) });
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
              {member.lead ? t('projects.peopleAndAccess.leadsIt') : ''}
              {u.isBot ? t('projects.peopleAndAccess.bot') : ''}
            </span>
          </span>
        </span>
      </th>
      <td>
        {member.lead ? (
          <span>{tr('projects.peopleAndAccess.managerAsItsLead', { t0: (c: ReactNode) => <span className="item-about">{c}</span> })}</span>
        ) : canEdit ? (
          <select value={member.role} onChange={(e) => change.mutate(e.target.value)} aria-label={t('projects.peopleAndAccess.roleOfIn', { name: name, key: project.key })} disabled={change.isPending}>
            {roles.map((r) => (
              <option key={r.id} value={r.id}>
                {roleLabel(r.id, r.name)}
              </option>
            ))}
          </select>
        ) : (
          roleLabel(member.role, member.roleName)
        )}
      </td>
      <td className="fit">
        {canEdit && listed && !member.lead ? (
          <Confirm
            small
            label={t('projects.peopleAndAccess.takeOut')}
            title={t('projects.peopleAndAccess.takeOutOf', { name: name, key: project.key })}
            about={
              project.visibility === 'members'
                ? t('projects.peopleAndAccess.wonTSeeOrIts', { name: name, key: project.key })
                : t('projects.peopleAndAccess.willBeAMemberAs', { name: name })
            }
            confirm={t('projects.peopleAndAccess.takeThemOut')}
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
  const roles = useRoles().data ?? BUILTIN_ROLES;
  const [role, setRole] = useState<string>('member');
  const [said, setSaid] = useState<{ text: string; bad?: boolean } | null>(null);
  const add = useMutation({
    mutationFn: () => post<ProjectMember>(`/projects/${project.key}/members`, { user: login, role }),
    onSuccess: (m) => {
      setSaid({ text: t('projects.peopleAndAccess.isRoleOfNow', { v: m.user.isBot ? m.user.login : m.user.name, role: aRole(m.role, m.roleName), named: roleNamed(m.role), key: project.key }) });
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
        <legend>{t('projects.peopleAndAccess.addSomeone')}</legend>
        <div className="form-fields">
          <FormField label={t('projects.peopleAndAccess.person')}>
            {(id) => (
              <select id={id} value={login} onChange={(e) => setLogin(e.target.value)} required>
                <option value="">{t('projects.peopleAndAccess.chooseSomeone')}</option>
                {choices.map((u) => (
                  <option key={u.id} value={u.login}>
                    {u.isBot ? t('projects.peopleAndAccess.bot2', { login: u.login }) : u.name}
                  </option>
                ))}
              </select>
            )}
          </FormField>
          <FormField label={t('projects.peopleAndAccess.role')} help={roleHelp(roles, role)}>
            {(id, help) => (
              <select id={id} value={role} onChange={(e) => setRole(e.target.value)} aria-describedby={help}>
                {roles.map((r) => (
                  <option key={r.id} value={r.id}>
                    {roleLabel(r.id, r.name)}
                  </option>
                ))}
              </select>
            )}
          </FormField>
        </div>
        <div className="cluster">
          <button type="submit" className="primary" disabled={!login || add.isPending}>
            {add.isPending ? t('projects.peopleAndAccess.adding') : t('projects.peopleAndAccess.addThem')}
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
  const roles = useRoles().data ?? BUILTIN_ROLES;
  const canEdit = project.access.manage;
  const list = members.data ?? [];
  return (
    <div className="stack">
      <Visibility project={project} canEdit={canEdit} />
      {/* What each role may do, a sentence each as the role picker's help says it, then who else may. */}
      <p className="note section-note">{sentences([...roles.map((r) => roleHelp(roles, r.id)), t('projects.peopleAndAccess.itsLeadIsAManager')])}</p>
      {members.isLoading ? <Loading what="loadingLine.projectPeople" /> : null}
      {members.error ? <ErrorNote error={members.error} /> : null}
      {members.data && !list.length ? (
        <p className="note">
          {project.visibility === 'members'
            ? t('projects.peopleAndAccess.nobodyIsListedByName')
            : t('projects.peopleAndAccess.nobodyIsListedByName2')}
        </p>
      ) : null}
      {list.length ? (
        <Scroll label={t('projects.peopleAndAccess.peopleIn', { key: project.key })}>
          <table className="figures middle">
            <thead>
              <tr>
                <th scope="col">{t('projects.peopleAndAccess.person')}</th>
                <th scope="col">{t('projects.peopleAndAccess.role')}</th>
                <th scope="col">
                  <span className="hidden">{t('projects.peopleAndAccess.change')}</span>
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
      <ProjectGroups project={project} />
    </div>
  );
}
