import type { Suggestion } from '@a4a/shared';
import { useState } from 'react';
import { Link, useSearchParams } from 'react-router';
import { useAIStatus, useProjects } from '../api/queries';
import { ErrorNote, Loading, PageHead } from '../components/States';
import { FormField } from '../features/common/bits';
import { count } from '../features/common/format';
import { useIssueSummaries, usePendingSuggestions } from '../features/common/queries';
import { SuggestionCard } from '../features/decide/SuggestionCard';
import { t, tr } from '../i18n';
import type { ReactNode } from 'react';

/** The Decide page: what agents propose, one decision each, until someone applies or dismisses it. */
export default function SuggestionsPage() {
  const [search, setSearch] = useSearchParams();
  const project = search.get('project') ?? '';
  const list = usePendingSuggestions(project);
  const projects = useProjects();
  const ai = useAIStatus();
  // Decided here, kept in place so the card can say what happened.
  const [kept, setKept] = useState<Suggestion[]>([]);

  const pending = list.data ?? [];
  const shown = [...pending];
  for (const k of kept) if (!shown.some((s) => s.id === k.id)) shown.push(k);
  shown.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  const summaries = useIssueSummaries(shown.map((s) => s.issueId));
  const waiting = pending.filter((s) => !kept.some((k) => k.id === s.id)).length;
  const projectName = projects.data?.find((p) => p.key === project)?.name;
  const triageOn = (projects.data ?? []).filter((p) => p.settings.triageMode !== 'off');

  return (
    <>
      <PageHead
        title={t('page.suggestions.suggestions')}
        about={t('page.suggestions.whatAgentsSuggestForYour')}
        meta={list.data ? <span>{waiting ? count(waiting, 'page.suggestions.waitOnYou') : t('page.suggestions.nothingWaitsOnYou')}</span> : null}
      />
      <div className="stack">
        <div className="cluster">
          <FormField label={t('page.suggestions.project')} className="inline">
            {(id) => (
              <select
                id={id}
                value={project}
                onChange={(e) => {
                  setKept([]);
                  setSearch(e.target.value ? { project: e.target.value } : {}, { replace: true });
                }}
              >
                <option value="">{t('page.suggestions.allProjects')}</option>
                {(projects.data ?? []).map((p) => (
                  <option key={p.key} value={p.key}>
                    {p.key} · {p.name}
                  </option>
                ))}
              </select>
            )}
          </FormField>
        </div>
        {list.isLoading ? <Loading what={t('loading.suggestions')} /> : null}
        {list.error ? <ErrorNote error={list.error} /> : null}
        {list.data && !shown.length ? (
          <section className="card">
            <h2>{project ? t('page.suggestions.nothingWaitsOnYouIn', { v: projectName ?? project }) : t('page.suggestions.nothingWaitsOnYou')}</h2>
            <p className="note">{t('page.suggestions.whenTriageReadsANew')}</p>
            {ai.data && !ai.data.enabled ? (
              <p className="note">{tr('page.suggestions.triageNeedsAiWhichIs', { code: <code>ANTHROPIC_API_KEY</code> })}</p>
            ) : projects.data && !triageOn.length ? (
              <p className="note">{tr('page.suggestions.triageIsOffInEvery', { t0: (c: ReactNode) => <Link to="/projects">{c}</Link> })}</p>
            ) : (
              <p className="note">{tr('page.suggestions.eachProjectChoosesHowFar', { t0: (c: ReactNode) => <Link to="/projects">{c}</Link> })}</p>
            )}
          </section>
        ) : null}
        {shown.length && summaries.isLoading ? <Loading what={t('page.suggestions.theIssuesTheyReAbout')} /> : null}
        {shown.length && !summaries.isLoading ? (
          <div className="approvals">
            <h2 className="hidden">{t('page.suggestions.waitingOnYou')}</h2>
            {shown.map((s) => {
              const issue = summaries.data?.get(s.issueId);
              return (
                <SuggestionCard
                  key={s.id}
                  suggestion={s}
                  summary={issue?.summary}
                  issue={issue}
                  onDone={() => setKept((k) => (k.some((x) => x.id === s.id) ? k : [...k, s]))}
                />
              );
            })}
          </div>
        ) : null}
      </div>
    </>
  );
}
