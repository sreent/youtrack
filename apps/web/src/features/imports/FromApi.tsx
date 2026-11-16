/**
 * Reading issues from YouTrack's or Jira's API: the form that starts it, the token asked for again
 * (to carry on, or to bring files as it runs), and what an import from an API reads. The token
 * lives in this page's memory and goes only to a4a's server, which uses it and doesn't keep it.
 */
import type { Import, ImportCredentials } from '@a4a/shared';
import { useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { useNavigate } from 'react-router';
import { useProjects } from '../../api/queries';
import { errorText, FormField, Said } from '../common/bits';
import { plural } from '../plan/format';
import { holdCredentials, importFromApi, importKeys } from './api';
import { formatBytes } from '../attachments/api';

type Source = 'youtrack' | 'jira';
export const SOURCE_NAME: Record<Source, string> = { youtrack: 'YouTrack', jira: 'Jira' };

const ADDRESS: Record<Source, string> = { youtrack: 'https://example.youtrack.cloud', jira: 'https://example.atlassian.net' };

/** The token's fields: a token, and for Jira Cloud the email of its account. */
export function TokenFields({
  source,
  cloud,
  credentials,
  onChange,
}: {
  source: Source;
  /** Jira: whether to ask for the email (Cloud); null to offer it as optional. */
  cloud: boolean | null;
  credentials: ImportCredentials;
  onChange: (c: ImportCredentials) => void;
}) {
  return (
    <div className="form-fields">
      {source === 'jira' && cloud !== false ? (
        <FormField
          label={cloud ? "Your Atlassian account's email" : 'Email, for Jira Cloud'}
          help={cloud ? 'The account the API token belongs to.' : 'Jira Cloud takes your Atlassian account\'s email with an API token. Leave it empty for Jira Data Center, whose personal access token is enough.'}
        >
          {(id, help) => (
            <input
              id={id}
              type="email"
              aria-describedby={help}
              autoComplete="off"
              required={cloud === true}
              value={credentials.email ?? ''}
              onChange={(e) => onChange({ ...credentials, email: e.target.value || undefined })}
            />
          )}
        </FormField>
      ) : null}
      <FormField
        label={source === 'youtrack' ? 'Permanent token' : cloud === false ? 'Personal access token' : 'Token'}
        help={
          source === 'youtrack'
            ? 'In YouTrack: your profile, Account Security, Tokens. It starts perm:.'
            : cloud === false
              ? 'In Jira: your profile, Personal Access Tokens.'
              : 'Jira Cloud: an API token (id.atlassian.com, Security). Jira Data Center: a personal access token.'
        }
      >
        {(id, help) => (
          <input id={id} type="password" className="mono" aria-describedby={help} autoComplete="off" required value={credentials.token} onChange={(e) => onChange({ ...credentials, token: e.target.value })} />
        )}
      </FormField>
    </div>
  );
}

/** Start an import from YouTrack's or Jira's API. */
export function FromApiForm() {
  const navigate = useNavigate();
  const qc = useQueryClient();
  const projects = (useProjects().data ?? []).filter((p) => !p.archived && p.access.manage);
  const [project, setProject] = useState('');
  const [source, setSource] = useState<Source>('youtrack');
  const [url, setUrl] = useState('');
  const [query, setQuery] = useState('');
  const [credentials, setCredentials] = useState<ImportCredentials>({ token: '' });
  const [bring, setBring] = useState({ comments: true, work: true, files: true });
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  return (
    <section className="card" aria-labelledby="from-api">
      <h2 id="from-api">Read from YouTrack or Jira</h2>
      <form
        className="form"
        onSubmit={async (e) => {
          e.preventDefault();
          if (!project) return setProblem('Choose the project to import into.');
          setBusy(true);
          setProblem(null);
          try {
            const sent = { ...credentials, token: credentials.token.trim(), ...(source === 'jira' && credentials.email ? { email: credentials.email.trim() } : { email: undefined }) };
            const imp = await importFromApi({ project, source, url: url.trim(), query: query.trim(), credentials: sent, bring });
            holdCredentials(imp.id, sent);
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
          <FormField label="Into the project">
            {(id) => (
              <select id={id} value={project} onChange={(e) => setProject(e.target.value)}>
                <option value="">Choose a project</option>
                {projects.map((p) => (
                  <option key={p.id} value={p.key}>
                    {p.name}
                  </option>
                ))}
              </select>
            )}
          </FormField>
          <fieldset className="choice-group">
            <legend>From</legend>
            {(['youtrack', 'jira'] as const).map((s) => (
              <label key={s} className="choice">
                <input type="radio" name="api-source" value={s} checked={source === s} onChange={() => setSource(s)} />
                <span>{SOURCE_NAME[s]}</span>
              </label>
            ))}
          </fieldset>
        </div>
        <FormField label="Its address" help={`Where you open ${SOURCE_NAME[source]}, such as ${ADDRESS[source]}. https.`}>
          {(id, help) => <input id={id} type="url" aria-describedby={help} required placeholder={ADDRESS[source]} value={url} onChange={(e) => setUrl(e.target.value)} />}
        </FormField>
        <TokenFields source={source} cloud={source === 'jira' ? null : false} credentials={credentials} onChange={setCredentials} />
        <FormField
          label={source === 'youtrack' ? 'Which issues: a query' : 'Which issues: a JQL'}
          help={source === 'youtrack' ? "As you would search in YouTrack, such as project: BACK or project: BACK #Unresolved." : "As you would search in Jira's advanced search, such as project = BACK."}
        >
          {(id, help) => <input id={id} className="mono" aria-describedby={help} required placeholder={source === 'youtrack' ? 'project: BACK' : 'project = BACK'} value={query} onChange={(e) => setQuery(e.target.value)} />}
        </FormField>
        <fieldset className="choice-group">
          <legend>With each issue</legend>
          {(
            [
              ['comments', 'Its comments'],
              ['work', source === 'youtrack' ? 'Its work items' : 'Its worklogs'],
              ['files', 'Its files'],
            ] as const
          ).map(([key, label]) => (
            <label key={key} className="choice">
              <input type="checkbox" checked={bring[key]} onChange={(e) => setBring({ ...bring, [key]: e.target.checked })} />
              <span>{label}</span>
            </label>
          ))}
        </fieldset>
        <p className="note">
          a4a uses the token to read the issues, and again to bring their files as the import runs. It doesn't keep it: importing again asks for it again. Issues and comments only some people may
          see there are left out.
        </p>
        {problem ? <Said text={problem} tone="bad" /> : null}
        <div className="cluster end">
          <button type="submit" className="primary" disabled={busy}>
            {busy ? 'Reading…' : 'Read the issues'}
          </button>
        </div>
      </form>
    </section>
  );
}

/** What an import from an API reads: where, which issues, as whom, and what came with them. */
export function OriginSummary({ imp }: { imp: Import }) {
  const o = imp.origin!;
  const f = o.fetch;
  const name = SOURCE_NAME[o.kind];
  const brought = [
    o.bring.comments ? plural(f.comments, 'comment') : null,
    o.bring.work ? plural(f.work, o.kind === 'youtrack' ? 'work item' : 'worklog') : null,
    o.bring.files ? `${plural(f.files, 'file')}${f.files ? ` (${formatBytes(f.fileBytes)})` : ''}` : null,
  ].filter(Boolean);
  return (
    <p className="note">
      From {name} at <span className="mono">{o.url}</span>, the issues matching <code>{o.query}</code>
      {o.account ? `, read as ${o.account}` : ''}: {plural(f.issues, 'issue')}
      {brought.length ? `, with ${brought.join(', ')}` : ''}.
      {f.left.issues ? ` ${plural(f.left.issues, 'issue')} only some people may see there ${f.left.issues === 1 ? 'is' : 'are'} left out.` : ''}
    </p>
  );
}
