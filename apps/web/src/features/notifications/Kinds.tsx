import type { NotifyKind, NotifyKindsSettings } from '@a4a/shared';
import { NOTIFY_KINDS } from '@a4a/shared/constants';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { get, put } from '../../api/client';
import { errorText, Said } from '../common/bits';
import { useState } from 'react';

const WORDS: Record<NotifyKind, string> = {
  created: 'Created',
  commented: 'Commented on',
  state: 'State changed',
  assigned: 'Assigned to someone',
  fields: 'Other fields changed',
  linked: 'Linked',
  attachments: 'Files added',
  sla: 'SLA at risk or breached',
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
      setSaid({ text: 'Saved.' });
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
    <div className="stack" aria-label="The kinds of change that tell you">
      <div className="table-wrap">
        <table className="table">
          <caption>The kinds of change that tell you</caption>
          <thead>
            <tr>
              <th scope="col">Change</th>
              <th scope="col">Watched: inbox</th>
              <th scope="col">Watched: email</th>
              <th scope="col">Subscribed: inbox</th>
              <th scope="col">Subscribed: email</th>
            </tr>
          </thead>
          <tbody>
            {NOTIFY_KINDS.map((k) => (
              <tr key={k}>
                <th scope="row">{WORDS[k]}</th>
                {(['watching', 'defaults'] as const).flatMap((scope) =>
                  (['inbox', 'email'] as const).map((way) => (
                    <td key={`${scope}-${way}`}>
                      <input
                        type="checkbox"
                        aria-label={`${WORDS[k]}, ${scope === 'watching' ? 'issues you watch' : 'your subscriptions'}, ${way}`}
                        checked={s[scope][k][way]}
                        disabled={save.isPending}
                        onChange={(e) => toggle(scope, k, way, e.target.checked)}
                      />
                    </td>
                  )),
                )}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="note">Whatever you choose, {s.always.join(', ')} always tell you. Email still follows your email level above.</p>
      {said ? <Said text={said.text} tone={said.bad ? 'bad' : undefined} /> : null}
    </div>
  );
}
