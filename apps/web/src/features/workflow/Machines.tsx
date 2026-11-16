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
      <strong>{t.name}</strong>: {t.from.join(', ').replace('*', 'any state')} → {t.to}
      {t.condition ? (
        <>
          , if it matches <code>{t.condition}</code>
        </>
      ) : null}
      {t.command ? (
        <>
          , then <code>{t.command}</code>
        </>
      ) : null}
    </li>
  );
}

function problemWords(p: WorkflowProblem): string {
  return `${p.transition !== null && p.transition !== undefined ? `Transition ${p.transition + 1}: ` : ''}${p.message}${p.hint ? `. ${p.hint}` : ''}`;
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
        <FormField label="For the field" help="A field with one value from a list, such as State.">
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
      <ul className="transitions" aria-label="Its transitions">
        {rows.map((r, i) => (
          <li className="transition" key={i}>
            <FormField label="Name" help="It reads as a command too.">
              {(id, help) => <input id={id} aria-describedby={help} value={r.name} onChange={(e) => set(i, 'name', e.target.value)} maxLength={60} placeholder="Start work" />}
            </FormField>
            <FormField label="From" help="States, by commas; * for any.">
              {(id, help) => <input id={id} aria-describedby={help} className="mono" value={r.from} onChange={(e) => set(i, 'from', e.target.value)} placeholder="Submitted, Open" />}
            </FormField>
            <FormField label="To">
              {(id) => (
                <select id={id} value={r.to} onChange={(e) => set(i, 'to', e.target.value)}>
                  <option value="">choose a state</option>
                  {values.map((v) => (
                    <option key={v} value={v}>
                      {v}
                    </option>
                  ))}
                </select>
              )}
            </FormField>
            <FormField label="If it matches" help="Optional: a query, as the issue is before the move.">
              {(id, help) => <input id={id} aria-describedby={help} className="mono" value={r.condition} onChange={(e) => set(i, 'condition', e.target.value)} placeholder="has: Assignee" />}
            </FormField>
            <FormField label="And apply" help="Optional: a command, as whoever moves it.">
              {(id, help) => <input id={id} aria-describedby={help} className="mono" value={r.command} onChange={(e) => set(i, 'command', e.target.value)} placeholder="tag started" />}
            </FormField>
            <div className="cluster end">
              <button type="button" className="small" onClick={() => setRows((rs) => rs.filter((_, j) => j !== i))} disabled={rows.length === 1}>
                Remove this transition
              </button>
            </div>
          </li>
        ))}
      </ul>
      <div className="cluster">
        <button type="button" onClick={() => setRows((rs) => [...rs, { ...EMPTY_ROW }])}>
          <Icon name="plus" />
          Add a transition
        </button>
      </div>
      {problems.map((p) => (
        <ErrorLine key={`${p.part}-${p.transition ?? ''}-${p.message}`}>{problemWords(p)}</ErrorLine>
      ))}
      {error ? <ErrorLine>{error}</ErrorLine> : null}
      <div className="cluster end">
        {onCancel ? (
          <button type="button" onClick={onCancel}>
            Cancel
          </button>
        ) : null}
        <button type="submit" className="primary" disabled={save.isPending || !field}>
          {save.isPending ? 'Saving…' : machine ? 'Save the change' : 'Save the state machine'}
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
      setSaid({ text: m.enabled ? 'It’s on: changes to the field go by its transitions.' : 'It’s off: the field changes freely.' });
    },
    onError: (e) => setSaid({ text: errorText(e), bad: true }),
  });
  const remove = useMutation({ mutationFn: () => del(`/state-machines/${machine.id}`), onSuccess: done, onError: (e) => setSaid({ text: errorText(e), bad: true }) });
  return (
    <li className={machine.enabled ? 'card rule-card' : 'card rule-card off'}>
      <div className="rule-head">
        <h3 className="rule-name">{machine.field}</h3>
        <span className="badges">
          <Badge grammar="own">refuses changes</Badge>
          {machine.problems.length ? <Badge tone="bad">needs fixing</Badge> : machine.enabled ? <Badge tone="good">on</Badge> : <Badge tone="idle">off</Badge>}
        </span>
      </div>
      <p className="rule-sentence">
        <span className="rule-word">When</span> {machine.field} changes, <span className="rule-word">then</span> it must be one of these moves, or it is refused:
      </p>
      <ul className="rule-said">
        {machine.transitions.map((t) => (
          <Words key={t.name} t={t} />
        ))}
      </ul>
      {machine.problems.map((p) => (
        <div className="error-note" role="note" key={`${p.part}-${p.transition ?? ''}-${p.message}`}>
          <Icon name="cross" />
          <strong>{problemWords(p)}</strong>
          <p>It refuses nothing until it’s fixed.</p>
        </div>
      ))}
      {manages ? (
        <div className="cluster">
          <button type="button" onClick={onEdit}>
            Edit it
          </button>
          <button type="button" onClick={() => toggle.mutate()} disabled={toggle.isPending}>
            {machine.enabled ? 'Turn it off' : 'Turn it back on'}
          </button>
          <span className="grow" />
          <Confirm
            small
            label="Delete it"
            title={`Delete the state machine for ${machine.field}?`}
            about="The field changes freely from then on. Issues stay where they are."
            confirm="Delete it"
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
        <h2 id="machines-title">State machines in {projectName}</h2>
        <span className="note">A change to a field with one must be one of its moves, however it’s made. The issue page offers the moves as buttons.</span>
      </div>
      {machines.isLoading ? <Loading what="its state machines" /> : null}
      {machines.error ? <ErrorNote error={machines.error} /> : null}
      {machines.data && !machines.data.length ? <p className="note">No state machine yet: its fields change freely.</p> : null}
      {machines.data?.length ? (
        <ul className="rules">
          {machines.data.map((m) =>
            editing === m.id && manages ? (
              <li key={m.id} className="card rule-card">
                <h3 className="rule-name">Change {m.field}’s moves</h3>
                <MachineForm
                  project={project}
                  fields={fields}
                  machine={m}
                  onCancel={() => setEditing(null)}
                  onDone={() => {
                    setEditing(null);
                    setSaid(`${m.field}’s moves are saved.`);
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
              setSaid(`${m.field} now goes by its moves.`);
            }}
          />
        ) : (
          <div className="cluster">
            <button type="button" onClick={() => setAdding(true)}>
              <Icon name="plus" />
              Add a state machine
            </button>
          </div>
        )
      ) : null}
      <Said text={said} />
    </section>
  );
}
