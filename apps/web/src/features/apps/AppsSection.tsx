/**
 * Apps, for administrators (D48): what's installed, what each may do and where it runs, its
 * settings and run log; installing from a package or a catalog after reading what it asks for;
 * updating, asking again only for more; and removing, after saying what goes.
 */
import type { App, AppPackagePreview, AppPermissions, AppRemoval, AppRun, AppSettingDef, AppSettings, CatalogApp, CatalogList } from '@a4a/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useId, useState } from 'react';
import { del, get, patch, post, put } from '../../api/client';
import { useProjects } from '../../api/queries';
import { ago } from '../../components/Badges';
import { ErrorNote, Loading } from '../../components/States';
import { errorText, FormField, Said } from '../common/bits';
import { Confirm } from '../common/Confirm';
import { appKeys, base64Of } from './api';

const EXTENSION_WORDS: Record<string, string> = {
  'issue-panel': "an issue's side panel",
  'issue-below-summary': "below an issue's summary",
  'project-settings': "a project's page",
  'main-menu': 'a page of its own, from the menu',
  dashboard: 'dashboards',
  'article-panel': "an article's side",
};

type Source = { kind: 'upload'; package: string } | { kind: 'catalog'; catalog: string; name: string; version: string };

/** What an app asks for and adds, as the person deciding reads it. */
function Asks({ p }: { p: AppPackagePreview }) {
  const more = p.more && (p.more.read.length || p.more.write.length) ? p.more : null;
  return (
    <div className="stack tight">
      <div className="app-card-head">
        <div>
          <h3>
            {p.title} <span className="note">{p.version}{p.vendor ? ` · ${p.vendor}` : ''}</span>
          </h3>
          {p.description ? <p className="note">{p.description}</p> : null}
        </div>
      </div>
      <p className="label">{p.installed ? `It's installed at ${p.installed.version}. This version may` : 'It asks to'}</p>
      {p.words.length ? (
        <ul className="app-may" aria-label="What it asks to do">
          {p.words.map((w) => (
            <li key={w}>{w}</li>
          ))}
        </ul>
      ) : (
        <p className="note">Nothing of a4a's: it reads and writes none of it.</p>
      )}
      {more ? <p className="approval-note">It asks for more than the installed version was granted: {[...more.read.map((r) => `reading ${r}`), ...more.write.map((r) => `writing ${r}`)].join(', ')}.</p> : null}
      <p className="note">
        It adds{' '}
        {[
          ...p.widgets.map((w) => `“${w.title}” on ${EXTENSION_WORDS[w.at] ?? w.at}`),
          ...p.handlers.map((h) => `a handler, “${h.title}”`),
          ...p.rules.map((r) => `a rule, “${r.title}”, acting as its own agent`),
        ].join('; ')}
        . {p.signedBy ? `Signed by the trusted key ${p.signedBy}.` : 'Not signed.'} {p.files} files, {(p.bytes / 1024).toFixed(0)} KB, SHA-256 <span className="mono">{p.sha256.slice(0, 12)}…</span>
      </p>
    </div>
  );
}

/** Where it runs: every project, or the ones chosen. */
function WhereFields({ every, setEvery, chosen, setChosen }: { every: boolean; setEvery: (v: boolean) => void; chosen: Set<string>; setChosen: (v: Set<string>) => void }) {
  const projects = useProjects();
  const id = useId();
  return (
    <div className="stack tight" role="group" aria-labelledby={id}>
      <p className="label" id={id}>
        Where it runs
      </p>
      <label className="approval-pick">
        <input type="checkbox" checked={every} onChange={(e) => setEvery(e.target.checked)} /> Every project, those made later too
      </label>
      {!every
        ? (projects.data ?? []).map((p) => (
            <label key={p.key} className="approval-pick">
              <input
                type="checkbox"
                checked={chosen.has(p.key)}
                onChange={(e) => {
                  const next = new Set(chosen);
                  if (e.target.checked) next.add(p.key);
                  else next.delete(p.key);
                  setChosen(next);
                }}
              />{' '}
              <span className="mono">{p.key}</span> {p.name}
            </label>
          ))
        : null}
    </div>
  );
}

/** Deciding on a package: what it asks, where it runs, and installing or updating it. */
function Decide({ preview, source, onDone, onCancel }: { preview: AppPackagePreview; source: Source; onDone: (said: string) => void; onCancel: () => void }) {
  const qc = useQueryClient();
  const [every, setEvery] = useState(false);
  const [chosen, setChosen] = useState<Set<string>>(new Set());
  const [said, setSaid] = useState<string | null>(null);
  const updating = Boolean(preview.installed);
  const accept: AppPermissions = preview.asks;
  const go = useMutation({
    mutationFn: async () => {
      const where = { allProjects: every, projects: every ? undefined : [...chosen] };
      if (source.kind === 'upload') {
        return updating ? put<App>(`/apps/${preview.name}/package`, { package: source.package, accept }) : post<App>('/apps', { package: source.package, accept, ...where });
      }
      return post<App>('/apps/catalog/install', { catalog: source.catalog, name: source.name, version: source.version, accept, ...(updating ? {} : where) });
    },
    onSuccess: (app) => {
      void qc.invalidateQueries({ queryKey: appKeys.all });
      onDone(updating ? `${app.title} is updated to ${app.version}.` : `${app.title} is installed${app.allProjects ? ', for every project' : app.projects.length ? `, for ${app.projects.map((p) => p.key).join(', ')}` : ': choose where it runs'}.`);
    },
    onError: (e) => setSaid(errorText(e)),
  });
  return (
    <section className="card stack" aria-label={`Install ${preview.title}`}>
      <Asks p={preview} />
      {!updating ? <WhereFields every={every} setEvery={setEvery} chosen={chosen} setChosen={setChosen} /> : null}
      <Said text={said} tone="bad" />
      <div className="cluster">
        <button type="button" className="primary" onClick={() => go.mutate()} disabled={go.isPending}>
          {go.isPending ? 'Installing…' : updating ? `Update to ${preview.version}` : 'Install it'}
        </button>
        <button type="button" onClick={onCancel}>
          Don’t
        </button>
      </div>
    </section>
  );
}

function useSettingsForm({ app, project }: { app: string; project: string | null }) {
  const qc = useQueryClient();
  const settings = useQuery({ queryKey: appKeys.settings(app, project), queryFn: () => get<AppSettings>(`/apps/${app}/settings${project ? `?project=${encodeURIComponent(project)}` : ''}`) });
  const [said, setSaid] = useState<{ text: string; bad?: boolean } | null>(null);
  const save = useMutation({
    mutationFn: (values: Record<string, string | number | boolean | null>) => put<AppSettings>(`/apps/${app}/settings`, { project, values }),
    onSuccess: () => {
      setSaid({ text: 'Saved.' });
      void qc.invalidateQueries({ queryKey: appKeys.settings(app, project) });
    },
    onError: (e) => setSaid({ text: errorText(e), bad: true }),
  });
  return { settings, save, said };
}

function Settings({ defs, app, project }: { defs: AppSettingDef[]; app: string; project: string | null }) {
  const { settings, save, said } = useSettingsForm({ app, project });
  const [draft, setDraft] = useState<Record<string, string | boolean>>({});
  if (!defs.length) return null;
  const valueOf = (d: AppSettingDef): string | boolean => {
    if (d.name in draft) return draft[d.name]!;
    const v = settings.data?.values[d.name];
    if (d.type === 'secret') return '';
    if (d.type === 'boolean') return Boolean(v);
    return v === null || v === undefined ? '' : String(v);
  };
  return (
    <form
      className="form-fields"
      aria-label="Its settings"
      onSubmit={(e) => {
        e.preventDefault();
        const values: Record<string, string | number | boolean | null> = {};
        for (const d of defs) {
          if (!(d.name in draft)) continue;
          const v = draft[d.name]!;
          values[d.name] = d.type === 'number' ? (v === '' ? null : Number(v)) : v;
        }
        save.mutate(values);
        setDraft({});
      }}
    >
      {settings.isLoading ? <Loading what="its settings" /> : null}
      {defs.map((d) => {
        const secretSet = d.type === 'secret' && (settings.data?.values[d.name] as { set?: boolean } | undefined)?.set;
        return (
          <FormField key={d.name} label={d.title} help={d.type === 'secret' ? `${d.description ?? ''} ${secretSet ? 'It’s set; a4a never shows it.' : 'Not set.'}`.trim() : (d.description ?? undefined)}>
            {(id, help) =>
              d.type === 'boolean' ? (
                <input id={id} aria-describedby={help} type="checkbox" checked={Boolean(valueOf(d))} onChange={(e) => setDraft({ ...draft, [d.name]: e.target.checked })} />
              ) : d.type === 'choice' ? (
                <select id={id} aria-describedby={help} value={String(valueOf(d))} onChange={(e) => setDraft({ ...draft, [d.name]: e.target.value })}>
                  {(d.choices ?? []).map((c) => (
                    <option key={c}>{c}</option>
                  ))}
                </select>
              ) : (
                <input
                  id={id}
                  aria-describedby={help}
                  type={d.type === 'secret' ? 'password' : d.type === 'number' ? 'number' : 'text'}
                  autoComplete="off"
                  value={String(valueOf(d))}
                  placeholder={d.type === 'secret' && secretSet ? '••••••••' : d.default !== null ? String(d.default) : ''}
                  onChange={(e) => setDraft({ ...draft, [d.name]: e.target.value })}
                />
              )
            }
          </FormField>
        );
      })}
      <div className="cluster tw:col-span-full">
        <button type="submit" disabled={save.isPending || !Object.keys(draft).length}>
          Save its settings
        </button>
        <Said text={said?.text} tone={said?.bad ? 'bad' : undefined} />
      </div>
    </form>
  );
}

function Runs({ app }: { app: string }) {
  const runs = useQuery({ queryKey: appKeys.runs(app), queryFn: () => get<AppRun[]>(`/apps/${app}/runs`) });
  if (runs.isLoading) return <Loading what="its runs" />;
  if (runs.error) return <ErrorNote error={runs.error} />;
  if (!runs.data?.length) return <p className="note">Its handlers and rules haven’t run yet.</p>;
  return (
    <table className="figures" aria-label="What it did">
      <thead>
        <tr>
          <th scope="col">When</th>
          <th scope="col">What</th>
          <th scope="col">Issue</th>
          <th scope="col">How it went</th>
        </tr>
      </thead>
      <tbody>
        {runs.data.slice(0, 20).map((r) => (
          <tr key={r.id}>
            <td>{ago(r.at)}</td>
            <td>
              {r.kind === 'handler' ? 'Handler' : 'Rule'} {r.name}
              {r.by ? <span className="note"> for {r.by.name}</span> : null}
            </td>
            <td className="mono">{r.issue ?? '—'}</td>
            <td>
              {r.outcome}
              {r.message ? <span className="note"> · {r.message.slice(0, 140)}</span> : null}
              {r.ms !== null ? <span className="note"> · {r.ms} ms</span> : null}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function InstalledApp({ app }: { app: App }) {
  const qc = useQueryClient();
  const [open, setOpen] = useState<'where' | 'settings' | 'runs' | null>(null);
  const [every, setEvery] = useState(app.allProjects);
  const [chosen, setChosen] = useState<Set<string>>(new Set(app.projects.filter((p) => !p.off || app.allProjects).map((p) => p.key)));
  const [said, setSaid] = useState<{ text: string; bad?: boolean } | null>(null);
  const titleId = useId();
  const change = useMutation({
    mutationFn: (body: { enabled?: boolean; allProjects?: boolean; projects?: string[] }) => patch<App>(`/apps/${app.name}`, body),
    onSuccess: (a) => {
      setSaid({ text: a.enabled ? 'Saved.' : `${a.title} is off: none of it runs or shows.` });
      void qc.invalidateQueries({ queryKey: appKeys.all });
    },
    onError: (e) => setSaid({ text: errorText(e), bad: true }),
  });
  const removal = useQuery({ queryKey: ['app-removal', app.name], queryFn: () => get<AppRemoval>(`/apps/${app.name}/removal`), enabled: false });
  const remove = async () => {
    try {
      await del(`/apps/${app.name}`);
      void qc.invalidateQueries({ queryKey: appKeys.all });
    } catch (e) {
      setSaid({ text: errorText(e), bad: true });
    }
  };
  const where = app.allProjects ? 'every project' : app.projects.filter((p) => p.enabled).map((p) => p.key).join(', ') || 'no project yet';
  const r = removal.data;
  return (
    <li className="card app-card" aria-labelledby={titleId}>
      <div className="app-card-head">
        <span className="app-icon" aria-hidden="true">
          {app.iconUrl ? <img src={app.iconUrl} alt="" /> : null}
        </span>
        <div>
          <h3 id={titleId}>
            {app.title} <span className="note">{app.version}{app.vendor ? ` · ${app.vendor}` : ''}</span>
          </h3>
          {app.description ? <p className="note">{app.description}</p> : null}
        </div>
      </div>
      <p className="label">It may</p>
      <ul className="app-may">
        {app.words.map((w) => (
          <li key={w}>{w}</li>
        ))}
      </ul>
      <p className="note">
        {app.enabled ? `Runs in ${where}.` : 'Off: none of it runs or shows.'} Its rules act as {app.agent.login}. Installed {ago(app.installedAt)}
        {app.installedBy ? ` by ${app.installedBy.name}` : ''}
        {app.source.kind === 'catalog' ? ', from a catalog' : ''}.
      </p>
      <div className="cluster">
        <button type="button" className="small" onClick={() => change.mutate({ enabled: !app.enabled })} disabled={change.isPending}>
          {app.enabled ? 'Turn it off' : 'Turn it on'}
        </button>
        <button type="button" className="small" aria-expanded={open === 'where'} onClick={() => setOpen(open === 'where' ? null : 'where')}>
          Where it runs
        </button>
        {app.settings.some((s) => s.scope === 'app') ? (
          <button type="button" className="small" aria-expanded={open === 'settings'} onClick={() => setOpen(open === 'settings' ? null : 'settings')}>
            Settings
          </button>
        ) : null}
        <button type="button" className="small" aria-expanded={open === 'runs'} onClick={() => setOpen(open === 'runs' ? null : 'runs')}>
          What it did
        </button>
        <span onFocusCapture={() => !removal.data && void removal.refetch()} onMouseEnter={() => !removal.data && void removal.refetch()}>
          <Confirm
            small
            label="Remove it"
            name={`Remove ${app.title}`}
            title={`Remove ${app.title}?`}
            about={
              r
                ? `Its ${r.rules} ${r.rules === 1 ? 'rule' : 'rules'}, ${r.widgets} ${r.widgets === 1 ? 'widget' : 'widgets'} and ${r.handlers} ${r.handlers === 1 ? 'handler' : 'handlers'} go, with ${r.settings} settings, ${r.stored} stored ${r.stored === 1 ? 'value' : 'values'}, ${r.runs} runs in its log, and its agent ${r.agent}. Nobody can bring them back.`
                : 'Its rules, widgets, handlers, settings, what it stored, its run log and its agent go. Nobody can bring them back.'
            }
            confirm="Remove it"
            onConfirm={() => void remove()}
          />
        </span>
      </div>
      {open === 'where' ? (
        <form
          className="stack tight"
          onSubmit={(e) => {
            e.preventDefault();
            change.mutate({ allProjects: every, projects: [...chosen] });
          }}
        >
          <WhereFields every={every} setEvery={setEvery} chosen={chosen} setChosen={setChosen} />
          {app.projects.some((p) => p.off) ? <p className="note">Turned off by their managers: {app.projects.filter((p) => p.off).map((p) => p.key).join(', ')}.</p> : null}
          <div className="cluster">
            <button type="submit" className="small primary" disabled={change.isPending}>
              Save where it runs
            </button>
          </div>
        </form>
      ) : null}
      {open === 'settings' ? <Settings defs={app.settings.filter((s) => s.scope === 'app')} app={app.name} project={null} /> : null}
      {open === 'runs' ? <Runs app={app.name} /> : null}
      <Said text={said?.text} tone={said?.bad ? 'bad' : undefined} />
    </li>
  );
}

function Catalog({ onPick }: { onPick: (a: CatalogApp) => void }) {
  const catalog = useQuery({ queryKey: appKeys.catalog, queryFn: () => get<CatalogList>('/apps/catalog'), staleTime: 60_000 });
  if (catalog.isLoading) return <Loading what="the catalogs" />;
  if (catalog.error) return <ErrorNote error={catalog.error} />;
  const c = catalog.data!;
  return (
    <div className="stack tight">
      {c.problems.map((p) => (
        <p key={p.catalog} className="error-line" role="alert">
          {p.message}
        </p>
      ))}
      {c.apps.length ? (
        <table className="figures" aria-label="Apps in the catalogs">
          <thead>
            <tr>
              <th scope="col">App</th>
              <th scope="col">Version</th>
              <th scope="col">From</th>
              <th scope="col" className="fit">
                <span className="hidden">Install</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {c.apps.map((a) => (
              <tr key={`${a.catalog}/${a.name}`}>
                <td>
                  <strong>{a.title}</strong>
                  {a.description ? <span className="note"> · {a.description}</span> : null}
                </td>
                <td>
                  {a.version}
                  {a.installed ? <span className="note"> · {a.installed} installed</span> : null}
                </td>
                <td>
                  {a.catalogName}
                  {a.signed ? <span className="note"> · signed</span> : null}
                </td>
                <td className="fit">
                  {!a.installed || a.update ? (
                    <button type="button" className="small" onClick={() => onPick(a)} aria-label={`${a.update ? 'Update' : 'Install'} ${a.title}`}>
                      {a.update ? 'Update' : 'Install'}
                    </button>
                  ) : (
                    <span className="note">Installed</span>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : (
        <p className="note">{c.problems.length ? 'Nothing to show from them.' : 'No catalog lists an app. Catalogs are set on the server, in APP_CATALOGS.'}</p>
      )}
    </div>
  );
}

/** Apps: installed, and installing. */
export function AppsSection() {
  const apps = useQuery({ queryKey: appKeys.list, queryFn: () => get<App[]>('/apps') });
  const [deciding, setDeciding] = useState<{ preview: AppPackagePreview; source: Source } | null>(null);
  const [said, setSaid] = useState<{ text: string; bad?: boolean } | null>(null);
  const [reading, setReading] = useState(false);
  const [showCatalog, setShowCatalog] = useState(false);
  const fileId = useId();
  const read = async (file: File | undefined) => {
    if (!file) return;
    setSaid(null);
    setReading(true);
    try {
      const pkg = await base64Of(file);
      const preview = await post<AppPackagePreview>('/apps/preview', { package: pkg });
      setDeciding({ preview, source: { kind: 'upload', package: pkg } });
    } catch (e) {
      setSaid({ text: errorText(e), bad: true });
    } finally {
      setReading(false);
    }
  };
  const pick = async (a: CatalogApp) => {
    setSaid(null);
    setReading(true);
    try {
      const preview = await post<AppPackagePreview>('/apps/catalog/preview', { catalog: a.catalog, name: a.name, version: a.version });
      setDeciding({ preview, source: { kind: 'catalog', catalog: a.catalog, name: a.name, version: a.version } });
    } catch (e) {
      setSaid({ text: errorText(e), bad: true });
    } finally {
      setReading(false);
    }
  };
  return (
    <section className="card" aria-labelledby="apps">
      <div className="section-head">
        <h2 id="apps">Apps</h2>
        <span className="note">What apps add to a4a, and what each may do</span>
      </div>
      <p className="note section-note">
        An app adds widgets to a4a’s pages, handlers to its API and rules to its workflows. It may do only what you accept when you install it, where you choose, and
        its rules act as an agent of its own. Its widgets run in a sandbox, and do for each person only what that person may.
      </p>
      <div className="stack">
        {apps.isLoading ? <Loading what="apps" /> : null}
        {apps.error ? <ErrorNote error={apps.error} /> : null}
        {apps.data?.length ? (
          <ul className="plain stack" aria-label="Installed apps">
            {apps.data.map((a) => (
              <InstalledApp key={a.name} app={a} />
            ))}
          </ul>
        ) : apps.data ? (
          <p className="note">No apps are installed.</p>
        ) : null}
        {deciding ? (
          <Decide
            preview={deciding.preview}
            source={deciding.source}
            onDone={(text) => {
              setDeciding(null);
              setSaid({ text });
            }}
            onCancel={() => setDeciding(null)}
          />
        ) : (
          <div className="cluster">
            <label className="button" htmlFor={fileId}>
              {reading ? 'Reading it…' : 'Install from a file'}
            </label>
            <input id={fileId} className="hidden" type="file" accept=".zip,application/zip" onChange={(e) => void read(e.target.files?.[0])} />
            <button type="button" aria-expanded={showCatalog} onClick={() => setShowCatalog(!showCatalog)}>
              From a catalog
            </button>
          </div>
        )}
        {showCatalog && !deciding ? <Catalog onPick={(a) => void pick(a)} /> : null}
        <Said text={said?.text} tone={said?.bad ? 'bad' : undefined} />
      </div>
    </section>
  );
}
