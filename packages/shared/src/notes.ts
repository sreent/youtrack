/**
 * What a rule's preview and a script's test run show, in a translator's language (D49). The server
 * sends what its note says as data (`says`), and a page words it here, from the catalogs; the API's
 * `note` says the same in English. The server's tests hold the catalog's English to the API's.
 */
import { canSayProblem, DEFAULT_LOCALE, joinSentences, sayProblem, type ProblemSaid, type Translator } from './i18n';
import type { RuleTrigger } from './constants';
import type { NoteSaid, RulePreview, RuleSchedule, RuleTarget, ScriptRun } from './schemas';

/** When a rule acts, as its sentence says it: "an issue is created", "an issue's Priority changes". */
export function triggerWordsIn(tr: Translator, trigger: RuleTrigger | null, field: string | null): string {
  if (trigger === 'created') return tr.t('rules.words.anIssueIsCreated');
  if (trigger === 'commented') return tr.t('rules.words.anIssueGetsAComment');
  return field ? tr.t('rules.words.anIssueSChanges', { field }) : tr.t('rules.words.anIssueChanges');
}

/** How often a scheduled rule runs: "Every hour", "Every weekday at 09:00". */
export function scheduleWordsIn(tr: Translator, schedule: RuleSchedule | null): string {
  if (!schedule) return tr.t('rules.words.onASchedule');
  if (schedule.every === 'hour') return tr.t('rules.words.everyHour');
  return tr.t('rules.words.everyDayAt', { every: schedule.every === 'weekday' ? 'weekday' : 'day', at: schedule.at ?? '09:00' });
}

/**
 * The issues an action reaches, as a code its message words (D49): its parent, its subtasks, the
 * issues it's linked to (by the link's phrase), or none for the issue itself.
 */
export function targetIn(tr: Translator, t: Pick<RuleTarget, 'to' | 'phrase'> | null | undefined): { target: 'parent' | 'subtasks' | 'linked' | 'none'; phrase: string } {
  const to = t?.to ?? 'issue';
  return { target: to === 'parent' || to === 'subtasks' || to === 'linked' ? to : 'none', phrase: t?.phrase?.trim() || tr.t('rules.words.isLinkedTo') };
}

/** What a rule's preview shows, from what the server says it shows: how many match, how it acts, what it shows of them. */
export function previewNote(tr: Translator, p: Pick<RulePreview, 'matching' | 'breaking' | 'says'>): string {
  const s = p.says;
  if (s.shows === 'fixUnderlined') return tr.t('rules.preview.fixUnderlined');
  if (s.scripted) {
    const counted = tr.t('rules.preview.scriptMatching', { matching: p.matching });
    if (s.shows === 'fixScript') return joinSentences(tr, [counted, tr.t('rules.preview.fixScript')]);
    if (s.shows === 'adminOnly') return joinSentences(tr, [counted, tr.t('rules.preview.adminOnly')]);
    return joinSentences(tr, [
      counted,
      tr.t('rules.preview.scriptRuns', { kind: s.kind, schedule: scheduleWordsIn(tr, s.schedule), trigger: triggerWordsIn(tr, s.trigger, s.field) }),
      s.shown ? tr.t('rules.preview.scriptShown', { shown: s.shown }) : '',
    ]);
  }
  if (s.kind === 'guard') {
    return p.breaking
      ? tr.t('rules.preview.guardBreaking', { matching: p.matching, query: s.query, breaking: p.breaking })
      : tr.t('rules.preview.guardKept', { matching: p.matching, query: s.query });
  }
  // A rule that reaches other issues acts "for" each it matches, and shows "those" it reaches.
  const reach = s.target ? 'yes' : 'no';
  const on = targetIn(tr, s.target);
  return joinSentences(tr, [
    tr.t('rules.preview.matching', { matching: p.matching }),
    s.kind === 'change' ? tr.t('rules.preview.actsWhen', { trigger: triggerWordsIn(tr, s.trigger, s.field) }) : tr.t('rules.preview.actsScheduled', { schedule: scheduleWordsIn(tr, s.schedule), reach }),
    s.target ? tr.t('rules.preview.actsOn', { target: on.target, phrase: on.phrase }) : '',
    s.outside ? tr.t('rules.preview.outside', { outside: s.outside, project: s.project ?? '' }) : '',
    s.shown ? tr.t('rules.preview.shown', { shown: s.shown, reach, tells: s.tells ? 'yes' : 'no' }) : '',
  ]);
}

/**
 * A problem the server gave, in a translator's language by its words, or in the English it came in:
 * on an English page, and for words no catalog has (what a script's engine said has none).
 */
export function problemIn(tr: Translator, words: ProblemSaid | null | undefined, english: string): string {
  return tr.locale !== DEFAULT_LOCALE && words && canSayProblem(tr, words) ? sayProblem(tr, words) : english;
}

/** A note's words as the server kept them: its message's key, `problem.<key>` for one said as a problem, and its values. */
type Kept = Pick<NoteSaid, 'key' | 'values'>;

/** One kept note in a translator's language, or null where its catalog lacks the words. */
function keptIn(tr: Translator, n: Kept): string | null {
  if (n.key.startsWith('problem.')) {
    const words: ProblemSaid = { key: n.key.slice('problem.'.length), ...(n.values ? { values: n.values as ProblemSaid['values'] } : {}) };
    return canSayProblem(tr, words) ? sayProblem(tr, words) : null;
  }
  return tr.has(n.key) ? tr.t(n.key, n.values as Record<string, string | number>) : null;
}

/**
 * A note the server kept beside its English (D49): a commit's command note, a build's. In the
 * translator's language by its words; in the English it was kept in where it has none (a row from
 * before a4a kept them), where a catalog lacks them, and for a problem on an English page, where the
 * API's own words stand.
 */
export function noteIn(tr: Translator, said: Kept | null | undefined, english: string): string {
  if (!said || (said.key.startsWith('problem.') && tr.locale === DEFAULT_LOCALE)) return english;
  return keptIn(tr, said) ?? english;
}

/**
 * Notes kept a sentence each (D49), as a rule's run keeps what it did: said one after the other, as
 * the translator's language puts sentences. In the English they were kept in where there are none (a
 * run from before a4a kept them) or a catalog lacks any one of them.
 */
export function notesIn(tr: Translator, said: readonly Kept[] | null | undefined, english: string): string {
  if (!said?.length) return english;
  const parts = said.map((n) => keptIn(tr, n));
  return parts.every((x): x is string => x !== null) ? joinSentences(tr, parts) : english;
}

/** What a script's test run did, from what the server says it did: stopped, refused, let a change through, or asked for commands. */
export function scriptRunNote(tr: Translator, run: Pick<ScriptRun, 'error' | 'refusal' | 'says'>): string {
  const s = run.says;
  switch (s.outcome) {
    case 'stopped': {
      const e = run.error;
      // The error's words, without the stop its own sentence ends with: the note goes on after it.
      const said = e ? problemIn(tr, e.key ? { key: e.key, ...(e.values ? { values: e.values } : {}) } : null, e.message) : '';
      return tr.t('workflow.scriptRun.stopped', { message: said.replace(/[.。]$/, '') });
    }
    case 'refuses':
      return tr.t('workflow.scriptRun.refuses', { refusal: run.refusal ?? '' });
    case 'passes':
      return tr.t('workflow.scriptRun.passes', { ignored: s.ignored ? 'yes' : 'no' });
    case 'doesNothing':
      return tr.t('workflow.scriptRun.doesNothing', { refusal: run.refusal ?? '' });
    default:
      return joinSentences(tr, [
        tr.t('workflow.scriptRun.asks', { commands: s.commands, changing: s.changing, failing: s.failing }),
        s.comments ? tr.t('workflow.scriptRun.posts', { comments: s.comments }) : '',
        tr.t('workflow.scriptRun.nothingSaved'),
      ]);
  }
}
