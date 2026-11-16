import type { AppSettings, ProjectApp } from '@a4a/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { get, put } from '../../api/client';
import { ErrorNote, Loading } from '../../components/States';
import { errorText, FormField, Said } from '../common/bits';
import { appKeys } from './api';

function ProjectSettings({ app, project }: { app: ProjectApp; project: string }) {
  const qc = useQueryClient();
  const settings = useQuery({ queryKey: appKeys.settings(app.name, project), queryFn: () => get<AppSettings>(`/apps/${app.name}/settings?project=${encodeURIComponent(project)}`) });
  const [draft, setDraft] = useState<Record<string, string>>({});
  const [said, setSaid] = useState<{ text: string; bad?: boolean } | null>(null);
  const save = useMutation({
    mutationFn: () => put<AppSettings>(`/apps/${app.name}/settings`, { project, values: Object.fromEntries(Object.entries(draft).map(([k, v]) => [k, v === '' ? null : v])) }),
    onSuccess: () => {
      setDraft({});
      setSaid({ text: 'Saved.' });
      void qc.invalidateQueries({ queryKey: appKeys.settings(app.name, project) });
    },
    onError: (e) => setSaid({ text: errorText(e), bad: true }),
  });
  if (!app.settings.length) return null;
  return (
    <form
      className="form-fields"
      aria-label={`${app.title}'s settings for ${project}`}
      onSubmit={(e) => {
        e.preventDefault();
        save.mutate();
      }}
    >
      {app.settings.map((d) => (
        <FormField key={d.name} label={d.title} help={d.description ?? undefined}>
          {(id, help) => (
            <input
              id={id}
              aria-describedby={help}
              type={d.type === 'secret' ? 'password' : d.type === 'number' ? 'number' : 'text'}
              autoComplete="off"
              value={draft[d.name] ?? (d.type === 'secret' ? '' : String(settings.data?.values[d.name] ?? ''))}
              onChange={(e) => setDraft({ ...draft, [d.name]: e.target.value })}
            />
          )}
        </FormField>
      ))}
      <div className="cluster tw:col-span-full">
        <button type="submit" className="small" disabled={save.isPending || !Object.keys(draft).length}>
          Save
        </button>
        <Said text={said?.text} tone={said?.bad ? 'bad' : undefined} />
      </div>
    </form>
  );
}

/** The apps an administrator chose for a project, which its managers can turn off here (D48). */
export function ProjectApps({ project }: { project: string }) {
  const qc = useQueryClient();
  const apps = useQuery({ queryKey: appKeys.project(project), queryFn: () => get<ProjectApp[]>(`/projects/${project}/apps`) });
  const [said, setSaid] = useState<{ text: string; bad?: boolean } | null>(null);
  const toggle = useMutation({
    mutationFn: (a: ProjectApp) => put<ProjectApp>(`/projects/${project}/apps/${a.name}`, { on: !a.enabled }),
    onSuccess: (a) => {
      setSaid({ text: a.enabled ? `${a.title} runs in ${project} again.` : `${a.title} is off in ${project}: none of it runs or shows here.` });
      void qc.invalidateQueries({ queryKey: appKeys.all });
    },
    onError: (e) => setSaid({ text: errorText(e), bad: true }),
  });
  if (apps.isLoading) return <Loading what="its apps" />;
  if (apps.error) return <ErrorNote error={apps.error} />;
  if (!apps.data?.length) return <p className="note">No app is chosen for it. Administrators install apps and choose where they run.</p>;
  return (
    <div className="stack">
      <ul className="plain stack" aria-label={`Apps in ${project}`}>
        {apps.data.map((a) => (
          <li key={a.name} className="app-card">
            <div className="cluster spread">
              <span>
                <strong>{a.title}</strong> <span className="note">{a.version} · {a.enabled ? 'runs here' : 'off here'}</span>
              </span>
              <button type="button" className="small" onClick={() => toggle.mutate(a)} disabled={toggle.isPending} aria-label={`${a.enabled ? 'Turn off' : 'Turn on'} ${a.title} in ${project}`}>
                {a.enabled ? 'Turn it off here' : 'Turn it on here'}
              </button>
            </div>
            {a.description ? <p className="note">{a.description}</p> : null}
            <ul className="app-may" aria-label={`What ${a.title} may do`}>
              {a.words.map((w) => (
                <li key={w}>{w}</li>
              ))}
            </ul>
            {a.enabled ? <ProjectSettings app={a} project={project} /> : null}
          </li>
        ))}
      </ul>
      <Said text={said?.text} tone={said?.bad ? 'bad' : undefined} />
    </div>
  );
}
