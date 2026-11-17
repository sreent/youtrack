/**
 * An app's widget on a page (docs/architecture.md, D48): its frame, and the page's side of its
 * conversation with it.
 *
 * - The frame is sandboxed (scripts and forms, no origin of its own) and its files come from an
 *   address a4a signed, under a policy that sandboxes them again: it can't reach a4a's cookies, its
 *   pages or its API.
 * - It talks only by postMessage, and only messages from its own frame are heard. It asks a4a for
 *   things through the page, which calls the API as the person, saying which app and widget ask:
 *   the server allows what the app was granted and the widget said it uses, within what the person
 *   may see. Its words go in a status line, as text; its height is kept between 80 and 800 pixels;
 *   and it moves the page only by asking the person.
 */
import type { AppExtension } from '@a4a/shared';
import { useEffect, useId, useRef, useState } from 'react';
import { useNavigate } from 'react-router';
import { useMe } from '../../api/queries';
import type { AppPlace } from './api';
import { t, tr } from '../../i18n';
import type { ReactNode } from 'react';

const METHODS = new Set(['GET', 'POST', 'PUT', 'PATCH', 'DELETE']);

interface Message {
  a4a?: number;
  type?: string;
  id?: number;
  method?: string;
  path?: string;
  body?: unknown;
  height?: number;
  text?: string;
  to?: string;
}

/** The page's stylesheet, which is Ocean's: offered to widgets so they look like a4a. */
function stylesheet(): string | null {
  const link = document.querySelector<HTMLLinkElement>('link[rel="stylesheet"][href]');
  return link ? new URL(link.href).pathname : null;
}

export function AppFrame({ ext, place }: { ext: AppExtension; place: AppPlace }) {
  const frame = useRef<HTMLIFrameElement>(null);
  const titleId = useId();
  const me = useMe();
  const navigate = useNavigate();
  const [height, setHeight] = useState(ext.height);
  const [said, setSaid] = useState('');
  const [ask, setAsk] = useState<string | null>(null);
  const viewer = me.data ? { login: me.data.login, name: me.data.name } : null;

  useEffect(() => {
    const onMessage = async (e: MessageEvent) => {
      const win = frame.current?.contentWindow;
      // Only its own frame is heard: another frame, or the page itself, is ignored.
      if (!win || e.source !== win) return;
      const m = e.data as Message;
      if (!m || typeof m !== 'object' || m.a4a !== 1 || typeof m.type !== 'string') return;
      const reply = (msg: Record<string, unknown>) => win.postMessage({ a4a: 1, ...msg }, '*');
      if (m.type === 'ready') {
        reply({
          type: 'init',
          context: { app: ext.app, widget: ext.name, issue: place.issue ?? null, project: place.project ?? null, article: place.article ?? null, viewer },
          stylesheet: stylesheet(),
          theme: window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light',
        });
      } else if (m.type === 'resize') {
        if (typeof m.height === 'number' && Number.isFinite(m.height)) setHeight(Math.min(800, Math.max(80, Math.round(m.height))));
      } else if (m.type === 'notify') {
        setSaid(String(m.text ?? '').slice(0, 300));
      } else if (m.type === 'open') {
        const to = String(m.to ?? '');
        // A page of a4a's own, never another site: and the person decides.
        if (/^\/[A-Za-z]/.test(to) && !to.startsWith('//')) setAsk(to.slice(0, 200));
      } else if (m.type === 'request') {
        const id = typeof m.id === 'number' ? m.id : 0;
        const method = String(m.method ?? 'GET').toUpperCase();
        const path = String(m.path ?? '');
        if (!METHODS.has(method) || !path.startsWith('/') || path.startsWith('//') || path.includes('..') || path.length > 500) {
          reply({ type: 'response', id, ok: false, status: 400, error: t('apps.appFrame.thePageRefusedACall') });
          return;
        }
        const hasBody = m.body !== undefined && method !== 'GET';
        try {
          const res = await fetch(`/api/v1${path}`, {
            method,
            credentials: 'same-origin',
            headers: { accept: 'application/json', 'x-a4a-app': ext.app, 'x-a4a-widget': ext.name, ...(hasBody ? { 'content-type': 'application/json' } : {}) },
            body: hasBody ? JSON.stringify(m.body) : undefined,
          });
          const text = await res.text();
          let body: unknown = null;
          try {
            body = text ? JSON.parse(text) : null;
          } catch {
            body = null;
          }
          const error = (body as { error?: { message?: string } } | null)?.error?.message ?? res.statusText;
          reply(res.ok ? { type: 'response', id, ok: true, status: res.status, body } : { type: 'response', id, ok: false, status: res.status, error, body });
        } catch {
          reply({ type: 'response', id, ok: false, status: 0, error: t('apps.appFrame.thePageCouldnTReach') });
        }
      }
    };
    window.addEventListener('message', onMessage);
    return () => window.removeEventListener('message', onMessage);
  }, [ext.app, ext.name, place.issue, place.project, place.article, viewer?.login, viewer?.name]);

  return (
    <section className="card app-frame" aria-labelledby={titleId}>
      <div className="app-frame-head">
        <h2 id={titleId}>{ext.title}</h2>
        <span className="badge" title={t('apps.appFrame.isAnApp', { appTitle: ext.appTitle })}>{tr('apps.appFrame.appAnApp', { appTitle: ext.appTitle, t0: (c: ReactNode) => <span className="hidden">{c}</span> })}</span>
      </div>
      <iframe ref={frame} title={ext.title} src={ext.url} sandbox="allow-scripts allow-forms" height={height} referrerPolicy="no-referrer" loading="lazy" />
      <p className="app-frame-said" role="status">
        {said}
      </p>
      {ask ? (
        <div className="app-frame-ask" role="group" aria-label={t('apps.appFrame.asks', { appTitle: ext.appTitle })}>
          <p>{tr('apps.appFrame.asksToOpen', { appTitle: ext.appTitle, ask: ask, t0: (c: ReactNode) => <strong>{c}</strong> })}</p>
          <div className="cluster">
            <button
              type="button"
              className="small primary"
              onClick={() => {
                const to = ask;
                setAsk(null);
                navigate(to);
              }}
            >{t('apps.appFrame.openIt')}</button>
            <button type="button" className="small" onClick={() => setAsk(null)}>{t('apps.appFrame.stayHere')}</button>
          </div>
        </div>
      ) : null}
    </section>
  );
}
