import type { IssueDetail } from '@a4a/shared';
import { useQueryClient } from '@tanstack/react-query';
import { useId, useState } from 'react';
import { keys } from '../../api/queries';
import { Icon } from '../../components/Icon';
import { errorText, Said } from '../common/bits';
import { runAction, runTransition, useIssueWorkflow, workflowKeys } from './api';
import { t } from '../../i18n';

/**
 * Ocean's workflow bar, on the issue page: the moves out of the state the issue is in (its state
 * machine's transitions), each saying where it goes, and the project's actions offered for it. A
 * move that can't be made now can't be pressed, and says why. Nothing for someone who can't change
 * the issue, nor for a project without a machine or an action.
 */
export function WorkflowBar({ issue, canEdit }: { issue: IssueDetail; canEdit: boolean }) {
  const id = useId();
  const qc = useQueryClient();
  const wf = useIssueWorkflow(issue.id, canEdit);
  const [busy, setBusy] = useState<string | null>(null);
  const [said, setSaid] = useState<{ text: string; bad?: boolean } | null>(null);
  const moves = wf.data?.transitions ?? [];
  const actions = wf.data?.actions ?? [];
  if (!canEdit || (!moves.length && !actions.length)) return null;

  const run = async (what: string, fn: () => Promise<IssueDetail>, done: string) => {
    setBusy(what);
    setSaid(null);
    try {
      const updated = await fn();
      qc.setQueryData(keys.issue(issue.id), updated);
      await Promise.all([
        qc.invalidateQueries({ queryKey: ['issues', 'one', issue.id] }),
        qc.invalidateQueries({ queryKey: workflowKeys.issue(issue.id) }),
        qc.invalidateQueries({ queryKey: ['issues'] }),
      ]);
      setSaid({ text: done });
    } catch (e) {
      setSaid({ text: errorText(e), bad: true });
    } finally {
      setBusy(null);
    }
  };

  const blocked = moves.filter((m) => !m.allowed && m.why);
  return (
    <section className="card" aria-labelledby={`${id}-head`}>
      <div className="workflow-bar" role="group" aria-labelledby={`${id}-head`}>
        <p className="label" id={`${id}-head`}>
          {moves.length ? t('workflow.workflowBar.moveItOn') : t('workflow.workflowBar.itsActions')}
        </p>
        {moves.map((m, i) => (
          <button
            key={`${m.field}-${m.name}`}
            type="button"
            className="move"
            disabled={!m.allowed || busy !== null}
            aria-describedby={!m.allowed && m.why ? `${id}-why-${i}` : undefined}
            onClick={() => void run(m.name, () => runTransition(issue.id, m.name, m.field), t('workflow.workflowBar.isNow', { name: m.name, field: m.field, to: m.to }))}
          >
            {busy === m.name ? `${m.name}…` : m.name}
            <Icon name="chevron" />
            {m.to}
          </button>
        ))}
        {actions.map((a) => (
          <button key={a.id} type="button" disabled={busy !== null} onClick={() => void run(a.name, () => runAction(issue.id, a.id), t('workflow.workflowBar.isDone', { name: a.name }))}>
            {busy === a.name ? `${a.name}…` : a.name}
          </button>
        ))}
        {blocked.map((m) => (
          <p className="workflow-why" key={`why-${m.name}`} id={`${id}-why-${moves.indexOf(m)}`}>
            {m.name}: {m.why}
          </p>
        ))}
      </div>
      <Said text={said?.text} tone={said?.bad ? 'bad' : undefined} />
    </section>
  );
}
