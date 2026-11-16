import type { Project, ProjectVisibility } from '@a4a/shared';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { Link, useNavigate } from 'react-router';
import { post } from '../api/client';
import { keys, useMe, useProjects, useUsers } from '../api/queries';
import { Badge } from '../components/Badges';
import { ErrorNote, Loading, PageHead } from '../components/States';
import { UserWho } from '../components/Who';
import { FormField, Scroll } from '../features/common/bits';
import { TRIAGE_WORDS } from '../features/projects/triage';
import { t, tr } from '../i18n';
import type { ReactNode } from 'react';

const TEMPLATES: { id: 'software' | 'waterfall' | 'blank'; name: string; about: string }[] = [
  { id: 'software', name: 'Software', about: t('page.projects.statePriorityTypeAssigneeSubsystem') },
  { id: 'waterfall', name: 'Waterfall', about: t('page.projects.theSameWithoutFixVersions') },
  { id: 'blank', name: 'Blank', about: t('page.projects.stateAndAssigneeOnlyYou') },
];

function CreateProject() {
  const qc = useQueryClient();
  const navigate = useNavigate();
  const users = useUsers();
  const [form, setForm] = useState({
    key: '',
    name: '',
    description: '',
    lead: '',
    template: 'software' as 'software' | 'waterfall' | 'blank',
    visibility: 'open' as ProjectVisibility,
  });
  const create = useMutation({
    mutationFn: () =>
      post<Project>('/projects', {
        key: form.key.trim().toUpperCase(),
        name: form.name.trim(),
        description: form.description.trim(),
        ...(form.lead ? { lead: form.lead } : {}),
        template: form.template,
        visibility: form.visibility,
      }),
    onSuccess: (p) => {
      void qc.invalidateQueries({ queryKey: keys.projects });
      void qc.invalidateQueries({ queryKey: keys.fields });
      navigate(`/projects/${p.key}`);
    },
  });
  const set = (k: keyof typeof form) => (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>) =>
    setForm((f) => ({ ...f, [k]: e.target.value }));
  return (
    <section className="card" aria-labelledby="new-project">
      <h2 id="new-project">{t('page.projects.createAProject')}</h2>
      <form
        className="form"
        onSubmit={(e) => {
          e.preventDefault();
          create.mutate();
        }}
      >
        <div className="form-fields">
          <FormField
            label={t('page.projects.key')}
            help={
              <>{tr('page.projects.n2To10LettersOr', { toUpperCase: (form.key || 'BACK').toUpperCase() })}</>
            }
          >
            {(id, help) => (
              <input
                id={id}
                value={form.key}
                onChange={set('key')}
                required
                minLength={2}
                maxLength={10}
                pattern="[A-Za-z][A-Za-z0-9]*"
                className="key"
                aria-describedby={help}
                autoComplete="off"
              />
            )}
          </FormField>
          <FormField label={t('page.projects.name')}>{(id) => <input id={id} value={form.name} onChange={set('name')} required maxLength={100} />}</FormField>
          <FormField label={t('page.projects.lead')}>
            {(id) => (
              <select id={id} value={form.lead} onChange={set('lead')}>
                <option value="">{t('page.projects.nobodyYet')}</option>
                {(users.data ?? [])
                  .filter((u) => !u.isBot && !u.banned)
                  .map((u) => (
                    <option key={u.id} value={u.login}>
                      {u.name}
                    </option>
                  ))}
              </select>
            )}
          </FormField>
          <FormField label={t('page.projects.whatItSFor')} className="tw:col-span-full">
            {(id) => <textarea id={id} value={form.description} onChange={set('description')} rows={2} maxLength={5000} />}
          </FormField>
        </div>
        <fieldset className="choice-group column">
          <legend>{t('page.projects.itsFieldsToStartWith')}</legend>
          {TEMPLATES.map((t) => (
            <label key={t.id} className="choice">
              <input type="radio" name="template" value={t.id} checked={form.template === t.id} onChange={() => setForm((f) => ({ ...f, template: t.id }))} />
              <span>
                {t.name}
                <small className="field-help">{t.about}</small>
              </span>
            </label>
          ))}
        </fieldset>
        <fieldset className="choice-group column">
          <legend>{t('page.projects.whoSeesIt')}</legend>
          <label className="choice">
            <input type="radio" name="visibility" value="open" checked={form.visibility === 'open'} onChange={() => setForm((f) => ({ ...f, visibility: 'open' }))} />
            <span>{tr('page.projects.openEveryoneSeesItAnd', { t0: (c: ReactNode) => <small className="field-help">{c}</small> })}</span>
          </label>
          <label className="choice">
            <input type="radio" name="visibility" value="members" checked={form.visibility === 'members'} onChange={() => setForm((f) => ({ ...f, visibility: 'members' }))} />
            <span>{tr('page.projects.membersOnlyOnlyItsLead', { t0: (c: ReactNode) => <small className="field-help">{c}</small> })}</span>
          </label>
        </fieldset>
        <div className="cluster">
          <button type="submit" className="primary" disabled={create.isPending}>
            {create.isPending ? t('page.projects.creating') : t('page.projects.createTheProject')}
          </button>
        </div>
        {create.error ? <ErrorNote error={create.error} /> : null}
      </form>
    </section>
  );
}

/** Every project, with its key, lead and how many of its issues are open. */
export default function ProjectsPage() {
  const projects = useProjects();
  const me = useMe();
  const isAdmin = Boolean(me.data?.auth.scopes.includes('admin'));
  return (
    <>
      <PageHead
        title={t('page.projects.projects')}
        about={t('page.projects.eachProjectHasAKey')}
      />
      {projects.isLoading ? <Loading what="projects" /> : null}
      {projects.error ? <ErrorNote error={projects.error} /> : null}
      {projects.data ? (
        <section className="card figures-card" aria-label={t('page.projects.projects')}>
          {projects.data.length ? (
            <Scroll label={t('page.projects.tableOfProjects')}>
              <table className="figures">
                <thead>
                  <tr>
                    <th scope="col">{t('page.projects.key')}</th>
                    <th scope="col">{t('page.projects.project')}</th>
                    <th scope="col">{t('page.projects.lead')}</th>
                    <th scope="col" className="num">{t('page.projects.open')}</th>
                    <th scope="col">{t('page.projects.triage')}</th>
                    <th scope="col">{t('page.projects.you')}</th>
                  </tr>
                </thead>
                <tbody>
                  {projects.data.map((p) => (
                    <tr key={p.id}>
                      <td>
                        <Link to={`/projects/${p.key}`} className="issue-id">
                          {p.key}
                        </Link>
                      </td>
                      <td>
                        <Link to={`/projects/${p.key}`} className="item-name">
                          {p.name}
                        </Link>
                        {p.visibility === 'members' ? (
                          <>
                            {' '}
                            <span className="chip">{t('page.projects.membersOnly')}</span>
                          </>
                        ) : null}
                        {p.archived ? (
                          <>
                            {' '}
                            <Badge tone="idle">{t('page.projects.archived')}</Badge>
                          </>
                        ) : null}
                        {p.description ? <span className="item-about">{p.description}</span> : null}
                      </td>
                      <td>
                        <UserWho user={p.lead} small />
                      </td>
                      <td className="num">
                        <span className="of-total">{tr('page.projects.of', { openIssueCount: p.openIssueCount, t0: (c: ReactNode) => <strong>{c}</strong>, issueCount: p.issueCount })}</span>
                      </td>
                      <td>{TRIAGE_WORDS[p.settings.triageMode]}</td>
                      <td>{p.access.via === 'admin' ? t('page.projects.administrator') : p.access.roleName}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </Scroll>
          ) : (
            <p className="note">{tr('page.projects.thereAreNoProjectsYet', { v: isAdmin ? t('page.projects.createTheFirstOneBelow') : t('page.projects.anAdministratorCanCreateOne') })}</p>
          )}
        </section>
      ) : null}
      {isAdmin ? <CreateProject /> : null}
    </>
  );
}
