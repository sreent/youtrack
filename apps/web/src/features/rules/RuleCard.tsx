import type { Rule, RuleInput, RulePreview, RuleRun } from '@a4a/shared';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { del, patch } from '../../api/client';
import { ago, Badge, IssueLink } from '../../components/Badges';
import { Icon } from '../../components/Icon';
import { errorText, Said } from '../common/bits';
import { ChangeLines } from '../common/ChangeLines';
import { Confirm } from '../common/Confirm';

import { previewRule, ruleKeys } from './api';
import { Sentence } from './words';

function input(rule: Rule): RuleInput {
  const { project, name, kind, trigger, field, schedule, query, command, comment, requires, message } = rule;
  return { project, name, kind, trigger, field, schedule, query, command, comment, requires, message };
}

const pad = (n: number) => String(n).padStart(2, '0');

/** A run to come, as people read it: "today at 09:00", "tomorrow at 09:00", "Mon 23 Nov at 09:00". */
function nextWords(iso: string, now = new Date()): string {
  const d = new Date(iso);
  const time = `${pad(d.getHours())}:${pad(d.getMinutes())}`;
  const days = Math.round((new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime() - new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime()) / 86_400_000);
  if (days === 0) return `today at ${time}`;
  if (days === 1) return `tomorrow at ${time}`;
  return `${d.toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short' }).replace(',', '')} at ${time}`;
}

/** What it did last, or when it next runs, in a line. */
function Last({ rule, run }: { rule: Rule; run: RuleRun | null }) {
  const next = rule.kind === 'schedule' && rule.enabled && rule.nextRunAt ? `Next runs ${nextWords(rule.nextRunAt)}.` : null;
  if (!run) return <p className="rule-said">{next ?? (rule.kind === 'guard' ? 'It hasn’t refused a change yet.' : 'It hasn’t acted yet.')}</p>;
  const when = ago(run.at);
  const on = run.issue ? (
    <>
      , on <IssueLink id={run.issue} />
    </>
  ) : null;
  let what: React.ReactNode;
  switch (run.outcome) {
    case 'refused':
      what = (
        <>
          Last refused a change{run.by ? ` by ${run.by.name}` : ''}, {when}
          {on}.
        </>
      );
      break;
    case 'applied':
      what = run.issue ? (
        <>
          Last acted {when}
          {on}: {run.changes.map((c) => c.field).join(', ') || run.message}.
        </>
      ) : (
        <>
          Last ran {when}: {run.message}
        </>
      );
      break;
    case 'failed':
      what = (
        <>
          Last failed {when}
          {on}: {run.message}
        </>
      );
      break;
    default:
      what = (
        <>
          Last ran {when}
          {on}: {run.message}
        </>
      );
  }
  return (
    <p className="rule-said">
      {next ? `${next} ` : null}
      {what}
    </p>
  );
}

/** Ocean's Rule: the rule as a sentence, what it does and how it stands, what it did last, and its actions. */
export function RuleCard({ rule, canManage, onEdit }: { rule: Rule; canManage: boolean; onEdit: () => void }) {
  const qc = useQueryClient();
  const [said, setSaid] = useState<{ text: string; bad?: boolean } | null>(null);
  const [preview, setPreview] = useState<RulePreview | null>(null);
  const done = () => void qc.invalidateQueries({ queryKey: ruleKeys.all });
  const toggle = useMutation({
    mutationFn: () => patch<Rule>(`/rules/${rule.id}`, { enabled: !rule.enabled, expectedVersion: rule.version }),
    onSuccess: (r) => {
      done();
      setSaid({ text: r.enabled ? 'It’s on again, from the next change.' : 'It’s off: it does nothing until it’s turned back on.' });
    },
    onError: (e) => setSaid({ text: errorText(e), bad: true }),
  });
  const remove = useMutation({
    mutationFn: () => del(`/rules/${rule.id}`),
    onSuccess: done,
    onError: (e) => setSaid({ text: errorText(e), bad: true }),
  });
  const look = useMutation({
    mutationFn: () => previewRule(input(rule)),
    onSuccess: setPreview,
    onError: (e) => setSaid({ text: errorText(e), bad: true }),
  });
  const broken = rule.problems.length > 0;
  return (
    <li className={rule.enabled ? 'card rule' : 'card rule off'}>
      <div className="rule-head">
        <h3 className="rule-name">{rule.name}</h3>
        <span className="badges">
          {rule.project === null ? <span className="chip">every project</span> : null}
          {rule.kind === 'guard' ? <Badge grammar="own">refuses changes</Badge> : <Badge grammar="changes">changes issues</Badge>}
          {broken ? <Badge tone="bad">needs fixing</Badge> : rule.enabled ? <Badge tone="good">on</Badge> : <Badge tone="idle">off</Badge>}
        </span>
      </div>
      <Sentence rule={rule} />
      <Last rule={rule} run={rule.lastRun} />
      {rule.problems.map((p) => (
        <div className="error-note" role="note" key={`${p.part}-${p.start}-${p.message}`}>
          <Icon name="cross" />
          <strong>
            Its {p.part === 'requires' ? 'requirement' : p.part} no longer reads: {p.message}
          </strong>
          <p>
            It does nothing until it’s fixed.
            {p.fix ? ` Did you mean ${p.fix}?` : p.hint ? ` ${p.hint}` : ''}
          </p>
        </div>
      ))}
      {preview ? (
        <div className="command-preview" role="group" aria-label={`What ${rule.name} would do now`}>
          <p className="label">What it would do now</p>
          <p className="note">{preview.note}</p>
          {preview.sample.length ? (
            <ul className="command-issues">
              {preview.sample.map((x) => (
                <li key={x.issue.id}>
                  <IssueLink id={x.issue.id} />
                  <span className="command-summary">{x.issue.summary}</span>
                  {rule.kind === 'guard' ? null : x.changes.length ? <ChangeLines changes={x.changes} /> : <span className="note">Nothing to change: it is so already</span>}
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
      <div className="cluster">
        <button type="button" onClick={() => (preview ? setPreview(null) : look.mutate())} disabled={look.isPending} aria-expanded={preview !== null}>
          {look.isPending ? 'Previewing…' : preview ? 'Hide the preview' : 'Preview it'}
        </button>
        {canManage ? (
          <>
            <button type="button" onClick={onEdit}>
              Edit it
            </button>
            <button type="button" onClick={() => toggle.mutate()} disabled={toggle.isPending}>
              {rule.enabled ? 'Turn it off' : 'Turn it back on'}
            </button>
            <span className="grow" />
            <Confirm
              small
              label="Delete it"
              title={`Delete the rule “${rule.name}”?`}
              about="It stops at once, and what it did goes from its log; what it changed on issues stays, in their history. Nobody can bring the rule back."
              confirm="Delete it"
              disabled={remove.isPending}
              onConfirm={() => remove.mutate()}
            />
          </>
        ) : null}
      </div>
      <Said text={said?.text} tone={said?.bad ? 'bad' : undefined} />
    </li>
  );
}
