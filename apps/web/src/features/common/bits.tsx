import { Fragment, useId } from 'react';
import { useMe } from '../../api/queries';
import { IssueLink } from '../../components/Badges';
import { ErrorLine, PageHead } from '../../components/States';
import { ISSUE_ID } from './format';
import { t } from '../../i18n';

/** Plain text with its issue ids linked ("Created BACK-14 …"). */
export function Linked({ text }: { text: string }) {
  const parts = text.split(new RegExp(ISSUE_ID.source, 'g'));
  return <>{parts.map((p, i) => (i % 2 === 1 ? <IssueLink key={i} id={p} /> : <Fragment key={i}>{p}</Fragment>))}</>;
}

export function useIsAdmin(): boolean {
  const me = useMe();
  return Boolean(me.data?.auth.scopes.includes('admin'));
}

/**
 * What happened, said where a screen reader hears it: "The token is revoked." (Ocean's outcome line).
 * What went wrong is Ocean's error note instead, with its cross.
 */
export function Said({ text, tone }: { text: string | null | undefined; tone?: 'bad' }) {
  if (tone === 'bad' && text) return <ErrorLine>{text}</ErrorLine>;
  return (
    <p role="status" className="outcome">
      {text ?? ''}
    </p>
  );
}

/** A table that may be wider than the page: it scrolls in its own frame, which a keyboard reaches to scroll it. */
export function Scroll({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="figures-scroll" role="region" aria-label={label} tabIndex={0}>
      {children}
    </div>
  );
}

/** Ocean's form field: its label's words above the control, tied by id, and what it's for under it. */
export function FormField({
  label,
  help,
  className,
  children,
}: {
  label: React.ReactNode;
  help?: React.ReactNode;
  className?: string;
  children: (id: string, helpId: string | undefined) => React.ReactNode;
}) {
  const id = useId();
  const helpId = help ? `${id}-help` : undefined;
  return (
    <div className={className ? `form-field ${className}` : 'form-field'}>
      <label htmlFor={id}>{label}</label>
      {children(id, helpId)}
      {help ? (
        <small className="field-help" id={helpId}>
          {help}
        </small>
      ) : null}
    </div>
  );
}

/** For a page only administrators use, when someone else opens it. */
export function AdminOnly({ title, children }: { title: string; children: React.ReactNode }) {
  const me = useMe();
  if (me.data && !me.data.auth.scopes.includes('admin')) {
    return (
      <>
        <PageHead title={title} about={t('common.bits.onlyAdministratorsCanChangeThis')} />
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
  return t('common.bits.somethingWentWrong');
}
