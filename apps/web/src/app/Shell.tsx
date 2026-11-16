import type { Me } from '@a4a/shared';
import { useQueryClient } from '@tanstack/react-query';
import { useEffect, Fragment } from 'react';
import { NavLink, Outlet, useNavigate } from 'react-router';
import { post, subscribeEvents } from '../api/client';
import { keys } from '../api/queries';
import { Icon, type IconName } from '../components/Icon';
import { initials } from '../components/Who';

interface NavItem {
  to: string;
  label: string;
  icon: IconName;
  admin?: boolean;
}

const NAV: { group: string; items: NavItem[] }[] = [
  {
    group: 'Work',
    items: [
      { to: '/issues', label: 'Issues', icon: 'tasks' },
      { to: '/boards', label: 'Boards', icon: 'board' },
      { to: '/plan', label: 'Plan', icon: 'timeline' },
      { to: '/assistant', label: 'Assistant', icon: 'agent' },
    ],
  },
  { group: 'Decide', items: [{ to: '/suggestions', label: 'Suggestions', icon: 'decide' }] },
  {
    group: 'Build',
    items: [
      { to: '/projects', label: 'Projects', icon: 'book' },
      { to: '/rules', label: 'Rules', icon: 'sync' },
      { to: '/fields', label: 'Fields', icon: 'settings', admin: true },
    ],
  },
  {
    group: 'Oversee',
    items: [
      { to: '/activity', label: 'Activity', icon: 'audit' },
      { to: '/agents', label: 'Agents and tokens', icon: 'key' },
      { to: '/webhooks', label: 'Webhooks', icon: 'send', admin: true },
      { to: '/integrations', label: 'Integrations', icon: 'code', admin: true },
      { to: '/admin', label: 'Administration', icon: 'people', admin: true },
    ],
  },
];

/** Re-read what changed when the tracker says so (best effort, live). */
function useLiveInvalidation() {
  const qc = useQueryClient();
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | null = null;
    const touched = new Set<string>();
    const flush = () => {
      timer = null;
      qc.invalidateQueries({ queryKey: ['issues', 'list'] });
      qc.invalidateQueries({ queryKey: ['boards'] });
      qc.invalidateQueries({ queryKey: ['events'] });
      qc.invalidateQueries({ queryKey: ['plan'] });
      for (const id of touched) qc.invalidateQueries({ queryKey: keys.issue(id) });
      touched.clear();
    };
    return subscribeEvents((e) => {
      if (e.issue?.id) touched.add(e.issue.id);
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

export function Shell({ me }: { me: Me }) {
  useAppFrame();
  useLiveInvalidation();
  const qc = useQueryClient();
  const navigate = useNavigate();
  const isAdmin = me.auth.scopes.includes('admin');
  const signOut = async () => {
    await post('/auth/logout').catch(() => {});
    qc.clear();
    navigate('/login');
  };
  return (
    <>
      <aside className="sidebar">
        <NavLink className="brand" to="/issues">
          <span className="mark">a4</span>
          <span>a4a</span>
        </NavLink>
        <nav aria-label="a4a's pages">
          {NAV.map((g) => {
            const items = g.items.filter((i) => !i.admin || isAdmin);
            if (!items.length) return null;
            return (
              <Fragment key={g.group}>
                <div className="group">{g.group}</div>
                {items.map((i) => (
                  <NavLink key={i.to} to={i.to}>
                    <Icon name={i.icon} />
                    <span>{i.label}</span>
                  </NavLink>
                ))}
              </Fragment>
            );
          })}
        </nav>
        <div className="me">
          <NavLink to="/me" title="Your profile">
            <span className="avatar" aria-hidden="true">
              {initials(me.name)}
            </span>
            <span>{me.name}</span>
          </NavLink>
          <button type="button" onClick={signOut} title="Sign out" aria-label="Sign out">
            <Icon name="logout" />
          </button>
        </div>
      </aside>
      <div className="page">
        <main>
          <Outlet />
        </main>
      </div>
    </>
  );
}
