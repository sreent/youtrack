import { ApiError } from '../api/client';

export function Loading({ what }: { what?: string }) {
  return (
    <p className="note" role="status">
      <span className="spin" aria-hidden="true" /> Loading{what ? ` ${what}` : ''}…
    </p>
  );
}

export function ErrorNote({ error }: { error: unknown }) {
  const e = error instanceof ApiError ? error : null;
  const message = e?.message ?? (error instanceof Error ? error.message : 'Something went wrong');
  return (
    <div className="a4-error" role="alert">
      <p>{message}</p>
      {e?.hint ? <p className="note">{e.hint}</p> : null}
    </div>
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
        <nav className="crumbs" aria-label="Where this is">
          {crumbs}
        </nav>
      ) : null}
      <div className="title-row">
        <h1>{title}</h1>
        {badges}
        {actions ? <div className="a4-grow a4-row a4-actions">{actions}</div> : null}
      </div>
      {about ? <p className="about">{about}</p> : null}
      {meta ? <div className="meta">{meta}</div> : null}
    </div>
  );
}
