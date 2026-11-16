import type { Field, FieldType, FieldValue, Tone } from '@a4a/shared';
import { FIELD_TYPES } from '@a4a/shared/constants';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { useSearchParams } from 'react-router';
import { del, patch, post } from '../api/client';
import { keys, useFields, useProjects } from '../api/queries';
import { Badge } from '../components/Badges';
import { Icon } from '../components/Icon';
import { ErrorNote, Loading, PageHead } from '../components/States';
import { AdminOnly, errorText, FormField, Said } from '../features/common/bits';
import { Confirm } from '../features/common/Confirm';
import { count } from '../features/common/format';
import { TYPE_WORDS } from '../features/projects/ProjectFields';

const OPTION_TYPES: FieldType[] = ['enum', 'state', 'version'];
const MULTI_TYPES: FieldType[] = ['enum', 'user', 'version'];

const TONES: { tone: Tone | null; word: string }[] = [
  { tone: null, word: 'A plain fact' },
  { tone: 'good', word: 'Going well' },
  { tone: 'warn', word: 'Waiting on someone' },
  { tone: 'bad', word: 'Failed or late' },
  { tone: 'idle', word: 'Not needed' },
];

function ToneSelect({ id, value, onChange, label }: { id?: string; value: Tone | null; onChange: (t: Tone | null) => void; label?: string }) {
  return (
    <select id={id} value={value ?? ''} onChange={(e) => onChange((e.target.value || null) as Tone | null)} aria-label={label}>
      {TONES.map((t) => (
        <option key={t.tone ?? 'none'} value={t.tone ?? ''}>
          {t.word}
        </option>
      ))}
    </select>
  );
}

function ValueRow({
  field,
  value,
  projects,
  first,
  last,
  onMove,
}: {
  field: Field;
  value: FieldValue;
  projects: Map<string, string>;
  first: boolean;
  last: boolean;
  onMove: (dir: -1 | 1) => void;
}) {
  const qc = useQueryClient();
  const initial = { name: value.name, tone: value.tone, isResolved: value.isResolved, archived: value.archived };
  const [form, setForm] = useState(initial);
  const [said, setSaid] = useState<{ text: string; bad?: boolean } | null>(null);
  const savedKey = JSON.stringify(initial);
  useEffect(() => setForm(JSON.parse(savedKey) as typeof initial), [savedKey]);
  const dirty = JSON.stringify(form) !== savedKey;
  const save = useMutation({
    mutationFn: () => patch<FieldValue>(`/fields/${field.id}/values/${value.id}`, { ...form, name: form.name.trim() }),
    onSuccess: () => {
      setSaid({ text: 'Saved.' });
      void qc.invalidateQueries({ queryKey: keys.fields });
      void qc.invalidateQueries({ queryKey: ['projects'] });
    },
    onError: (e) => setSaid({ text: errorText(e), bad: true }),
  });
  const remove = useMutation({
    mutationFn: () => del(`/fields/${field.id}/values/${value.id}`),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: keys.fields });
      void qc.invalidateQueries({ queryKey: ['projects'] });
    },
    onError: (e) => setSaid({ text: errorText(e), bad: true }),
  });
  return (
    <li className={value.archived ? 'value-row dimmed' : 'value-row'}>
      <span className="value-order">
        <button type="button" className="round" aria-label={`Move ${value.name} up`} disabled={first} onClick={() => onMove(-1)}>
          <Icon name="chevron" className="up" />
        </button>
        <button type="button" className="round" aria-label={`Move ${value.name} down`} disabled={last} onClick={() => onMove(1)}>
          <Icon name="chevron" />
        </button>
      </span>
      <input
        className="value-name"
        value={form.name}
        onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))}
        aria-label={`Name of ${value.name}`}
        maxLength={80}
      />
      <span className="value-tone">
        <ToneSelect value={form.tone} onChange={(tone) => setForm((f) => ({ ...f, tone }))} label={`How ${value.name} shows`} />
        <Badge tone={form.tone}>{form.name || value.name}</Badge>
      </span>
      <span className="value-more">
        {field.type === 'state' ? (
          <label className="choice">
            <input type="checkbox" checked={form.isResolved} onChange={(e) => setForm((f) => ({ ...f, isResolved: e.target.checked }))} />
            <span>Resolves</span>
          </label>
        ) : null}
        <label className="choice">
          <input type="checkbox" checked={form.archived} onChange={(e) => setForm((f) => ({ ...f, archived: e.target.checked }))} />
          <span>Archived</span>
        </label>
        {value.projectId ? (
          <span className="chip mono" title="Only in this project">
            {projects.get(value.projectId) ?? 'one project'} only
          </span>
        ) : null}
        <span className="cluster">
          <button type="button" className="small" disabled={!dirty || !form.name.trim() || save.isPending} onClick={() => save.mutate()}>
            {save.isPending ? 'Saving…' : 'Save'}
          </button>
          <Confirm
            small
            label="Delete"
            title={`Delete the value ${value.name} of ${field.name}?`}
            about="Nobody can bring it back. a4a only deletes a value no issue has; archive it instead to keep it on the issues that have it."
            confirm="Delete it"
            disabled={remove.isPending}
            onConfirm={() => remove.mutate()}
          />
        </span>
      </span>
      <Said text={said?.text} tone={said?.bad ? 'bad' : undefined} />
    </li>
  );
}

function AddValue({ field, projects }: { field: Field; projects: { key: string; name: string }[] }) {
  const qc = useQueryClient();
  const [form, setForm] = useState({ name: '', tone: null as Tone | null, isResolved: false, project: '' });
  const [said, setSaid] = useState<{ text: string; bad?: boolean } | null>(null);
  const add = useMutation({
    mutationFn: () =>
      post<FieldValue>(`/fields/${field.id}/values`, {
        name: form.name.trim(),
        tone: form.tone,
        ...(field.type === 'state' ? { isResolved: form.isResolved } : {}),
        project: form.project || null,
      }),
    onSuccess: (v) => {
      setSaid({ text: `${v.name} is added to ${field.name}.` });
      setForm({ name: '', tone: null, isResolved: false, project: '' });
      void qc.invalidateQueries({ queryKey: keys.fields });
      void qc.invalidateQueries({ queryKey: ['projects'] });
    },
    onError: (e) => setSaid({ text: errorText(e), bad: true }),
  });
  return (
    <form
      className="stack"
      onSubmit={(e) => {
        e.preventDefault();
        if (form.name.trim()) add.mutate();
      }}
    >
      <fieldset className="form-card adding stack">
        <legend>Add a value</legend>
        <div className="form-fields">
          <FormField label="Name">
            {(id) => <input id={id} value={form.name} onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))} required maxLength={80} />}
          </FormField>
          <FormField label="Shows as">
            {(id) => (
              <>
                <ToneSelect id={id} value={form.tone} onChange={(tone) => setForm((f) => ({ ...f, tone }))} />
                <span>
                  <Badge tone={form.tone}>{form.name.trim() || 'Its name'}</Badge>
                </span>
              </>
            )}
          </FormField>
          <FormField label="For" help="A value for one project can't move to others later.">
            {(id, help) => (
              <select id={id} aria-describedby={help} value={form.project} onChange={(e) => setForm((f) => ({ ...f, project: e.target.value }))}>
                <option value="">Every project</option>
                {projects.map((p) => (
                  <option key={p.key} value={p.key}>
                    {p.key} only
                  </option>
                ))}
              </select>
            )}
          </FormField>
          {field.type === 'state' ? (
            <label className="choice">
              <input type="checkbox" checked={form.isResolved} onChange={(e) => setForm((f) => ({ ...f, isResolved: e.target.checked }))} />
              <span>
                Resolves an issue
                <small className="field-help">Issues in this state count as done.</small>
              </span>
            </label>
          ) : null}
        </div>
        <div className="cluster">
          <button type="submit" disabled={!form.name.trim() || add.isPending}>
            {add.isPending ? 'Adding…' : 'Add the value'}
          </button>
          <Said text={said?.text} tone={said?.bad ? 'bad' : undefined} />
        </div>
      </fieldset>
    </form>
  );
}

function FieldEditor({ field }: { field: Field }) {
  const qc = useQueryClient();
  const [, setSearch] = useSearchParams();
  const projects = useProjects();
  const projectKeys = new Map((projects.data ?? []).map((p) => [p.id, p.key]));
  const initial = { name: field.name, description: field.description };
  const [form, setForm] = useState(initial);
  const [said, setSaid] = useState<{ text: string; bad?: boolean } | null>(null);
  const savedKey = JSON.stringify(initial);
  useEffect(() => setForm(JSON.parse(savedKey) as typeof initial), [savedKey]);
  const dirty = JSON.stringify(form) !== savedKey;
  const save = useMutation({
    mutationFn: () => patch<Field>(`/fields/${field.id}`, { name: form.name.trim(), description: form.description }),
    onSuccess: () => {
      setSaid({ text: 'Saved. Queries and commands use the new name from now on.' });
      void qc.invalidateQueries({ queryKey: keys.fields });
      void qc.invalidateQueries({ queryKey: ['projects'] });
    },
    onError: (e) => setSaid({ text: errorText(e), bad: true }),
  });
  const remove = useMutation({
    mutationFn: () => del(`/fields/${field.id}`),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: keys.fields });
      void qc.invalidateQueries({ queryKey: ['projects'] });
      setSearch({}, { replace: true });
    },
    onError: (e) => setSaid({ text: errorText(e), bad: true }),
  });
  const values = [...field.values].sort((a, b) => a.ordinal - b.ordinal);
  const move = useMutation({
    mutationFn: async ({ index, dir }: { index: number; dir: -1 | 1 }) => {
      // Number them afresh in the new order, so equal or gapped places never tie.
      const order = [...values];
      const [moved] = order.splice(index, 1);
      order.splice(index + dir, 0, moved!);
      await Promise.all(order.map((v, i) => (v.ordinal === i ? null : patch(`/fields/${field.id}/values/${v.id}`, { ordinal: i }))));
    },
    onSettled: () => {
      void qc.invalidateQueries({ queryKey: keys.fields });
      void qc.invalidateQueries({ queryKey: ['projects'] });
    },
    onError: (e) => setSaid({ text: errorText(e), bad: true }),
  });
  const options = OPTION_TYPES.includes(field.type);
  return (
    <section className="card" aria-labelledby="field-title">
      <div className="section-head">
        <h2 id="field-title">{field.name}</h2>
        <Confirm
          small
          label="Delete the field"
          title={`Delete the field ${field.name}?`}
          about={`Its values go with it, from every project and every issue that has them, and nobody can bring them back.`}
          confirm="Delete it"
          disabled={remove.isPending}
          onConfirm={() => remove.mutate()}
        />
      </div>
      <p className="note section-note">
        {TYPE_WORDS[field.type][0]!.toUpperCase() + TYPE_WORDS[field.type].slice(1)}
        {field.multi ? ', several at once' : ''}. Its kind can't change once it's made.
      </p>
      <form
        className="form"
        onSubmit={(e) => {
          e.preventDefault();
          save.mutate();
        }}
      >
        <div className="form-fields">
          <FormField label="Name">
            {(id) => <input id={id} value={form.name} onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))} required maxLength={60} />}
          </FormField>
          <FormField label="What it means" className="tw:col-span-full">
            {(id) => (
              <textarea id={id} value={form.description} onChange={(e) => setForm((f) => ({ ...f, description: e.target.value }))} rows={2} maxLength={1000} />
            )}
          </FormField>
        </div>
        <div className="cluster">
          <button type="submit" disabled={!dirty || save.isPending}>
            {save.isPending ? 'Saving…' : 'Save the field'}
          </button>
          <Said text={said?.text} tone={said?.bad ? 'bad' : undefined} />
        </div>
      </form>
      {options ? (
        <>
          <h3>Its values ({values.length})</h3>
          <p className="note">
            In order: the first comes first in lists and sorts first. A value shows as the badge beside it, its colour a meaning, never a decoration.
          </p>
          {values.length ? (
            <ol className="value-rows" aria-label={`Values of ${field.name}`}>
              {values.map((v, i) => (
                <ValueRow
                  key={v.id}
                  field={field}
                  value={v}
                  projects={projectKeys}
                  first={i === 0 || move.isPending}
                  last={i === values.length - 1 || move.isPending}
                  onMove={(dir) => move.mutate({ index: i, dir })}
                />
              ))}
            </ol>
          ) : (
            <p className="note">No values yet.</p>
          )}
          <AddValue field={field} projects={projects.data ?? []} />
        </>
      ) : (
        <p className="note">{field.type === 'user' ? 'Its values are the people of a4a.' : 'People type its values, so it has no list.'}</p>
      )}
    </section>
  );
}

function CreateField() {
  const qc = useQueryClient();
  const [, setSearch] = useSearchParams();
  const [form, setForm] = useState({ name: '', type: 'enum' as FieldType, multi: false, description: '' });
  const [said, setSaid] = useState<{ text: string; bad?: boolean } | null>(null);
  const create = useMutation({
    mutationFn: () =>
      post<Field>('/fields', {
        name: form.name.trim(),
        type: form.type,
        multi: MULTI_TYPES.includes(form.type) ? form.multi : false,
        description: form.description.trim(),
        values: [],
      }),
    onSuccess: (f) => {
      void qc.invalidateQueries({ queryKey: keys.fields });
      setForm({ name: '', type: 'enum', multi: false, description: '' });
      setSaid({ text: `${f.name} is made. Attach it to a project on the project's page.` });
      setSearch({ field: f.id }, { replace: true });
    },
    onError: (e) => setSaid({ text: errorText(e), bad: true }),
  });
  return (
    <section className="card side-card" aria-labelledby="new-field">
      <h2 id="new-field">Make a field</h2>
      <form
        className="form"
        onSubmit={(e) => {
          e.preventDefault();
          create.mutate();
        }}
      >
        <FormField label="Name">
          {(id) => <input id={id} value={form.name} onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))} required maxLength={60} />}
        </FormField>
        <FormField label="What it holds">
          {(id) => (
            <select id={id} value={form.type} onChange={(e) => setForm((f) => ({ ...f, type: e.target.value as FieldType }))}>
              {FIELD_TYPES.map((t) => (
                <option key={t} value={t}>
                  {TYPE_WORDS[t][0]!.toUpperCase() + TYPE_WORDS[t].slice(1)}
                </option>
              ))}
            </select>
          )}
        </FormField>
        {MULTI_TYPES.includes(form.type) ? (
          <label className="choice">
            <input type="checkbox" checked={form.multi} onChange={(e) => setForm((f) => ({ ...f, multi: e.target.checked }))} />
            <span>Several at once</span>
          </label>
        ) : null}
        <FormField label="What it means">
          {(id) => (
            <textarea id={id} value={form.description} onChange={(e) => setForm((f) => ({ ...f, description: e.target.value }))} rows={2} maxLength={1000} />
          )}
        </FormField>
        <div className="cluster">
          <button type="submit" className="primary" disabled={!form.name.trim() || create.isPending}>
            {create.isPending ? 'Making…' : 'Make the field'}
          </button>
        </div>
        <Said text={said?.text} tone={said?.bad ? 'bad' : undefined} />
      </form>
    </section>
  );
}

/** The fields issues can have, and their values, for every project. */
export default function FieldsPage() {
  const fields = useFields();
  const [search, setSearch] = useSearchParams();
  const chosenId = search.get('field');
  const chosen = fields.data?.find((f) => f.id === chosenId) ?? fields.data?.[0];
  return (
    <AdminOnly title="Fields">
      <PageHead title="Fields" about="The fields issues can have, and their values. Each project chooses the ones it uses, on its own page." />
      {fields.isLoading ? <Loading what="fields" /> : null}
      {fields.error ? <ErrorNote error={fields.error} /> : null}
      {fields.data ? (
        <div className="tw:grid tw:grid-cols-[15rem_minmax(0,1fr)] tw:items-start tw:gap-4 tw:max-[900px]:grid-cols-1">
          <div className="stack">
            <nav className="card side-card nav-card" aria-label="Fields">
              <h2>{count(fields.data.length, 'field')}</h2>
              <ul className="nav-list">
                {fields.data.map((f) => (
                  <li key={f.id}>
                    <a
                      href={`?field=${f.id}`}
                      aria-current={chosen?.id === f.id ? 'page' : undefined}
                      onClick={(e) => {
                        e.preventDefault();
                        setSearch({ field: f.id }, { replace: true });
                      }}
                    >
                      <span className="nav-list-name">{f.name}</span>
                      <span className="nav-list-about">
                        <span>{TYPE_WORDS[f.type]}</span>
                        {OPTION_TYPES.includes(f.type) ? <span>{count(f.values.length, 'value')}</span> : null}
                      </span>
                    </a>
                  </li>
                ))}
              </ul>
            </nav>
            <CreateField />
          </div>
          <div className="stack">
            {chosen ? <FieldEditor key={chosen.id} field={chosen} /> : <p className="note">There are no fields yet. Make the first one.</p>}
          </div>
        </div>
      ) : null}
    </AdminOnly>
  );
}
