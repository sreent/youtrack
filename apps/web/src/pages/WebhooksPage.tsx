import type { Webhook } from '@a4a/shared';
import { EVENT_TYPES } from '@a4a/shared/constants';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { del, patch, post } from '../api/client';
import { keys, useProjects, useWebhooks } from '../api/queries';
import { ago, Badge } from '../components/Badges';
import { ErrorNote, Loading, PageHead } from '../components/States';
import { AdminOnly, errorText, FormField, Said, Scroll } from '../features/common/bits';
import { Confirm } from '../features/common/Confirm';
import { CopyButton } from '../features/common/CopyButton';
import { whenRead } from '../features/common/format';
import { pageKeys, useDeliveries } from '../features/common/queries';

const EVENT_WORDS: Record<(typeof EVENT_TYPES)[number], string> = {
  'issue.created': 'an issue is created',
  'issue.updated': 'an issue changes',
  'issue.deleted': 'an issue is deleted',
  'issue.moved': 'an issue moves to another project',
  'sla.warning': "a help desk request's SLA target is at risk",
  'sla.breached': "a help desk request goes past its SLA target",
  'comment.created': 'someone comments',
  'comment.updated': 'a comment is edited',
  'comment.deleted': 'a comment is deleted',
  'link.created': 'issues are linked',
  'link.deleted': 'issues are unlinked',
  'work.logged': 'work is logged',
  'work.deleted': 'logged work is removed',
  'ai.triage.completed': 'triage suggests changes',
  'baseline.created': 'a baseline is saved',
  'project.member.added': 'someone is given a role in a project',
  'project.member.changed': 'someone’s role in a project changes',
  'project.member.removed': 'someone is taken out of a project',
  'project.visibility.changed': 'who sees a project changes',
  'attachment.added': 'a file is attached',
  'attachment.removed': 'a file is removed',
  'article.created': 'an article is written',
  'article.updated': 'an article changes or moves',
  'article.deleted': 'an article is deleted',
  'sprint.issue_added': 'an issue joins a sprint',
  'sprint.issue_removed': 'an issue leaves a sprint',
  'commit.linked': 'a commit mentions an issue',
  'pull_request.linked': 'a pull request mentions an issue',
  'pull_request.updated': 'a pull request is merged or closed',
  'rule.notified': 'a workflow rule tells people',
  'rule.called': 'a workflow rule calls it',
  'project.group.added': 'a group is given a role in a project',
  'project.group.changed': 'a group’s role in a project changes',
  'project.group.removed': 'a group is taken out of a project',
};

/** What a webhook can listen for: a rule's call goes only to the webhook the rule names. */
const SUBSCRIBABLE = EVENT_TYPES.filter((t) => t !== 'rule.called');

const VERIFY = `import { createHmac, timingSafeEqual } from 'node:crypto';

// body: the request's raw bytes, as they arrived
const mac = createHmac('sha256', secret).update(body);
const expected = 'sha256=' + mac.digest('hex');
const given = req.headers['x-a4a-signature'] ?? '';
const genuine = given.length === expected.length &&
  timingSafeEqual(Buffer.from(given), Buffer.from(expected));`;

function Deliveries({ hook }: { hook: Webhook }) {
  const deliveries = useDeliveries(hook.id, true);
  if (deliveries.isLoading) return <Loading what="its deliveries" />;
  if (deliveries.error) return <ErrorNote error={deliveries.error} />;
  if (!deliveries.data?.length) return <p className="note">Nothing sent yet. Send a test, or wait for the next change.</p>;
  return (
    <Scroll label="Table of recent deliveries">
      <table className="figures">
        <thead>
          <tr>
            <th scope="col">When</th>
            <th scope="col">Event</th>
            <th scope="col">How it went</th>
            <th scope="col" className="num">
              Try
            </th>
            <th scope="col" className="num">
              Took
            </th>
          </tr>
        </thead>
        <tbody>
          {deliveries.data.map((d) => (
            <tr key={d.id}>
              <td>
                <time dateTime={d.createdAt} title={d.createdAt}>
                  {whenRead(d.createdAt)}
                </time>
              </td>
              <td>
                <span className="mono">{d.eventType}</span>
                {d.eventId !== null ? <span className="item-about">event {d.eventId}</span> : <span className="item-about">a test</span>}
              </td>
              <td>
                {d.success ? (
                  <Badge tone="good">delivered{d.statusCode ? `, ${d.statusCode}` : ''}</Badge>
                ) : (
                  <Badge tone="bad">failed{d.statusCode ? `, ${d.statusCode}` : ''}</Badge>
                )}
                {d.error && !d.success ? <span className="item-about">{d.error}</span> : null}
              </td>
              <td className="num">{d.attempt} of 3</td>
              <td className="num mono">{d.durationMs} ms</td>
            </tr>
          ))}
        </tbody>
      </table>
    </Scroll>
  );
}

function HookCard({ hook, projectName }: { hook: Webhook; projectName?: string }) {
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);
  const [said, setSaid] = useState<{ text: string; bad?: boolean } | null>(null);
  const toggle = useMutation({
    // Send its events too: the PATCH body's defaults would otherwise reset them to every event.
    mutationFn: (active: boolean) => patch<Webhook>(`/webhooks/${hook.id}`, { active, events: hook.events }),
    onSuccess: (h) => {
      void qc.invalidateQueries({ queryKey: keys.webhooks });
      setSaid({ text: h.active ? 'It sends again, from the next change.' : 'It is paused: nothing is sent until you turn it back on.' });
    },
    onError: (e) => setSaid({ text: errorText(e), bad: true }),
  });
  const test = useMutation({
    mutationFn: () => post<{ delivered: boolean }>(`/webhooks/${hook.id}/test`),
    onSuccess: (r) => {
      setOpen(true);
      void qc.invalidateQueries({ queryKey: pageKeys.deliveries(hook.id) });
      setSaid(r.delivered ? { text: 'The test arrived.' } : { text: "The test didn't arrive. Its attempts are below.", bad: true });
    },
    onError: (e) => setSaid({ text: errorText(e), bad: true }),
  });
  const remove = useMutation({
    mutationFn: () => del(`/webhooks/${hook.id}`),
    onSuccess: () => void qc.invalidateQueries({ queryKey: keys.webhooks }),
    onError: (e) => setSaid({ text: errorText(e), bad: true }),
  });
  const all = hook.events.includes('*');
  return (
    <li className="card hook">
      <div className="hook-head">
        <div className="hook-what">
          <span className="mono hook-url">{hook.url}</span>
          <span className="item-about">
            {all ? 'Every change' : `When ${hook.events.map((e) => EVENT_WORDS[e as keyof typeof EVENT_WORDS] ?? e).join(', or ')}`}
            {' · '}
            {hook.project ? `in ${projectName ?? hook.project}` : 'in every project'}
            {' · '}added {ago(hook.createdAt)}
          </span>
        </div>
        {hook.active ? <Badge tone="good">sends</Badge> : <Badge tone="idle">paused</Badge>}
      </div>
      <div className="cluster">
        <button type="button" onClick={() => test.mutate()} disabled={test.isPending}>
          {test.isPending ? 'Sending…' : 'Send a test'}
        </button>
        <button type="button" onClick={() => toggle.mutate(!hook.active)} disabled={toggle.isPending}>
          {hook.active ? 'Pause it' : 'Turn it back on'}
        </button>
        <button type="button" className="link" aria-expanded={open} onClick={() => setOpen((o) => !o)}>
          {open ? 'Hide its deliveries' : 'Show its deliveries'}
        </button>
        <span className="grow" />
        <Confirm
          small
          label="Delete it"
          title={`Delete the webhook to ${hook.url}?`}
          about="a4a stops sending to it at once, and its delivery log goes with it. Nobody can bring them back."
          confirm="Delete it"
          disabled={remove.isPending}
          onConfirm={() => remove.mutate()}
        />
      </div>
      <Said text={said?.text} tone={said?.bad ? 'bad' : undefined} />
      {open ? (
        <div className="hook-log">
          <h3>Recent deliveries</h3>
          <Deliveries hook={hook} />
        </div>
      ) : null}
    </li>
  );
}

function AddHook() {
  const qc = useQueryClient();
  const projects = useProjects();
  const [url, setUrl] = useState('');
  const [all, setAll] = useState(true);
  const [events, setEvents] = useState<Set<string>>(() => new Set(['issue.created', 'issue.updated']));
  const [project, setProject] = useState('');
  const [created, setCreated] = useState<(Webhook & { secret: string }) | null>(null);
  const add = useMutation({
    mutationFn: () =>
      post<Webhook & { secret: string }>('/webhooks', {
        url: url.trim(),
        events: all ? ['*'] : SUBSCRIBABLE.filter((e) => events.has(e)),
        project: project || null,
        active: true,
      }),
    onSuccess: (h) => {
      setCreated(h);
      setUrl('');
      void qc.invalidateQueries({ queryKey: keys.webhooks });
    },
  });
  return (
    <section className="card" aria-labelledby="add-hook">
      <h2 id="add-hook">Add a webhook</h2>
      <form
        className="form"
        onSubmit={(e) => {
          e.preventDefault();
          add.mutate();
        }}
      >
        <div className="form-fields">
          <FormField
            label="Where to send"
            help="a4a posts to it from the server, so it can reach addresses inside your network: add only ones you trust."
            className="tw:col-span-full"
          >
            {(id, help) => (
              <input
                id={id}
                aria-describedby={help}
                type="url"
                value={url}
                onChange={(e) => setUrl(e.target.value)}
                required
                placeholder="https://ci.example.com/a4a"
                className="mono"
              />
            )}
          </FormField>
          <FormField label="From">
            {(id) => (
              <select id={id} value={project} onChange={(e) => setProject(e.target.value)}>
                <option value="">Every project</option>
                {(projects.data ?? []).map((p) => (
                  <option key={p.key} value={p.key}>
                    {p.key} only
                  </option>
                ))}
              </select>
            )}
          </FormField>
        </div>
        <fieldset className="choice-group columns">
          <legend>When</legend>
          <label className="choice tw:col-span-full">
            <input type="checkbox" checked={all} onChange={(e) => setAll(e.target.checked)} />
            <span>Every change, including kinds added later</span>
          </label>
          {!all
            ? SUBSCRIBABLE.map((t) => (
                <label key={t} className="choice">
                  <input
                    type="checkbox"
                    checked={events.has(t)}
                    onChange={() =>
                      setEvents((s) => {
                        const n = new Set(s);
                        if (n.has(t)) n.delete(t);
                        else n.add(t);
                        return n;
                      })
                    }
                  />
                  <span>
                    {EVENT_WORDS[t][0]!.toUpperCase() + EVENT_WORDS[t].slice(1)}
                    <small className="field-help mono">{t}</small>
                  </span>
                </label>
              ))
            : null}
        </fieldset>
        <div className="cluster">
          <button type="submit" className="primary" disabled={add.isPending || !url.trim() || (!all && !events.size)}>
            {add.isPending ? 'Adding…' : 'Add the webhook'}
          </button>
        </div>
        {add.error ? <ErrorNote error={add.error} /> : null}
      </form>
      {created ? (
        <div className="secret" role="status">
          <p>
            <strong>Copy its secret now.</strong> This is the only time a4a shows it. Your receiver checks each delivery's signature with it.
          </p>
          <code>{created.secret}</code>
          <div className="cluster">
            <CopyButton text={created.secret} label="Copy the secret" what="the secret" />
            <button type="button" className="link" onClick={() => setCreated(null)}>
              I've kept it
            </button>
          </div>
        </div>
      ) : null}
    </section>
  );
}

/** Where a4a sends each change, signed: the addresses, a test, and how each delivery went. */
export default function WebhooksPage() {
  const hooks = useWebhooks();
  const projects = useProjects();
  const names = new Map((projects.data ?? []).map((p) => [p.key, p.name]));
  return (
    <AdminOnly title="Webhooks">
      <PageHead
        title="Webhooks"
        about="a4a posts each change to the addresses here as it happens, signed, so your systems can act on it: CI, chat, a dashboard."
      />
      <section className="card" aria-labelledby="hooks">
        <h2 id="hooks">Where it sends</h2>
        {hooks.isLoading ? <Loading what="webhooks" /> : null}
        {hooks.error ? <ErrorNote error={hooks.error} /> : null}
        {hooks.data && !hooks.data.length ? <p className="note">Nowhere yet. Add a webhook, then send it a test.</p> : null}
        {hooks.data?.length ? (
          <ul className="hooks">
            {hooks.data.map((h) => (
              <HookCard key={h.id} hook={h} projectName={h.project ? names.get(h.project) : undefined} />
            ))}
          </ul>
        ) : null}
      </section>
      <div className="tw:grid tw:grid-cols-[repeat(auto-fit,minmax(min(100%,24rem),1fr))] tw:items-start tw:gap-x-4">
        <AddHook />
        <section className="card" aria-labelledby="how">
          <h2 id="how">How deliveries work</h2>
          <p className="note">Each delivery is a POST of the change as JSON, the same as GET /api/v1/events gives.</p>
          <dl className="facts-list">
            <div className="pair">
              <dt>Signed</dt>
              <dd>
                <code>X-A4A-Signature: sha256=&lt;HMAC of the body&gt;</code>: an HMAC-SHA256 of the raw body, with the webhook's secret.
              </dd>
            </div>
            <div className="pair">
              <dt>At least once</dt>
              <dd>
                A change can arrive twice. Keep the <code>X-A4A-Event-Id</code> of what you've handled, and skip it when it comes again.
              </dd>
            </div>
            <div className="pair">
              <dt>Retried</dt>
              <dd>Up to 3 tries, a second and then four seconds apart. An answer in the 400s other than 408 or 429 isn't retried.</dd>
            </div>
            <div className="pair">
              <dt>Also sent</dt>
              <dd>
                <code>X-A4A-Event</code>, its kind, and <code>X-A4A-Delivery</code>, the try's own id.
              </dd>
            </div>
          </dl>
          <h3>Checking the signature, in Node</h3>
          <div className="stack tight">
            <pre className="snippet code" tabIndex={0} aria-label="Checking the signature, in Node">
              {VERIFY}
            </pre>
            <div className="cluster">
              <CopyButton text={VERIFY} label="Copy it" what="the check" />
            </div>
          </div>
        </section>
      </div>
    </AdminOnly>
  );
}
