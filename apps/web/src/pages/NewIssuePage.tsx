import type { IssueDetail, ProjectField, SimilarIssue } from '@a4a/shared';
import { isOwnAgent } from '@a4a/shared/constants';
import { useQueryClient } from '@tanstack/react-query';
import { useEffect, useId, useMemo, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router';
import { post } from '../api/client';
import { useAIStatus, useProjectFields, useProjects, useUsers } from '../api/queries';
import { ErrorNote, Loading, PageHead } from '../components/States';
import { Who } from '../components/Who';
import { useStateTones } from '../features/issues/api';
import { Badge } from '../components/Badges';
import { FormField } from '../components/Form';

/** Fields worth setting while reporting; the rest can wait for triage or the team. */
const ASKED = ['Type', 'Priority', 'Assignee', 'Subsystem', 'Due date'];

function newKey(): string {
  return typeof crypto !== 'undefined' && 'randomUUID' in crypto ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

/** Issues like the one being reported, found as its summary is typed, so it isn't reported twice. */
function Similar({ summary, description, project, judge }: { summary: string; description: string; project: string; judge: boolean }) {
  const tones = useStateTones();
  const [result, setResult] = useState<{ items: SimilarIssue[]; judged: boolean; for: string } | null>(null);
  const [judging, setJudging] = useState(false);
  const text = summary.trim();

  useEffect(() => {
    if (text.length < 8) {
      setResult(null);
      return;
    }
    let live = true;
    const timer = setTimeout(() => {
      post<{ items: SimilarIssue[]; judged: boolean }>('/ai/similar', { summary: text, description, project, limit: 5 })
        .then((r) => live && setResult({ ...r, for: text }))
        .catch(() => {});
    }, 400);
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [text, description, project]);

  if (!result || !result.items.length) return null;
  const askAgent = async () => {
    setJudging(true);
    try {
      const r = await post<{ items: SimilarIssue[]; judged: boolean }>('/ai/similar', { summary: text, description, project, limit: 5, judge: true });
      setResult({ ...r, for: text });
    } catch {
      // keep the plain list
    } finally {
      setJudging(false);
    }
  };
  const shown = result.judged ? result.items.filter((i) => i.verdict !== 'different') : result.items;

  return (
    <section className="card issue-links-box" aria-labelledby="similar-title" aria-live="polite">
      <div className="issue-links stack">
        <div className="issue-links-head">
          <h2 id="similar-title">{result.judged ? 'What the agent thinks these are' : 'Issues that may be the same'}</h2>
          {judge && !result.judged ? (
            <button type="button" onClick={() => void askAgent()} disabled={judging}>
              {judging ? 'Reading them…' : 'Ask an agent which are duplicates'}
            </button>
          ) : null}
        </div>
      {result.judged ? (
        <p className="note">
          <Who kind="agent" name="triage" small /> read each against your words.
        </p>
      ) : (
        <p className="note">Found by their words. If one of these is what you’re reporting, add to it instead.</p>
      )}
      {shown.length ? (
        <ul className="link-list">
          {shown.map((s) => (
            <li key={s.issue.id} className={s.issue.resolved ? 'resolved' : undefined}>
              <span className="issue-id">{s.issue.id}</span>
              <Link to={`/issues/${s.issue.id}`} target="_blank" rel="noreferrer">
                {s.issue.summary}
              </Link>
              <span className="badges">
                {s.issue.state ? <Badge tone={tones.get(s.issue.state) ?? null}>{s.issue.state}</Badge> : null}
                {s.verdict ? <Badge>{s.verdict === 'duplicate' ? 'likely the same' : 'related'}</Badge> : null}
              </span>
              {s.reason ? <p className="note">{s.reason}</p> : null}
            </li>
          ))}
        </ul>
      ) : (
        <p className="note">None of them is the same as this.</p>
      )}
      </div>
    </section>
  );
}

function FieldInput({ field, value, onChange }: { field: ProjectField; value: string; onChange: (v: string) => void }) {
  const users = useUsers();
  if (field.type === 'user') {
    return (
      <FormField label={field.name}>
        {(id) => (
          <select id={id} value={value} onChange={(e) => onChange(e.target.value)}>
            <option value="">Unassigned</option>
            {/* People, and agents an administrator added; a4a's own agents take no work (D34). */}
            {(users.data ?? [])
              .filter((u) => !u.banned && !isOwnAgent(u))
              .map((u) => (
                <option key={u.id} value={u.login}>
                  {u.isBot ? `${u.login} (agent)` : u.name}
                </option>
              ))}
          </select>
        )}
      </FormField>
    );
  }
  if (field.type === 'date') {
    return <FormField label={field.name}>{(id) => <input id={id} type="date" value={value} onChange={(e) => onChange(e.target.value)} />}</FormField>;
  }
  return (
    <FormField label={field.name}>
      {(id) => (
        <select id={id} value={value} onChange={(e) => onChange(e.target.value)}>
          <option value="">{field.defaultValue ? 'The project’s default' : 'Not set'}</option>
          {field.values
            .filter((v) => !v.archived)
            .map((v) => (
              <option key={v.id} value={v.name}>
                {v.name}
              </option>
            ))}
        </select>
      )}
    </FormField>
  );
}

export default function NewIssuePage() {
  const navigate = useNavigate();
  const qc = useQueryClient();
  const [params] = useSearchParams();
  const projects = useProjects();
  const ai = useAIStatus();
  const [project, setProject] = useState(params.get('project') ?? '');
  const [summary, setSummary] = useState('');
  const [description, setDescription] = useState('');
  const [fields, setFields] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  // One key per report: a retry after a lost response can't create it twice.
  const [key, setKey] = useState(newKey);
  const projectFields = useProjectFields(project || undefined);

  useEffect(() => {
    if (!project && projects.data?.length) setProject(projects.data.find((p) => !p.archived)?.key ?? projects.data[0]!.key);
  }, [project, projects.data]);
  useEffect(() => setKey(newKey()), [project, summary, description, fields]);

  const asked = useMemo(() => (projectFields.data ?? []).filter((f) => ASKED.includes(f.name)).sort((a, b) => ASKED.indexOf(a.name) - ASKED.indexOf(b.name)), [projectFields.data]);

  const create = async () => {
    setBusy(true);
    setError(null);
    try {
      const chosen = Object.fromEntries(Object.entries(fields).filter(([, v]) => v !== ''));
      const issue = await post<IssueDetail>('/issues', { project, summary: summary.trim(), description, fields: chosen }, { idempotencyKey: key });
      await qc.invalidateQueries({ queryKey: ['issues', 'list'] });
      navigate(`/issues/${issue.id}`);
    } catch (e) {
      setError(e);
      setBusy(false);
    }
  };

  if (projects.isLoading) return <Loading what="projects" />;
  if (projects.error) return <ErrorNote error={projects.error} />;
  const triageOn = ai.data?.enabled;

  return (
    <>
      <PageHead
        crumbs={<Link to="/issues">Issues</Link>}
        title="New issue"
        about={triageOn ? 'Say what happened. Triage suggests a type, a priority and who could take it; nothing changes until someone accepts it.' : 'Say what happened, and what you expected instead.'}
      />
      <div className="split">
        <form
          className="card form"
          onSubmit={(e) => {
            e.preventDefault();
            if (summary.trim() && project) void create();
          }}
        >
          <FormField label="Project">
            {(id) => (
              <select id={id} value={project} onChange={(e) => setProject(e.target.value)} required>
                {(projects.data ?? [])
                  .filter((p) => !p.archived)
                  .map((p) => (
                    <option key={p.id} value={p.key}>
                      {p.name} ({p.key})
                    </option>
                  ))}
              </select>
            )}
          </FormField>
          <FormField label="Summary">
            {(id) => <input id={id} value={summary} onChange={(e) => setSummary(e.target.value)} required maxLength={500} autoFocus placeholder="Login fails on Safari with SSO" />}
          </FormField>
          <FormField label="Description">
            {(id) => (
              <textarea id={id} value={description} onChange={(e) => setDescription(e.target.value)} rows={8} placeholder={'Steps, what you expected, what happened instead.\nMarkdown works here.'} />
            )}
          </FormField>
          {asked.length ? (
            <div className="form-fields">
              {asked.map((f) => (
                <FieldInput key={f.fieldId} field={f} value={fields[f.name] ?? ''} onChange={(v) => setFields((x) => ({ ...x, [f.name]: v }))} />
              ))}
            </div>
          ) : null}
          {error ? <ErrorNote error={error} /> : null}
          <div className="cluster end">
            <Link to="/issues" className="button">
              Cancel
            </Link>
            <button type="submit" className="primary" disabled={!summary.trim() || !project || busy}>
              {busy ? 'Reporting…' : 'Report it'}
            </button>
          </div>
        </form>
        <div className="stack">
          {project ? <Similar summary={summary} description={description} project={project} judge={Boolean(triageOn)} /> : null}
        </div>
      </div>
    </>
  );
}
