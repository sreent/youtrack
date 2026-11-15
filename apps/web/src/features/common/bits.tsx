import { Fragment } from 'react';
import { useMe } from '../../api/queries';
import { IssueLink } from '../../components/Badges';
import { PageHead } from '../../components/States';
import { ISSUE_ID } from './format';

/** Plain text with its issue ids linked ("Created BACK-14 …"). */
export function Linked({ text }: { text: string }) {
  const parts = text.split(new RegExp(ISSUE_ID.source, 'g'));
  return (
    <>
      {parts.map((p, i) => (i % 2 === 1 ? <IssueLink key={i} id={p} /> : <Fragment key={i}>{p}</Fragment>))}
    </>
  );
}

export function useIsAdmin(): boolean {
  const me = useMe();
  return Boolean(me.data?.auth.scopes.includes('admin'));
}

/** What happened, said where a screen reader hears it: "The token is revoked." */
export function Said({ text, tone }: { text: string | null | undefined; tone?: 'bad' }) {
  return (
    <p role="status" className={tone === 'bad' ? 'a4p-said a4p-said-bad' : 'a4p-said'}>
      {text ?? ''}
    </p>
  );
}

/** A table that may be wider than the page: it scrolls on its own, and a keyboard reaches it to scroll it. */
export function Scroll({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="a4p-scroll" role="region" aria-label={label} tabIndex={0}>
      {children}
    </div>
  );
}

/** For a page only administrators use, when someone else opens it. */
export function AdminOnly({ title, children }: { title: string; children: React.ReactNode }) {
  const me = useMe();
  if (me.data && !me.data.auth.scopes.includes('admin')) {
    return (
      <>
        <PageHead title={title} about="Only administrators can change this. Ask one of them if something here needs to change." />
      </>
    );
  }
  return <>{children}</>;
}

/** An error in a sentence, with the server's hint on how to fix it. */
export function errorText(e: unknown): string {
  if (e && typeof e === 'object' && 'message' in e) {
    const hint = (e as { hint?: string }).hint;
    const msg = String((e as { message: string }).message).replace(/[.\s]+$/, '');
    return hint ? `${msg}. ${hint}` : `${msg}.`;
  }
  return 'Something went wrong.';
}
