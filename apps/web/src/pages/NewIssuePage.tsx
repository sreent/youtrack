import type { IssueDetail, ProjectField, SimilarIssue } from '@a4a/shared';
import { isOwnAgent } from '@a4a/shared/constants';
import { useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef, useId, useMemo, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router';
import { patch, post } from '../api/client';
import { useAIStatus, useProjectFields, useProjects, useUsers } from '../api/queries';
import { ErrorNote, Loading, PageHead } from '../components/States';
import { Who } from '../components/Who';
import { useStateTones } from '../features/issues/api';
import { Badge } from '../components/Badges';
import { placedMarkdown, RichField } from '../features/editor/RichField';
import { imagePath } from '@a4a/shared/markdown';
import { contentPath, uploadFile } from '../features/attachments/api';
import { FormField } from '../components/Form';
import { t, tr } from '../i18n';

/** Fields worth setting while reporting; the rest can wait for triage or the team. */
// not words: a field's name, as a4a names it
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
          <h2 id="similar-title">{result.judged ? t('page.newIssue.whatTheAgentThinksThese') : t('page.newIssue.issuesThatMayBeThe')}</h2>
          {judge && !result.judged ? (
            <button type="button" onClick={() => void askAgent()} disabled={judging}>
              {judging ? t('page.newIssue.readingThem') : t('page.newIssue.askAnAgentWhichAre')}
            </button>
          ) : null}
        </div>
      {result.judged ? (
        <p className="note">{tr('page.newIssue.readEachAgainstYourWords', { el: <Who kind="agent" name="triage" small /> })}</p>
      ) : (
        <p className="note">{t('page.newIssue.foundByTheirWordsIf')}</p>
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
                {s.verdict ? <Badge>{s.verdict === 'duplicate' ? t('page.newIssue.likelyTheSame') : t('page.newIssue.related')}</Badge> : null}
              </span>
              {s.reason ? <p className="note">{s.reason}</p> : null}
            </li>
          ))}
        </ul>
      ) : (
        <p className="note">{t('page.newIssue.noneOfThemIsThe')}</p>
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
            <option value="">{t('page.newIssue.unassigned')}</option>
            {/* People, and agents an administrator added; a4a's own agents take no work (D34). */}
            {(users.data ?? [])
              .filter((u) => !u.banned && !isOwnAgent(u))
              .map((u) => (
                <option key={u.id} value={u.login}>
                  {u.isBot ? t('page.newIssue.agent', { login: u.login }) : u.name}
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
          <option value="">{field.defaultValue ? t('page.newIssue.theProjectSDefault') : t('page.newIssue.notSet')}</option>
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

/**
 * What another app shared into a4a (its share target, D47): a page's title, its words, its address.
 * Android often puts the address in the words; either way it ends up once in the description.
 */
export function fromShare(params: URLSearchParams): { summary: string; description: string } {
  const title = params.get('title')?.trim() ?? '';
  const text = params.get('text')?.trim() ?? '';
  const url = params.get('url')?.trim() ?? '';
  const words = text && text !== title ? text : '';
  const firstLine = words.split('\n').find((l) => l.trim())?.trim() ?? '';
  const summary = (title || (firstLine && !/^https?:\/\//.test(firstLine) ? firstLine : '') || url).slice(0, 500);
  const description = [words === summary ? '' : words, url && !words.includes(url) && url !== summary ? url : ''].filter(Boolean).join('\n\n');
  return { summary, description };
}

export default function NewIssuePage() {
  const navigate = useNavigate();
  const qc = useQueryClient();
  const [params] = useSearchParams();
  const projects = useProjects();
  const ai = useAIStatus();
  const [project, setProject] = useState(params.get('project') ?? '');
  const shared = useMemo(() => fromShare(params), [params]);
  const [summary, setSummary] = useState(shared.summary);
  const [description, setDescription] = useState(shared.description);
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

  // A private field only for who may set it (D50); to anyone else it isn't there at all.
  const setsPrivate = Boolean(projects.data?.find((p) => p.key === project)?.access.permissions.includes('editPrivate'));
  const asked = useMemo(
    () => (projectFields.data ?? []).filter((f) => ASKED.includes(f.name) && (!f.private || setsPrivate)).sort((a, b) => ASKED.indexOf(a.name) - ASKED.indexOf(b.name)),
    [projectFields.data, setsPrivate],
  );

  // Pictures pasted before the issue exists (D39): held, then uploaded to it, each where its mark stands.
  const heldPictures = useRef<{ files: File[]; marks: string[] }[]>([]);
  const descriptionRef = useRef(description);
  descriptionRef.current = description;
  const settlePictures = async (issueId: string) => {
    for (const entry of heldPictures.current) {
      for (const [i, file] of entry.files.entries()) {
        const placed = await uploadFile(`/issues/${encodeURIComponent(issueId)}/attachments`, file, () => {}).then(
          (stored) => (stored.inline ? { kind: 'image' as const, name: stored.name, href: imagePath(stored.id) } : { kind: 'link' as const, name: stored.name, href: contentPath(stored) }),
          () => null,
        );
        const mark = entry.marks[i]!;
        setDescription((d) => (d.includes(mark) ? d.replace(mark, placed ? placedMarkdown(placed) : '') : d));
      }
    }
    heldPictures.current = [];
    const now = descriptionRef.current;
    if (now !== description) await patch<IssueDetail>(`/issues/${issueId}`, { description: now }).catch(() => {});
  };

  const create = async () => {
    setBusy(true);
    setError(null);
    try {
      const chosen = Object.fromEntries(Object.entries(fields).filter(([, v]) => v !== ''));
      const issue = await post<IssueDetail>('/issues', { project, summary: summary.trim(), description, fields: chosen }, { idempotencyKey: key });
      await qc.invalidateQueries({ queryKey: ['issues', 'list'] });
      navigate(`/issues/${issue.id}`);
      if (heldPictures.current.length) void settlePictures(issue.id);
    } catch (e) {
      setError(e);
      setBusy(false);
    }
  };

  if (projects.isLoading) return <Loading what="loadingLine.projects" />;
  if (projects.error) return <ErrorNote error={projects.error} />;
  const triageOn = ai.data?.enabled;

  return (
    <>
      <PageHead
        crumbs={<Link to="/issues">{t('page.newIssue.issues')}</Link>}
        title={t('page.newIssue.newIssue')}
        about={triageOn ? t('page.newIssue.sayWhatHappenedTriageSuggests') : t('page.newIssue.sayWhatHappenedAndWhat')}
      />
      <div className="split">
        <form
          className="card form"
          onSubmit={(e) => {
            e.preventDefault();
            if (summary.trim() && project) void create();
          }}
        >
          <FormField label={t('page.newIssue.project')}>
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
          <FormField label={t('page.newIssue.summary')}>
            {(id) => <input id={id} value={summary} onChange={(e) => setSummary(e.target.value)} required maxLength={500} autoFocus placeholder={t('page.newIssue.loginFailsOnSafariWith')} />}
          </FormField>
          <FormField label={t('page.newIssue.description')}>
            {(id) => (
              <RichField
                id={id}
                label={t('page.newIssue.description')}
                value={description}
                onChange={setDescription}
                rows={8}
                placeholder={t('page.newIssue.stepsWhatYouExpectedWhat')}
                writing={{ kind: 'description', project: project || undefined, title: summary || undefined }}
                holdPictures={(files, marks) => {
                  heldPictures.current.push({ files, marks });
                }}
              />
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
            <Link to="/issues" className="button">{t('page.newIssue.cancel')}</Link>
            <button type="submit" className="primary" disabled={!summary.trim() || !project || busy}>
              {busy ? t('page.newIssue.reporting') : t('page.newIssue.reportIt')}
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
