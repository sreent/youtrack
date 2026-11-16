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
import { WorkTypes } from '../features/projects/WorkTypes';
import { DeskMailboxSettings, SlaSettings } from '../features/helpdesk/Sla';
import { ProjectSubscription } from '../features/notifications/Subscriptions';
import { ProjectChannels } from '../features/chat/Chat';
import { AppWidgets } from '../features/apps/AppWidgets';
import { ProjectApps } from '../features/apps/ProjectApps';
import { t, tr } from '../i18n';
import type { ReactNode } from 'react';

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
      setSaid({ text: t('page.project.theDetailsAreSaved') });
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
          <FormField label={t('page.project.name')}>
            {(id) => <input id={id} value={form.name} onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))} required maxLength={100} />}
          </FormField>
          <FormField label={t('page.project.lead')}>
            {(id) => (
              <select id={id} value={form.lead} onChange={(e) => setForm((f) => ({ ...f, lead: e.target.value }))}>
                <option value="">{t('page.project.nobody')}</option>
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
          <FormField label={t('page.project.whatItSFor')} className="tw:col-span-full">
            {(id) => (
              <textarea id={id} value={form.description} onChange={(e) => setForm((f) => ({ ...f, description: e.target.value }))} rows={3} maxLength={5000} />
            )}
          </FormField>
        </div>
        <label className="choice">
          <input type="checkbox" checked={form.archived} onChange={(e) => setForm((f) => ({ ...f, archived: e.target.checked }))} />
          <span>{tr('page.project.archivedItsIssuesStayAnd', { t0: (c: ReactNode) => <small className="field-help">{c}</small> })}</span>
        </label>
      </fieldset>
      {canEdit ? (
        <div className="cluster">
          <button type="submit" className="primary" disabled={!dirty || save.isPending}>
            {save.isPending ? t('page.project.saving') : t('page.project.saveTheDetails')}
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
            ? t('page.project.triageIsOffHereIt')
            : mode === 'suggest'
              ? t('page.project.triageNowSuggestsForA')
              : t('page.project.triageNowFillsEmptyFields'),
      });
    },
    onError: (e) => setSaid({ text: errorText(e), bad: true }),
  });
  return (
    <>
      <LadderChoice
        legend={t('page.project.howFarTriageMayGo')}
        rungs={TRIAGE_RUNGS}
        value={save.isPending && save.variables ? save.variables : project.settings.triageMode}
        onChange={canEdit && !save.isPending ? (m) => save.mutate(m) : undefined}
        note={
          aiOn
            ? t('page.project.whateverTheRungTriageNever')
            : t('page.project.aiIsOffOnThis')
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
      <p className="note">{tr('page.project.noBaselinesYetSaveOne', { t0: (c: ReactNode) => <Link to={`/plan/${project.key}`}>{c}</Link> })}</p>
    );
  return (
    <Scroll label={t('page.project.tableOfBaselines')}>
      <table className="figures">
        <thead>
          <tr>
            <th scope="col">{t('page.project.baseline')}</th>
            <th scope="col">{t('page.project.saved')}</th>
            <th scope="col" className="num">{t('page.project.tasks')}</th>
            <th scope="col">{t('page.project.from')}</th>
            <th scope="col">{t('page.project.to')}</th>
            <th scope="col" className="num">{t('page.project.plannedCost')}</th>
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
                {b.createdBy ? <span className="item-about">{tr('page.project.by', { name: b.createdBy.name })}</span> : null}
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

  if (project.isLoading) return <Loading what={t('page.project.theProject')} />;
  if (project.error || !project.data)
    return (
      <>
        <PageHead title={t('page.project.project')} crumbs={<Link to="/projects">{t('page.project.projects')}</Link>} />
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
            <Link to="/projects">{t('page.project.projects')}</Link>
            <span className="sep">/</span>
            <span className="issue-id">{p.key}</span>
          </>
        }
        title={p.name}
        badges={
          <>
            <span className="chip mono">{p.key}</span>
            {p.visibility === 'members' ? <span className="chip">{t('page.project.membersOnly')}</span> : null}
            {p.archived ? <Badge tone="idle">{t('page.project.archived')}</Badge> : null}
          </>
        }
        about={p.description || undefined}
        meta={
          <>
            <span className="tw:inline-flex tw:items-center tw:gap-2">{tr('page.project.lead2', { el: <UserWho user={p.lead} small /> })}</span>
            <span>
              {t('page.project.openIssuesOf', { n: p.openIssueCount, of: p.issueCount })}
            </span>
            <span>{tr('page.project.triage', { v: TRIAGE_WORDS[p.settings.triageMode] })}</span>
            {p.settings.helpdesk.enabled ? <span>{t('page.project.helpDeskOpen')}</span> : null}
            {plan.budget !== null ? <span>{tr('page.project.budget', { money: money(plan.budget, plan.currency) })}</span> : null}
          </>
        }
        actions={
          <>
            <Link className="button" to={`/issues?q=${encodeURIComponent(`project: ${p.key} #Unresolved`)}`}>{t('page.project.openItsIssues')}</Link>
            <Link className="button" to={`/plan/${p.key}`}>{t('page.project.openItsPlan')}</Link>
            <Link className="button" to={`/rules/${p.key}`}>{t('page.project.openItsRules')}</Link>
          </>
        }
      />
      <p className="note">
        {yourRole(p)}
        {!canEdit ? t('page.project.itsManagersChangeHowIt') : ''}
      </p>
      <div className="tw:grid tw:grid-cols-[repeat(auto-fit,minmax(min(100%,24rem),1fr))] tw:items-start tw:gap-x-4">
        <section className="card" aria-labelledby="details">
          <h2 id="details">{t('page.project.details')}</h2>
          <Details project={p} canEdit={canEdit} />
        </section>
        <section className="card" aria-labelledby="triage">
          <h2 id="triage">{t('page.project.aiTriage')}</h2>
          <Triage project={p} canEdit={canEdit} aiOn={Boolean(ai.data?.enabled)} />
        </section>
        <section className="card" aria-labelledby="subscription">
          <h2 id="subscription">{t('page.project.yourSubscription')}</h2>
          <ProjectSubscription project={p} />
        </section>
      </div>
      <section className="card" aria-labelledby="people">
        <div className="section-head">
          <h2 id="people">{t('page.project.peopleAndAccess')}</h2>
          <span className="note">{p.visibility === 'members' ? t('page.project.membersOnly2') : t('page.project.openToEveryone')}</span>
        </div>
        <PeopleAndAccess project={p} />
      </section>
      <section className="card" aria-labelledby="helpdesk">
        <div className="section-head">
          <h2 id="helpdesk">{t('page.project.helpDesk')}</h2>
          <span className="note">{t('page.project.aPublicFormForPeople')}</span>
        </div>
        <HelpdeskSettings project={p} canEdit={canEdit} />
      </section>
      <section className="card" aria-labelledby="service-levels">
        <div className="section-head">
          <h2 id="service-levels">{t('page.project.serviceLevels')}</h2>
          <span className="note">{t('page.project.targetsForTheTeamS')}</span>
        </div>
        <SlaSettings project={p} canEdit={canEdit} />
      </section>
      {canEdit ? (
        <section className="card" aria-labelledby="helpdesk-mail">
          <div className="section-head">
            <h2 id="helpdesk-mail">{t('page.project.helpDeskByEmail')}</h2>
            <span className="note">{t('page.project.anAddressPeopleWriteTo')}</span>
          </div>
          <HelpdeskMail project={p} />
          <DeskMailboxSettings project={p} />
        </section>
      ) : null}
      <section className="card" aria-labelledby="chat-channels">
        <div className="section-head">
          <h2 id="chat-channels">{t('page.project.chatChannels')}</h2>
          <span className="note">{t('page.project.teamsAndSlackChannelsTold')}</span>
        </div>
        <ProjectChannels project={p} canAdd={p.visibility === 'members' ? canEdit : p.access.write || canEdit} />
      </section>
      <section className="card" aria-labelledby="plan">
        <div className="section-head">
          <h2 id="plan">{t('page.project.planSettings')}</h2>
          <span className="note">{t('page.project.thePlanSCalendarAnd')}</span>
        </div>
        <PlanSettings project={p} canEdit={canEdit} />
      </section>

      <section className="card" aria-labelledby="work-types">
        <div className="section-head">
          <h2 id="work-types">{t('page.project.workTypes')}</h2>
          <span className="note">{t('page.project.theKindsOfWorkTime')}</span>
        </div>
        <WorkTypes project={p} canEdit={canEdit} />
      </section>
      <section className="card" aria-labelledby="fields">
        <div className="section-head">
          <h2 id="fields">{t('page.project.fields')}</h2>
          <span className="note">{t('page.project.whatItsIssuesHaveValues')}</span>
        </div>
        {projectFields.isLoading || allFields.isLoading ? <Loading what={t('page.project.itsFields')} /> : null}
        {projectFields.error ? <ErrorNote error={projectFields.error} /> : null}
        {projectFields.data && allFields.data ? (
          <ProjectFields projectKey={p.key} fields={projectFields.data} all={allFields.data} users={users.data ?? []} canEdit={canEdit} />
        ) : null}
      </section>
      <section className="card" aria-labelledby="baselines">
        <div className="section-head">
          <h2 id="baselines">{t('page.project.baselines')}</h2>
          <span className="note">{t('page.project.thePlanAsItWas')}</span>
        </div>
        <Baselines project={p} />
      </section>
      {canEdit ? (
        <section className="card" aria-labelledby="project-apps">
          <div className="section-head">
            <h2 id="project-apps">{t('page.project.apps')}</h2>
            <span className="note">{t('page.project.whatAppsAddHereTurn')}</span>
          </div>
          <ProjectApps project={p.key} />
        </section>
      ) : null}
      <AppWidgets at="project-settings" project={p.key} />
    </>
  );
}
