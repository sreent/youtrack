import { EVENT_TYPES, type Webhook } from '@a4a/shared';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { del, patch, post } from '../api/client';
import { keys, useProjects, useWebhooks } from '../api/queries';
import { ago, Badge } from '../components/Badges';
import { ErrorNote, Loading, PageHead } from '../components/States';
import { AdminOnly, errorText, Said } from '../features/common/bits';
import { Confirm } from '../features/common/Confirm';
import { CopyButton } from '../features/common/CopyButton';
import { whenRead } from '../features/common/format';
import { pageKeys, useDeliveries } from '../features/common/queries';
import '../features/common/pages.css';

const EVENT_WORDS: Record<(typeof EVENT_TYPES)[number], string> = {
  'issue.created': 'an issue is created',
  'issue.updated': 'an issue changes',
  'issue.deleted': 'an issue is deleted',
  'comment.created': 'someone comments',
  'comment.updated': 'a comment is edited',
  'comment.deleted': 'a comment is deleted',
  'link.created': 'issues are linked',
  'link.deleted': 'issues are unlinked',
  'work.logged': 'work is logged',
  'work.deleted': 'logged work is removed',
  'ai.triage.completed': 'triage suggests changes',
  'baseline.created': 'a baseline is saved',
};

const VERIFY = `import { createHmac, timingSafeEqual } from 'node:crypto';

// rawBody: the request's bytes, exactly as they arrived.
const expected = 'sha256=' + createHmac('sha256', process.env.A4A_WEBHOOK_SECRET)
  .update(rawBody).digest('hex');
const given = request.headers['x-a4a-signature'];
const genuine = given?.length === expected.length
  && timingSafeEqual(Buffer.from(given), Buffer.from(expected));`;

function Deliveries({ hook }: { hook: Webhook }) {
  const deliveries = useDeliveries(hook.id, true);
  if (deliveries.isLoading) return <Loading what="its deliveries" />;
  if (deliveries.error) return <ErrorNote error={deliveries.error} />;
  if (!deliveries.data?.length) return <p className="note">Nothing sent yet. Send a test, or wait for the next change.</p>;
  return (
    <div className="a4p-scroll">
      <table className="figures a4p-deliveries">
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
                <span className="a4p-mono">{d.eventType}</span>
                {d.eventId !== null ? <span className="a4p-row-about">event {d.eventId}</span> : <span className="a4p-row-about">a test</span>}
              </td>
              <td>
                {d.success ? <Badge tone="good">delivered{d.statusCode ? `, ${d.statusCode}` : ''}</Badge> : <Badge tone="bad">failed{d.statusCode ? `, ${d.statusCode}` : ''}</Badge>}
                {d.error && !d.success ? <span className="a4p-row-about">{d.error}</span> : null}
              </td>
              <td className="num">{d.attempt} of 3</td>
              <td className="num a4p-mono">{d.durationMs} ms</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function HookCard({ hook, projectName }: { hook: Webhook; projectName?: string }) {
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);
  const [said, setSaid] = useState<{ text: string; bad?: boolean } | null>(null);
  const toggle = useMutation({
    mutationFn: (active: boolean) => patch<Webhook>(`/webhooks/${hook.id}`, { active }),
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
    <li className="card a4p-hook">
      <div className="a4p-hook-head">
        <div className="a4p-hook-what">
          <span className="a4p-mono a4p-hook-url">{hook.url}</span>
          <span className="a4p-row-about">
            {all ? 'Every change' : `When ${hook.events.map((e) => EVENT_WORDS[e as keyof typeof EVENT_WORDS] ?? e).join(', or ')}`}
            {' · '}
            {hook.project ? `in ${projectName ?? hook.project}` : 'in every project'}
            {' · '}added {ago(hook.createdAt)}
          </span>
        </div>
        {hook.active ? <Badge tone="good">sends</Badge> : <Badge tone="idle">paused</Badge>}
      </div>
      <div className="a4p-actions">
        <button type="button" onClick={() => test.mutate()} disabled={test.isPending}>
          {test.isPending ? 'Sending…' : 'Send a test'}
        </button>
        <button type="button" onClick={() => toggle.mutate(!hook.active)} disabled={toggle.isPending}>
          {hook.active ? 'Pause it' : 'Turn it back on'}
        </button>
        <button type="button" className="link" aria-expanded={open} onClick={() => setOpen((o) => !o)}>
          {open ? 'Hide its deliveries' : 'Show its deliveries'}
        </button>
        <span className="a4p-grow" />
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
        <div className="a4p-hook-deliveries">
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
        events: all ? ['*'] : EVENT_TYPES.filter((e) => events.has(e)),
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
        className="a4p-form"
        onSubmit={(e) => {
          e.preventDefault();
          add.mutate();
        }}
      >
        <div className="a4p-fields">
          <label className="a4p-field a4p-wide">
            <span>Where to send</span>
            <input type="url" value={url} onChange={(e) => setUrl(e.target.value)} required placeholder="https://ci.example.com/a4a" className="a4p-mono-input" />
            <small>a4a posts to it from the server, so it can reach addresses inside your network: add only ones you trust.</small>
          </label>
          <label className="a4p-field">
            <span>From</span>
            <select value={project} onChange={(e) => setProject(e.target.value)}>
              <option value="">Every project</option>
              {(projects.data ?? []).map((p) => (
                <option key={p.key} value={p.key}>
                  {p.key} only
                </option>
              ))}
            </select>
          </label>
        </div>
        <fieldset className="a4p-checks a4p-events">
          <legend>When</legend>
          <label className="a4p-check a4p-wide">
            <input type="checkbox" checked={all} onChange={(e) => setAll(e.target.checked)} />
            <span>Every change, including kinds added later</span>
          </label>
          {!all
            ? EVENT_TYPES.map((t) => (
                <label key={t} className="a4p-check">
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
                    <small className="a4p-mono">{t}</small>
                  </span>
                </label>
              ))
            : null}
        </fieldset>
        <div className="a4p-actions">
          <button type="submit" className="primary" disabled={add.isPending || !url.trim() || (!all && !events.size)}>
            {add.isPending ? 'Adding…' : 'Add the webhook'}
          </button>
        </div>
        {add.error ? (
          <p className="a4-error" role="alert">
            {errorText(add.error)}
          </p>
        ) : null}
      </form>
      {created ? (
        <div className="a4p-secret" role="status">
          <p>
            <strong>Copy its secret now.</strong> This is the only time a4a shows it. Your receiver checks each delivery's signature with it.
          </p>
          <code>{created.secret}</code>
          <div className="a4p-actions">
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
      <div className="a4-split">
        <div className="a4-stack">
          <section className="card a4p-flush-list" aria-labelledby="hooks">
            <h2 id="hooks">Where it sends</h2>
            {hooks.isLoading ? <Loading what="webhooks" /> : null}
            {hooks.error ? <ErrorNote error={hooks.error} /> : null}
            {hooks.data && !hooks.data.length ? <p className="note">Nowhere yet. Add a webhook, then send it a test.</p> : null}
            {hooks.data?.length ? (
              <ul className="a4p-hooks">
                {hooks.data.map((h) => (
                  <HookCard key={h.id} hook={h} projectName={h.project ? names.get(h.project) : undefined} />
                ))}
              </ul>
            ) : null}
          </section>
          <AddHook />
        </div>
        <aside className="a4p-side" aria-labelledby="how">
          <section className="card">
            <h2 id="how">How deliveries work</h2>
            <p className="note">Each delivery is a POST of the change as JSON, the same as GET /api/v1/events gives.</p>
            <dl className="a4p-facts">
              <div className="pair">
                <dt>Signed</dt>
                <dd>
                  <code>X-A4A-Signature: sha256=&lt;HMAC of the body&gt;</code>, an HMAC-SHA256 of the raw body, with the webhook's secret.
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
                  <code>X-A4A-Event</code> (its kind) and <code>X-A4A-Delivery</code> (this try).
                </dd>
              </div>
            </dl>
            <h3>Checking the signature, in Node</h3>
            <pre className="a4p-snippet">{VERIFY}</pre>
            <CopyButton text={VERIFY} label="Copy it" what="the check" />
          </section>
        </aside>
      </div>
    </AdminOnly>
  );
}
