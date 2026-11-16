import type { NotifyKind, NotifyKindsSettings } from '@a4a/shared';
import { NOTIFY_KINDS } from '@a4a/shared/constants';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { get, put } from '../../api/client';
import { errorText, Said } from '../common/bits';
import { useState } from 'react';
import { t, tr, formatList } from '../../i18n';

const WORDS: Record<NotifyKind, string> = {
  created: t('notifications.kinds.created'),
  commented: t('notifications.kinds.commentedOn'),
  state: t('notifications.kinds.stateChanged'),
  assigned: t('notifications.kinds.assignedToSomeone'),
  fields: t('notifications.kinds.otherFieldsChanged'),
  linked: t('notifications.kinds.linked'),
  attachments: t('notifications.kinds.filesAdded'),
  sla: t('notifications.kinds.slaAtRiskOrBreached'),
};

/** The kinds of change that tell a person, by the inbox and by email (D45): for what they watch, and their subscriptions' default. */
export function NotifyKindsSettingsCard() {
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ['notification-kinds'], queryFn: () => get<NotifyKindsSettings>('/me/notification-kinds') });
  const [said, setSaid] = useState<{ text: string; bad?: boolean } | null>(null);
  const save = useMutation({
    mutationFn: (body: Partial<Pick<NotifyKindsSettings, 'watching' | 'defaults'>>) => put<NotifyKindsSettings>('/me/notification-kinds', body),
    onSuccess: (s) => {
      qc.setQueryData(['notification-kinds'], s);
      setSaid({ text: t('notifications.kinds.saved') });
    },
    onError: (e) => setSaid({ text: errorText(e), bad: true }),
  });
  const s = q.data;
  if (!s) return null;
  const toggle = (scope: 'watching' | 'defaults', kind: NotifyKind, way: 'inbox' | 'email', on: boolean) => {
    const was = s[scope][kind];
    save.mutate({ [scope]: { [kind]: { ...was, [way]: on } } });
  };
  return (
    <div className="stack" aria-label={t('notifications.kinds.theKindsOfChangeThat')}>
      {/* A fieldset per kind, its four choices wrapping: a table of five columns is too wide for a phone. */}
      <div role="group" aria-label={t('notifications.kinds.theKindsOfChangeThat')} className="stack">
        {NOTIFY_KINDS.map((k) => (
          <fieldset key={k} className="unframed stack tight">
            <legend>{WORDS[k]}</legend>
            <div className="cluster">
              {(['watching', 'defaults'] as const).flatMap((scope) =>
                (['inbox', 'email'] as const).map((way) => (
                  <label key={`${scope}-${way}`} className="check">
                    <input
                      type="checkbox"
                      aria-label={`${WORDS[k]}, ${scope === 'watching' ? t('notifications.kinds.issuesYouWatch') : t('notifications.kinds.yourSubscriptions')}, ${way === 'inbox' ? t('notifications.kinds.byInbox') : t('notifications.kinds.byEmail')}`}
                      checked={s[scope][k][way]}
                      disabled={save.isPending}
                      onChange={(e) => toggle(scope, k, way, e.target.checked)}
                    />
                    {scope === 'watching' ? t('notifications.kinds.watched') : t('notifications.kinds.subscribed')}: {way === 'inbox' ? t('notifications.kinds.byInbox') : t('notifications.kinds.byEmail')}
                  </label>
                )),
              )}
            </div>
          </fieldset>
        ))}
      </div>
      <p className="note">{tr('notifications.kinds.whateverYouChooseAlwaysTell', { join: formatList([t('notifications.kinds.alwaysMentioned'), t('notifications.kinds.alwaysAssigned'), t('notifications.kinds.alwaysRule'), t('notifications.kinds.alwaysRequest')]) })}</p>
      {said ? <Said text={said.text} tone={said.bad ? 'bad' : undefined} /> : null}
    </div>
  );
}
