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
import '../features/plan/plan.css';

const VIEWS = [
  { id: 'timeline', label: 'Timeline' },
  { id: 'resources', label: 'Resources' },
  { id: 'costs', label: 'Costs' },
] as const;
type View = (typeof VIEWS)[number]['id'];

function planFacts(p: Project): string {
  const plan = p.settings.plan;
  const parts = [plan.startDate ? `Starts ${dayMonth(plan.startDate)}` : 'No start date set', plan.budget !== null ? `budget ${money(plan.budget, plan.currency)}` : 'no budget set'];
  return `${parts.join(', ')} · ${plural(p.openIssueCount, 'open issue')}`;
}

function ChooseProject() {
  const projects = useProjects();
  const live = (projects.data ?? []).filter((p) => !p.archived);
  return (
    <>
      <PageHead title="Plan" about="A project's tasks over time, who's booked when, and what it costs, drawn from its issues: their estimates, start and due dates, assignees, subtasks and what each depends on." />
      {projects.isLoading ? <Loading what="projects" /> : null}
      {projects.error ? <ErrorNote error={projects.error} /> : null}
      {projects.data && live.length === 0 ? <Empty title="No projects yet">A plan belongs to a project. Make a project, then its plan shows here.</Empty> : null}
      {live.length ? (
        <section className="card" aria-labelledby="plan-projects">
          <h2 id="plan-projects">Choose a project</h2>
          <ul className="a4-plan-projects">
            {live.map((p) => (
              <li key={p.id}>
                <span className="a4-row">
                  <Link to={`/plan/${p.key}`}>
                    <strong>{p.name}</strong>
                  </Link>
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
      <Link to="/plan">Plan</Link>
      <span className="sep" aria-hidden="true">
        /
      </span>
    </>
  );
  return (
    <>
      <PageHead title={project.name} crumbs={crumbs} about={project.description || undefined} />
      <div className="a4-stack">
        {/* Ocean's choice of views: a row of buttons, the chosen one pressed; each view has its own address. */}
        <div className="modes a4-plan-views" role="group" aria-label={`${project.name}'s plan`}>
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
  if (projects.isLoading) return <Loading what="the plan" />;
  if (projects.error) return <ErrorNote error={projects.error} />;
  const project = projects.data?.find((p) => p.key.toLowerCase() === key.toLowerCase());
  if (!project) {
    return (
      <>
        <PageHead title="Plan" crumbs={<Link to="/plan">Plan</Link>} />
        <Empty title={`There is no project ${key}`}>
          <Link to="/plan">Choose a project</Link> to see its plan.
        </Empty>
      </>
    );
  }
  if (project.key !== key) return <Navigate to={`/plan/${project.key}${view ? `/${view}` : ''}`} replace />;
  return <ProjectPlan project={project} view={(view as View | undefined) ?? 'timeline'} />;
}
