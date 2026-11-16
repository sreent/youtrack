import type { RuleOutcome, RuleRun } from '@a4a/shared';
import { Badge, IssueLink } from '../../components/Badges';
import { ErrorNote, Loading } from '../../components/States';
import { Scroll } from '../common/bits';
import { ChangeLines } from '../common/ChangeLines';
import { whenRead } from '../common/format';
import { useRuleRuns } from './api';

/** How a run went, with its shape: applied went well; nothing to change and skipped stood still; failed and refused, a cross. */
const OUTCOME: Record<RuleOutcome, { tone: 'good' | 'idle' | 'bad'; word: string }> = {
  applied: { tone: 'good', word: 'applied' },
  unchanged: { tone: 'idle', word: 'nothing to change' },
  skipped: { tone: 'idle', word: 'skipped' },
  failed: { tone: 'bad', word: 'failed' },
  refused: { tone: 'bad', word: 'refused' },
};

function cause(run: RuleRun): string {
  if (run.outcome === 'refused') return run.by ? `${run.by.name}’s change` : 'a change';
  if (!run.issue) return 'on its schedule';
  return run.by ? `set off by ${run.by.name}` : 'on its schedule';
}

/** What rules did in a project, newest first: Ocean's table of runs (components/Rule). */
export function RuleRuns({ project }: { project: string }) {
  const runs = useRuleRuns(project);
  if (runs.isLoading) return <Loading what="what rules did" />;
  if (runs.error) return <ErrorNote error={runs.error} />;
  if (!runs.data?.length) return <p className="note">Nothing yet. What each rule does, or refuses, shows here, newest first.</p>;
  return (
    <Scroll label="Table of what rules did">
      <table className="figures rule-runs">
        <thead>
          <tr>
            <th scope="col">When</th>
            <th scope="col">Rule</th>
            <th scope="col">Issue</th>
            <th scope="col">How it went</th>
            <th scope="col">What it did</th>
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
              <td>{r.issue ? <IssueLink id={r.issue} /> : <span className="muted">every match</span>}</td>
              <td>
                <Badge tone={OUTCOME[r.outcome].tone}>{OUTCOME[r.outcome].word}</Badge>
              </td>
              <td>{r.outcome === 'applied' && r.changes.length ? <ChangeLines changes={r.changes} /> : r.message}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </Scroll>
  );
}
