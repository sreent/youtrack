import type { IssueDetail, IssueWorkflow, QueryProblem, RuleInput, ScriptRun, StateMachine, WorkflowAction } from '@a4a/shared';
import { useQuery } from '@tanstack/react-query';
import { get, post, qs } from '../../api/client';

export const workflowKeys = {
  all: ['workflow'] as const,
  machines: (project: string) => ['workflow', 'machines', project] as const,
  actions: (project: string) => ['workflow', 'actions', project] as const,
  issue: (id: string) => ['workflow', 'issue', id] as const,
};

export const useMachines = (project: string | undefined) =>
  useQuery({ queryKey: workflowKeys.machines(project ?? ''), queryFn: () => get<StateMachine[]>(`/state-machines${qs({ project })}`), enabled: Boolean(project) });

export const useActions = (project: string | undefined) =>
  useQuery({ queryKey: workflowKeys.actions(project ?? ''), queryFn: () => get<WorkflowAction[]>(`/workflow-actions${qs({ project })}`), enabled: Boolean(project) });

/** What someone can do to an issue now by its workflows: its moves and its project's actions. */
export const useIssueWorkflow = (id: string, enabled: boolean) =>
  useQuery({ queryKey: workflowKeys.issue(id), queryFn: () => get<IssueWorkflow>(`/issues/${id}/workflow`), enabled });

export const runTransition = (id: string, transition: string, field: string) => post<IssueDetail>(`/issues/${id}/transitions`, { transition, field });
export const runAction = (id: string, action: string) => post<IssueDetail>(`/issues/${id}/actions/${action}`, {});
export const testRule = (draft: RuleInput & { issue: string }) => post<ScriptRun>('/rules/test', draft);

/** A script's problems as it's typed: what stops it compiling, at the line it's on. */
export async function checkScript(project: string | null, text: string): Promise<QueryProblem[]> {
  const r = await post<{ problems: QueryProblem[] }>('/rules/check', { project, kind: 'change', part: 'script', text });
  return r.problems;
}
