import type { Project, TriageMode } from '@a4a/shared';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { Link, useParams } from 'react-router';
import { patch } from '../api/client';
import { keys, useAIStatus, useFields, useProject, useProjectFields, useUsers } from '../api/queries';
import { ago, Badge } from '../components/Badges';
import { ErrorNote, Loading, PageHead } from '../components/States';
import { UserWho } from '../components/Who';
import { errorText, FormField, Said, Scroll } from '../features/common/bits';
import { count, dateRead, money } from '../features/common/format';
import { LadderChoice } from '../features/common/Ladder';
import { useBaselines } from '../features/common/queries';
import { PeopleAndAccess, yourRole } from '../features/projects/PeopleAndAccess';
import { PlanSettings } from '../features/projects/PlanSettings';
import { ProjectFields } from '../features/projects/ProjectFields';
import { TRIAGE_RUNGS, TRIAGE_WORDS } from '../features/projects/triage';
import { HelpdeskMail } from '../features/helpdesk/HelpdeskMail';
import { HelpdeskSettings } from '../features/helpdesk/HelpdeskSettings';
import { ProjectSubscription } from '../features/notifications/Subscriptions';
import { ProjectChannels } from '../features/chat/Chat';

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
      className="form"
      onSubmit={(e) => {
        e.preventDefault();
        save.mutate();
      }}
    >
      <fieldset className="unframed form" disabled={!canEdit || save.isPending}>
        <div className="form-fields">
          <FormField label="Name">
            {(id) => <input id={id} value={form.name} onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))} required maxLength={100} />}
          </FormField>
          <FormField label="Lead">
            {(id) => (
              <select id={id} value={form.lead} onChange={(e) => setForm((f) => ({ ...f, lead: e.target.value }))}>
                <option value="">Nobody</option>
                {(users.data ?? [])
                  .filter((u) => !u.isBot)
                  .map((u) => (
                    <option key={u.id} value={u.login}>
                      {u.name}
                    </option>
                  ))}
              </select>
            )}
          </FormField>
          <FormField label="What it's for" className="tw:col-span-full">
            {(id) => (
              <textarea id={id} value={form.description} onChange={(e) => setForm((f) => ({ ...f, description: e.target.value }))} rows={3} maxLength={5000} />
            )}
          </FormField>
        </div>
        <label className="choice">
          <input type="checkbox" checked={form.archived} onChange={(e) => setForm((f) => ({ ...f, archived: e.target.checked }))} />
          <span>
            Archived
            <small className="field-help">Its issues stay, and can still be found; it leaves the lists of projects people work in.</small>
          </span>
        </label>
      </fieldset>
      {canEdit ? (
        <div className="cluster">
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
        value={save.isPending && save.variables ? save.variables : project.settings.triageMode}
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
    <Scroll label="Table of baselines">
      <table className="figures">
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
                <span className="item-name">{b.name}</span>
                {b.note ? <span className="item-about">{b.note}</span> : null}
              </td>
              <td>
                <time dateTime={b.createdAt}>{ago(b.createdAt)}</time>
                {b.createdBy ? <span className="item-about">by {b.createdBy.name}</span> : null}
              </td>
              <td className="num">{b.taskCount}</td>
              <td>{b.start ? <time dateTime={b.start}>{dateRead(b.start)}</time> : '—'}</td>
              <td>{b.finish ? <time dateTime={b.finish}>{dateRead(b.finish)}</time> : '—'}</td>
              <td className="num">{money(b.plannedCost, currency)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </Scroll>
  );
}

/** One project: its details, how far triage may go, its plan's calendar and budget, its fields and its baselines. */
export default function ProjectPage() {
  const { key = '' } = useParams();
  const project = useProject(key.toUpperCase());
  const projectFields = useProjectFields(key.toUpperCase());
  const allFields = useFields();
  const users = useUsers();
  const ai = useAIStatus();

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
  // Its managers (and administrators) change a project; everyone who sees it sees how it's set up.
  const canEdit = p.access.manage;
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
            {p.visibility === 'members' ? <span className="chip">members only</span> : null}
            {p.archived ? <Badge tone="idle">archived</Badge> : null}
          </>
        }
        about={p.description || undefined}
        meta={
          <>
            <span className="tw:inline-flex tw:items-center tw:gap-2">
              Lead: <UserWho user={p.lead} small />
            </span>
            <span>
              {count(p.openIssueCount, 'open issue')} of {p.issueCount}
            </span>
            <span>Triage: {TRIAGE_WORDS[p.settings.triageMode]}</span>
            {p.settings.helpdesk.enabled ? <span>Help desk: open</span> : null}
            {plan.budget !== null ? <span>Budget: {money(plan.budget, plan.currency)}</span> : null}
          </>
        }
        actions={
          <>
            <Link className="button" to={`/issues?q=${encodeURIComponent(`project: ${p.key} #Unresolved`)}`}>
              Open its issues
            </Link>
            <Link className="button" to={`/plan/${p.key}`}>
              Open its plan
            </Link>
            <Link className="button" to={`/rules/${p.key}`}>
              Open its rules
            </Link>
          </>
        }
      />
      <p className="note">
        {yourRole(p)}
        {!canEdit ? ' Its managers change how it’s set up; you can see it here.' : ''}
      </p>
      <div className="tw:grid tw:grid-cols-[repeat(auto-fit,minmax(min(100%,24rem),1fr))] tw:items-start tw:gap-x-4">
        <section className="card" aria-labelledby="details">
          <h2 id="details">Details</h2>
          <Details project={p} canEdit={canEdit} />
        </section>
        <section className="card" aria-labelledby="triage">
          <h2 id="triage">AI triage</h2>
          <Triage project={p} canEdit={canEdit} aiOn={Boolean(ai.data?.enabled)} />
        </section>
        <section className="card" aria-labelledby="subscription">
          <h2 id="subscription">Your subscription</h2>
          <ProjectSubscription project={p} />
        </section>
      </div>
      <section className="card" aria-labelledby="people">
        <div className="section-head">
          <h2 id="people">People and access</h2>
          <span className="note">{p.visibility === 'members' ? 'Members only' : 'Open to everyone'}</span>
        </div>
        <PeopleAndAccess project={p} />
      </section>
      <section className="card" aria-labelledby="helpdesk">
        <div className="section-head">
          <h2 id="helpdesk">Help desk</h2>
          <span className="note">A public form for people outside the team, and a page for each of their requests.</span>
        </div>
        <HelpdeskSettings project={p} canEdit={canEdit} />
      </section>
      {canEdit ? (
        <section className="card" aria-labelledby="helpdesk-mail">
          <div className="section-head">
            <h2 id="helpdesk-mail">Help desk by email</h2>
            <span className="note">An address people write to, and where their mail comes in.</span>
          </div>
          <HelpdeskMail project={p} />
        </section>
      ) : null}
      <section className="card" aria-labelledby="chat-channels">
        <div className="section-head">
          <h2 id="chat-channels">Chat channels</h2>
          <span className="note">Teams and Slack channels told of its issues</span>
        </div>
        <ProjectChannels project={p} canAdd={p.visibility === 'members' ? canEdit : p.access.write || canEdit} />
      </section>
      <section className="card" aria-labelledby="plan">
        <div className="section-head">
          <h2 id="plan">Plan settings</h2>
          <span className="note">The plan's calendar and its money. People's own hours and rates are under Administration.</span>
        </div>
        <PlanSettings project={p} canEdit={canEdit} />
      </section>
      <section className="card" aria-labelledby="fields">
        <div className="section-head">
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
        <div className="section-head">
          <h2 id="baselines">Baselines</h2>
          <span className="note">The plan as it was agreed, kept to compare with.</span>
        </div>
        <Baselines project={p} />
      </section>
    </>
  );
}
