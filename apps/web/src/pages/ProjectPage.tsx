import type { Project, TriageMode } from '@a4a/shared';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { Link, useParams } from 'react-router';
import { patch } from '../api/client';
import { keys, useAIStatus, useFields, useMe, useProject, useProjectFields, useUsers } from '../api/queries';
import { ago, Badge } from '../components/Badges';
import { ErrorNote, Loading, PageHead } from '../components/States';
import { UserWho } from '../components/Who';
import { errorText, Said } from '../features/common/bits';
import { count, dateRead, money } from '../features/common/format';
import { LadderChoice } from '../features/common/Ladder';
import { useBaselines } from '../features/common/queries';
import { PlanSettings } from '../features/projects/PlanSettings';
import { ProjectFields } from '../features/projects/ProjectFields';
import { TRIAGE_RUNGS, TRIAGE_WORDS } from '../features/projects/triage';
import '../features/common/pages.css';

function Details({ project, canEdit }: { project: Project; canEdit: boolean }) {
  const qc = useQueryClient();
  const users = useUsers();
  const initial = { name: project.name, description: project.description, lead: project.lead?.login ?? '', archived: project.archived };
  const [form, setForm] = useState(initial);
  const [said, setSaid] = useState<{ text: string; bad?: boolean } | null>(null);
  const savedKey = JSON.stringify(initial);
  useEffect(() => setForm(JSON.parse(savedKey) as typeof initial), [savedKey]);
  const dirty = JSON.stringify(form) !== savedKey;
  const save = useMutation({
    mutationFn: () =>
      patch<Project>(`/projects/${project.key}`, {
        name: form.name.trim(),
        description: form.description,
        lead: form.lead || null,
        archived: form.archived,
      }),
    onSuccess: (p) => {
      qc.setQueryData(keys.project(p.key), p);
      void qc.invalidateQueries({ queryKey: keys.projects });
      setSaid({ text: 'The details are saved.' });
    },
    onError: (e) => setSaid({ text: errorText(e), bad: true }),
  });
  return (
    <form
      className="a4p-form"
      onSubmit={(e) => {
        e.preventDefault();
        save.mutate();
      }}
    >
      <fieldset className="a4p-bare" disabled={!canEdit || save.isPending}>
        <div className="a4p-fields">
          <label className="a4p-field">
            <span>Name</span>
            <input value={form.name} onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))} required maxLength={100} />
          </label>
          <label className="a4p-field">
            <span>Lead</span>
            <select value={form.lead} onChange={(e) => setForm((f) => ({ ...f, lead: e.target.value }))}>
              <option value="">Nobody</option>
              {(users.data ?? [])
                .filter((u) => !u.isBot)
                .map((u) => (
                  <option key={u.id} value={u.login}>
                    {u.name}
                  </option>
                ))}
            </select>
          </label>
          <label className="a4p-field a4p-wide">
            <span>What it's for</span>
            <textarea value={form.description} onChange={(e) => setForm((f) => ({ ...f, description: e.target.value }))} rows={3} maxLength={5000} />
          </label>
          <label className="a4p-check a4p-wide">
            <input type="checkbox" checked={form.archived} onChange={(e) => setForm((f) => ({ ...f, archived: e.target.checked }))} />
            <span>
              Archived
              <small>Its issues stay, and can still be found; it leaves the lists of projects people work in.</small>
            </span>
          </label>
        </div>
      </fieldset>
      {canEdit ? (
        <div className="a4p-actions">
          <button type="submit" className="primary" disabled={!dirty || save.isPending}>
            {save.isPending ? 'Saving…' : 'Save the details'}
          </button>
          <Said text={said?.text} tone={said?.bad ? 'bad' : undefined} />
        </div>
      ) : null}
    </form>
  );
}

function Triage({ project, canEdit, aiOn }: { project: Project; canEdit: boolean; aiOn: boolean }) {
  const qc = useQueryClient();
  const [said, setSaid] = useState<{ text: string; bad?: boolean } | null>(null);
  const save = useMutation({
    mutationFn: (mode: TriageMode) => patch<Project>(`/projects/${project.key}`, { settings: { triageMode: mode } }),
    onSuccess: (p) => {
      qc.setQueryData(keys.project(p.key), p);
      void qc.invalidateQueries({ queryKey: keys.projects });
      const mode = p.settings.triageMode;
      setSaid({
        text:
          mode === 'off'
            ? 'Triage is off here. It works only when someone asks, on an issue.'
            : mode === 'suggest'
              ? 'Triage now suggests, for a person to apply.'
              : 'Triage now fills empty fields on its own, and says so in each issue’s history.',
      });
    },
    onError: (e) => setSaid({ text: errorText(e), bad: true }),
  });
  return (
    <>
      <LadderChoice
        legend="How far triage may go with new issues"
        rungs={TRIAGE_RUNGS}
        value={project.settings.triageMode}
        onChange={canEdit && !save.isPending ? (m) => save.mutate(m) : undefined}
        note={
          aiOn
            ? 'Whatever the rung, triage never changes a value a person chose, and everything it does is in the issue’s history.'
            : 'AI is off on this server, so triage doesn’t run at any rung. Set ANTHROPIC_API_KEY where the server runs to turn it on.'
        }
      />
      <Said text={said?.text} tone={said?.bad ? 'bad' : undefined} />
    </>
  );
}

function Baselines({ project }: { project: Project }) {
  const baselines = useBaselines(project.key);
  const currency = project.settings.plan.currency;
  if (baselines.isLoading) return <Loading what="baselines" />;
  if (baselines.error) return <ErrorNote error={baselines.error} />;
  if (!baselines.data?.length)
    return (
      <p className="note">
        No baselines yet. Save one from <Link to={`/plan/${project.key}`}>the plan</Link> when it's agreed, to see later how far it moved.
      </p>
    );
  return (
    <div className="a4p-scroll">
      <table className="figures a4p-baselines">
        <thead>
          <tr>
            <th scope="col">Baseline</th>
            <th scope="col">Saved</th>
            <th scope="col" className="num">
              Tasks
            </th>
            <th scope="col">From</th>
            <th scope="col">To</th>
            <th scope="col" className="num">
              Planned cost
            </th>
          </tr>
        </thead>
        <tbody>
          {baselines.data.map((b) => (
            <tr key={b.id}>
              <td>
                <span className="a4p-row-title">{b.name}</span>
                {b.note ? <span className="a4p-row-about">{b.note}</span> : null}
              </td>
              <td>
                <time dateTime={b.createdAt}>{ago(b.createdAt)}</time>
                {b.createdBy ? <span className="a4p-row-about">by {b.createdBy.name}</span> : null}
              </td>
              <td className="num">{b.taskCount}</td>
              <td>{b.start ? <time dateTime={b.start}>{dateRead(b.start)}</time> : '—'}</td>
              <td>{b.finish ? <time dateTime={b.finish}>{dateRead(b.finish)}</time> : '—'}</td>
              <td className="num">{money(b.plannedCost, currency)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** One project: its details, how far triage may go, its plan's calendar and budget, its fields and its baselines. */
export default function ProjectPage() {
  const { key = '' } = useParams();
  const project = useProject(key.toUpperCase());
  const projectFields = useProjectFields(key.toUpperCase());
  const allFields = useFields();
  const users = useUsers();
  const me = useMe();
  const ai = useAIStatus();
  const canEdit = Boolean(me.data?.auth.scopes.includes('admin'));

  if (project.isLoading) return <Loading what="the project" />;
  if (project.error || !project.data)
    return (
      <>
        <PageHead title="Project" crumbs={<Link to="/projects">Projects</Link>} />
        <ErrorNote error={project.error} />
      </>
    );
  const p = project.data;
  const plan = p.settings.plan;
  return (
    <>
      <PageHead
        crumbs={
          <>
            <Link to="/projects">Projects</Link>
            <span className="sep">/</span>
            <span className="issue-id">{p.key}</span>
          </>
        }
        title={p.name}
        badges={
          <>
            <span className="chip mono">{p.key}</span>
            {p.archived ? <Badge tone="idle">archived</Badge> : null}
          </>
        }
        about={p.description || undefined}
        meta={
          <>
            <span className="a4p-meta-who">
              Lead: <UserWho user={p.lead} small />
            </span>
            <span>
              {count(p.openIssueCount, 'open issue')} of {p.issueCount}
            </span>
            <span>Triage: {TRIAGE_WORDS[p.settings.triageMode]}</span>
            {plan.budget !== null ? <span>Budget: {money(plan.budget, plan.currency)}</span> : null}
          </>
        }
        actions={
          <>
            <Link className="button" to={`/issues?query=${encodeURIComponent(`project: ${p.key} #Unresolved`)}`}>
              Open its issues
            </Link>
            <Link className="button" to={`/plan/${p.key}`}>
              Open its plan
            </Link>
          </>
        }
      />
      {!canEdit ? <p className="note">Only administrators can change a project. You can see how it's set up.</p> : null}
      <div className="a4p-two-col">
        <section className="card" aria-labelledby="details">
          <h2 id="details">Details</h2>
          <Details project={p} canEdit={canEdit} />
        </section>
        <section className="card" aria-labelledby="triage">
          <h2 id="triage">AI triage</h2>
          <Triage project={p} canEdit={canEdit} aiOn={Boolean(ai.data?.enabled)} />
        </section>
      </div>
      <section className="card" aria-labelledby="plan">
        <div className="a4p-section-head">
          <h2 id="plan">Plan settings</h2>
          <span className="note">The plan's calendar and its money. People's own hours and rates are under Administration.</span>
        </div>
        <PlanSettings project={p} canEdit={canEdit} />
      </section>
      <section className="card" aria-labelledby="fields">
        <div className="a4p-section-head">
          <h2 id="fields">Fields</h2>
          <span className="note">What its issues have. Values and new fields are on the Fields page.</span>
        </div>
        {projectFields.isLoading || allFields.isLoading ? <Loading what="its fields" /> : null}
        {projectFields.error ? <ErrorNote error={projectFields.error} /> : null}
        {projectFields.data && allFields.data ? (
          <ProjectFields projectKey={p.key} fields={projectFields.data} all={allFields.data} users={users.data ?? []} canEdit={canEdit} />
        ) : null}
      </section>
      <section className="card" aria-labelledby="baselines">
        <div className="a4p-section-head">
          <h2 id="baselines">Baselines</h2>
          <span className="note">The plan as it was agreed, kept to compare with.</span>
        </div>
        <Baselines project={p} />
      </section>
    </>
  );
}
