import type { Me } from '@a4a/shared';
import { useQueryClient } from '@tanstack/react-query';
import { useEffect, Fragment } from 'react';
import { NavLink, Outlet, useNavigate } from 'react-router';
import { post, subscribeEvents } from '../api/client';
import { keys, useProjects } from '../api/queries';
import { Icon, type IconName } from '../components/Icon';
import { ToastProvider } from '../components/Toasts';
import { initials } from '../components/Who';
import { useInboxLive, useUnreadCount } from '../features/notifications/api';
import { forgetPushHere, keepPushInStep } from '../features/notifications/push';
import { takeNewVersion, useAppBadge, useNewVersionReady, useOnline, useOpenFromNotifications } from './pwa';
import { useAppExtensions } from '../features/apps/api';
import { t } from '../i18n';

interface NavItem {
  to: string;
  label: string;
  icon: IconName;
  admin?: boolean;
  /** For someone who manages a project (or an administrator). */
  manager?: boolean;
  /** A count beside it, such as what's unread. */
  count?: 'unread';
}

const NAV: { group: string; items: NavItem[] }[] = [
  {
    group: t('app.shell.work'),
    items: [
      { to: '/dashboard', label: t('app.shell.dashboard'), icon: 'dashboard' },
      { to: '/inbox', label: t('app.shell.inbox'), icon: 'bell', count: 'unread' },
      { to: '/issues', label: t('app.shell.issues'), icon: 'tasks' },
      { to: '/boards', label: t('app.shell.boards'), icon: 'board' },
      { to: '/whiteboards', label: t('app.shell.whiteboards'), icon: 'whiteboard' },
      { to: '/plan', label: t('app.shell.plan'), icon: 'timeline' },
      { to: '/timesheet', label: t('app.shell.timesheet'), icon: 'clock' },
      { to: '/articles', label: t('app.shell.knowledgeBase'), icon: 'book' },
      { to: '/reports', label: t('app.shell.reports'), icon: 'report' },
      { to: '/assistant', label: t('app.shell.assistant'), icon: 'agent' },
    ],
  },
  { group: t('app.shell.decide'), items: [{ to: '/suggestions', label: t('app.shell.suggestions'), icon: 'decide' }] },
  {
    group: t('app.shell.build'),
    items: [
      { to: '/projects', label: t('app.shell.projects'), icon: 'list' },
      { to: '/rules', label: t('app.shell.rules'), icon: 'sync' },
      { to: '/fields', label: t('app.shell.fields'), icon: 'settings', admin: true },
      { to: '/import', label: t('app.shell.import'), icon: 'import', manager: true },
    ],
  },
  {
    group: t('app.shell.oversee'),
    items: [
      { to: '/activity', label: t('app.shell.activity'), icon: 'audit' },
      { to: '/agents', label: t('app.shell.agentsAndTokens'), icon: 'key' },
      { to: '/webhooks', label: t('app.shell.webhooks'), icon: 'send', admin: true },
      { to: '/integrations', label: t('app.shell.integrations'), icon: 'code', admin: true },
      { to: '/chat', label: t('app.shell.chat'), icon: 'chat', admin: true },
      { to: '/admin', label: t('app.shell.administration'), icon: 'people', admin: true },
    ],
  },
];

/** Apps' pages of their own (D48), under the menu's last group, when there are any. */
function AppNav() {
  const ext = useAppExtensions('main-menu');
  if (!ext.data?.length) return null;
  return (
    <>
      <div className="group">{t('app.shell.apps')}</div>
      {ext.data.map((e) => (
        <NavLink key={`${e.app}/${e.name}`} to={`/apps/${e.app}/${e.name}`}>
          <Icon name="list" />
          <span>{e.title}</span>
        </NavLink>
      ))}
    </>
  );
}

/** Re-read what changed when the tracker says so (best effort, live). */
function useLiveInvalidation() {
  const qc = useQueryClient();
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | null = null;
    const touched = new Set<string>();
    let articles = false;
    let cards = false;
    let whiteboards = false;
    let rekeyed = false;
    const flush = () => {
      timer = null;
      // A project's key renamed (D52): every id on every page reads under its new key, so read them all again.
      if (rekeyed) {
        rekeyed = false;
        touched.clear();
        articles = false;
        void qc.invalidateQueries();
        return;
      }
      qc.invalidateQueries({ queryKey: ['issues', 'list'] });
      qc.invalidateQueries({ queryKey: ['boards'] });
      qc.invalidateQueries({ queryKey: ['events'] });
      qc.invalidateQueries({ queryKey: ['plan'] });
      qc.invalidateQueries({ queryKey: ['reports'] });
      for (const id of touched) qc.invalidateQueries({ queryKey: keys.issue(id) });
      touched.clear();
      if (articles) qc.invalidateQueries({ queryKey: ['articles'] });
      // A whiteboard's cards follow their issues and articles (D58); its list, its life.
      if (cards) qc.invalidateQueries({ queryKey: ['whiteboard-cards'] });
      if (whiteboards) qc.invalidateQueries({ queryKey: ['whiteboards', 'list'] });
      cards = false;
      whiteboards = false;
      articles = false;
    };
    return subscribeEvents((e) => {
      if (e.type === 'project.key.changed') rekeyed = true;
      if (e.issue?.id) touched.add(e.issue.id);
      // An article's change, or a file on one; and mentions of articles come from issues' text.
      if (e.type.startsWith('article.') || (e.type.startsWith('attachment.') && !e.issue) || e.type.startsWith('comment.') || e.type === 'issue.updated') articles = true;
      if (e.type.startsWith('issue.') || e.type.startsWith('article.')) cards = true;
      if (e.type.startsWith('whiteboard.')) whiteboards = true;
      timer ??= setTimeout(flush, 400);
    });
  }, [qc]);
}

/** Ocean's frame is body.app: the sidebar's column and the page beside it. */
function useAppFrame() {
  useEffect(() => {
    document.body.classList.add('app');
    return () => document.body.classList.remove('app');
  }, []);
}

/** What's unread, beside the inbox's link; screen readers hear it as part of the link's name. */
function UnreadCount() {
  const unread = useUnreadCount();
  const n = unread.data ?? 0;
  if (!n) return null;
  return (
    <span className="nav-count">
      <span aria-hidden="true">{n > 99 ? '99+' : n}</span>
      <span className="hidden">{t('app.shell.unreadCount', { n })}</span>
    </span>
  );
}

export function Shell({ me }: { me: Me }) {
  useAppFrame();
  useLiveInvalidation();
  useInboxLive();
  useOpenFromNotifications();
  useAppBadge(useUnreadCount().data);
  // Once per sign-in: this device's push, given to a4a again if it's theirs (a new sign-in's record).
  useEffect(() => {
    void keepPushInStep({ id: me.id }).catch(() => {});
  }, [me.id]);
  const qc = useQueryClient();
  const navigate = useNavigate();
  const isAdmin = me.auth.scopes.includes('admin');
  const projectList = useProjects();
  const managesSome = isAdmin || Boolean(projectList.data?.some((p) => p.access.manage));
  const signOut = async () => {
    // This device stops hearing for them; signing out ends a4a's record of it too (D47).
    await forgetPushHere().catch(() => {});
    await post('/auth/logout').catch(() => {});
    qc.clear();
    navigate('/login');
  };
  // Toasts (D72): what a page just did, said at the foot of the window, for every page in the shell.
  return (
    <ToastProvider>
      <aside className="sidebar">
        <NavLink className="brand" to="/issues">
          <span className="mark">{t('app.shell.a4')}</span>
          <span>{t('app.shell.a4a')}</span>
        </NavLink>
        <nav aria-label={t('app.shell.a4aSPages')}>
          {NAV.map((g) => {
            const items = g.items.filter((i) => (!i.admin || isAdmin) && (!i.manager || managesSome));
            if (!items.length) return null;
            return (
              <Fragment key={g.group}>
                <div className="group">{g.group}</div>
                {items.map((i) => (
                  <NavLink key={i.to} to={i.to}>
                    <Icon name={i.icon} />
                    <span>{i.label}</span>
                    {i.count === 'unread' ? <UnreadCount /> : null}
                  </NavLink>
                ))}
              </Fragment>
            );
          })}
          <AppNav />
        </nav>
        <div className="me">
          <NavLink to="/me" title={t('app.shell.yourProfile')}>
            <span className="avatar" aria-hidden="true">
              {initials(me.name)}
            </span>
            <span>{me.name}</span>
          </NavLink>
          <button type="button" onClick={signOut} title={t('app.shell.signOut')} aria-label={t('app.shell.signOut')}>
            <Icon name="logout" />
          </button>
        </div>
      </aside>
      <div className="page">
        <AppNotices />
        <main>
          <Outlet />
        </main>
      </div>
    </ToastProvider>
  );
}

/** What's true of a4a itself, above every page: offline, or a new version ready (D47). */
function AppNotices() {
  const online = useOnline();
  const ready = useNewVersionReady();
  if (online && !ready) return null;
  return (
    <div className="app-notices">
      {!online ? (
        <p className="app-notice offline" role="status">
          <Icon name="sync" />
          <span>{t('app.shell.youReOfflineWhatS')}</span>
        </p>
      ) : null}
      {ready ? (
        <p className="app-notice" role="status">
          <span>{t('app.shell.aNewVersionOfA4a')}</span>
          <button type="button" className="small" onClick={takeNewVersion}>{t('app.shell.reload')}</button>
        </p>
      ) : null}
    </div>
  );
}
