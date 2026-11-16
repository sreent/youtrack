import type { EmailLink } from '@a4a/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useSearchParams } from 'react-router';
import { get, post } from '../api/client';
import { keys } from '../api/queries';
import { ErrorNote, Loading, PageHead } from '../components/States';
import { emailKeys } from '../features/vcs/People';

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
      <PageHead title="Confirm your email" about="Commits under a confirmed email are yours: they link to issues as yours, and the commands in them run as you." />
      <section className="card stack" aria-labelledby="confirming">
        {!usable ? (
          <>
            <h2 id="confirming">This link has no token</h2>
            <p className="note">Open the link from the email again, as it came. Or send a new one from your profile.</p>
          </>
        ) : link.isLoading ? (
          <>
            <h2 id="confirming">Reading the link</h2>
            <Loading what="the link" />
          </>
        ) : link.error ? (
          <>
            <h2 id="confirming">This link can’t confirm an email</h2>
            <ErrorNote error={link.error} />
          </>
        ) : done ? (
          <>
            <h2 id="confirming">{done.email} is confirmed</h2>
            <p>Commits under it are yours from now on.</p>
          </>
        ) : link.data ? (
          <>
            <h2 id="confirming">Is {link.data.email} yours?</h2>
            <p>
              Once it’s confirmed, the commits under it are yours: they link to issues as yours, and the commands in them, such as <code>BACK-12 #Fixed</code>, run as you.
            </p>
            <div className="cluster">
              <button type="button" className="primary" disabled={confirm.isPending} onClick={() => confirm.mutate()}>
                {confirm.isPending ? 'Confirming…' : 'Yes, confirm it'}
              </button>
            </div>
            {confirm.error ? <ErrorNote error={confirm.error} /> : null}
          </>
        ) : null}
        <p className="note">
          <Link to="/me">Your emails are on your profile.</Link>
        </p>
      </section>
    </>
  );
}
