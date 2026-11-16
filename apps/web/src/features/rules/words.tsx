import type { Rule, RuleSchedule, RuleTrigger } from '@a4a/shared';

/** As the server says them (workflow/words.ts): a rule's parts in words. */
export function triggerWords(trigger: RuleTrigger | null, field: string | null): string {
  if (trigger === 'created') return 'an issue is created';
  if (trigger === 'commented') return 'an issue gets a comment';
  return field ? `an issue's ${field} changes` : 'an issue changes';
}

export function scheduleWords(schedule: RuleSchedule | null): string {
  if (!schedule) return 'On a schedule';
  if (schedule.every === 'hour') return 'Every hour';
  return `Every ${schedule.every === 'weekday' ? 'weekday' : 'day'} at ${schedule.at ?? '09:00'}`;
}

type Parts = Pick<Rule, 'kind' | 'trigger' | 'field' | 'schedule' | 'query' | 'command' | 'comment' | 'requires' | 'message'>;

function Then({ rule }: { rule: Parts }) {
  const comment = rule.comment?.trim();
  return (
    <>
      <span className="rule-word">then</span> {rule.command ? <>apply <code>{rule.command}</code></> : null}
      {rule.command && comment ? ' and ' : null}
      {comment ? <>comment “{comment.length > 80 ? `${comment.slice(0, 79)}…` : comment}”</> : null}
    </>
  );
}

/** Ocean's Rule sentence: When … if … then …, its three words in --text, the query and command as written. */
export function Sentence({ rule }: { rule: Parts }) {
  const query = rule.query.trim();
  if (rule.kind === 'guard') {
    return (
      <p className="rule-sentence">
        <span className="rule-word">When</span> a change would make an issue match <code>{query}</code>, <span className="rule-word">if</span> it doesn't also
        match <code>{rule.requires}</code>, <span className="rule-word">then</span> refuse the change{rule.message ? <>: “{rule.message}”</> : '.'}
      </p>
    );
  }
  if (rule.kind === 'schedule') {
    return (
      <p className="rule-sentence">
        <span className="rule-word">{scheduleWords(rule.schedule)}</span>,{' '}
        {query ? (
          <>
            <span className="rule-word">if</span> an issue matches <code>{query}</code>
          </>
        ) : (
          'for every issue'
        )}
        , <Then rule={rule} />.
      </p>
    );
  }
  return (
    <p className="rule-sentence">
      <span className="rule-word">When</span> {triggerWords(rule.trigger, rule.field)}
      {query ? (
        <>
          , <span className="rule-word">if</span> it matches <code>{query}</code>
        </>
      ) : null}
      , <Then rule={rule} />.
    </p>
  );
}
