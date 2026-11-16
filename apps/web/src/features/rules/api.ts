import type { QueryProblem, Rule, RuleInput, RuleKind, RulePreview, RuleRun, SuggestItem } from '@a4a/shared';
import { useQuery } from '@tanstack/react-query';
import { get, post, qs } from '../../api/client';
import type { Checker } from '../issues/LanguageField';

export const ruleKeys = {
  all: ['rules'] as const,
  list: (project: string) => ['rules', project] as const,
  runs: (project: string) => ['rules', project, 'runs'] as const,
};

export const useRules = (project: string | undefined) =>
  useQuery({ queryKey: ruleKeys.list(project ?? ''), queryFn: () => get<Rule[]>(`/rules${qs({ project })}`), enabled: Boolean(project) });

/** Rules act a moment after a change, from the outbox: the log looks again while it's open. */
export const useRuleRuns = (project: string | undefined) =>
  useQuery({
    queryKey: ruleKeys.runs(project ?? ''),
    queryFn: () => get<RuleRun[]>(`/rule-runs${qs({ project, limit: 50 })}`),
    enabled: Boolean(project),
    refetchInterval: 15_000,
  });

export const previewRule = (draft: RuleInput) => post<RulePreview>('/rules/preview', draft);

type CheckResult = { problems: QueryProblem[]; description: string; suggestions: SuggestItem[] };

/** A part of a rule, checked as it's typed: its problems, its reading and what could come next. */
export function ruleChecker(project: string | null, kind: RuleKind, part: 'query' | 'requires' | 'command' | 'related'): Checker {
  return async (text, caret) => {
    const r = await post<CheckResult>('/rules/check', { project, kind, part, text, caret });
    return { problems: r.problems, about: r.description, suggestions: r.suggestions };
  };
}
