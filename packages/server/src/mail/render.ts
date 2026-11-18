/** Each kind of mail, rendered when it is sent. */
import type { AppServices } from '../context';
import { renderRequestMail } from '../helpdesk/mails';
import { renderRelayMail } from '../helpdesk/relay';
import { renderDigestMail, renderNotificationMail } from '../notify/mails';
import { renderEmailConfirmMail } from '../services/emails';
import { renderPasskeyMail } from '../services/passkeys';
import { renderPortalPasskeyMail } from '../services/portal-passkeys';
import { renderPortalSignIn } from '../services/portal';
import { renderPortalAccount, renderPortalPassword } from '../services/portal-sign-in';
import type { RenderedMail } from './compose';
import type { MailRow } from './outbox';

export async function renderMail(app: AppServices, row: MailRow): Promise<RenderedMail | null> {
  switch (row.kind) {
    case 'notification':
      return renderNotificationMail(app, row);
    case 'digest':
      return renderDigestMail(app, row);
    case 'request-received':
    case 'request-reply':
    case 'request-state':
      return renderRequestMail(app, row);
    case 'request-relay':
      return renderRelayMail(app, row);
    case 'email-confirm':
      return renderEmailConfirmMail(app, row);
    case 'portal-sign-in':
      return renderPortalSignIn(app, row);
    case 'portal-password':
      return renderPortalPassword(app, row);
    case 'portal-account':
      return renderPortalAccount(app, row);
    case 'passkey':
      return renderPasskeyMail(app, row);
    case 'portal-passkey':
      return renderPortalPasskeyMail(app, row);
    default:
      return null;
  }
}
