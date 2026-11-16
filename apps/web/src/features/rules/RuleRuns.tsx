import type { RuleOutcome, RuleRun } from '@a4a/shared';
import { Badge, IssueLink } from '../../components/Badges';
import { ErrorNote, Loading } from '../../components/States';
import { Scroll } from '../common/bits';
import { ChangeLines } from '../common/ChangeLines';
import { whenRead } from '../common/format';
import { useRuleRuns } from './api';
import { t } from '../../i18n';

/** How a run went, with its shape: applied went well; nothing to change and skipped stood still; failed and refused, a cross. */
const OUTCOME: Record<RuleOutcome, { tone: 'good' | 'idle' | 'bad'; word: string }> = {
  applied: { tone: 'good', word: t('rules.ruleRuns.applied') },
  unchanged: { tone: 'idle', word: t('rules.ruleRuns.nothingToChange') },
  skipped: { tone: 'idle', word: t('rules.ruleRuns.skipped') },
  failed: { tone: 'bad', word: t('rules.ruleRuns.failed') },
  refused: { tone: 'bad', word: t('rules.ruleRuns.refused') },
};

function cause(run: RuleRun): string {
  if (run.outcome === 'refused') return run.by ? t('rules.ruleRuns.sChange', { name: run.by.name }) : t('rules.ruleRuns.aChange');
  if (!run.issue) return t('rules.ruleRuns.onItsSchedule');
  return run.by ? t('rules.ruleRuns.setOffBy', { name: run.by.name }) : t('rules.ruleRuns.onItsSchedule');
}

/** What rules did in a project, newest first: Ocean's table of runs (components/Rule). */
export function RuleRuns({ project }: { project: string }) {
  const runs = useRuleRuns(project);
  if (runs.isLoading) return <Loading what={t('rules.ruleRuns.whatRulesDid')} />;
  if (runs.error) return <ErrorNote error={runs.error} />;
  if (!runs.data?.length) return <p className="note">{t('rules.ruleRuns.nothingYetWhatEachRule')}</p>;
  return (
    <Scroll label={t('rules.ruleRuns.tableOfWhatRulesDid')}>
      <table className="figures rule-runs">
        <thead>
          <tr>
            <th scope="col">{t('rules.ruleRuns.when')}</th>
            <th scope="col">{t('rules.ruleRuns.rule')}</th>
            <th scope="col">{t('rules.ruleRuns.issue')}</th>
            <th scope="col">{t('rules.ruleRuns.howItWent')}</th>
            <th scope="col">{t('rules.ruleRuns.whatItDid')}</th>
          </tr>
        </thead>
        <tbody>
          {runs.data.map((r) => (
            <tr key={r.id}>
              <td>
                <time dateTime={r.at} title={r.at}>
                  {whenRead(r.at)}
                </time>
              </td>
              <td>
                <span className="item-name">{r.rule.name}</span>
                <span className="item-about">{cause(r)}</span>
              </td>
              <td>{r.issue ? <IssueLink id={r.issue} /> : <span className="muted">{t('rules.ruleRuns.everyMatch')}</span>}</td>
              <td>
                <Badge tone={OUTCOME[r.outcome].tone}>{OUTCOME[r.outcome].word}</Badge>
              </td>
              <td>
                {r.outcome === 'applied' && r.changes.length ? (
                  <>
                    <ChangeLines changes={r.changes} />
                    {/* What a script logged as it ran (D40), after its changes. */}
                    {r.message.includes(' Logged: ') ? <span className="item-about">{r.message.slice(r.message.indexOf(' Logged: ') + 1)}</span> : null}
                  </>
                ) : (
                  r.message
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </Scroll>
  );
}
