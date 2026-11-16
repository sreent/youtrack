import type { ProjectField, QueryProblem, Rule, RuleInput, RuleKind, RulePreview, RuleProblem } from '@a4a/shared';
import { useQueryClient } from '@tanstack/react-query';
import { useEffect, useId, useMemo, useState } from 'react';
import { ApiError, patch, post } from '../../api/client';
import { IssueLink } from '../../components/Badges';
import { ErrorLine } from '../../components/States';
import { errorText, FormField } from '../common/bits';
import { ChangeLines } from '../common/ChangeLines';
import { LanguageField, useLanguage, type Checker } from '../issues/LanguageField';
import { previewRule, ruleChecker, ruleKeys } from './api';

/** What sets a rule off, as the form's first word says it. Each choice is one kind of rule. */
type When = 'created' | 'updated' | 'commented' | 'hour' | 'day' | 'weekday' | 'guard';
const WHEN: { value: When; words: string; kind: RuleKind }[] = [
  { value: 'created', words: 'an issue is created', kind: 'change' },
  { value: 'updated', words: 'an issue changes', kind: 'change' },
  { value: 'commented', words: 'an issue gets a comment', kind: 'change' },
  { value: 'hour', words: 'every hour', kind: 'schedule' },
  { value: 'day', words: 'every day', kind: 'schedule' },
  { value: 'weekday', words: 'every weekday', kind: 'schedule' },
  { value: 'guard', words: 'a change would make an issue match', kind: 'guard' },
];
const kindOf = (w: When): RuleKind => WHEN.find((x) => x.value === w)!.kind;

export interface Draft {
  name: string;
  when: When;
  field: string;
  at: string;
  query: string;
  command: string;
  comment: string;
  requires: string;
  message: string;
}

export const EMPTY: Draft = { name: '', when: 'created', field: '', at: '09:00', query: '', command: '', comment: '', requires: '', message: '' };

/** The brief's examples, to start from. */
export const EXAMPLES: { label: string; draft: Draft }[] = [
  {
    label: 'Critical bugs go to someone',
    draft: { ...EMPTY, name: 'Critical bugs go to Anna', when: 'created', query: 'Type: Bug Priority: Critical', command: 'Assignee anna tag urgent' },
  },
  {
    label: 'Overdue issues get tagged, daily',
    draft: { ...EMPTY, name: 'Overdue issues get tagged', when: 'day', at: '09:00', query: '#Unresolved Due date: Overdue', command: 'tag overdue' },
  },
  {
    label: "Won't fix needs a comment",
    draft: { ...EMPTY, name: "Won't fix says why", when: 'guard', query: "State: {Won't fix}", requires: 'has: comments', message: "Say in a comment why it won't be fixed." },
  },
];

export function draftOf(rule: Rule): Draft {
  const when: When = rule.kind === 'guard' ? 'guard' : rule.kind === 'schedule' ? (rule.schedule?.every ?? 'day') : (rule.trigger ?? 'created');
  return {
    name: rule.name,
    when,
    field: rule.field ?? '',
    at: rule.schedule?.at ?? '09:00',
    query: rule.query,
    command: rule.command,
    comment: rule.comment ?? '',
    requires: rule.requires ?? '',
    message: rule.message ?? '',
  };
}

function toInput(project: string | null, d: Draft): RuleInput {
  const kind = kindOf(d.when);
  return {
    project,
    name: d.name.trim(),
    kind,
    trigger: kind === 'change' ? (d.when as 'created' | 'updated' | 'commented') : null,
    field: d.when === 'updated' && d.field ? d.field : null,
    schedule: kind === 'schedule' ? { every: d.when as 'hour' | 'day' | 'weekday', ...(d.when === 'hour' ? {} : { at: d.at || '09:00' }) } : null,
    query: d.query,
    command: kind === 'guard' ? '' : d.command,
    comment: kind === 'guard' ? null : d.comment.trim() || null,
    requires: kind === 'guard' ? d.requires : null,
    message: kind === 'guard' ? d.message.trim() || null : null,
    enabled: true,
  };
}

/** One part of the rule in the query or command language: Ocean's QueryBar field, checked as it's typed. */
function Part({
  lang,
  text,
  onText,
  label,
  placeholder,
}: {
  lang: ReturnType<typeof useLanguage>;
  text: string;
  onText: (t: string) => void;
  label: string;
  placeholder: string;
}) {
  return (
    <div className="query">
      <LanguageField text={text} onText={onText} onCaret={lang.setCaret} onEnter={() => {}} label={label} placeholder={placeholder} problems={lang.problems} suggestions={lang.suggestions} />
      {text.trim() && lang.checked && !lang.problems.length && lang.about ? <p className="query-found">{lang.about}</p> : null}
    </div>
  );
}

function same(a: QueryProblem, b: QueryProblem) {
  return a.message === b.message && a.start === b.start && a.end === b.end;
}

/**
 * Ocean's rule form: the rule said as a sentence, a row for each of its words, each part checked as it's
 * typed, and what it would do now, from a dry run. It saves a new rule, or changes `rule`.
 */
export function RuleForm({
  project,
  fields,
  rule,
  initial,
  onDone,
  onCancel,
}: {
  /** The project's key; null for a rule for every project. */
  project: string | null;
  fields: ProjectField[];
  rule?: Rule;
  initial?: Draft;
  onDone: (rule: Rule) => void;
  onCancel?: () => void;
}) {
  const id = useId();
  const qc = useQueryClient();
  const [d, setD] = useState<Draft>(() => (rule ? draftOf(rule) : (initial ?? EMPTY)));
  // A preview belongs to the rule as it was written when it was asked for.
  const [previewed, setPreviewed] = useState<{ key: string; preview: RulePreview } | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [refused, setRefused] = useState<RuleProblem[]>([]);
  useEffect(() => {
    if (initial) setD(initial);
  }, [initial]);
  const set = <K extends keyof Draft>(k: K, v: Draft[K]) => setD((x) => ({ ...x, [k]: v }));
  const kind = kindOf(d.when);

  const checkers = useMemo(
    () => ({ query: ruleChecker(project, kind, 'query'), requires: ruleChecker(project, kind, 'requires'), command: ruleChecker(project, kind, 'command') }) satisfies Record<string, Checker>,
    [project, kind],
  );
  const query = useLanguage(checkers.query, d.query, d.query.trim() !== '');
  const requires = useLanguage(checkers.requires, d.requires, kind === 'guard' && d.requires.trim() !== '');
  const command = useLanguage(checkers.command, d.command, kind !== 'guard' && d.command.trim() !== '');
  const live = [...query.problems, ...requires.problems, ...command.problems];

  // What it would do now, once something is written: debounced, the latest answer wins. A preview
  // needs no name yet.
  const input = useMemo(() => toInput(project, d), [project, d]);
  const touched = Boolean(d.query.trim() || d.command.trim() || d.requires.trim() || d.comment.trim());
  const key = JSON.stringify(input);
  useEffect(() => {
    let current = true;
    if (!touched) {
      setPreviewed(null);
      return;
    }
    const timer = setTimeout(() => {
      previewRule({ ...input, name: input.name || 'A rule' })
        .then((p) => current && setPreviewed({ key, preview: p }))
        .catch(() => current && setPreviewed(null));
    }, 450);
    return () => {
      current = false;
      clearTimeout(timer);
    };
  }, [key, touched]); // `key` is `input` as text, so it changes only when the rule does

  const preview = previewed?.key === key ? previewed.preview : null;

  // Problems the fields don't underline themselves: a part left empty, a value the project lacks.
  const others = [...(preview?.problems ?? []), ...refused].filter((p, i, all) => !live.some((l) => same(l, p)) && all.findIndex((x) => x.message === p.message) === i);
  const ready = Boolean(d.name.trim()) && !live.length && preview?.ok === true && !saving;

  const save = async () => {
    setSaving(true);
    setError(null);
    setRefused([]);
    try {
      const saved = rule
        ? await patch<Rule>(`/rules/${rule.id}`, { ...input, project: undefined, kind: undefined, enabled: undefined, expectedVersion: rule.version })
        : await post<Rule>('/rules', input);
      await qc.invalidateQueries({ queryKey: ruleKeys.all });
      onDone(saved);
    } catch (e) {
      const problems = e instanceof ApiError ? ((e.details as { problems?: RuleProblem[] } | undefined)?.problems ?? []) : [];
      if (problems.length) setRefused(problems);
      else setError(errorText(e));
    } finally {
      setSaving(false);
    }
  };

  const fieldNames = ['Summary', 'Description', 'Tags', ...fields.map((f) => f.name)];
  const whenOptions = rule ? WHEN.filter((w) => w.kind === rule.kind) : WHEN;
  const ifId = `${id}-if`;
  const thenId = `${id}-then`;

  return (
    <form
      className="form"
      onSubmit={(e) => {
        e.preventDefault();
        if (ready) void save();
      }}
    >
      <FormField label="Name" help="Say what it's for: people see it in each issue's history.">
        {(fid, help) => <input id={fid} aria-describedby={help} value={d.name} onChange={(e) => set('name', e.target.value)} maxLength={80} required />}
      </FormField>
      <fieldset className="unframed rule-form">
        <legend className="hidden">The rule, as a sentence</legend>
        <div className="rule-clause">
          <span className="rule-word" id={`${id}-when`}>
            When
          </span>
          <div className="rule-clause-body">
            <div className="cluster">
              <select aria-labelledby={`${id}-when`} value={d.when} onChange={(e) => set('when', e.target.value as When)} disabled={whenOptions.length === 1}>
                {whenOptions.map((w) => (
                  <option key={w.value} value={w.value}>
                    {w.words}
                  </option>
                ))}
              </select>
              {d.when === 'updated' ? (
                <>
                  <span id={`${id}-in`}>in</span>
                  <select aria-label="Only when this field changes" value={d.field} onChange={(e) => set('field', e.target.value)}>
                    <option value="">any field</option>
                    {fieldNames.map((n) => (
                      <option key={n} value={n}>
                        {n}
                      </option>
                    ))}
                  </select>
                </>
              ) : null}
              {d.when === 'day' || d.when === 'weekday' ? (
                <>
                  <span>at</span>
                  <input type="time" aria-label="At what time of day, in the server's time zone" value={d.at} onChange={(e) => set('at', e.target.value)} required />
                </>
              ) : null}
            </div>
            {kind === 'guard' ? (
              <Part lang={query} text={d.query} onText={(t) => set('query', t)} label="When a change would make an issue match this query" placeholder="State: {Won't fix}" />
            ) : null}
          </div>
        </div>
        <div className="rule-clause">
          <span className="rule-word" id={ifId}>
            if
          </span>
          <div className="rule-clause-body">
            {kind === 'guard' ? (
              <>
                <span>it doesn't also match</span>
                <Part lang={requires} text={d.requires} onText={(t) => set('requires', t)} label="If it doesn't also match this query" placeholder="has: comments" />
              </>
            ) : (
              <>
                <span>{kind === 'schedule' ? 'an issue matches' : 'it matches'}</span>
                <Part
                  lang={query}
                  text={d.query}
                  onText={(t) => set('query', t)}
                  label={kind === 'schedule' ? 'If an issue matches this query' : 'If it matches this query'}
                  placeholder={kind === 'schedule' ? '#Unresolved Due date: Overdue' : 'Type: Bug Priority: Critical'}
                />
              </>
            )}
          </div>
        </div>
        <div className="rule-clause">
          <span className="rule-word" id={thenId}>
            then
          </span>
          <div className="rule-clause-body">
            {kind === 'guard' ? (
              <FormField label="refuse the change, saying">
                {(fid) => <input id={fid} value={d.message} onChange={(e) => set('message', e.target.value)} maxLength={500} placeholder="Say in a comment why it won't be fixed." />}
              </FormField>
            ) : (
              <>
                <span>apply</span>
                <Part lang={command} text={d.command} onText={(t) => set('command', t)} label="Then apply this command" placeholder="Assignee anna tag urgent" />
                <FormField label="And a comment, if it should post one" help="It goes on each issue the rule changes, by the workflow agent.">
                  {(fid, help) => <textarea id={fid} aria-describedby={help} rows={2} value={d.comment} onChange={(e) => set('comment', e.target.value)} maxLength={5000} />}
                </FormField>
              </>
            )}
          </div>
        </div>
      </fieldset>

      {others.map((p) => (
        <ErrorLine key={`${p.part}-${p.message}`}>
          {p.message}
          {p.hint ? `. ${p.hint}` : ''}
        </ErrorLine>
      ))}

      {preview && !live.length ? (
        <div className="command-preview" role="group" aria-label="What it would do">
          <p className="label">What it would do now</p>
          <p className="note">{preview.note}</p>
          {preview.sample.length ? (
            <ul className="command-issues">
              {preview.sample.map((x) => (
                <li key={x.issue.id}>
                  <IssueLink id={x.issue.id} />
                  <span className="command-summary">{x.issue.summary}</span>
                  {kind === 'guard' ? null : x.changes.length ? <ChangeLines changes={x.changes} /> : <span className="note">Nothing to change: it is so already</span>}
                  {x.errors.map((err) => (
                    <span key={err} className="note">
                      {err}
                    </span>
                  ))}
                </li>
              ))}
            </ul>
          ) : null}
        </div>
      ) : null}

      {error ? <ErrorLine>{error}</ErrorLine> : null}
      <div className="cluster end">
        {onCancel ? (
          <button type="button" onClick={onCancel}>
            Cancel
          </button>
        ) : null}
        <button type="submit" className="primary" disabled={!ready}>
          {saving ? 'Saving…' : rule ? 'Save the change' : 'Save the rule'}
        </button>
      </div>
    </form>
  );
}
