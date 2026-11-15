import type { Project } from '@a4a/shared';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { Link, useNavigate } from 'react-router';
import { post } from '../api/client';
import { keys, useMe, useProjects, useUsers } from '../api/queries';
import { Badge } from '../components/Badges';
import { ErrorNote, Loading, PageHead } from '../components/States';
import { UserWho } from '../components/Who';
import { errorText, Scroll } from '../features/common/bits';
import { TRIAGE_WORDS } from '../features/projects/triage';
import '../features/common/pages.css';

const TEMPLATES: { id: 'software' | 'waterfall' | 'blank'; name: string; about: string }[] = [
  { id: 'software', name: 'Software', about: 'State, Priority, Type, Assignee, Subsystem, Fix versions, Estimation and Due date.' },
  { id: 'waterfall', name: 'Waterfall', about: 'The same without Fix versions, with Start date and Fixed cost, for a plan over time and its budget.' },
  { id: 'blank', name: 'Blank', about: 'State and Assignee only. You attach the rest.' },
];


function CreateProject() {
  const qc = useQueryClient();
  const navigate = useNavigate();
  const users = useUsers();
  const [form, setForm] = useState({ key: '', name: '', description: '', lead: '', template: 'software' as 'software' | 'waterfall' | 'blank' });
  const create = useMutation({
    mutationFn: () =>
      post<Project>('/projects', {
        key: form.key.trim().toUpperCase(),
        name: form.name.trim(),
        description: form.description.trim(),
        ...(form.lead ? { lead: form.lead } : {}),
        template: form.template,
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
        className="a4p-form"
        onSubmit={(e) => {
          e.preventDefault();
          create.mutate();
        }}
      >
        <div className="a4p-fields">
          <label className="a4p-field">
            <span>Key</span>
            <input
              value={form.key}
              onChange={set('key')}
              required
              minLength={2}
              maxLength={10}
              pattern="[A-Za-z][A-Za-z0-9]*"
              className="a4p-key-input"
              aria-describedby="key-help"
              autoComplete="off"
            />
            <small id="key-help">2 to 10 letters or digits, starting with a letter. It begins every issue's id, such as {(form.key || 'BACK').toUpperCase()}-12, and can't change later.</small>
          </label>
          <label className="a4p-field">
            <span>Name</span>
            <input value={form.name} onChange={set('name')} required maxLength={100} />
          </label>
          <label className="a4p-field">
            <span>Lead</span>
            <select value={form.lead} onChange={set('lead')}>
              <option value="">Nobody yet</option>
              {(users.data ?? [])
                .filter((u) => !u.isBot && !u.banned)
                .map((u) => (
                  <option key={u.id} value={u.login}>
                    {u.name}
                  </option>
                ))}
            </select>
          </label>
          <label className="a4p-field a4p-wide">
            <span>What it's for</span>
            <textarea value={form.description} onChange={set('description')} rows={2} maxLength={5000} />
          </label>
        </div>
        <fieldset className="a4p-checks a4p-templates">
          <legend>Its fields, to start with</legend>
          {TEMPLATES.map((t) => (
            <label key={t.id} className="a4p-check">
              <input type="radio" name="template" value={t.id} checked={form.template === t.id} onChange={() => setForm((f) => ({ ...f, template: t.id }))} />
              <span>
                {t.name}
                <small>{t.about}</small>
              </span>
            </label>
          ))}
        </fieldset>
        <div className="a4p-actions">
          <button type="submit" className="primary" disabled={create.isPending}>
            {create.isPending ? 'Creating…' : 'Create the project'}
          </button>
        </div>
        {create.error ? (
          <p className="a4-error" role="alert">
            {errorText(create.error)}
          </p>
        ) : null}
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
        <section className="card a4p-flush" aria-label="Projects">
          {projects.data.length ? (
            <Scroll label="Table of projects">
              <table className="figures a4p-projects">
                <thead>
                  <tr>
                    <th scope="col">Key</th>
                    <th scope="col">Project</th>
                    <th scope="col">Lead</th>
                    <th scope="col" className="num">
                      Open
                    </th>
                    <th scope="col">Triage</th>
                  </tr>
                </thead>
                <tbody>
                  {projects.data.map((p) => (
                    <tr key={p.id}>
                      <td>
                        <Link to={`/projects/${p.key}`} className="a4p-key">
                          {p.key}
                        </Link>
                      </td>
                      <td>
                        <Link to={`/projects/${p.key}`} className="a4p-row-title">
                          {p.name}
                        </Link>
                        {p.archived ? (
                          <>
                            {' '}
                            <Badge tone="idle">archived</Badge>
                          </>
                        ) : null}
                        {p.description ? <span className="a4p-row-about">{p.description}</span> : null}
                      </td>
                      <td>
                        <UserWho user={p.lead} small />
                      </td>
                      <td className="num">
                        <span className="a4p-counts">
                          <strong>{p.openIssueCount}</strong> of {p.issueCount}
                        </span>
                      </td>
                      <td>{TRIAGE_WORDS[p.settings.triageMode]}</td>
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
