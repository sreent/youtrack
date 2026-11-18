import type { HelpdeskMail, Project } from '@a4a/shared';
import { CC_RELAY_LIMITS, REQUEST_CCS_CEILING } from '@a4a/shared/constants';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { get, patch } from '../../api/client';
import { keys } from '../../api/queries';
import { errorText, FormField, Said } from '../common/bits';
import { formatList, t, tr } from '../../i18n';
import type { ReactNode } from 'react';

/**
 * A desk's own rules for the people copied on its requests (D67), for its managers: its cap, whether a
 * new request's Cc waits for its requester, and whether everyone on a request hears each other. The
 * page says plainly what each does, and which mail servers this server trusts to say who sent an email.
 */
export function RequestCcSettings({ project }: { project: Project }) {
  const qc = useQueryClient();
  const h = project.settings.helpdesk;
  const initial = { max: String(h.ccsMax), confirm: h.ccsConfirm, relay: h.ccsRelay };
  const savedKey = JSON.stringify(initial);
  const [form, setForm] = useState(initial);
  const [said, setSaid] = useState<{ text: string; bad?: boolean } | null>(null);
  useEffect(() => setForm(JSON.parse(savedKey) as typeof initial), [savedKey]);
  // Shared with the desk's mail card: what this server trusts is said there too.
  const mail = useQuery({ queryKey: ['helpdesk-mail', project.key], queryFn: () => get<HelpdeskMail>(`/projects/${project.key}/helpdesk/mail`) });
  const max = Number(form.max);
  const badMax = !Number.isInteger(max) || max < 1 || max > REQUEST_CCS_CEILING;
  const dirty = JSON.stringify(form) !== savedKey;
  const save = useMutation({
    mutationFn: () => patch<Project>(`/projects/${project.key}`, { settings: { helpdesk: { ccsMax: max, ccsConfirm: form.confirm, ccsRelay: form.relay } } }),
    onSuccess: (p) => {
      qc.setQueryData(keys.project(p.key), p);
      void qc.invalidateQueries({ queryKey: keys.projects });
      setSaid({ text: t('helpdesk.ccSettings.saved') });
    },
    onError: (e) => setSaid({ text: errorText(e), bad: true }),
  });
  const servers = mail.data?.trustedServers ?? [];
  const small = (c: ReactNode) => <small className="field-help">{c}</small>;
  return (
    <form
      className="form"
      onSubmit={(e) => {
        e.preventDefault();
        if (!badMax) save.mutate();
      }}
    >
      <fieldset className="unframed form" disabled={save.isPending}>
        <div className="form-fields">
          <FormField label={t('helpdesk.ccSettings.max')} help={t('helpdesk.ccSettings.maxHelp', { ceiling: REQUEST_CCS_CEILING })}>
            {(id, help) => (
              <input
                id={id}
                type="number"
                min={1}
                max={REQUEST_CCS_CEILING}
                step={1}
                inputMode="numeric"
                value={form.max}
                aria-describedby={help}
                aria-invalid={badMax || undefined}
                onChange={(e) => setForm((f) => ({ ...f, max: e.target.value }))}
              />
            )}
          </FormField>
        </div>
        <label className="choice">
          <input type="checkbox" checked={form.confirm} onChange={(e) => setForm((f) => ({ ...f, confirm: e.target.checked }))} />
          <span>{tr('helpdesk.ccSettings.confirm', { t0: small })}</span>
        </label>
        <label className="choice">
          <input type="checkbox" checked={form.relay} onChange={(e) => setForm((f) => ({ ...f, relay: e.target.checked }))} />
          <span>{tr('helpdesk.ccSettings.relay', { perRequest: CC_RELAY_LIMITS.perRequest, perSender: CC_RELAY_LIMITS.perSender, t0: small })}</span>
        </label>
      </fieldset>
      {mail.data ? <p className="note">{t('helpdesk.ccSettings.trusts', { count: servers.length, servers: formatList(servers) })}</p> : null}
      <div className="cluster">
        <button type="submit" className="primary" disabled={!dirty || badMax || save.isPending}>
          {save.isPending ? t('helpdesk.ccSettings.saving') : t('helpdesk.ccSettings.save')}
        </button>
        <Said text={badMax ? t('helpdesk.ccSettings.badMax', { ceiling: REQUEST_CCS_CEILING }) : said?.text} tone={badMax || said?.bad ? 'bad' : undefined} />
      </div>
    </form>
  );
}
