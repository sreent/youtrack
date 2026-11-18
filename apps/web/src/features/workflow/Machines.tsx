import type { ProjectField, StateMachine, StateTransition, WorkflowProblem } from '@a4a/shared';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { ApiError, del, patch, post } from '../../api/client';
import { Badge } from '../../components/Badges';
import { Icon } from '../../components/Icon';
import { ErrorLine, ErrorNote, Loading } from '../../components/States';
import { errorText, FormField, Said } from '../common/bits';
import { Confirm } from '../common/Confirm';
import { useMachines, workflowKeys } from './api';
import { formatItems, problemSaid, t, t as tx, tr } from '../../i18n';
import type { ReactNode } from 'react';

interface Row {
  name: string;
  from: string;
  to: string;
  condition: string;
  command: string;
}

const rowOf = (t: StateTransition): Row => ({ name: t.name, from: t.from.join(', '), to: t.to, condition: t.condition ?? '', command: t.command ?? '' });
const transitionOf = (r: Row): StateTransition => ({
  name: r.name.trim(),
  from: r.from
    .split(',')
    .map((x) => x.trim())
    .filter(Boolean),
  to: r.to,
  condition: r.condition.trim() || null,
  command: r.command.trim() || null,
});
const EMPTY_ROW: Row = { name: '', from: '', to: '', condition: '', command: '' };

/** A transition in words: "Start work: Submitted, Open → In Progress, if has: Assignee, then tag started". */
function Words({ t }: { t: StateTransition }) {
  return (
    <li>
      <strong>{t.name}</strong>: {formatItems(t.from.map((s) => (s === '*' ? tx('workflow.machines.anyState') : s)))} → {t.to}
      {t.condition ? (
        <>{tr('workflow.machines.ifItMatches', { code: <code>{t.condition}</code> })}</>
      ) : null}
      {t.command ? (
        <>{tr('workflow.machines.then', { code: <code>{t.command}</code> })}</>
      ) : null}
    </li>
  );
}

function problemWords(p: WorkflowProblem): string {
  return `${p.transition !== null && p.transition !== undefined ? t('workflow.machines.transition', { v: p.transition + 1 }) : ''}${problemSaid(p) ?? `${p.message}${p.hint ? `. ${p.hint}` : ''}`}`;
}

/** The form for one machine: which field, and its transitions, a row each. */
function MachineForm({ project, fields, machine, onDone, onCancel }: { project: string; fields: ProjectField[]; machine?: StateMachine; onDone: (m: StateMachine) => void; onCancel?: () => void }) {
  const qc = useQueryClient();
  const states = fields.filter((f) => (f.type === 'state' || f.type === 'enum') && !f.multi);
  const [field, setField] = useState(machine?.field ?? states.find((f) => f.type === 'state')?.name ?? states[0]?.name ?? '');
  const [rows, setRows] = useState<Row[]>(machine ? machine.transitions.map(rowOf) : [{ ...EMPTY_ROW }]);
  const [problems, setProblems] = useState<WorkflowProblem[]>([]);
  const [error, setError] = useState<string | null>(null);
  const values = states.find((f) => f.name === field)?.values.map((v) => v.name) ?? [];
  const set = (i: number, k: keyof Row, v: string) => setRows((rs) => rs.map((r, j) => (j === i ? { ...r, [k]: v } : r)));
  const save = useMutation({
    mutationFn: () => {
      const transitions = rows.filter((r) => r.name.trim() || r.to).map(transitionOf);
      return machine
        ? patch<StateMachine>(`/state-machines/${machine.id}`, { transitions, expectedVersion: machine.version })
        : post<StateMachine>('/state-machines', { project, field, transitions });
    },
    onSuccess: async (m) => {
      await qc.invalidateQueries({ queryKey: workflowKeys.all });
      onDone(m);
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
      {machine ? null : (
        <FormField label={t('workflow.machines.forTheField')} help={t('workflow.machines.aFieldWithOneValue')}>
          {(id, help) => (
            <select id={id} aria-describedby={help} value={field} onChange={(e) => setField(e.target.value)}>
              {states.map((f) => (
                <option key={f.name} value={f.name}>
                  {f.name}
                </option>
              ))}
            </select>
          )}
        </FormField>
      )}
      <ul className="transitions" aria-label={t('workflow.machines.itsTransitions')}>
        {rows.map((r, i) => (
          <li className="transition" key={i}>
            <FormField label={t('workflow.machines.name')} help={t('workflow.machines.itReadsAsACommand')}>
              {(id, help) => <input id={id} aria-describedby={help} value={r.name} onChange={(e) => set(i, 'name', e.target.value)} maxLength={60} placeholder={t('workflow.machines.startWork')} />}
            </FormField>
            <FormField label={t('workflow.machines.from')} help={t('workflow.machines.statesByCommasForAny')}>
              {(id, help) => <input id={id} aria-describedby={help} className="mono" value={r.from} onChange={(e) => set(i, 'from', e.target.value)} placeholder={t('workflow.machines.submittedOpen')} />}
            </FormField>
            <FormField label={t('workflow.machines.to')}>
              {(id) => (
                <select id={id} value={r.to} onChange={(e) => set(i, 'to', e.target.value)}>
                  <option value="">{t('workflow.machines.chooseAState')}</option>
                  {values.map((v) => (
                    <option key={v} value={v}>
                      {v}
                    </option>
                  ))}
                </select>
              )}
            </FormField>
            <FormField label={t('workflow.machines.ifItMatches2')} help={t('workflow.machines.optionalAQueryAsThe')}>
              {(id, help) => <input id={id} aria-describedby={help} className="mono" value={r.condition} onChange={(e) => set(i, 'condition', e.target.value)} placeholder={t('workflow.machines.hasAssignee')} />}
            </FormField>
            <FormField label={t('workflow.machines.andApply')} help={t('workflow.machines.optionalACommandAsWhoever')}>
              {(id, help) => <input id={id} aria-describedby={help} className="mono" value={r.command} onChange={(e) => set(i, 'command', e.target.value)} placeholder="tag started" />}
            </FormField>
            <div className="cluster end">
              <button type="button" className="small" onClick={() => setRows((rs) => rs.filter((_, j) => j !== i))} disabled={rows.length === 1}>{t('workflow.machines.removeThisTransition')}</button>
            </div>
          </li>
        ))}
      </ul>
      <div className="cluster">
        <button type="button" onClick={() => setRows((rs) => [...rs, { ...EMPTY_ROW }])}>{tr('workflow.machines.addATransition', { el: <Icon name="plus" /> })}</button>
      </div>
      {problems.map((p) => (
        <ErrorLine key={`${p.part}-${p.transition ?? ''}-${p.message}`}>{problemWords(p)}</ErrorLine>
      ))}
      {error ? <ErrorLine>{error}</ErrorLine> : null}
      <div className="cluster end">
        {onCancel ? (
          <button type="button" onClick={onCancel}>{t('workflow.machines.cancel')}</button>
        ) : null}
        <button type="submit" className="primary" disabled={save.isPending || !field}>
          {save.isPending ? t('workflow.machines.saving') : machine ? t('workflow.machines.saveTheChange') : t('workflow.machines.saveTheStateMachine')}
        </button>
      </div>
    </form>
  );
}

function MachineCard({ machine, manages, onEdit }: { machine: StateMachine; manages: boolean; onEdit: () => void }) {
  const qc = useQueryClient();
  const [said, setSaid] = useState<{ text: string; bad?: boolean } | null>(null);
  const done = () => void qc.invalidateQueries({ queryKey: workflowKeys.all });
  const toggle = useMutation({
    mutationFn: () => patch<StateMachine>(`/state-machines/${machine.id}`, { enabled: !machine.enabled, expectedVersion: machine.version }),
    onSuccess: (m) => {
      done();
      setSaid({ text: m.enabled ? t('workflow.machines.itSOnChangesTo') : t('workflow.machines.itSOffTheField') });
    },
    onError: (e) => setSaid({ text: errorText(e), bad: true }),
  });
  const remove = useMutation({ mutationFn: () => del(`/state-machines/${machine.id}`), onSuccess: done, onError: (e) => setSaid({ text: errorText(e), bad: true }) });
  return (
    <li className={machine.enabled ? 'card rule-card' : 'card rule-card off'}>
      <div className="rule-head">
        <h3 className="rule-name">{machine.field}</h3>
        <span className="badges">
          <Badge grammar="own">{t('workflow.machines.refusesChanges')}</Badge>
          {machine.problems.length ? <Badge tone="bad">{t('workflow.machines.needsFixing')}</Badge> : machine.enabled ? <Badge tone="good">{t('workflow.machines.on')}</Badge> : <Badge tone="idle">{t('workflow.machines.off')}</Badge>}
        </span>
      </div>
      <p className="rule-sentence">{tr('workflow.machines.whenChangesThenItMust', { t0: (c: ReactNode) => <span className="rule-word">{c}</span>, field: machine.field, t1: (c: ReactNode) => <span className="rule-word">{c}</span> })}</p>
      <ul className="rule-said">
        {machine.transitions.map((t) => (
          <Words key={t.name} t={t} />
        ))}
      </ul>
      {machine.problems.map((p) => (
        <div className="error-note" role="note" key={`${p.part}-${p.transition ?? ''}-${p.message}`}>
          <Icon name="cross" />
          <strong>{problemWords(p)}</strong>
          <p>{t('workflow.machines.itRefusesNothingUntilIt')}</p>
        </div>
      ))}
      {manages ? (
        <div className="cluster">
          <button type="button" onClick={onEdit}>{t('workflow.machines.editIt')}</button>
          <button type="button" onClick={() => toggle.mutate()} disabled={toggle.isPending}>
            {machine.enabled ? t('workflow.machines.turnItOff') : t('workflow.machines.turnItBackOn')}
          </button>
          <span className="grow" />
          <Confirm
            small
            label={t('workflow.machines.deleteIt')}
            title={t('workflow.machines.deleteTheStateMachineFor', { field: machine.field })}
            about={t('workflow.machines.theFieldChangesFreelyFrom')}
            confirm={t('workflow.machines.deleteIt')}
            disabled={remove.isPending}
            onConfirm={() => remove.mutate()}
          />
        </div>
      ) : null}
      <Said text={said?.text} tone={said?.bad ? 'bad' : undefined} />
    </li>
  );
}

/** A project's state machines: each read as its moves, and, for its managers, the form that makes or changes one. */
export function Machines({ project, projectName, fields, manages }: { project: string; projectName: string; fields: ProjectField[]; manages: boolean }) {
  const machines = useMachines(project);
  const [editing, setEditing] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [said, setSaid] = useState<string | null>(null);
  return (
    <section className="card stack" aria-labelledby="machines-title">
      <div className="section-head">
        <h2 id="machines-title">{tr('workflow.machines.stateMachinesIn', { projectName: projectName })}</h2>
        <span className="note">{t('workflow.machines.aChangeToAField')}</span>
      </div>
      {machines.isLoading ? <Loading what="loadingLine.stateMachines" /> : null}
      {machines.error ? <ErrorNote error={machines.error} /> : null}
      {machines.data && !machines.data.length ? <p className="note">{t('workflow.machines.noStateMachineYetIts')}</p> : null}
      {machines.data?.length ? (
        <ul className="rules">
          {machines.data.map((m) =>
            editing === m.id && manages ? (
              <li key={m.id} className="card rule-card">
                <h3 className="rule-name">{tr('workflow.machines.changeSMoves', { field: m.field })}</h3>
                <MachineForm
                  project={project}
                  fields={fields}
                  machine={m}
                  onCancel={() => setEditing(null)}
                  onDone={() => {
                    setEditing(null);
                    setSaid(t('workflow.machines.sMovesAreSaved', { field: m.field }));
                  }}
                />
              </li>
            ) : (
              <MachineCard key={m.id} machine={m} manages={manages} onEdit={() => setEditing(m.id)} />
            ),
          )}
        </ul>
      ) : null}
      {manages ? (
        adding ? (
          <MachineForm
            project={project}
            fields={fields}
            onCancel={() => setAdding(false)}
            onDone={(m) => {
              setAdding(false);
              setSaid(t('workflow.machines.nowGoesByItsMoves', { field: m.field }));
            }}
          />
        ) : (
          <div className="cluster">
            <button type="button" onClick={() => setAdding(true)}>{tr('workflow.machines.addAStateMachine', { el: <Icon name="plus" /> })}</button>
          </div>
        )
      ) : null}
      <Said text={said} />
    </section>
  );
}
