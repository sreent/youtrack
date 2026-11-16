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
      <FormField label="Name" help="Its button says it, and it reads as a command: “Escalate”.">
        {(id, help) => <input id={id} aria-describedby={help} value={name} onChange={(e) => setName(e.target.value)} maxLength={60} required />}
      </FormField>
      {isAdmin ? (
        <fieldset className="choice-group">
          <legend>It does</legend>
          <label className="choice">
            <input type="radio" name="does" checked={!scripted} onChange={() => setScripted(false)} />
            <span>a command</span>
          </label>
          <label className="choice">
            <input type="radio" name="does" checked={scripted} onChange={() => setScripted(true)} />
            <span>a script, in JavaScript</span>
          </label>
        </fieldset>
      ) : null}
      {scripted ? (
        <ScriptField text={script} onText={setScript} problems={live} label="What it does, in JavaScript" />
      ) : (
        <FormField label="What it does, in the command language" help="As whoever presses it.">
          {(id, help) => <input id={id} aria-describedby={help} className="mono" value={command} onChange={(e) => setCommand(e.target.value)} placeholder="Priority Critical tag escalated" />}
        </FormField>
      )}
      <FormField label="Offered for issues that match" help="Optional: a query. Empty: every issue.">
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
          <button type="button" onClick={onCancel}>
            Cancel
          </button>
        ) : null}
        <button type="submit" className="primary" disabled={save.isPending || !name.trim() || (scripted && live.length > 0)}>
          {save.isPending ? 'Saving…' : action ? 'Save the change' : 'Save the action'}
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
      setSaid({ text: a.enabled ? 'It’s offered again.' : 'It’s off: nobody is offered it.' });
    },
    onError: (e) => setSaid({ text: errorText(e), bad: true }),
  });
  const remove = useMutation({ mutationFn: () => del(`/workflow-actions/${action.id}`), onSuccess: done, onError: (e) => setSaid({ text: errorText(e), bad: true }) });
  return (
    <li className={action.enabled ? 'card rule-card' : 'card rule-card off'}>
      <div className="rule-head">
        <h3 className="rule-name">{action.name}</h3>
        <span className="badges">
          <Badge grammar="changes">changes issues</Badge>
          {action.script ? <Badge>a script</Badge> : null}
          {action.problems.length ? <Badge tone="bad">needs fixing</Badge> : action.enabled ? <Badge tone="good">on</Badge> : <Badge tone="idle">off</Badge>}
        </span>
      </div>
      <p className="rule-sentence">
        <span className="rule-word">When</span> someone runs it{action.condition ? (
          <>
            {' '}
            on an issue that matches <code>{action.condition}</code>
          </>
        ) : null}
        , <span className="rule-word">then</span> {action.script ? 'run its script' : <>apply <code>{action.command}</code></>}, as them.
      </p>
      {action.script ? (
        <details>
          <summary>Its script</summary>
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
            <button type="button" onClick={onEdit}>
              Edit it
            </button>
          ) : null}
          {canChange || action.enabled ? (
            <button type="button" onClick={() => toggle.mutate()} disabled={toggle.isPending}>
              {action.enabled ? 'Turn it off' : 'Turn it back on'}
            </button>
          ) : null}
          <span className="grow" />
          {canChange ? (
            <Confirm small label="Delete it" title={`Delete the action “${action.name}”?`} about="Its button goes, and its name no longer reads as a command." confirm="Delete it" disabled={remove.isPending} onConfirm={() => remove.mutate()} />
          ) : (
            <span className="note">It runs a script, so an administrator changes it.</span>
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
        <h2 id="actions-title">Actions in {projectName}</h2>
        <span className="note">Each is a button on the issues it’s offered for, and a command by its name, for whoever may change them.</span>
      </div>
      {actions.isLoading ? <Loading what="its actions" /> : null}
      {actions.error ? <ErrorNote error={actions.error} /> : null}
      {actions.data && !actions.data.length ? <p className="note">No actions yet.</p> : null}
      {actions.data?.length ? (
        <ul className="rules">
          {actions.data.map((a) =>
            editing === a.id && manages ? (
              <li key={a.id} className="card rule-card">
                <h3 className="rule-name">Change “{a.name}”</h3>
                <ActionForm
                  project={project}
                  action={a}
                  isAdmin={isAdmin}
                  onCancel={() => setEditing(null)}
                  onDone={(saved) => {
                    setEditing(null);
                    setSaid(`“${saved.name}” is saved.`);
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
              setSaid(`“${a.name}” is saved: its button is on the issues it’s offered for.`);
            }}
          />
        ) : (
          <div className="cluster">
            <button type="button" onClick={() => setAdding(true)}>
              <Icon name="plus" />
              Add an action
            </button>
          </div>
        )
      ) : null}
      <Said text={said} />
    </section>
  );
}
