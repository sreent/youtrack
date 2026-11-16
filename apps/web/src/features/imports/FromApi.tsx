/**
 * Reading issues from another tracker's API (YouTrack, Jira, GitHub Issues, Redmine, Zendesk): the
 * form that starts it, the token asked for again
 * (to carry on, or to bring files as it runs), and what an import from an API reads. The token
 * lives in this page's memory and goes only to a4a's server, which uses it and doesn't keep it.
 */
import type { ApiImportSource, Import, ImportCredentials } from '@a4a/shared';
import { useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { useNavigate } from 'react-router';
import { useProjects } from '../../api/queries';
import { errorText, FormField, Said } from '../common/bits';
import { plural } from '../plan/format';
import { holdCredentials, importFromApi, importKeys } from './api';
import { formatBytes } from '../attachments/api';

type Source = ApiImportSource;
export const SOURCE_NAME: Record<Source, string> = { youtrack: 'YouTrack', jira: 'Jira', github: 'GitHub Issues', redmine: 'Redmine', zendesk: 'Zendesk' };

const ADDRESS: Record<Source, string> = {
  youtrack: 'https://example.youtrack.cloud',
  jira: 'https://example.atlassian.net',
  github: 'https://api.github.com',
  redmine: 'https://redmine.example.com',
  zendesk: 'https://example.zendesk.com',
};

/** Which issues, in each tracker's words: the field's label, its help and an example. */
const WHICH: Record<Source, { label: string; help: string; example: string }> = {
  youtrack: { label: 'Which issues: a query', help: 'As you would search in YouTrack, such as project: BACK or project: BACK #Unresolved.', example: 'project: BACK' },
  jira: { label: 'Which issues: a JQL', help: "As you would search in Jira's advanced search, such as project = BACK.", example: 'project = BACK' },
  github: { label: 'Which issues: a repository', help: 'owner/name, then state:open, label:bug or since:2026-01-01 if you like. Pull requests are left out.', example: 'acme/backend' },
  redmine: { label: "Which issues: a project's identifier", help: 'As in its address: /projects/backend is backend. Every status, open or closed.', example: 'backend' },
  zendesk: { label: 'Which tickets', help: 'all, or since 2026-01-01 for the tickets changed since then. Into a help desk: requesters and public replies come as they were.', example: 'all' },
};

/** The token's words for each tracker. */
const TOKEN: Record<Exclude<Source, 'jira'>, { label: string; help: string }> = {
  youtrack: { label: 'Permanent token', help: 'In YouTrack: your profile, Account Security, Tokens. It starts perm:.' },
  github: { label: 'Token', help: 'A fine-grained token with Issues read access to the repository, or a classic one with repo.' },
  redmine: { label: 'API key', help: 'In Redmine: My account, API access key. The REST API must be on (Administration, Settings, API).' },
  zendesk: { label: 'API token', help: 'In Zendesk: Admin Center, Apps and integrations, Zendesk API. With the email of the agent it belongs to.' },
};

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
      {source === 'zendesk' ? (
        <FormField label="The agent's email" help="The Zendesk agent the API token belongs to. Leave it empty for an OAuth token.">
          {(id, help) => (
            <input id={id} type="email" aria-describedby={help} autoComplete="off" value={credentials.email ?? ''} onChange={(e) => onChange({ ...credentials, email: e.target.value || undefined })} />
          )}
        </FormField>
      ) : null}
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
        label={source !== 'jira' ? TOKEN[source].label : cloud === false ? 'Personal access token' : 'Token'}
        help={
          source !== 'jira'
            ? TOKEN[source].help
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

/** Start an import from another tracker's API. */
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
      <h2 id="from-api">Read from another tracker</h2>
      <form
        className="form"
        onSubmit={async (e) => {
          e.preventDefault();
          if (!project) return setProblem('Choose the project to import into.');
          setBusy(true);
          setProblem(null);
          try {
            const sent = { ...credentials, token: credentials.token.trim(), ...((source === 'jira' || source === 'zendesk') && credentials.email ? { email: credentials.email.trim() } : { email: undefined }) };
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
            {(['youtrack', 'jira', 'github', 'redmine', 'zendesk'] as const).map((s) => (
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
        <FormField label={WHICH[source].label} help={WHICH[source].help}>
          {(id, help) => <input id={id} className="mono" aria-describedby={help} required placeholder={WHICH[source].example} value={query} onChange={(e) => setQuery(e.target.value)} />}
        </FormField>
        <fieldset className="choice-group">
          <legend>With each issue</legend>
          {(
            [
              ['comments', 'Its comments'],
              ['work', source === 'youtrack' ? 'Its work items' : source === 'redmine' ? 'Its time entries' : 'Its worklogs'],
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
    o.bring.work ? plural(f.work, o.kind === 'youtrack' ? 'work item' : o.kind === 'redmine' ? 'time entry' : 'worklog', o.kind === 'redmine' ? 'time entries' : undefined) : null,
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
