import type { EmailLink } from '@a4a/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useSearchParams } from 'react-router';
import { get, post } from '../api/client';
import { keys } from '../api/queries';
import { ErrorNote, Loading, PageHead } from '../components/States';
import { emailKeys } from '../features/vcs/People';
import { t, tr } from '../i18n';

/**
 * Where the link a4a mails to confirm an email leads. It asks before it confirms (mail scanners
 * open links), and only the person who added the email, signed in, can.
 */
export default function ConfirmEmailPage() {
  const qc = useQueryClient();
  const [params] = useSearchParams();
  const token = params.get('token') ?? '';
  const usable = token.length >= 16;
  const link = useQuery({
    queryKey: ['me', 'emails', 'link', token],
    queryFn: () => get<EmailLink>(`/me/emails/confirm?token=${encodeURIComponent(token)}`),
    enabled: usable,
    retry: false,
  });
  const confirm = useMutation({
    mutationFn: () => post<EmailLink>('/me/emails/confirm', { token }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: emailKeys.mine });
      void qc.invalidateQueries({ queryKey: keys.me });
    },
  });
  const done = confirm.data ?? (link.data?.confirmed ? link.data : null);
  return (
    <>
      <PageHead title={t('page.confirmEmail.confirmYourEmail')} about={t('page.confirmEmail.commitsUnderAConfirmedEmail')} />
      <section className="card stack" aria-labelledby="confirming">
        {!usable ? (
          <>
            <h2 id="confirming">{t('page.confirmEmail.thisLinkHasNoToken')}</h2>
            <p className="note">{t('page.confirmEmail.openTheLinkFromThe')}</p>
          </>
        ) : link.isLoading ? (
          <>
            <h2 id="confirming">{t('page.confirmEmail.readingTheLink')}</h2>
            <Loading what="loadingLine.link" />
          </>
        ) : link.error ? (
          <>
            <h2 id="confirming">{t('page.confirmEmail.thisLinkCanTConfirm')}</h2>
            <ErrorNote error={link.error} />
          </>
        ) : done ? (
          <>
            <h2 id="confirming">{tr('page.confirmEmail.isConfirmed', { email: done.email })}</h2>
            <p>{t('page.confirmEmail.commitsUnderItAreYours')}</p>
          </>
        ) : link.data ? (
          <>
            <h2 id="confirming">{tr('page.confirmEmail.isYours', { email: link.data.email })}</h2>
            <p>{tr('page.confirmEmail.onceItSConfirmedThe', { code: <code>BACK-12 #Fixed</code> })}</p>
            <div className="cluster">
              <button type="button" className="primary" disabled={confirm.isPending} onClick={() => confirm.mutate()}>
                {confirm.isPending ? t('page.confirmEmail.confirming') : t('page.confirmEmail.yesConfirmIt')}
              </button>
            </div>
            {confirm.error ? <ErrorNote error={confirm.error} /> : null}
          </>
        ) : null}
        <p className="note">
          <Link to="/me">{t('page.confirmEmail.yourEmailsAreOnYour')}</Link>
        </p>
      </section>
    </>
  );
}
