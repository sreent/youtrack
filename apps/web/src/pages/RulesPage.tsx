import { useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router';
import { useMe, useProjectFields, useProjects } from '../api/queries';
import { ErrorNote, Loading, PageHead } from '../components/States';
import { FormField, Said } from '../features/common/bits';
import { useRules } from '../features/rules/api';
import { RuleCard } from '../features/rules/RuleCard';
import { EXAMPLES, RuleForm, type Draft } from '../features/rules/RuleForm';
import { RuleRuns } from '../features/rules/RuleRuns';
import { Actions } from '../features/workflow/Actions';
import { Machines } from '../features/workflow/Machines';
import { t, tr } from '../i18n';
import type { ReactNode } from 'react';

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
  // Calling a webhook sends issues to an address an administrator chose: theirs to set (workflow/rules.ts).
  const canCall = isAdmin && scopes.includes('write');
  // As the server decides it (services/access.ts): the project's managers make its rules.
  const manages = project?.access.manage ?? false;

  if (projects.isLoading) return <Loading what="loadingLine.projects" />;
  if (projects.error) return <ErrorNote error={projects.error} />;
  if (!project) {
    return (
      <>
        <PageHead title={t('page.rules.rules')} />
        <p className="note">{param ? t('page.rules.thereSNoProjectOr', { param: param }) : t('page.rules.thereAreNoProjectsYet')}</p>
      </>
    );
  }

  return (
    <>
      <PageHead
        title={t('page.rules.rules')}
        about={t('page.rules.rulesChangeIssuesOnTheir')}
        actions={
          <FormField label={t('page.rules.project')} className="inline">
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
        <p className="note">{tr('page.rules.sManagersMakeAndChange', { key: project.key })}</p>
      ) : null}

      <section className="card" aria-labelledby="rules-title">
        <div className="section-head">
          <h2 id="rules-title">{tr('page.rules.rulesIn', { name: project.name })}</h2>
          <span className="note">{tr('page.rules.eachChangeTheyMakeIs', { t0: (c: ReactNode) => <Link to={`/projects/${project.key}`}>{c}</Link> })}</span>
        </div>
        {rules.isLoading ? <Loading what="loadingLine.rules" /> : null}
        {rules.error ? <ErrorNote error={rules.error} /> : null}
        {rules.data && !rules.data.length ? (
          <p className="note">{tr('page.rules.noRulesYet', { v: manages ? t('page.rules.addOneBelowOrStart') : '' })}</p>
        ) : null}
        {rules.data?.length ? (
          <ul className="rules">
            {rules.data.map((r) => {
              const canManage = r.project === null ? isAdmin && scopes.includes('write') : manages;
              if (editing === r.id && canManage) {
                return (
                  <li key={r.id} className="card rule-card">
                    <h3 className="rule-name">{tr('page.rules.change', { name: r.name })}</h3>
                    <RuleForm
                      project={r.project}
                      fields={fields.data ?? []}
                      rule={r}
                      canCall={canCall}
                      onCancel={() => setEditing(null)}
                      onDone={(saved) => {
                        setEditing(null);
                        setSaid(t('page.rules.isSaved', { name: saved.name }));
                      }}
                    />
                  </li>
                );
              }
              return <RuleCard key={r.id} rule={r} canManage={canManage} canCall={canCall} onEdit={() => setEditing(r.id)} />;
            })}
          </ul>
        ) : null}
        <Said text={said} />
      </section>

      {manages ? (
        <section className="card stack" aria-labelledby="add-rule">
          <h2 id="add-rule">{t('page.rules.addARule')}</h2>
          <div className="cluster">
            <span className="note">{t('page.rules.startFromAnExample')}</span>
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
            <FormField label={t('page.rules.for')} className="inline">
              {(id) => (
                <select id={id} value={everywhere ? '' : project.key} onChange={(e) => setEverywhere(e.target.value === '')}>
                  <option value={project.key}>{tr('page.rules.only', { name: project.name })}</option>
                  <option value="">{t('page.rules.everyProject')}</option>
                </select>
              )}
            </FormField>
          ) : null}
          <RuleForm
            key={`${formKey}-${everywhere}`}
            project={everywhere ? null : project.key}
            fields={fields.data ?? []}
            initial={start}
            canCall={canCall}
            onDone={(saved) => {
              setStart(undefined);
              setFormKey((k) => k + 1);
              setSaid(t('page.rules.isSaved2', { name: saved.name, v: saved.kind === 'schedule' ? t('page.rules.itRunsOnItsSchedule') : t('page.rules.itActsFromTheNext') }));
            }}
          />
        </section>
      ) : null}

      <Machines project={project.key} projectName={project.name} fields={fields.data ?? []} manages={manages} />
      <Actions project={project.key} projectName={project.name} manages={manages} isAdmin={isAdmin && scopes.includes('write')} />

      <section className="card" aria-labelledby="runs-title">
        <div className="section-head">
          <h2 id="runs-title">{t('page.rules.whatRulesDid')}</h2>
          <span className="note">{t('page.rules.theLast30DaysNewest')}</span>
        </div>
        <RuleRuns project={project.key} />
      </section>
    </>
  );
}
