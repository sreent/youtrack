/**
 * Where a person allows an app to work in a4a as them over MCP, or declines it (D28). An app such as
 * Claude sends the browser here with its OAuth request; this page asks the server whether the
 * request holds, and shows who asks and for what as Ocean's ApprovalCard, as the lone page's card,
 * striped `outside`: what the app reads leaves a4a. The answer goes back to the app at the address
 * it registered: a code, or why not.
 */
import type { OAuthAuthorization, OAuthRedirect, OAuthScope } from '@a4a/shared';
import { useQuery } from '@tanstack/react-query';
import { useEffect, useId, useMemo, useState } from 'react';
import { Navigate, useLocation } from 'react-router';
import { ApiError, get, post } from '../api/client';
import { useMe, useProjects } from '../api/queries';
import { Lone } from '../app/Auth';
import { Icon } from '../components/Icon';
import { ErrorNote, Loading } from '../components/States';
import { Avatar } from '../components/Who';

type Asked = Extract<OAuthAuthorization, { ok: true }>;

const decide = (request: Record<string, string>, allow: boolean, scopes: OAuthScope[], projects: string[] | null) =>
  post<OAuthRedirect>('/oauth/authorize', { request, allow, scopes, projects });

/** The browser goes back to the app; the page stays as it was until it does. */
const goBack = (to: string) => window.location.assign(to);

function Consent({ asked, request, who }: { asked: Asked; request: Record<string, string>; who: { name: string; login: string } }) {
  const titleId = useId();
  const mayId = useId();
  const whereId = useId();
  const projects = useProjects();
  const { client } = asked;
  const remembered = asked.remembered;
  const [write, setWrite] = useState(asked.canWrite && asked.asked.includes('write') && (remembered ? remembered.scopes.includes('write') : true));
  const [every, setEvery] = useState(remembered ? remembered.projects === null : true);
  const [chosen, setChosen] = useState<Set<string>>(() => new Set(remembered?.projects ?? []));
  const [busy, setBusy] = useState(false);
  const [sent, setSent] = useState<boolean | null>(null);
  const [error, setError] = useState<unknown>(null);
  const name = client.name ? `“${client.name}”` : 'An app';

  useEffect(() => {
    document.title = `${client.name ?? 'An app'} asks to work in a4a`;
  }, [client.name]);
  // A page before the frame, as Lone's: the card is the page's one thing, in its middle.
  useEffect(() => {
    document.body.classList.add('lone');
    return () => document.body.classList.remove('lone');
  }, []);

  const answer = async (allow: boolean) => {
    setBusy(true);
    setError(null);
    try {
      const res = await decide(request, allow, write ? ['read', 'write'] : ['read'], every ? null : [...chosen]);
      setSent(allow);
      goBack(res.redirect);
    } catch (e) {
      setError(e);
      setBusy(false);
    }
  };
  const pick = (key: string) =>
    setChosen((cur) => {
      const next = new Set(cur);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });

  return (
    <main className="approval lone-card" aria-labelledby={titleId}>
      <div className="approval-stripe outside" />
      <div className="approval-body">
        <div className="who">
          <Avatar kind="agent" name={client.name ?? 'app'} />
          <span>
            <h1 className="approval-title" id={titleId}>
              {name} asks to work in a4a as you
            </h1>
            <span className="who-about">
              {client.documentHost
                ? `${client.documentHost} describes it (its name is that site’s word) · `
                : client.name
                  ? 'The name is its own, and a4a can’t check it · '
                  : ''}
              {client.local ? 'it is a program on this computer' : `it sends you back to ${client.redirectHost}`}
            </span>
          </span>
        </div>
        <dl className="approval-changes">
          <div className="pair">
            <dt>As</dt>
            <dd>
              {who.name} ({who.login})
            </dd>
          </div>
          <div className="pair">
            <dt>Back to</dt>
            <dd>
              <code>{client.redirectUri}</code>
            </dd>
          </div>
          <div className="pair">
            <dt id={mayId}>May</dt>
            <dd>
              <div className="stack tight" role="group" aria-labelledby={mayId}>
                <label className="approval-pick">
                  <input type="checkbox" checked disabled />
                  Read issues, boards and plans
                </label>
                {asked.asked.includes('write') ? (
                  <label className="approval-pick">
                    <input type="checkbox" checked={write} disabled={!asked.canWrite || busy} onChange={(e) => setWrite(e.target.checked)} />
                    Make changes, as you
                  </label>
                ) : null}
              </div>
            </dd>
          </div>
          <div className="pair">
            <dt id={whereId}>Where</dt>
            <dd>
              <div className="stack tight" role="group" aria-labelledby={whereId}>
                <label className="approval-pick">
                  <input type="radio" name={whereId} checked={every} disabled={busy} onChange={() => setEvery(true)} />
                  Every project you can see, and ones you join later
                </label>
                <label className="approval-pick">
                  <input type="radio" name={whereId} checked={!every} disabled={busy} onChange={() => setEvery(false)} />
                  Only these
                </label>
                {!every ? (
                  projects.isLoading ? (
                    <Loading what="your projects" />
                  ) : (
                    (projects.data ?? []).map((p) => (
                      <label key={p.key} className="approval-pick">
                        <input type="checkbox" checked={chosen.has(p.key)} disabled={busy} onChange={() => pick(p.key)} />
                        <span>
                          <span className="mono">{p.key}</span> {p.name}
                        </span>
                      </label>
                    ))
                  )
                ) : null}
              </div>
            </dd>
          </div>
        </dl>
        {asked.asked.includes('write') && !asked.canWrite ? <p className="approval-note">Your role only reads, so it can’t make changes.</p> : null}
        {!every && !chosen.size ? <p className="approval-note">Choose at least one project.</p> : null}
        <p className="approval-why">
          <strong>What it gets: </strong>a token for a4a’s MCP server alone, renewed while the app is in use. Each change it makes is yours in the
          history, under its name.
        </p>
        {error ? <ErrorNote error={error} /> : null}
        {sent === null ? (
          <div className="approval-actions">
            <button type="button" className="primary" disabled={busy || (!every && !chosen.size)} onClick={() => void answer(true)}>
              Allow
            </button>
            <button type="button" disabled={busy} onClick={() => void answer(false)}>
              Decline
            </button>
          </div>
        ) : (
          <p className="approval-done" role="status">
            {sent ? 'You allowed it.' : 'You declined it.'} Sending you back to {client.local ? 'the app' : client.redirectHost}…
          </p>
        )}
        <p className="approval-signed">
          <Icon name="audit" />
          Revoke it any time, under Agents and tokens.
        </p>
      </div>
    </main>
  );
}

/** A request that went wrong before a4a knew where the app is: said here, and sent nowhere. */
function Refused({ error }: { error: Extract<OAuthAuthorization, { ok: false }> }) {
  useEffect(() => {
    document.title = 'a4a can’t send you back to the app';
  }, []);
  return (
    <Lone>
      <h1>a4a can’t send you back to this app</h1>
      <div className="error-note" role="alert">
        <Icon name="cross" />
        <strong>{error.message}.</strong>
        {error.hint ? <p>{error.hint}</p> : null}
      </div>
      <a className="button" href="/issues">
        Go to a4a
      </a>
    </Lone>
  );
}

/** Said while the browser leaves for the app. */
function Leaving({ text }: { text: string }) {
  return (
    <Lone>
      <h1>{text}</h1>
      <Loading />
    </Lone>
  );
}

export default function OAuthConsentPage() {
  const location = useLocation();
  const me = useMe();
  const search = location.search;
  const request = useMemo(() => Object.fromEntries(new URLSearchParams(search)), [search]);
  const check = useQuery({
    queryKey: ['oauth', 'authorize', search],
    queryFn: () => get<OAuthAuthorization>(`/oauth/authorize${search}`),
    enabled: Boolean(me.data),
    retry: false,
    staleTime: Infinity,
  });
  const [auto, setAuto] = useState<unknown>(null);
  const data = check.data;

  // What the server says goes back to the app goes back at once; a request the person allowed
  // before, asking no more, carries on with what they allowed.
  useEffect(() => {
    if (!data || !me.data) return;
    if (!data.ok && data.redirect) goBack(data.redirect);
    if (data.ok && data.ready && data.remembered) {
      decide(request, true, data.remembered.scopes, data.remembered.projects)
        .then((res) => goBack(res.redirect))
        .catch(setAuto);
    }
  }, [data, me.data, request]);

  if (me.error instanceof ApiError && me.error.status === 401) {
    return <Navigate to={`/login?next=${encodeURIComponent(`${location.pathname}${location.search}`)}`} replace />;
  }
  if (me.error) {
    return (
      <Lone>
        <ErrorNote error={me.error} />
      </Lone>
    );
  }
  if (check.error) {
    return (
      <Lone>
        <ErrorNote error={check.error} />
      </Lone>
    );
  }
  if (!me.data || !data) {
    return (
      <Lone>
        <Loading what="the app’s request" />
      </Lone>
    );
  }
  if (!data.ok) return data.redirect ? <Leaving text="Sending you back to the app" /> : <Refused error={data} />;
  if (data.ready && !auto) return <Leaving text={`You allowed ${data.client.name ?? 'this app'} before: signing it in`} />;
  return <Consent asked={data} request={request} who={{ name: me.data.name, login: me.data.login }} />;
}
