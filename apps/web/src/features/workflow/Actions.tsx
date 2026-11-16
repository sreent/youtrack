import type { WorkflowAction, WorkflowProblem } from '@a4a/shared';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { ApiError, del, patch, post } from '../../api/client';
import { Badge } from '../../components/Badges';
import { Icon } from '../../components/Icon';
import { ErrorLine, ErrorNote, Loading } from '../../components/States';
import { errorText, FormField, Said } from '../common/bits';
import { Confirm } from '../common/Confirm';
import { useActions, workflowKeys } from './api';
import { ScriptField, useScriptProblems } from './ScriptField';
import { t, tr } from '../../i18n';
import type { ReactNode } from 'react';

function ActionForm({ project, action, isAdmin, onDone, onCancel }: { project: string; action?: WorkflowAction; isAdmin: boolean; onDone: (a: WorkflowAction) => void; onCancel?: () => void }) {
  const qc = useQueryClient();
  const [name, setName] = useState(action?.name ?? '');
  const [scripted, setScripted] = useState(Boolean(action?.script));
  const [command, setCommand] = useState(action?.command ?? '');
  const [script, setScript] = useState(action?.script ?? "// The issue is `issue`; apply(command[, issueId]), comment(text), refuse(why).\nfor (const t of issue.subtasks) if (!t.resolved) apply('State Done', t.id);\n");
  const [condition, setCondition] = useState(action?.condition ?? '');
  const [problems, setProblems] = useState<WorkflowProblem[]>([]);
  const [error, setError] = useState<string | null>(null);
  const live = useScriptProblems(project, script, scripted);
  const save = useMutation({
    mutationFn: () => {
      const body = { name, command: scripted ? '' : command, script: scripted ? script : null, condition };
      return action ? patch<WorkflowAction>(`/workflow-actions/${action.id}`, { ...body, expectedVersion: action.version }) : post<WorkflowAction>('/workflow-actions', { project, ...body });
    },
    onSuccess: async (a) => {
      await qc.invalidateQueries({ queryKey: workflowKeys.all });
      onDone(a);
    },
    onError: (e) => {
      const ps = e instanceof ApiError ? ((e.details as { problems?: WorkflowProblem[] } | undefined)?.problems ?? []) : [];
      setProblems(ps);
      setError(ps.length ? null : errorText(e));
    },
  });
  return (
    <form
      className="form stack"
      onSubmit={(e) => {
        e.preventDefault();
        setProblems([]);
        setError(null);
        save.mutate();
      }}
    >
      <FormField label={t('workflow.actions.name')} help={t('workflow.actions.itsButtonSaysItAnd')}>
        {(id, help) => <input id={id} aria-describedby={help} value={name} onChange={(e) => setName(e.target.value)} maxLength={60} required />}
      </FormField>
      {isAdmin ? (
        <fieldset className="choice-group">
          <legend>{t('workflow.actions.itDoes')}</legend>
          <label className="choice">
            <input type="radio" name="does" checked={!scripted} onChange={() => setScripted(false)} />
            <span>{t('workflow.actions.aCommand')}</span>
          </label>
          <label className="choice">
            <input type="radio" name="does" checked={scripted} onChange={() => setScripted(true)} />
            <span>{t('workflow.actions.aScriptInJavascript')}</span>
          </label>
        </fieldset>
      ) : null}
      {scripted ? (
        <ScriptField text={script} onText={setScript} problems={live} label={t('workflow.actions.whatItDoesInJavascript')} />
      ) : (
        <FormField label={t('workflow.actions.whatItDoesInThe')} help={t('workflow.actions.asWhoeverPressesIt')}>
          {(id, help) => <input id={id} aria-describedby={help} className="mono" value={command} onChange={(e) => setCommand(e.target.value)} placeholder={t('workflow.actions.priorityCriticalTagEscalated')} />}
        </FormField>
      )}
      <FormField label={t('workflow.actions.offeredForIssuesThatMatch')} help={t('workflow.actions.optionalAQueryEmptyEvery')}>
        {(id, help) => <input id={id} aria-describedby={help} className="mono" value={condition} onChange={(e) => setCondition(e.target.value)} placeholder="#Unresolved" />}
      </FormField>
      {problems.map((p) => (
        <ErrorLine key={`${p.part}-${p.message}`}>
          {p.message}
          {p.hint ? `. ${p.hint}` : ''}
        </ErrorLine>
      ))}
      {error ? <ErrorLine>{error}</ErrorLine> : null}
      <div className="cluster end">
        {onCancel ? (
          <button type="button" onClick={onCancel}>{t('workflow.actions.cancel')}</button>
        ) : null}
        <button type="submit" className="primary" disabled={save.isPending || !name.trim() || (scripted && live.length > 0)}>
          {save.isPending ? t('workflow.actions.saving') : action ? t('workflow.actions.saveTheChange') : t('workflow.actions.saveTheAction')}
        </button>
      </div>
    </form>
  );
}

function ActionCard({ action, manages, isAdmin, onEdit }: { action: WorkflowAction; manages: boolean; isAdmin: boolean; onEdit: () => void }) {
  const qc = useQueryClient();
  const [said, setSaid] = useState<{ text: string; bad?: boolean } | null>(null);
  const done = () => void qc.invalidateQueries({ queryKey: workflowKeys.all });
  // A scripted action is an administrator's to change; its project's managers can still turn it off.
  const canChange = manages && (!action.script || isAdmin);
  const toggle = useMutation({
    mutationFn: () => patch<WorkflowAction>(`/workflow-actions/${action.id}`, { enabled: !action.enabled, expectedVersion: action.version }),
    onSuccess: (a) => {
      done();
      setSaid({ text: a.enabled ? t('workflow.actions.itSOfferedAgain') : t('workflow.actions.itSOffNobodyIs') });
    },
    onError: (e) => setSaid({ text: errorText(e), bad: true }),
  });
  const remove = useMutation({ mutationFn: () => del(`/workflow-actions/${action.id}`), onSuccess: done, onError: (e) => setSaid({ text: errorText(e), bad: true }) });
  return (
    <li className={action.enabled ? 'card rule-card' : 'card rule-card off'}>
      <div className="rule-head">
        <h3 className="rule-name">{action.name}</h3>
        <span className="badges">
          <Badge grammar="changes">{t('workflow.actions.changesIssues')}</Badge>
          {action.script ? <Badge>{t('workflow.actions.aScript')}</Badge> : null}
          {action.problems.length ? <Badge tone="bad">{t('workflow.actions.needsFixing')}</Badge> : action.enabled ? <Badge tone="good">{t('workflow.actions.on')}</Badge> : <Badge tone="idle">{t('workflow.actions.off')}</Badge>}
        </span>
      </div>
      <p className="rule-sentence">{tr('workflow.actions.whenSomeoneRunsItThen', { t0: (c: ReactNode) => <span className="rule-word">{c}</span>, v: action.condition ? (
          <>{tr('workflow.actions.onAnIssueThatMatches', { code: <code>{action.condition}</code> })}</>
        ) : null, t1: (c: ReactNode) => <span className="rule-word">{c}</span>, v2: action.script ? t('workflow.actions.runItsScript') : <>{tr('workflow.actions.apply', { code: <code>{action.command}</code> })}</> })}</p>
      {action.script ? (
        <details>
          <summary>{t('workflow.actions.itsScript')}</summary>
          <pre className="script-log">{action.script}</pre>
        </details>
      ) : null}
      {action.problems.map((p) => (
        <div className="error-note" role="note" key={`${p.part}-${p.message}`}>
          <Icon name="cross" />
          <strong>{p.message}</strong>
          {p.hint ? <p>{p.hint}</p> : null}
        </div>
      ))}
      {manages ? (
        <div className="cluster">
          {canChange ? (
            <button type="button" onClick={onEdit}>{t('workflow.actions.editIt')}</button>
          ) : null}
          {canChange || action.enabled ? (
            <button type="button" onClick={() => toggle.mutate()} disabled={toggle.isPending}>
              {action.enabled ? t('workflow.actions.turnItOff') : t('workflow.actions.turnItBackOn')}
            </button>
          ) : null}
          <span className="grow" />
          {canChange ? (
            <Confirm small label={t('workflow.actions.deleteIt')} title={t('workflow.actions.deleteTheAction', { name: action.name })} about={t('workflow.actions.itsButtonGoesAndIts')} confirm={t('workflow.actions.deleteIt')} disabled={remove.isPending} onConfirm={() => remove.mutate()} />
          ) : (
            <span className="note">{t('workflow.actions.itRunsAScriptSo')}</span>
          )}
        </div>
      ) : null}
      <Said text={said?.text} tone={said?.bad ? 'bad' : undefined} />
    </li>
  );
}

/** A project's custom actions: buttons on its issues, and commands by name, for whoever may change them. */
export function Actions({ project, projectName, manages, isAdmin }: { project: string; projectName: string; manages: boolean; isAdmin: boolean }) {
  const actions = useActions(project);
  const [editing, setEditing] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [said, setSaid] = useState<string | null>(null);
  return (
    <section className="card stack" aria-labelledby="actions-title">
      <div className="section-head">
        <h2 id="actions-title">{tr('workflow.actions.actionsIn', { projectName: projectName })}</h2>
        <span className="note">{t('workflow.actions.eachIsAButtonOn')}</span>
      </div>
      {actions.isLoading ? <Loading what={t('workflow.actions.itsActions')} /> : null}
      {actions.error ? <ErrorNote error={actions.error} /> : null}
      {actions.data && !actions.data.length ? <p className="note">{t('workflow.actions.noActionsYet')}</p> : null}
      {actions.data?.length ? (
        <ul className="rules">
          {actions.data.map((a) =>
            editing === a.id && manages ? (
              <li key={a.id} className="card rule-card">
                <h3 className="rule-name">{tr('workflow.actions.change', { name: a.name })}</h3>
                <ActionForm
                  project={project}
                  action={a}
                  isAdmin={isAdmin}
                  onCancel={() => setEditing(null)}
                  onDone={(saved) => {
                    setEditing(null);
                    setSaid(t('workflow.actions.isSaved', { name: saved.name }));
                  }}
                />
              </li>
            ) : (
              <ActionCard key={a.id} action={a} manages={manages} isAdmin={isAdmin} onEdit={() => setEditing(a.id)} />
            ),
          )}
        </ul>
      ) : null}
      {manages ? (
        adding ? (
          <ActionForm
            project={project}
            isAdmin={isAdmin}
            onCancel={() => setAdding(false)}
            onDone={(a) => {
              setAdding(false);
              setSaid(t('workflow.actions.isSavedItsButtonIs', { name: a.name }));
            }}
          />
        ) : (
          <div className="cluster">
            <button type="button" onClick={() => setAdding(true)}>{tr('workflow.actions.addAnAction', { el: <Icon name="plus" /> })}</button>
          </div>
        )
      ) : null}
      <Said text={said} />
    </section>
  );
}
