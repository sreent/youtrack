import { ApiError } from '../api/client';
import { Icon } from './Icon';
import { t, tr } from '../i18n';

export function Loading({ what }: { what?: string }) {
  return (
    <p className="note" role="status">{tr('ui.states.loading', { el: <span className="spin" aria-hidden="true" />, v: what ? ` ${what}` : '' })}</p>
  );
}

/** What went wrong, as Ocean's error note: a cross, what happened, and how to put it right. */
export function ErrorNote({ error }: { error: unknown }) {
  const e = error instanceof ApiError ? error : null;
  const message = e?.message ?? (error instanceof Error ? error.message : t('ui.states.somethingWentWrong'));
  return (
    <div className="error-note" role="alert">
      <Icon name="cross" />
      <strong>{message}</strong>
      {e?.hint ? <p>{e.hint}</p> : null}
    </div>
  );
}

/** One line of what went wrong, where it went wrong (beside a control, under a form). */
export function ErrorLine({ children, id }: { children: React.ReactNode; id?: string }) {
  return (
    <p className="error-note" role="alert" id={id}>
      <Icon name="cross" />
      <strong>{children}</strong>
    </p>
  );
}

export function Empty({ title, children }: { title: string; children?: React.ReactNode }) {
  return (
    <section className="card">
      <h2>{title}</h2>
      {children ? <div className="note">{children}</div> : null}
    </section>
  );
}

export function PageHead({
  title,
  about,
  crumbs,
  badges,
  meta,
  actions,
}: {
  title: React.ReactNode;
  about?: React.ReactNode;
  crumbs?: React.ReactNode;
  badges?: React.ReactNode;
  meta?: React.ReactNode;
  actions?: React.ReactNode;
}) {
  return (
    <div className="page-head">
      {crumbs ? (
        <nav className="crumbs" aria-label={t('ui.states.whereThisIs')}>
          {crumbs}
        </nav>
      ) : null}
      <div className="title-row">
        <h1>{title}</h1>
        {badges}
        {actions ? <div className="grow cluster end">{actions}</div> : null}
      </div>
      {about ? <p className="about">{about}</p> : null}
      {meta ? <div className="meta">{meta}</div> : null}
    </div>
  );
}
