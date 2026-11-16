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

const TEMPLATES: { id: 'software' | 'waterfall' | 'blank'; name: string; about: string }[] = [
  { id: 'software', name: 'Software', about: 'State, Priority, Type, Assignee, Subsystem, Fix versions, Estimation and Due date.' },
  { id: 'waterfall', name: 'Waterfall', about: 'The same without Fix versions, with Start date and Fixed cost, for a plan over time and its budget.' },
  { id: 'blank', name: 'Blank', about: 'State and Assignee only. You attach the rest.' },
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
      <h2 id="new-project">Create a project</h2>
      <form
        className="form"
        onSubmit={(e) => {
          e.preventDefault();
          create.mutate();
        }}
      >
        <div className="form-fields">
          <FormField
            label="Key"
            help={
              <>
                2 to 10 letters or digits, starting with a letter. It begins every issue's id, such as {(form.key || 'BACK').toUpperCase()}-12, and can't change
                later.
              </>
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
          <FormField label="Name">{(id) => <input id={id} value={form.name} onChange={set('name')} required maxLength={100} />}</FormField>
          <FormField label="Lead">
            {(id) => (
              <select id={id} value={form.lead} onChange={set('lead')}>
                <option value="">Nobody yet</option>
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
          <FormField label="What it's for" className="tw:col-span-full">
            {(id) => <textarea id={id} value={form.description} onChange={set('description')} rows={2} maxLength={5000} />}
          </FormField>
        </div>
        <fieldset className="choice-group column">
          <legend>Its fields, to start with</legend>
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
          <legend>Who sees it</legend>
          <label className="choice">
            <input type="radio" name="visibility" value="open" checked={form.visibility === 'open'} onChange={() => setForm((f) => ({ ...f, visibility: 'open' }))} />
            <span>
              Open
              <small className="field-help">Everyone sees it and works in it.</small>
            </span>
          </label>
          <label className="choice">
            <input type="radio" name="visibility" value="members" checked={form.visibility === 'members'} onChange={() => setForm((f) => ({ ...f, visibility: 'members' }))} />
            <span>
              Members only
              <small className="field-help">Only its lead, the people you add on its page, and administrators see it.</small>
            </span>
          </label>
        </fieldset>
        <div className="cluster">
          <button type="submit" className="primary" disabled={create.isPending}>
            {create.isPending ? 'Creating…' : 'Create the project'}
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
        title="Projects"
        about="Each project has a key that begins its issues' ids, a lead, the fields its issues have, how far triage may go, and its plan's calendar and budget."
      />
      {projects.isLoading ? <Loading what="projects" /> : null}
      {projects.error ? <ErrorNote error={projects.error} /> : null}
      {projects.data ? (
        <section className="card figures-card" aria-label="Projects">
          {projects.data.length ? (
            <Scroll label="Table of projects">
              <table className="figures">
                <thead>
                  <tr>
                    <th scope="col">Key</th>
                    <th scope="col">Project</th>
                    <th scope="col">Lead</th>
                    <th scope="col" className="num">
                      Open
                    </th>
                    <th scope="col">Triage</th>
                    <th scope="col">You</th>
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
                            <span className="chip">members only</span>
                          </>
                        ) : null}
                        {p.archived ? (
                          <>
                            {' '}
                            <Badge tone="idle">archived</Badge>
                          </>
                        ) : null}
                        {p.description ? <span className="item-about">{p.description}</span> : null}
                      </td>
                      <td>
                        <UserWho user={p.lead} small />
                      </td>
                      <td className="num">
                        <span className="of-total">
                          <strong>{p.openIssueCount}</strong> of {p.issueCount}
                        </span>
                      </td>
                      <td>{TRIAGE_WORDS[p.settings.triageMode]}</td>
                      <td>{p.access.via === 'admin' ? 'Administrator' : p.access.roleName}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </Scroll>
          ) : (
            <p className="note">There are no projects yet.{isAdmin ? ' Create the first one below.' : ' An administrator can create one.'}</p>
          )}
        </section>
      ) : null}
      {isAdmin ? <CreateProject /> : null}
    </>
  );
}
