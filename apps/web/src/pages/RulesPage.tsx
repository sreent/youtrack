import { useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router';
import { useMe, useProjectFields, useProjects } from '../api/queries';
import { ErrorNote, Loading, PageHead } from '../components/States';
import { FormField, Said } from '../features/common/bits';
import { useRules } from '../features/rules/api';
import { RuleCard } from '../features/rules/RuleCard';
import { EXAMPLES, RuleForm, type Draft } from '../features/rules/RuleForm';
import { RuleRuns } from '../features/rules/RuleRuns';

/**
 * A project's workflow rules: each read as a sentence, made and changed with the query and command
 * languages, previewed before they're saved, and what they did. Its managers (administrators
 * among them) change them; anyone who can see the project can see them.
 */
export default function RulesPage() {
  const { project: param } = useParams();
  const navigate = useNavigate();
  const projects = useProjects();
  const me = useMe();
  const key = (param ?? projects.data?.find((p) => !p.archived)?.key ?? projects.data?.[0]?.key ?? '').toUpperCase();
  const project = projects.data?.find((p) => p.key.toUpperCase() === key);
  const fields = useProjectFields(project?.key);
  const rules = useRules(project?.key);
  const [editing, setEditing] = useState<string | null>(null);
  const [start, setStart] = useState<Draft | undefined>(undefined);
  const [formKey, setFormKey] = useState(0);
  const [everywhere, setEverywhere] = useState(false);
  const [said, setSaid] = useState<string | null>(null);

  const scopes = me.data?.auth.scopes ?? [];
  const isAdmin = scopes.includes('admin');
  // As the server decides it (services/access.ts): the project's managers make its rules.
  const manages = project?.access.manage ?? false;

  if (projects.isLoading) return <Loading what="projects" />;
  if (projects.error) return <ErrorNote error={projects.error} />;
  if (!project) {
    return (
      <>
        <PageHead title="Rules" />
        <p className="note">{param ? `There’s no project ${param}, or you can’t see it.` : 'There are no projects yet.'}</p>
      </>
    );
  }

  return (
    <>
      <PageHead
        title="Rules"
        about="Rules change issues on their own, as the workflow agent: when something happens to an issue, or on a schedule. A guard refuses a change that would break it. Each reads as a sentence."
        actions={
          <FormField label="Project" className="inline">
            {(id) => (
              <select
                id={id}
                value={project.key}
                onChange={(e) => {
                  setEditing(null);
                  setSaid(null);
                  navigate(`/rules/${e.target.value}`);
                }}
              >
                {(projects.data ?? []).map((p) => (
                  <option key={p.key} value={p.key}>
                    {p.name}
                  </option>
                ))}
              </select>
            )}
          </FormField>
        }
      />
      {!manages ? (
        <p className="note">{project.key}’s managers make and change its rules. You can see what they do, and preview them.</p>
      ) : null}

      <section className="card" aria-labelledby="rules-title">
        <div className="section-head">
          <h2 id="rules-title">Rules in {project.name}</h2>
          <span className="note">
            Each change they make is in the issue’s history, by the workflow agent. <Link to={`/projects/${project.key}`}>The project</Link>
          </span>
        </div>
        {rules.isLoading ? <Loading what="its rules" /> : null}
        {rules.error ? <ErrorNote error={rules.error} /> : null}
        {rules.data && !rules.data.length ? (
          <p className="note">No rules yet.{manages ? ' Add one below, or start from an example.' : ''}</p>
        ) : null}
        {rules.data?.length ? (
          <ul className="rules">
            {rules.data.map((r) => {
              const canManage = r.project === null ? isAdmin && scopes.includes('write') : manages;
              if (editing === r.id && canManage) {
                return (
                  <li key={r.id} className="card rule">
                    <h3 className="rule-name">Change “{r.name}”</h3>
                    <RuleForm
                      project={r.project}
                      fields={fields.data ?? []}
                      rule={r}
                      onCancel={() => setEditing(null)}
                      onDone={(saved) => {
                        setEditing(null);
                        setSaid(`“${saved.name}” is saved.`);
                      }}
                    />
                  </li>
                );
              }
              return <RuleCard key={r.id} rule={r} canManage={canManage} onEdit={() => setEditing(r.id)} />;
            })}
          </ul>
        ) : null}
        <Said text={said} />
      </section>

      {manages ? (
        <section className="card stack" aria-labelledby="add-rule">
          <h2 id="add-rule">Add a rule</h2>
          <div className="cluster">
            <span className="note">Start from an example:</span>
            {EXAMPLES.map((x) => (
              <button
                key={x.label}
                type="button"
                className="link"
                onClick={() => {
                  setStart(x.draft);
                  setFormKey((k) => k + 1);
                }}
              >
                {x.label}
              </button>
            ))}
          </div>
          {isAdmin ? (
            <FormField label="For" className="inline">
              {(id) => (
                <select id={id} value={everywhere ? '' : project.key} onChange={(e) => setEverywhere(e.target.value === '')}>
                  <option value={project.key}>{project.name} only</option>
                  <option value="">every project</option>
                </select>
              )}
            </FormField>
          ) : null}
          <RuleForm
            key={`${formKey}-${everywhere}`}
            project={everywhere ? null : project.key}
            fields={fields.data ?? []}
            initial={start}
            onDone={(saved) => {
              setStart(undefined);
              setFormKey((k) => k + 1);
              setSaid(`“${saved.name}” is saved. ${saved.kind === 'schedule' ? 'It runs on its schedule.' : 'It acts from the next change.'}`);
            }}
          />
        </section>
      ) : null}

      <section className="card" aria-labelledby="runs-title">
        <div className="section-head">
          <h2 id="runs-title">What rules did</h2>
          <span className="note">The last 30 days, newest first.</span>
        </div>
        <RuleRuns project={project.key} />
      </section>
    </>
  );
}
