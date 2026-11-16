import type { LinkType, ProjectField, QueryProblem, Rule, RuleInput, RuleKind, RulePreview, RuleProblem, RuleRelation, RuleTargetKind, RuleTell } from '@a4a/shared';
import { useQueryClient } from '@tanstack/react-query';
import { useEffect, useId, useMemo, useState } from 'react';
import { ApiError, patch, post } from '../../api/client';
import { useLinkTypes, useWebhooks } from '../../api/queries';
import { IssueLink } from '../../components/Badges';
import { ErrorLine } from '../../components/States';
import { errorText, FormField } from '../common/bits';
import { ChangeLines } from '../common/ChangeLines';
import { LanguageField, useLanguage, type Checker } from '../issues/LanguageField';
import { testRule } from '../workflow/api';
import { ScriptField, ScriptRunView, useScriptProblems } from '../workflow/ScriptField';
import type { ScriptRun } from '@a4a/shared';
import { previewRule, ruleChecker, ruleKeys } from './api';
import { t, tr } from '../../i18n';

/** What sets a rule off, as the form's first word says it. Each choice is one kind of rule. */
type When = 'created' | 'updated' | 'commented' | 'hour' | 'day' | 'weekday' | 'guard';
const WHEN: { value: When; words: string; kind: RuleKind }[] = [
  { value: 'created', words: t('rules.ruleForm.anIssueIsCreated'), kind: 'change' },
  { value: 'updated', words: t('rules.ruleForm.anIssueChanges'), kind: 'change' },
  { value: 'commented', words: t('rules.ruleForm.anIssueGetsAComment'), kind: 'change' },
  { value: 'hour', words: t('rules.ruleForm.everyHour'), kind: 'schedule' },
  { value: 'day', words: t('rules.ruleForm.everyDay'), kind: 'schedule' },
  { value: 'weekday', words: t('rules.ruleForm.everyWeekday'), kind: 'schedule' },
  { value: 'guard', words: t('rules.ruleForm.aChangeWouldMakeAn'), kind: 'guard' },
];
const kindOf = (w: When): RuleKind => WHEN.find((x) => x.value === w)!.kind;

/** A further condition, as the form's "and" says it: on which related issues, and all of them or any. */
type And = '' | 'parent' | 'subtasks-all' | 'subtasks-any' | 'siblings-all' | 'siblings-any' | 'linked-all' | 'linked-any';
const AND: { value: And; words: string }[] = [
  { value: '', words: t('rules.ruleForm.nothingMore') },
  { value: 'parent', words: t('rules.ruleForm.itsParentMatches') },
  { value: 'subtasks-all', words: t('rules.ruleForm.allOfItsSubtasksMatch') },
  { value: 'subtasks-any', words: t('rules.ruleForm.anyOfItsSubtasksMatches') },
  { value: 'siblings-all', words: t('rules.ruleForm.allOfItsParentS') },
  { value: 'siblings-any', words: t('rules.ruleForm.anyOfItsParentS') },
  { value: 'linked-all', words: t('rules.ruleForm.allTheIssuesItMatch') },
  { value: 'linked-any', words: t('rules.ruleForm.anyIssueItMatches') },
];

const TO: { value: RuleTargetKind; words: string }[] = [
  { value: 'issue', words: t('rules.ruleForm.theIssueItself') },
  { value: 'parent', words: t('rules.ruleForm.itsParent') },
  { value: 'subtasks', words: t('rules.ruleForm.itsSubtasks') },
  { value: 'linked', words: t('rules.ruleForm.theIssuesIt') },
];

const TELL: { value: RuleTell; words: string }[] = [
  { value: 'assignee', words: t('rules.ruleForm.itsAssignee') },
  { value: 'reporter', words: t('rules.ruleForm.itsReporter') },
  { value: 'watchers', words: t('rules.ruleForm.itsWatchers') },
  { value: 'managers', words: t('rules.ruleForm.theProjectSManagers') },
];

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
  and: And;
  andPhrase: string;
  andQuery: string;
  to: RuleTargetKind;
  toPhrase: string;
  tell: RuleTell[];
  /** Logins, as typed: "anna, ben". */
  people: string;
  saying: string;
  /** The webhook it calls, by id. */
  call: string;
  /** Written as a script (D40), an administrator's: it runs in place of the command, or of what a guard requires. */
  scripted: boolean;
  script: string;
}

export const EMPTY: Draft = {
  name: '',
  when: 'created',
  field: '',
  at: '09:00',
  query: '',
  command: '',
  comment: '',
  requires: '',
  message: '',
  and: '',
  andPhrase: '',
  andQuery: '',
  to: 'issue',
  toPhrase: '',
  tell: [],
  people: '',
  saying: '',
  call: '',
  scripted: false,
  script: '',
};

/** What a new script starts as: what it's given, and what it can ask for. */
const SCRIPT_START = `// It's given \`issue\` (fields, tags, links, parent, subtasks, comments), \`change\` (who changed what) and \`project\`.
// It asks with apply(command[, issueId]), comment(text) and refuse(why), and writes to its run log with log(...).
if (issue.fields.Priority === 'Critical' && !issue.tags.includes('triaged')) {
  apply('tag triaged');
}
`;
const GUARD_START = `// A guard runs after a change and before it's saved: refuse(why) refuses it.
const fixing = change.changes.some((c) => c.field === 'State' && c.to === 'Fixed');
if (fixing && !issue.comments.length) refuse('Say how it was fixed in a comment first');
`;

/** The brief's examples, to start from. */
export const EXAMPLES: { label: string; draft: Draft }[] = [
  {
    label: t('rules.ruleForm.criticalBugsGoToSomeone'),
    draft: { ...EMPTY, name: t('rules.ruleForm.criticalBugsGoToAnna'), when: 'created', query: 'Type: Bug Priority: Critical', command: t('rules.ruleForm.assigneeAnnaTagUrgent') },
  },
  {
    label: t('rules.ruleForm.overdueIssuesGetTaggedDaily'),
    draft: { ...EMPTY, name: t('rules.ruleForm.overdueIssuesGetTagged'), when: 'day', at: '09:00', query: '#Unresolved Due date: Overdue', command: 'tag overdue' },
  },
  {
    label: t('rules.ruleForm.wonTFixNeedsA'),
    // not words: a query
    draft: { ...EMPTY, name: t('rules.ruleForm.wonTFixSaysWhy'), when: 'guard', query: "State: {Won't fix}", requires: 'has: comments', message: t('rules.ruleForm.sayInACommentWhy') },
  },
  {
    label: t('rules.ruleForm.doneSubtasksFixTheirParent'),
    draft: {
      ...EMPTY,
      name: t('rules.ruleForm.doneSubtasksFixTheirParent'),
      when: 'updated',
      field: 'State',
      query: '#Resolved',
      and: 'siblings-all',
      andQuery: '#Resolved',
      to: 'parent',
      command: t('rules.ruleForm.stateFixed'),
    },
  },
  {
    label: t('rules.ruleForm.criticalBugsAreNews'),
    draft: {
      ...EMPTY,
      name: t('rules.ruleForm.criticalBugsAreNews'),
      when: 'created',
      query: 'Priority: Critical',
      tell: ['assignee', 'managers'],
      saying: t('rules.ruleForm.aCriticalBugCameIn'),
    },
  },
];

const peopleOf = (text: string): string[] =>
  text
    .split(/[\s,]+/)
    .map((p) => p.replace(/^@/, '').trim())
    .filter(Boolean);

function andOf(rule: Rule): And {
  const r = rule.related;
  if (!r) return '';
  if (r.of === 'parent') return 'parent';
  return `${r.of}-${r.match === 'any' ? 'any' : 'all'}` as And;
}

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
    and: andOf(rule),
    andPhrase: rule.related?.phrase ?? '',
    andQuery: rule.related?.query ?? '',
    to: rule.target.to,
    toPhrase: rule.target.phrase ?? '',
    tell: rule.notify?.to ?? [],
    people: (rule.notify?.people ?? []).join(', '),
    saying: rule.notify?.message ?? '',
    call: rule.call?.webhook ?? '',
    scripted: Boolean(rule.script),
    script: rule.script ?? '',
  };
}

function toInput(project: string | null, d: Draft): RuleInput {
  const kind = kindOf(d.when);
  const acts = kind !== 'guard';
  const scripted = d.scripted;
  const [of, match] = d.and === 'parent' ? (['parent', 'any'] as const) : d.and ? (d.and.split('-') as [RuleRelation, 'all' | 'any']) : [null, null];
  const people = peopleOf(d.people);
  return {
    project,
    name: d.name.trim(),
    kind,
    trigger: kind === 'change' ? (d.when as 'created' | 'updated' | 'commented') : null,
    field: d.when === 'updated' && d.field ? d.field : null,
    schedule: kind === 'schedule' ? { every: d.when as 'hour' | 'day' | 'weekday', ...(d.when === 'hour' ? {} : { at: d.at || '09:00' }) } : null,
    query: d.query,
    command: kind === 'guard' || scripted ? '' : d.command,
    comment: kind === 'guard' || scripted ? null : d.comment.trim() || null,
    requires: kind === 'guard' && !scripted ? d.requires : null,
    message: kind === 'guard' && !scripted ? d.message.trim() || null : null,
    related: acts && !scripted && of ? { of, phrase: of === 'linked' ? d.andPhrase || null : null, match, query: d.andQuery } : null,
    target: acts && !scripted && d.to !== 'issue' ? { to: d.to, phrase: d.to === 'linked' ? d.toPhrase || null : null } : null,
    script: scripted ? d.script : null,
    notify: acts && (d.tell.length || people.length || d.saying.trim()) ? { to: d.tell, people, message: d.saying } : null,
    call: acts && d.call ? { webhook: d.call } : null,
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

/** The links a rule can follow from an issue, as they read from it: "depends on", "is required for"… (not subtask links). */
function phrasesOf(types: LinkType[] | undefined): string[] {
  const out = new Set<string>();
  for (const t of types ?? []) {
    if (t.aggregation) continue;
    out.add(t.outward);
    if (t.directed) out.add(t.inward);
  }
  return [...out];
}

function PhraseSelect({ label, value, onChange, phrases }: { label: string; value: string; onChange: (v: string) => void; phrases: string[] }) {
  return (
    <select aria-label={label} value={value} onChange={(e) => onChange(e.target.value)}>
      <option value="">{t('rules.ruleForm.chooseALink')}</option>
      {phrases.map((p) => (
        <option key={p} value={p}>
          {p}
        </option>
      ))}
    </select>
  );
}

/**
 * What a rule would do to one issue, in the second column of the command bar's list: what it would
 * change, whom it would tell, and what stops it. One cell, however many lines.
 */
export function SampleDetail({ sample, guard, commands }: { sample: RulePreview['sample'][number]; guard: boolean; commands: boolean }) {
  return (
    <div>
      {guard ? null : sample.changes.length ? <ChangeLines changes={sample.changes} /> : commands ? <p className="note">{t('rules.ruleForm.nothingToChangeItIs')}</p> : null}
      {sample.told ? <p className="note">{sample.told.length ? t('rules.ruleForm.tells', { join: sample.told.map((u) => u.name).join(', ') }) : t('rules.ruleForm.nobodyToTell')}</p> : null}
      {sample.errors.map((err) => (
        <p key={err} className="note">
          {err}
        </p>
      ))}
    </div>
  );
}

function same(a: QueryProblem, b: QueryProblem) {
  return a.message === b.message && a.start === b.start && a.end === b.end;
}

/**
 * Ocean's rule form: the rule said as a sentence, a row for each of its words, each part checked as it's
 * typed, and what it would do now, from a dry run. It saves a new rule, or changes `rule`. Only an
 * administrator (`canCall`) chooses a webhook for it to call.
 */
export function RuleForm({
  project,
  fields,
  rule,
  initial,
  canCall = false,
  canScript = canCall,
  onDone,
  onCancel,
}: {
  /** The project's key; null for a rule for every project. */
  project: string | null;
  fields: ProjectField[];
  rule?: Rule;
  initial?: Draft;
  canCall?: boolean;
  /** Writing a script is an administrator's (D40). */
  canScript?: boolean;
  onDone: (rule: Rule) => void;
  onCancel?: () => void;
}) {
  const id = useId();
  const qc = useQueryClient();
  const links = useLinkTypes();
  const hooks = useWebhooks(canCall);
  const phrases = phrasesOf(links.data);
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
    () =>
      ({
        query: ruleChecker(project, kind, 'query'),
        requires: ruleChecker(project, kind, 'requires'),
        command: ruleChecker(project, kind, 'command'),
        related: ruleChecker(project, kind, 'related'),
      }) satisfies Record<string, Checker>,
    [project, kind],
  );
  const query = useLanguage(checkers.query, d.query, d.query.trim() !== '');
  const requires = useLanguage(checkers.requires, d.requires, kind === 'guard' && d.requires.trim() !== '');
  const command = useLanguage(checkers.command, d.command, kind !== 'guard' && d.command.trim() !== '');
  const related = useLanguage(checkers.related, d.andQuery, kind !== 'guard' && !d.scripted && d.and !== '' && d.andQuery.trim() !== '');
  const scriptProblems = useScriptProblems(project, d.script, d.scripted);
  const live = [...query.problems, ...(d.scripted ? scriptProblems : [...requires.problems, ...command.problems, ...related.problems])];
  // A test run: the script on one issue, as it is now, saving nothing.
  const [testOn, setTestOn] = useState('');
  const [tested, setTested] = useState<{ issue: string; run: ScriptRun } | null>(null);
  const [testError, setTestError] = useState<string | null>(null);
  const [testing, setTesting] = useState(false);

  // What it would do now, once something is written: debounced, the latest answer wins. A preview
  // needs no name yet.
  const input = useMemo(() => toInput(project, d), [project, d]);
  const touched = Boolean(d.query.trim() || d.command.trim() || d.requires.trim() || d.comment.trim() || d.saying.trim() || d.call || (d.scripted && d.script.trim()));
  const key = JSON.stringify(input);
  useEffect(() => {
    let current = true;
    if (!touched) {
      setPreviewed(null);
      return;
    }
    const timer = setTimeout(() => {
      previewRule({ ...input, name: input.name || t('rules.ruleForm.aRule') })
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
        ? await patch<Rule>(`/rules/${rule.id}`, {
            ...input,
            project: undefined,
            kind: undefined,
            enabled: undefined,
            ...(canCall ? {} : { call: undefined }),
            ...(canScript ? {} : { script: undefined }),
            expectedVersion: rule.version,
          })
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
  const tellId = `${id}-tell`;

  const test = async () => {
    setTesting(true);
    setTestError(null);
    try {
      const issue = testOn.trim().toUpperCase();
      setTested({ issue, run: await testRule({ ...input, name: input.name || t('rules.ruleForm.aRule'), issue }) });
    } catch (e) {
      setTested(null);
      setTestError(errorText(e));
    } finally {
      setTesting(false);
    }
  };
  const scriptField = (
    <ScriptField
      text={d.script}
      onText={(t) => set('script', t)}
      problems={scriptProblems}
      label={kind === 'guard' ? t('rules.ruleForm.itsScriptWhichMayRefuse') : t('rules.ruleForm.thenRunThisScript')}
    />
  );

  return (
    <form
      className="form"
      onSubmit={(e) => {
        e.preventDefault();
        if (ready) void save();
      }}
    >
      <FormField label={t('rules.ruleForm.name')} help={t('rules.ruleForm.sayWhatItSFor')}>
        {(fid, help) => <input id={fid} aria-describedby={help} value={d.name} onChange={(e) => set('name', e.target.value)} maxLength={80} required />}
      </FormField>
      {canScript ? (
        <fieldset className="choice-group">
          <legend>{t('rules.ruleForm.writeItAs')}</legend>
          <label className="choice">
            <input type="radio" name={`${id}-as`} checked={!d.scripted} onChange={() => set('scripted', false)} />
            <span>{t('rules.ruleForm.aSentenceInTheQuery')}</span>
          </label>
          <label className="choice">
            <input
              type="radio"
              name={`${id}-as`}
              checked={d.scripted}
              onChange={() => setD((x) => ({ ...x, scripted: true, script: x.script.trim() ? x.script : kindOf(x.when) === 'guard' ? GUARD_START : SCRIPT_START }))}
            />
            <span>{t('rules.ruleForm.aScriptInJavascriptIt')}</span>
          </label>
        </fieldset>
      ) : null}
      <fieldset className="unframed rule-form">
        <legend className="hidden">{t('rules.ruleForm.theRuleAsASentence')}</legend>
        <div className="rule-clause">
          <span className="rule-word" id={`${id}-when`}>{t('rules.ruleForm.when')}</span>
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
                  <span id={`${id}-in`}>{t('rules.ruleForm.in')}</span>
                  <select aria-label={t('rules.ruleForm.onlyWhenThisFieldChanges')} value={d.field} onChange={(e) => set('field', e.target.value)}>
                    <option value="">{t('rules.ruleForm.anyField')}</option>
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
                  <span>{t('rules.ruleForm.at')}</span>
                  <input type="time" aria-label={t('rules.ruleForm.atWhatTimeOfDay')} value={d.at} onChange={(e) => set('at', e.target.value)} required />
                </>
              ) : null}
            </div>
            {kind === 'guard' ? (
              <Part
                lang={query}
                text={d.query}
                onText={(t) => set('query', t)}
                label={d.scripted ? t('rules.ruleForm.whenAChangeIsMade') : t('rules.ruleForm.whenAChangeWouldMake')}
                placeholder="State: {Won't fix}"
              />
            ) : null}
          </div>
        </div>
        <div className="rule-clause">
          <span className="rule-word" id={ifId}>{t('rules.ruleForm.if')}</span>
          <div className="rule-clause-body">
            {kind === 'guard' && d.scripted ? (
              <>
                <span>{t('rules.ruleForm.itsScriptRefusesIt')}</span>
                {scriptField}
              </>
            ) : kind === 'guard' ? (
              <>
                <span>{t('rules.ruleForm.itDoesnTAlsoMatch')}</span>
                <Part lang={requires} text={d.requires} onText={(t) => set('requires', t)} label={t('rules.ruleForm.ifItDoesnTAlso')} placeholder={t('rules.ruleForm.hasComments')} />
              </>
            ) : (
              <>
                <span>{kind === 'schedule' ? t('rules.ruleForm.anIssueMatches') : t('rules.ruleForm.itMatches')}</span>
                <Part
                  lang={query}
                  text={d.query}
                  onText={(t) => set('query', t)}
                  label={kind === 'schedule' ? t('rules.ruleForm.ifAnIssueMatchesThis') : t('rules.ruleForm.ifItMatchesThisQuery')}
                  placeholder={kind === 'schedule' ? '#Unresolved Due date: Overdue' : t('rules.ruleForm.typeBugPriorityCritical')}
                />
                <div className="cluster" hidden={d.scripted}>
                  <span>{t('rules.ruleForm.and')}</span>
                  <select aria-label={t('rules.ruleForm.andWhatItsRelatedIssues')} value={d.and} onChange={(e) => set('and', e.target.value as And)}>
                    {AND.map((a) => (
                      <option key={a.value} value={a.value}>
                        {a.words}
                      </option>
                    ))}
                  </select>
                  {d.and.startsWith('linked') ? <PhraseSelect label={t('rules.ruleForm.whichLinkAsItReads')} value={d.andPhrase} onChange={(v) => set('andPhrase', v)} phrases={phrases} /> : null}
                </div>
                {d.and && !d.scripted ? (
                  <Part lang={related} text={d.andQuery} onText={(t) => set('andQuery', t)} label={t('rules.ruleForm.whatItsRelatedIssuesMust')} placeholder="#Resolved" />
                ) : null}
              </>
            )}
          </div>
        </div>
        <div className="rule-clause">
          <span className="rule-word" id={thenId}>{t('rules.ruleForm.then')}</span>
          <div className="rule-clause-body">
            {kind === 'guard' && d.scripted ? (
              <span>{t('rules.ruleForm.refuseTheChangeInThe')}</span>
            ) : kind === 'guard' ? (
              <FormField label={t('rules.ruleForm.refuseTheChangeSaying')}>
                {(fid) => <input id={fid} value={d.message} onChange={(e) => set('message', e.target.value)} maxLength={500} placeholder={t('rules.ruleForm.sayInACommentWhy')} />}
              </FormField>
            ) : (
              <>
                {d.scripted ? (
                  <>
                    <span>{t('rules.ruleForm.runThisScript')}</span>
                    {scriptField}
                  </>
                ) : (
                  <>
                <div className="cluster">
                  <span>{t('rules.ruleForm.actingOn')}</span>
                  <select aria-label={t('rules.ruleForm.whichIssuesItActsOn')} value={d.to} onChange={(e) => set('to', e.target.value as RuleTargetKind)}>
                    {TO.map((t) => (
                      <option key={t.value} value={t.value}>
                        {t.words}
                      </option>
                    ))}
                  </select>
                  {d.to === 'linked' ? <PhraseSelect label={t('rules.ruleForm.whichLinkItFollowsTo')} value={d.toPhrase} onChange={(v) => set('toPhrase', v)} phrases={phrases} /> : null}
                </div>
                <span>{t('rules.ruleForm.apply')}</span>
                <Part lang={command} text={d.command} onText={(t) => set('command', t)} label={t('rules.ruleForm.thenApplyThisCommand')} placeholder={t('rules.ruleForm.assigneeAnnaTagUrgent')} />
                <FormField label={t('rules.ruleForm.andACommentIfIt')} help={t('rules.ruleForm.itGoesOnEachIssue')}>
                  {(fid, help) => <textarea id={fid} aria-describedby={help} rows={2} value={d.comment} onChange={(e) => set('comment', e.target.value)} maxLength={5000} />}
                </FormField>
                  </>
                )}
                <fieldset className="choice-group columns" aria-describedby={tellId}>
                  <legend>{t('rules.ruleForm.andTell')}</legend>
                  {TELL.map((t) => (
                    <label key={t.value} className="choice">
                      <input
                        type="checkbox"
                        checked={d.tell.includes(t.value)}
                        onChange={(e) => set('tell', e.target.checked ? [...d.tell, t.value] : d.tell.filter((x) => x !== t.value))}
                      />
                      <span>{t.words}</span>
                    </label>
                  ))}
                  <small className="field-help tw:col-span-full" id={tellId}>{t('rules.ruleForm.ofEachIssueItActs')}</small>
                </fieldset>
                <FormField label={t('rules.ruleForm.andThesePeopleByLogin')} help={t('rules.ruleForm.eGAnnaBen')}>
                  {(fid, help) => <input id={fid} aria-describedby={help} value={d.people} onChange={(e) => set('people', e.target.value)} className="mono" />}
                </FormField>
                {d.tell.length || d.people.trim() ? (
                  <FormField label={t('rules.ruleForm.tellingThem')} help={t('rules.ruleForm.inTheirInboxAndBy')}>
                    {(fid, help) => <textarea id={fid} aria-describedby={help} rows={2} value={d.saying} onChange={(e) => set('saying', e.target.value)} maxLength={2000} />}
                  </FormField>
                ) : null}
                {canCall ? (
                  <FormField label={t('rules.ruleForm.andCallAWebhook')} help={t('rules.ruleForm.signedWithTheWebhookS')}>
                    {(fid, help) => (
                      <select id={fid} aria-describedby={help} value={d.call} onChange={(e) => set('call', e.target.value)}>
                        <option value="">{t('rules.ruleForm.noWebhook')}</option>
                        {(hooks.data ?? []).map((h) => (
                          <option key={h.id} value={h.id}>
                            {h.url}
                          </option>
                        ))}
                      </select>
                    )}
                  </FormField>
                ) : null}
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
        <div className="command-preview" role="group" aria-label={t('rules.ruleForm.whatItWouldDo')}>
          <p className="label">{t('rules.ruleForm.whatItWouldDoNow')}</p>
          <p className="note">{preview.note}</p>
          {preview.sample.length ? (
            <ul className="command-issues">
              {preview.sample.map((x) => (
                <li key={`${x.via?.id ?? ''}-${x.issue.id}`}>
                  <IssueLink id={x.issue.id} />
                  <span className="command-summary">
                    {x.issue.summary}
                    {x.via ? (
                      <>{tr('rules.ruleForm.for', { el: <IssueLink id={x.via.id} /> })}</>
                    ) : null}
                  </span>
                  <SampleDetail sample={x} guard={kind === 'guard'} commands={Boolean(d.command.trim())} />
                </li>
              ))}
            </ul>
          ) : null}
        </div>
      ) : null}

      {d.scripted && canScript ? (
        <div className="stack">
          <div className="cluster">
            <FormField label={t('rules.ruleForm.testItOnAnIssue')} className="inline" help={t('rules.ruleForm.asTheIssueIsNow')}>
              {(fid, help) => <input id={fid} aria-describedby={help} className="mono" value={testOn} onChange={(e) => setTestOn(e.target.value)} placeholder={`${project ?? 'BACK'}-1`} />}
            </FormField>
            <button type="button" onClick={() => void test()} disabled={testing || !testOn.trim() || !d.script.trim()}>
              {testing ? t('rules.ruleForm.running') : t('rules.ruleForm.runIt')}
            </button>
          </div>
          {testError ? <ErrorLine>{testError}</ErrorLine> : null}
          {tested ? <ScriptRunView issue={tested.issue} run={tested.run} /> : null}
        </div>
      ) : null}

      {error ? <ErrorLine>{error}</ErrorLine> : null}
      <div className="cluster end">
        {onCancel ? (
          <button type="button" onClick={onCancel}>{t('rules.ruleForm.cancel')}</button>
        ) : null}
        <button type="submit" className="primary" disabled={!ready}>
          {saving ? t('rules.ruleForm.saving') : rule ? t('rules.ruleForm.saveTheChange') : t('rules.ruleForm.saveTheRule')}
        </button>
      </div>
    </form>
  );
}
