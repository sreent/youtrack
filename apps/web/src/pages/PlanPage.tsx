import type { Project } from '@a4a/shared';
import { Link, Navigate, useLocation, useNavigate, useParams } from 'react-router';
import { useProjects } from '../api/queries';
import { Empty, ErrorNote, Loading, PageHead } from '../components/States';
import { useBaselineChoice } from '../features/plan/Baselines';
import { Costs } from '../features/plan/Costs';
import { dayMonth } from '../features/plan/dates';
import { money, plural } from '../features/plan/format';
import { Resources } from '../features/plan/Resources';
import { Timeline } from '../features/plan/Timeline';
import { t, tr } from '../i18n';
import type { ReactNode } from 'react';

const VIEWS = [
  { id: 'timeline', label: t('page.plan.timeline') },
  { id: 'resources', label: t('page.plan.resources') },
  { id: 'costs', label: t('page.plan.costs') },
] as const;
type View = (typeof VIEWS)[number]['id'];

function planFacts(p: Project): string {
  const plan = p.settings.plan;
  const parts = [plan.startDate ? t('page.plan.starts', { dayMonth: dayMonth(plan.startDate) }) : t('page.plan.noStartDateSet'), plan.budget !== null ? t('page.plan.budget', { money: money(plan.budget, plan.currency) }) : t('page.plan.noBudgetSet')];
  return `${parts.join(', ')} · ${plural(p.openIssueCount, 'open issue')}`;
}

function ChooseProject() {
  const projects = useProjects();
  const live = (projects.data ?? []).filter((p) => !p.archived);
  return (
    <>
      <PageHead title={t('page.plan.plan')} about={t('page.plan.aProjectSTasksOver')} />
      {projects.isLoading ? <Loading what="projects" /> : null}
      {projects.error ? <ErrorNote error={projects.error} /> : null}
      {projects.data && live.length === 0 ? <Empty title={t('page.plan.noProjectsYet')}>{t('page.plan.aPlanBelongsToA')}</Empty> : null}
      {live.length ? (
        <section className="card" aria-labelledby="plan-projects">
          <h2 id="plan-projects">{t('page.plan.chooseAProject')}</h2>
          <ul className="directory">
            {live.map((p) => (
              <li key={p.id}>
                <span className="directory-name">
                  <Link to={`/plan/${p.key}`}>{p.name}</Link>
                  <span className="issue-id">{p.key}</span>
                </span>
                <p className="note">{planFacts(p)}</p>
              </li>
            ))}
          </ul>
        </section>
      ) : null}
    </>
  );
}

function ProjectPlan({ project, view }: { project: Project; view: View }) {
  const navigate = useNavigate();
  const location = useLocation();
  const choice = useBaselineChoice(project.key);
  const crumbs = (
    <>
      <Link to="/plan">{t('page.plan.plan')}</Link>
      <span className="sep" aria-hidden="true">
        /
      </span>
    </>
  );
  return (
    <>
      <PageHead title={project.name} crumbs={crumbs} about={project.description || undefined} />
      <div className="stack">
        {/* Ocean's choice of views: a row of buttons, the chosen one pressed; each view has its own address. */}
        <div className="modes plan-views" role="group" aria-label={t('page.plan.sPlan', { name: project.name })}>
          {VIEWS.map((v) => (
            <button key={v.id} type="button" aria-pressed={view === v.id} onClick={() => navigate({ pathname: `/plan/${project.key}/${v.id}`, search: location.search })}>
              {v.label}
            </button>
          ))}
        </div>
        {/* Keyed by project, so a what-if or a levelling proposal never outlives the plan it was for. */}
        {view === 'timeline' ? <Timeline key={project.key} project={project} choice={choice} /> : null}
        {view === 'resources' ? <Resources key={project.key} project={project} /> : null}
        {view === 'costs' ? <Costs key={project.key} project={project} choice={choice} /> : null}
      </div>
    </>
  );
}

export default function PlanPage() {
  const { project: key, view } = useParams();
  const projects = useProjects();
  if (!key) return <ChooseProject />;
  if (view && !VIEWS.some((v) => v.id === view)) return <Navigate to={`/plan/${key}`} replace />;
  if (projects.isLoading) return <Loading what={t('page.plan.thePlan')} />;
  if (projects.error) return <ErrorNote error={projects.error} />;
  const project = projects.data?.find((p) => p.key.toLowerCase() === key.toLowerCase());
  if (!project) {
    return (
      <>
        <PageHead title={t('page.plan.plan')} crumbs={<Link to="/plan">{t('page.plan.plan')}</Link>} />
        <Empty title={t('page.plan.thereIsNoProject', { key: key })}>{tr('page.plan.chooseAProjectToSee', { t0: (c: ReactNode) => <Link to="/plan">{c}</Link> })}</Empty>
      </>
    );
  }
  if (project.key !== key) return <Navigate to={`/plan/${project.key}${view ? `/${view}` : ''}`} replace />;
  return <ProjectPlan project={project} view={(view as View | undefined) ?? 'timeline'} />;
}
