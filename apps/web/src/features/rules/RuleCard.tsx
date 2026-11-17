import type { Rule, RuleInput, RulePreview, RuleRun } from '@a4a/shared';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { del, patch } from '../../api/client';
import { ago, Badge, IssueLink } from '../../components/Badges';
import { Icon } from '../../components/Icon';
import { errorText, Said } from '../common/bits';
import { Confirm } from '../common/Confirm';

import { previewRule, ruleKeys } from './api';
import { SampleDetail } from './RuleForm';
import { previewWords, Sentence } from './words';
import { intlLocale, problemSaid, t, tr } from '../../i18n';

/** The rule as its preview takes it; its call only for whoever may make one (others would be told they can't). */
function input(rule: Rule, canCall: boolean): RuleInput {
  const { project, name, kind, trigger, field, schedule, query, command, comment, requires, message, related, target, notify, call, script } = rule;
  return { project, name, kind, trigger, field, schedule, query, command, comment, requires, message, related, target, notify, call: canCall && call ? { webhook: call.webhook } : null, script };
}

const pad = (n: number) => String(n).padStart(2, '0');

/** A run to come, as people read it: "today at 09:00", "tomorrow at 09:00", "Mon 23 Nov at 09:00". */
function nextWords(iso: string, now = new Date()): string {
  const d = new Date(iso);
  const time = `${pad(d.getHours())}:${pad(d.getMinutes())}`;
  const days = Math.round((new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime() - new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime()) / 86_400_000);
  if (days === 0) return t('rules.ruleCard.todayAt', { time: time });
  if (days === 1) return t('rules.ruleCard.tomorrowAt', { time: time });
  return t('rules.ruleCard.at', { replace: d.toLocaleDateString(intlLocale(), { weekday: 'short', day: 'numeric', month: 'short' }).replace(',', ''), time: time });
}

/** What it did last, or when it next runs, in a line. */
function Last({ rule, run }: { rule: Rule; run: RuleRun | null }) {
  const next = rule.kind === 'schedule' && rule.enabled && rule.nextRunAt ? t('rules.ruleCard.nextRuns', { nextWords: nextWords(rule.nextRunAt) }) : null;
  if (!run) return <p className="rule-said">{next ?? (rule.kind === 'guard' ? t('rules.ruleCard.itHasnTRefusedA') : t('rules.ruleCard.itHasnTActedYet'))}</p>;
  const when = ago(run.at);
  const on = run.issue ? (
    <>{tr('rules.ruleCard.on', { el: <IssueLink id={run.issue} /> })}</>
  ) : null;
  let what: React.ReactNode;
  switch (run.outcome) {
    case 'refused':
      what = (
        <>{tr('rules.ruleCard.lastRefusedAChange', { v: run.by ? t('rules.ruleCard.by', { name: run.by.name }) : '', when: when, on: on })}</>
      );
      break;
    case 'applied':
      what = run.issue ? (
        <>{tr('rules.ruleCard.lastActed', { when: when, on: on, v: run.changes.map((c) => c.field).join(', ') || run.message })}</>
      ) : (
        <>{tr('rules.ruleCard.lastRan', { when: when, message: run.message })}</>
      );
      break;
    case 'failed':
      what = (
        <>{tr('rules.ruleCard.lastFailed', { when: when, on: on, message: run.message })}</>
      );
      break;
    default:
      what = (
        <>{tr('rules.ruleCard.lastRan2', { when: when, on: on, message: run.message })}</>
      );
  }
  return (
    <p className="rule-said">
      {next ? `${next} ` : null}
      {what}
    </p>
  );
}

/**
 * Ocean's Rule: the rule as a sentence, what it does and how it stands, what it did last, and its actions.
 * A rule that calls a webhook is an administrator's (`canCall`) to change or delete; its project's
 * managers can still turn it off.
 */
export function RuleCard({ rule, canManage, canCall = false, onEdit }: { rule: Rule; canManage: boolean; canCall?: boolean; onEdit: () => void }) {
  // A rule that calls out, or runs a script, is an administrator's to change (D32, D40).
  const canChange = canManage && ((!rule.call && !rule.script) || canCall);
  const qc = useQueryClient();
  const [said, setSaid] = useState<{ text: string; bad?: boolean } | null>(null);
  const [preview, setPreview] = useState<RulePreview | null>(null);
  const done = () => void qc.invalidateQueries({ queryKey: ruleKeys.all });
  const toggle = useMutation({
    mutationFn: () => patch<Rule>(`/rules/${rule.id}`, { enabled: !rule.enabled, expectedVersion: rule.version }),
    onSuccess: (r) => {
      done();
      setSaid({ text: r.enabled ? t('rules.ruleCard.itSOnAgainFrom') : t('rules.ruleCard.itSOffItDoes') });
    },
    onError: (e) => setSaid({ text: errorText(e), bad: true }),
  });
  const remove = useMutation({
    mutationFn: () => del(`/rules/${rule.id}`),
    onSuccess: done,
    onError: (e) => setSaid({ text: errorText(e), bad: true }),
  });
  const look = useMutation({
    mutationFn: () => previewRule(input(rule, canCall)),
    onSuccess: setPreview,
    onError: (e) => setSaid({ text: errorText(e), bad: true }),
  });
  const broken = rule.problems.length > 0;
  return (
    <li className={rule.enabled ? 'card rule-card' : 'card rule-card off'}>
      <div className="rule-head">
        <h3 className="rule-name">{rule.name}</h3>
        <span className="badges">
          {rule.project === null ? <span className="chip">{t('rules.ruleCard.everyProject')}</span> : null}
          {rule.kind === 'guard' ? <Badge grammar="own">{t('rules.ruleCard.refusesChanges')}</Badge> : null}
          {rule.kind !== 'guard' && (rule.command || rule.comment) ? <Badge grammar="changes">{t('rules.ruleCard.changesIssues')}</Badge> : null}
          {rule.notify ? <Badge>{t('rules.ruleCard.tellsPeople')}</Badge> : null}
          {rule.call ? <Badge grammar="outside">{t('rules.ruleCard.callsOut')}</Badge> : null}
          {rule.script ? <Badge>{t('rules.ruleCard.aScript')}</Badge> : null}
          {broken ? <Badge tone="bad">{t('rules.ruleCard.needsFixing')}</Badge> : rule.enabled ? <Badge tone="good">{t('rules.ruleCard.on2')}</Badge> : <Badge tone="idle">{t('rules.ruleCard.off')}</Badge>}
        </span>
      </div>
      <Sentence rule={rule} />
      {rule.script ? (
        <details>
          <summary>{t('rules.ruleCard.itsScript')}</summary>
          <pre className="script-log">{rule.script}</pre>
        </details>
      ) : null}
      <Last rule={rule} run={rule.lastRun} />
      {rule.problems.map((p) => (
        <div className="error-note" role="note" key={`${p.part}-${p.start}-${p.message}`}>
          <Icon name="cross" />
          <strong>{tr('rules.ruleCard.partNoLongerReads', { part: p.part /* a stable code the message selects on */, message: problemSaid(p, Boolean(p.fix)) ?? p.message })}</strong>
          <p>{tr('rules.ruleCard.itDoesNothingUntilIt', { v: p.fix ? t('rules.ruleCard.didYouMean', { fix: p.fix }) : p.hint && !problemSaid(p) ? ` ${p.hint}` : '' })}</p>
        </div>
      ))}
      {preview ? (
        <div className="command-preview" role="group" aria-label={t('rules.ruleCard.whatWouldDoNow', { name: rule.name })}>
          <p className="label">{t('rules.ruleCard.whatItWouldDoNow')}</p>
          <p className="note">{previewWords(preview)}</p>
          {preview.sample.length ? (
            <ul className="command-issues">
              {preview.sample.map((x) => (
                <li key={`${x.via?.id ?? ''}-${x.issue.id}`}>
                  <IssueLink id={x.issue.id} />
                  <span className="command-summary">
                    {x.issue.summary}
                    {x.via ? (
                      <>{tr('rules.ruleCard.for', { el: <IssueLink id={x.via.id} /> })}</>
                    ) : null}
                  </span>
                  <SampleDetail sample={x} guard={rule.kind === 'guard'} commands={Boolean(rule.command)} />
                </li>
              ))}
            </ul>
          ) : null}
        </div>
      ) : null}
      <div className="cluster">
        <button type="button" onClick={() => (preview ? setPreview(null) : look.mutate())} disabled={look.isPending} aria-expanded={preview !== null}>
          {look.isPending ? t('rules.ruleCard.previewing') : preview ? t('rules.ruleCard.hideThePreview') : t('rules.ruleCard.previewIt')}
        </button>
        {canManage ? (
          <>
            {canChange ? (
              <button type="button" onClick={onEdit}>{t('rules.ruleCard.editIt')}</button>
            ) : null}
            {canChange || rule.enabled ? (
              <button type="button" onClick={() => toggle.mutate()} disabled={toggle.isPending}>
                {rule.enabled ? t('rules.ruleCard.turnItOff') : t('rules.ruleCard.turnItBackOn')}
              </button>
            ) : null}
            <span className="grow" />
            {canChange ? (
              <Confirm
                small
                label={t('rules.ruleCard.deleteIt')}
                title={t('rules.ruleCard.deleteTheRule', { name: rule.name })}
                about={t('rules.ruleCard.itStopsAtOnceAnd')}
                confirm={t('rules.ruleCard.deleteIt')}
                disabled={remove.isPending}
                onConfirm={() => remove.mutate()}
              />
            ) : (
              <span className="note">{tr('rules.ruleCard.soAnAdministratorChangesIt', { v: rule.script ? t('rules.ruleCard.itRunsAScript') : t('rules.ruleCard.itCallsAWebhook') })}</span>
            )}
          </>
        ) : null}
      </div>
      <Said text={said?.text} tone={said?.bad ? 'bad' : undefined} />
    </li>
  );
}
