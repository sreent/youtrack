import type { Suggestion } from '@a4a/shared';
import { useState } from 'react';
import { Link, useSearchParams } from 'react-router';
import { useAIStatus, useProjects } from '../api/queries';
import { ErrorNote, Loading, PageHead } from '../components/States';
import { FormField } from '../features/common/bits';
import { count } from '../features/common/format';
import { useIssueSummaries, usePendingSuggestions } from '../features/common/queries';
import { SuggestionCard } from '../features/decide/SuggestionCard';

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
        title="Suggestions"
        about="What agents suggest for your issues waits here for a person. Nothing changes until someone applies it, all of it or a value at a time."
        meta={list.data ? <span>{waiting ? `${count(waiting, 'suggestion')} ${waiting === 1 ? 'waits' : 'wait'} on you` : 'Nothing waits on you'}</span> : null}
      />
      <div className="stack">
        <div className="cluster">
          <FormField label="Project" className="inline">
            {(id) => (
              <select
                id={id}
                value={project}
                onChange={(e) => {
                  setKept([]);
                  setSearch(e.target.value ? { project: e.target.value } : {}, { replace: true });
                }}
              >
                <option value="">All projects</option>
                {(projects.data ?? []).map((p) => (
                  <option key={p.key} value={p.key}>
                    {p.key} · {p.name}
                  </option>
                ))}
              </select>
            )}
          </FormField>
        </div>
        {list.isLoading ? <Loading what="suggestions" /> : null}
        {list.error ? <ErrorNote error={list.error} /> : null}
        {list.data && !shown.length ? (
          <section className="card">
            <h2>{project ? `Nothing waits on you in ${projectName ?? project}` : 'Nothing waits on you'}</h2>
            <p className="note">
              When triage reads a new issue, what it suggests (fields, tags and issues it looks like) waits here until someone applies it or dismisses it.
            </p>
            {ai.data && !ai.data.enabled ? (
              <p className="note">
                Triage needs AI, which is off on this server. To turn it on, set <code>ANTHROPIC_API_KEY</code> where the server runs, and restart it.
              </p>
            ) : projects.data && !triageOn.length ? (
              <p className="note">
                Triage is off in every project. Each project chooses how far it goes, on its page under <Link to="/projects">Projects</Link>.
              </p>
            ) : (
              <p className="note">
                Each project chooses how far triage goes, on its page under <Link to="/projects">Projects</Link>.
              </p>
            )}
          </section>
        ) : null}
        {shown.length && summaries.isLoading ? <Loading what="the issues they're about" /> : null}
        {shown.length && !summaries.isLoading ? (
          <div className="approvals">
            <h2 className="hidden">Waiting on you</h2>
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
