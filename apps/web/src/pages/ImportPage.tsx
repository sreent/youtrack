import type { Import, ImportCheck, ImportUndo } from '@a4a/shared';
import { useQueryClient } from '@tanstack/react-query';
import { useId, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router';
import { useLinkTypes, useProjectFields, useProjects } from '../api/queries';
import { Badge } from '../components/Badges';
import { Icon } from '../components/Icon';
import { ErrorNote, Loading, PageHead } from '../components/States';
import { Said, errorText } from '../features/common/bits';
import { Confirm } from '../features/common/Confirm';
import { checkImport, importKeys, putMapping, runImport, undoImport, uploadFile, useImport, useImportRows, useImports } from '../features/imports/api';
import { ColumnsTable, ProblemsTable, Tally, ValuesTable } from '../features/imports/MappingTable';
import { whenRead } from '../features/common/format';
import { plural } from '../features/plan/format';

const SOURCES: Record<Import['source'], string> = { jira: 'Jira', youtrack: 'YouTrack', csv: 'a CSV file' };
const STAGES = [
  { name: 'Upload the export', about: "Jira's or YouTrack's, as CSV." },
  { name: 'Map it', about: 'Its columns to the project\'s fields, and its states, priorities and people to a4a\'s.' },
  { name: 'Check it', about: 'What it would create and update, and each row\'s problems. Nothing changes.' },
  { name: 'Import it', about: 'As a job you can leave. Running it again never makes an issue twice.' },
  { name: 'Read what it did', about: 'What it made, what it left out, and why; and undo it, if you need to.' },
];

/** Ocean's JourneyPath: the stages of an import, each done, now or later. */
function Stages({ now }: { now: number }) {
  return (
    <div className="journey-box">
      <ol className="journey" aria-label="The import's steps">
        {STAGES.map((s, i) => {
          const state = i < now ? 'done' : i === now ? 'now' : 'later';
          return (
            <li key={s.name} className={state} aria-current={state === 'now' ? 'step' : undefined}>
              <span className="journey-mark" aria-hidden="true">
                {state === 'done' ? <Icon name="check" /> : i + 1}
              </span>
              <span>
                <strong>{s.name}</strong>
                <span className="hidden">{state === 'done' ? ', done' : state === 'now' ? ', to do now' : ''}</span>
                <span className="journey-about">{s.about}</span>
              </span>
            </li>
          );
        })}
      </ol>
    </div>
  );
}

function Upload() {
  const navigate = useNavigate();
  const qc = useQueryClient();
  // Importing is managing a project: the ones you manage.
  const projects = (useProjects().data ?? []).filter((p) => !p.archived && p.access.manage);
  const past = useImports();
  const id = useId();
  const [project, setProject] = useState('');
  const [source, setSource] = useState('');
  const [file, setFile] = useState<File | null>(null);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  return (
    <>
      <Stages now={0} />
      <section className="card" aria-labelledby={`${id}-h`}>
        <h2 id={`${id}-h`}>Upload an export</h2>
        <form
          className="form"
          onSubmit={async (e) => {
            e.preventDefault();
            if (!project) return setProblem('Choose the project to import into.');
            if (!file) return setProblem('Choose the CSV file to import.');
            setBusy(true);
            setProblem(null);
            try {
              const imp = await uploadFile(file, project, source || undefined);
              await qc.invalidateQueries({ queryKey: importKeys.list });
              navigate(`/import/${imp.id}`);
            } catch (err) {
              setProblem(errorText(err));
            } finally {
              setBusy(false);
            }
          }}
        >
          <div className="form-fields">
            <div className="form-field">
              <label htmlFor={`${id}-project`}>Into the project</label>
              <select id={`${id}-project`} value={project} onChange={(e) => setProject(e.target.value)}>
                <option value="">Choose a project</option>
                {projects.map((p) => (
                  <option key={p.id} value={p.key}>
                    {p.name}
                  </option>
                ))}
              </select>
            </div>
            <div className="form-field">
              <label htmlFor={`${id}-source`}>From</label>
              <select id={`${id}-source`} value={source} onChange={(e) => setSource(e.target.value)}>
                <option value="">Whichever wrote it (a4a reads it from the headers)</option>
                <option value="jira">Jira</option>
                <option value="youtrack">YouTrack</option>
                <option value="csv">Another tracker</option>
              </select>
            </div>
          </div>
          <div className="form-field">
            <label htmlFor={`${id}-file`}>The CSV file</label>
            <input id={`${id}-file`} type="file" accept=".csv,text/csv" aria-describedby={`${id}-file-help`} onChange={(e) => setFile(e.target.files?.[0] ?? null)} />
            <small className="field-help" id={`${id}-file-help`}>
              In Jira, export the issues as CSV (all fields); in YouTrack, as CSV from the issues list. Up to 64 MB and 50,000 rows. Nothing is imported until you say so.
            </small>
          </div>
          {problem ? <Said text={problem} tone="bad" /> : null}
          <div className="cluster end">
            <button type="submit" className="primary" disabled={busy}>
              {busy ? 'Uploading…' : 'Upload it'}
            </button>
          </div>
        </form>
      </section>
      {past.data?.length ? (
        <section className="card" aria-labelledby={`${id}-past`}>
          <h2 id={`${id}-past`}>Imports so far</h2>
          <ul className="directory">
            {past.data.map((i) => (
              <li key={i.id}>
                <span className="directory-name">
                  <Link to={`/import/${i.id}`}>{i.fileName}</Link>
                  <span className="issue-id">{i.project.key}</span>
                </span>
                <p className="note">
                  From {SOURCES[i.source]}, {plural(i.rows, 'row')}, {whenRead(i.createdAt)}
                  {i.result ? `, ${i.result.created} created, ${i.result.updated} updated` : ''} · {i.status}
                </p>
              </li>
            ))}
          </ul>
        </section>
      ) : null}
    </>
  );
}

function Progress({ imp }: { imp: Import }) {
  const { done, total, phase } = imp.progress;
  const pct = total ? Math.round((done / total) * 100) : 0;
  const words = phase === 'links' ? `Linking: ${done} of ${plural(total, 'issue')}` : `Importing: ${done} of ${plural(total, 'row')}`;
  return (
    <div className="import-progress" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={pct} aria-valuetext={words} aria-label="How far the import is">
      <svg aria-hidden="true">
        <rect className="import-progress-track" width="100%" height="100%" rx="3" />
        <rect className="import-progress-done" width={`${pct}%`} height="100%" rx="3" />
      </svg>
      <p>{words}. You can leave this page; it carries on.</p>
    </div>
  );
}

function Report({ imp }: { imp: Import }) {
  const qc = useQueryClient();
  const problems = useImportRows(imp.id, 'problems', true);
  const created = useImportRows(imp.id, 'created', true);
  const [undo, setUndo] = useState<ImportUndo | null>(null);
  const [said, setSaid] = useState<{ text: string; tone?: 'bad' } | null>(null);
  const r = imp.result!;
  const rows = problems.data?.items ?? [];
  return (
    <>
      <section className="card stack" aria-label="What the import did">
        <div className="section-head">
          <h2>What it did</h2>
          {imp.status === 'undone' ? <Badge tone="idle">Undone</Badge> : <Badge tone="good">Done</Badge>}
        </div>
        <Tally counts={r} label="What it did" />
        {r.linksMissing ? <p className="note">{plural(r.linksMissing, 'link')} named issues neither in the file nor imported before, so they were left out.</p> : null}
        {created.data?.items.length ? (
          <p className="note">
            It made{' '}
            {created.data.items.slice(0, 12).map((row, i) => (
              <span key={row.row}>
                {i ? ', ' : ''}
                <Link className="issue-id" to={`/issues/${row.issue}`}>
                  {row.issue}
                </Link>
              </span>
            ))}
            {created.data.total > 12 ? ` and ${created.data.total - 12} more` : ''}.
          </p>
        ) : null}
      </section>
      {rows.length ? (
        <section className="card stack" aria-label="Rows with problems">
          <h2>{plural(problems.data!.total, 'row')} with problems</h2>
          <ProblemsTable problems={rows.flatMap((row) => row.problems)} caption="Problems, row by row" />
        </section>
      ) : null}
      <section className="card stack" aria-label="Undo">
        <h2>Undo it</h2>
        <p className="note">
          Undoing takes away the issues this import created, unless someone has worked on them since. Changes it made to issues that were already here stay: writing their old values back over whatever
          happened since wouldn't be safe.
        </p>
        <Said text={said?.text} tone={said?.tone} />
        {undo && !undo.applied ? (
          <div className="stack">
            <p>
              {undo.remove.length ? `${plural(undo.remove.length, 'issue')} would go.` : 'Nothing would go.'}{' '}
              {undo.keep.length ? `${plural(undo.keep.length, 'issue')} would stay, because someone has worked on them since:` : ''}
            </p>
            {undo.keep.length ? (
              <ul>
                {undo.keep.map((k) => (
                  <li key={k.issue}>
                    <Link className="issue-id" to={`/issues/${k.issue}`}>
                      {k.issue}
                    </Link>
                    : {k.why}
                  </li>
                ))}
              </ul>
            ) : null}
            {undo.remove.length ? (
              <Confirm
                label={`Undo the import of ${plural(undo.remove.length, 'issue')}`}
                title={`Delete the ${plural(undo.remove.length, 'issue')} this import created?`}
                about="Their comments, links and logged time go with them, and nobody can bring them back. Running the import again would make them afresh."
                confirm="Delete them"
                onConfirm={async () => {
                  try {
                    const done = await undoImport(imp.id, false);
                    setUndo(done);
                    setSaid({ text: `${plural(done.remove.length, 'issue')} taken away${done.keep.length ? `; ${done.keep.length} stayed` : ''}.` });
                    await qc.invalidateQueries({ queryKey: importKeys.all });
                    await qc.invalidateQueries({ queryKey: ['issues'] });
                  } catch (e) {
                    setSaid({ text: errorText(e), tone: 'bad' });
                  }
                }}
              />
            ) : null}
          </div>
        ) : (
          <div className="cluster">
            <button type="button" disabled={imp.status === 'undone'} onClick={async () => setUndo(await undoImport(imp.id, true).catch((e) => (setSaid({ text: errorText(e), tone: 'bad' }), null)))}>
              See what undoing would do
            </button>
          </div>
        )}
      </section>
    </>
  );
}

function ImportSteps({ imp }: { imp: Import }) {
  const qc = useQueryClient();
  const fields = useProjectFields(imp.project.key);
  const links = useLinkTypes();
  const phrases = [...new Set((links.data ?? []).flatMap((l) => [l.outward.toLowerCase(), l.inward.toLowerCase()]))];
  const [check, setCheck] = useState<ImportCheck | null>(null);
  const [said, setSaid] = useState<{ text: string; tone?: 'bad' } | null>(null);
  const [busy, setBusy] = useState(false);
  const running = imp.status === 'running';
  const finished = imp.status === 'done' || imp.status === 'undone';
  const stage = running ? 3 : finished ? 4 : check ? 3 : 1;

  const change = async (body: Parameters<typeof putMapping>[1]) => {
    try {
      const next = await putMapping(imp.id, body);
      qc.setQueryData(importKeys.one(imp.id), next);
      setCheck(null);
      setSaid({ text: 'Saved. Check it again to see what it would do now.' });
    } catch (e) {
      setSaid({ text: errorText(e), tone: 'bad' });
    }
  };

  return (
    <>
      <Stages now={stage} />
      <Said text={said?.text} tone={said?.tone} />
      {imp.status === 'stopped' ? (
        <p className="error-note" role="alert">
          <Icon name="cross" />
          <strong>The import stopped before it finished, as when the server restarts.</strong>
        </p>
      ) : null}
      {imp.error ? <ErrorNote error={new Error(imp.error)} /> : null}
      {running ? (
        <section className="card stack" aria-label="Importing">
          <h2>Importing into {imp.project.name}</h2>
          <Progress imp={imp} />
        </section>
      ) : null}
      {finished && imp.result ? <Report imp={imp} /> : null}
      {!running && !finished ? (
        <>
          <section className="card stack" aria-labelledby="map-columns">
            <div className="section-head">
              <h2 id="map-columns">Its columns</h2>
              <p className="note">
                {imp.fileName}, from {SOURCES[imp.source]}: {plural(imp.rows, 'row')}, {plural(imp.columns.length, 'column')}.
              </p>
            </div>
            {fields.data ? <ColumnsTable imp={imp} fields={fields.data} phrases={phrases} onTarget={(i, t) => change({ columns: { [String(i)]: t } })} /> : <Loading what="the project's fields" />}
          </section>
          {imp.values.map((map) => (
            <section key={map.target} className="card stack" aria-labelledby={`values-${map.target}`}>
              <div className="section-head">
                <h2 id={`values-${map.target}`}>{map.label}</h2>
                <p className="note">What each {map.label === 'Sprint' ? 'sprint' : 'value'} in the file becomes here.</p>
              </div>
              <ValuesTable map={map} onValue={(value, to) => change({ values: { [map.target]: { [value]: to } } })} />
            </section>
          ))}
          <section className="card stack" aria-labelledby="check-it">
            <h2 id="check-it">Check it, then import it</h2>
            <fieldset className="choice-group column">
              <legend>An issue imported before, found again by its key</legend>
              {(['update', 'skip'] as const).map((o) => (
                <label key={o} className="choice">
                  <input type="radio" name="onExisting" checked={imp.options.onExisting === o} onChange={() => change({ options: { onExisting: o } })} />{' '}
                  {o === 'update' ? 'Update what changed in the export since; what someone changed here stays' : 'Leave it as it is'}
                </label>
              ))}
            </fieldset>
            <p className="note">Dates without a time zone are read in {imp.options.timeZone}.</p>
            <div className="cluster">
              <button
                type="button"
                disabled={busy}
                onClick={async () => {
                  setBusy(true);
                  try {
                    setCheck(await checkImport(imp.id));
                    setSaid(null);
                  } catch (e) {
                    setSaid({ text: errorText(e), tone: 'bad' });
                  } finally {
                    setBusy(false);
                  }
                }}
              >
                Check it
              </button>
              {check ? (
                <button
                  type="button"
                  className="primary"
                  disabled={busy || check.counts.created + check.counts.updated === 0}
                  onClick={async () => {
                    setBusy(true);
                    try {
                      qc.setQueryData(importKeys.one(imp.id), await runImport(imp.id));
                    } catch (e) {
                      setSaid({ text: errorText(e), tone: 'bad' });
                    } finally {
                      setBusy(false);
                    }
                  }}
                >
                  Import {plural(check.counts.created + check.counts.updated, 'issue')}
                </button>
              ) : null}
            </div>
            {check ? (
              <div className="stack" aria-live="polite">
                <Tally counts={check.counts} label="What it would do" planned />
                {check.warnings.length ? (
                  <ul className="note">
                    {check.warnings.map((w) => (
                      <li key={w}>{w}</li>
                    ))}
                  </ul>
                ) : null}
                <ProblemsTable problems={check.problems} caption="Problems, row by row" />
                {check.counts.problems > check.problems.length ? <p className="note">The first {check.problems.length} of {plural(check.counts.problems, 'problem')}.</p> : null}
              </div>
            ) : null}
          </section>
        </>
      ) : null}
    </>
  );
}

export default function ImportPage() {
  const { id } = useParams();
  const imp = useImport(id);
  return (
    <ManagersOnly>
      <PageHead
        title="Import"
        crumbs={
          id ? (
            <>
              <Link to="/import">Import</Link>
              <span className="sep" aria-hidden="true">
                /
              </span>
            </>
          ) : undefined
        }
        about="Bring issues over from Jira or YouTrack: their fields, comments, links and dates, recorded in each issue's history as imported."
      />
      <div className="stack">
        {!id ? <Upload /> : null}
        {id && imp.isLoading ? <Loading what="the import" /> : null}
        {id && imp.error ? <ErrorNote error={imp.error} /> : null}
        {imp.data ? <ImportSteps imp={imp.data} /> : null}
      </div>
    </ManagersOnly>
  );
}

/** For someone who manages a project; others are told who can import. */
function ManagersOnly({ children }: { children: React.ReactNode }) {
  const projects = useProjects();
  if (projects.data && !projects.data.some((p) => p.access.manage)) {
    return <PageHead title="Import" about="Importing is for a project's managers and administrators. Ask a manager of the project to import into it." />;
  }
  return <>{children}</>;
}
