/**
 * The widget kit (docs/architecture.md, D48): the one script a widget loads from a4a, at
 * /app-kit/a4a-app.js. A widget runs in a sandboxed frame with no origin of its own, so it can't
 * reach a4a's cookies, its pages or its API: it talks to the page around it by postMessage, and
 * the page asks a4a for it, within what its app was granted and what the viewer may see.
 *
 *   await a4a.ready()                     → { app, widget, issue, project, viewer, theme }
 *   await a4a.get('/issues/BACK-1')       → the API's answer, as the viewer within the grant
 *   await a4a.post(path, body)
 *   await a4a.handler('summary', body)    → the app's handler, about this issue or project
 *   await a4a.storage.get() / .set(key, value)
 *   a4a.resize(height) · a4a.notify(text) · a4a.open('/issues/BACK-2') (the page asks the person first)
 *
 * The page offers Ocean's stylesheet; the kit links it, and follows the page's theme.
 */
export const WIDGET_KIT = `(() => {
  'use strict';
  const pending = new Map();
  const waiting = [];
  let seq = 0;
  let context = null;
  const send = (msg) => parent.postMessage(Object.assign({ a4a: 1 }, msg), '*');
  window.addEventListener('message', (e) => {
    if (e.source !== parent) return;
    const m = e.data;
    if (!m || m.a4a !== 1) return;
    if (m.type === 'init') {
      context = Object.freeze(m.context || {});
      if (m.stylesheet && !document.querySelector('link[data-a4a]')) {
        const link = document.createElement('link');
        link.rel = 'stylesheet';
        link.href = m.stylesheet;
        link.setAttribute('data-a4a', '');
        document.head.appendChild(link);
      }
      if (m.theme) document.documentElement.setAttribute('data-theme', m.theme);
      for (const f of waiting.splice(0)) f(context);
      return;
    }
    if (m.type === 'response') {
      const p = pending.get(m.id);
      if (!p) return;
      pending.delete(m.id);
      if (m.ok) p.resolve(m.body);
      else p.reject(Object.assign(new Error(m.error || 'a4a refused the request'), { status: m.status, body: m.body }));
    }
  });
  const request = (method, path, body) =>
    new Promise((resolve, reject) => {
      const id = ++seq;
      pending.set(id, { resolve, reject });
      send({ type: 'request', id, method: String(method).toUpperCase(), path: String(path), body });
    });
  const own = (suffix) => '/apps/' + encodeURIComponent(context && context.app) + suffix;
  const scope = () => (context && context.project ? '?project=' + encodeURIComponent(context.project) : '');
  const a4a = {
    ready: () => (context ? Promise.resolve(context) : new Promise((r) => waiting.push(r))),
    request,
    get: (path) => request('GET', path),
    post: (path, body) => request('POST', path, body),
    patch: (path, body) => request('PATCH', path, body),
    handler: (name, body) =>
      request('POST', own('/handlers/' + encodeURIComponent(name)), { issue: (context && context.issue) || undefined, project: (context && context.project) || undefined, body }),
    storage: Object.freeze({
      get: () => request('GET', own('/storage') + scope()),
      set: (key, value) => request('PUT', own('/storage/' + encodeURIComponent(key)) + scope(), { value: value === undefined ? null : value }),
    }),
    resize: (height) => send({ type: 'resize', height: Number(height) }),
    notify: (text) => send({ type: 'notify', text: String(text) }),
    open: (to) => send({ type: 'open', to: String(to) }),
  };
  Object.defineProperty(window, 'a4a', { value: Object.freeze(a4a) });
  const fit = () => a4a.resize(Math.ceil(document.documentElement.scrollHeight));
  const start = () => {
    send({ type: 'ready' });
    fit();
    if (window.ResizeObserver) new ResizeObserver(fit).observe(document.documentElement);
  };
  if (document.readyState === 'complete') start();
  else window.addEventListener('load', start);
})();
`;
