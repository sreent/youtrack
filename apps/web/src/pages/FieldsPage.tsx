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
import { t, tr } from '../i18n';
import type { ReactNode } from 'react';

const OPTION_TYPES: FieldType[] = ['enum', 'state', 'version'];
const MULTI_TYPES: FieldType[] = ['enum', 'user', 'version'];

const TONES: { tone: Tone | null; word: string }[] = [
  { tone: null, word: t('page.fields.aPlainFact') },
  { tone: 'good', word: t('page.fields.goingWell') },
  { tone: 'warn', word: t('page.fields.waitingOnSomeone') },
  { tone: 'bad', word: t('page.fields.failedOrLate') },
  { tone: 'idle', word: t('page.fields.notNeeded') },
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
      setSaid({ text: t('page.fields.saved') });
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
        <button type="button" className="round" aria-label={t('page.fields.moveUp', { name: value.name })} disabled={first} onClick={() => onMove(-1)}>
          <Icon name="chevron" className="up" />
        </button>
        <button type="button" className="round" aria-label={t('page.fields.moveDown', { name: value.name })} disabled={last} onClick={() => onMove(1)}>
          <Icon name="chevron" />
        </button>
      </span>
      <input
        className="value-name"
        value={form.name}
        onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))}
        aria-label={t('page.fields.nameOf', { name: value.name })}
        maxLength={80}
      />
      <span className="value-tone">
        <ToneSelect value={form.tone} onChange={(tone) => setForm((f) => ({ ...f, tone }))} label={t('page.fields.howShows', { name: value.name })} />
        <Badge tone={form.tone}>{form.name || value.name}</Badge>
      </span>
      <span className="value-more">
        {field.type === 'state' ? (
          <label className="choice">
            <input type="checkbox" checked={form.isResolved} onChange={(e) => setForm((f) => ({ ...f, isResolved: e.target.checked }))} />
            <span>{t('page.fields.resolves')}</span>
          </label>
        ) : null}
        <label className="choice">
          <input type="checkbox" checked={form.archived} onChange={(e) => setForm((f) => ({ ...f, archived: e.target.checked }))} />
          <span>{t('page.fields.archived')}</span>
        </label>
        {value.projectId ? (
          <span className="chip mono" title={t('page.fields.onlyInThisProject')}>{tr('page.fields.only', { v: projects.get(value.projectId) ?? t('page.fields.oneProject') })}</span>
        ) : null}
        <span className="cluster">
          <button type="button" className="small" disabled={!dirty || !form.name.trim() || save.isPending} onClick={() => save.mutate()}>
            {save.isPending ? t('page.fields.saving') : t('page.fields.save')}
          </button>
          <Confirm
            small
            label={t('page.fields.delete')}
            title={t('page.fields.deleteTheValueOf', { name: value.name, name2: field.name })}
            about={t('page.fields.nobodyCanBringItBack')}
            confirm={t('page.fields.deleteIt')}
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
      setSaid({ text: t('page.fields.isAddedTo', { name: v.name, name2: field.name }) });
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
        <legend>{t('page.fields.addAValue')}</legend>
        <div className="form-fields">
          <FormField label={t('page.fields.name')}>
            {(id) => <input id={id} value={form.name} onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))} required maxLength={80} />}
          </FormField>
          <FormField label={t('page.fields.showsAs')}>
            {(id) => (
              <>
                <ToneSelect id={id} value={form.tone} onChange={(tone) => setForm((f) => ({ ...f, tone }))} />
                <span>
                  <Badge tone={form.tone}>{form.name.trim() || t('page.fields.itsName')}</Badge>
                </span>
              </>
            )}
          </FormField>
          <FormField label={t('page.fields.for')} help={t('page.fields.aValueForOneProject')}>
            {(id, help) => (
              <select id={id} aria-describedby={help} value={form.project} onChange={(e) => setForm((f) => ({ ...f, project: e.target.value }))}>
                <option value="">{t('page.fields.everyProject')}</option>
                {projects.map((p) => (
                  <option key={p.key} value={p.key}>{tr('page.fields.only2', { key: p.key })}</option>
                ))}
              </select>
            )}
          </FormField>
          {field.type === 'state' ? (
            <label className="choice">
              <input type="checkbox" checked={form.isResolved} onChange={(e) => setForm((f) => ({ ...f, isResolved: e.target.checked }))} />
              <span>{tr('page.fields.resolvesAnIssueIssuesIn', { t0: (c: ReactNode) => <small className="field-help">{c}</small> })}</span>
            </label>
          ) : null}
        </div>
        <div className="cluster">
          <button type="submit" disabled={!form.name.trim() || add.isPending}>
            {add.isPending ? t('page.fields.adding') : t('page.fields.addTheValue')}
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
      setSaid({ text: t('page.fields.savedQueriesAndCommandsUse') });
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
          label={t('page.fields.deleteTheField')}
          title={t('page.fields.deleteTheField2', { name: field.name })}
          about={t('page.fields.itsValuesGoWithIt')}
          confirm={t('page.fields.deleteIt')}
          disabled={remove.isPending}
          onConfirm={() => remove.mutate()}
        />
      </div>
      <p className="note section-note">{tr('page.fields.itsKindCanTChange', { v: TYPE_WORDS[field.type][0]!.toUpperCase() + TYPE_WORDS[field.type].slice(1), v2: field.multi ? t('page.fields.severalAtOnce') : '' })}</p>
      <form
        className="form"
        onSubmit={(e) => {
          e.preventDefault();
          save.mutate();
        }}
      >
        <div className="form-fields">
          <FormField label={t('page.fields.name')}>
            {(id) => <input id={id} value={form.name} onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))} required maxLength={60} />}
          </FormField>
          <FormField label={t('page.fields.whatItMeans')} className="tw:col-span-full">
            {(id) => (
              <textarea id={id} value={form.description} onChange={(e) => setForm((f) => ({ ...f, description: e.target.value }))} rows={2} maxLength={1000} />
            )}
          </FormField>
        </div>
        <div className="cluster">
          <button type="submit" disabled={!dirty || save.isPending}>
            {save.isPending ? t('page.fields.saving') : t('page.fields.saveTheField')}
          </button>
          <Said text={said?.text} tone={said?.bad ? 'bad' : undefined} />
        </div>
      </form>
      {options ? (
        <>
          <h3>{tr('page.fields.itsValues', { length: values.length })}</h3>
          <p className="note">{t('page.fields.inOrderTheFirstComes')}</p>
          {values.length ? (
            <ol className="value-rows" aria-label={t('page.fields.valuesOf', { name: field.name })}>
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
            <p className="note">{t('page.fields.noValuesYet')}</p>
          )}
          <AddValue field={field} projects={projects.data ?? []} />
        </>
      ) : (
        <p className="note">{field.type === 'user' ? t('page.fields.itsValuesAreThePeople') : t('page.fields.peopleTypeItsValuesSo')}</p>
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
      setSaid({ text: t('page.fields.isMadeAttachItTo', { name: f.name }) });
      setSearch({ field: f.id }, { replace: true });
    },
    onError: (e) => setSaid({ text: errorText(e), bad: true }),
  });
  return (
    <section className="card side-card" aria-labelledby="new-field">
      <h2 id="new-field">{t('page.fields.makeAField')}</h2>
      <form
        className="form"
        onSubmit={(e) => {
          e.preventDefault();
          create.mutate();
        }}
      >
        <FormField label={t('page.fields.name')}>
          {(id) => <input id={id} value={form.name} onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))} required maxLength={60} />}
        </FormField>
        <FormField label={t('page.fields.whatItHolds')}>
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
            <span>{t('page.fields.severalAtOnce2')}</span>
          </label>
        ) : null}
        <FormField label={t('page.fields.whatItMeans')}>
          {(id) => (
            <textarea id={id} value={form.description} onChange={(e) => setForm((f) => ({ ...f, description: e.target.value }))} rows={2} maxLength={1000} />
          )}
        </FormField>
        <div className="cluster">
          <button type="submit" className="primary" disabled={!form.name.trim() || create.isPending}>
            {create.isPending ? t('page.fields.making') : t('page.fields.makeTheField')}
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
    <AdminOnly title={t('page.fields.fields2')}>
      <PageHead title={t('page.fields.fields2')} about={t('page.fields.theFieldsIssuesCanHave')} />
      {fields.isLoading ? <Loading what="loadingLine.fields" /> : null}
      {fields.error ? <ErrorNote error={fields.error} /> : null}
      {fields.data ? (
        <div className="tw:grid tw:grid-cols-[15rem_minmax(0,1fr)] tw:items-start tw:gap-4 tw:max-[900px]:grid-cols-1">
          <div className="stack">
            <nav className="card side-card nav-card" aria-label={t('page.fields.fields2')}>
              <h2>{count(fields.data.length, 'page.fields.fields')}</h2>
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
                        {OPTION_TYPES.includes(f.type) ? <span>{count(f.values.length, 'page.fields.values')}</span> : null}
                      </span>
                    </a>
                  </li>
                ))}
              </ul>
            </nav>
            <CreateField />
          </div>
          <div className="stack">
            {chosen ? <FieldEditor key={chosen.id} field={chosen} /> : <p className="note">{t('page.fields.thereAreNoFieldsYet')}</p>}
          </div>
        </div>
      ) : null}
    </AdminOnly>
  );
}
