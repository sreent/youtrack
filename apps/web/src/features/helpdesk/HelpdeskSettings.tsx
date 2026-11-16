import type { Project } from '@a4a/shared';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { patch } from '../../api/client';
import { keys } from '../../api/queries';
import { errorText, FormField, Said } from '../common/bits';
import { CopyButton } from '../common/CopyButton';
import { t, tr } from '../../i18n';
import type { ReactNode } from 'react';

/** A project's help desk: whether its public form takes requests, its first-response target, and its words. */
export function HelpdeskSettings({ project, canEdit }: { project: Project; canEdit: boolean }) {
  const qc = useQueryClient();
  const h = project.settings.helpdesk;
  const initial = { enabled: h.enabled, hours: h.firstResponseHours === null ? '' : String(h.firstResponseHours), intro: h.intro, captcha: h.captcha };
  const savedKey = JSON.stringify(initial);
  const [form, setForm] = useState(initial);
  const [said, setSaid] = useState<{ text: string; bad?: boolean } | null>(null);
  useEffect(() => setForm(JSON.parse(savedKey) as typeof initial), [savedKey]);
  const dirty = JSON.stringify(form) !== savedKey;
  const hours = form.hours.trim() === '' ? null : Number(form.hours);
  const badHours = hours !== null && (!Number.isFinite(hours) || hours < 0.25 || hours > 1440);
  const save = useMutation({
    mutationFn: () =>
      patch<Project>(`/projects/${project.key}`, { settings: { helpdesk: { enabled: form.enabled, firstResponseHours: hours, intro: form.intro.trim(), captcha: form.captcha } } }),
    onSuccess: (p) => {
      qc.setQueryData(keys.project(p.key), p);
      void qc.invalidateQueries({ queryKey: keys.projects });
      setSaid({ text: p.settings.helpdesk.enabled ? t('helpdesk.helpdeskSettings.savedTheFormTakesRequests') : t('helpdesk.helpdeskSettings.savedTheFormIsClosed') });
    },
    onError: (e) => setSaid({ text: errorText(e), bad: true }),
  });
  const url = `${window.location.origin}/help/${project.key}`;
  return (
    <form
      className="form"
      onSubmit={(e) => {
        e.preventDefault();
        if (!badHours) save.mutate();
      }}
    >
      <fieldset className="unframed form" disabled={!canEdit || save.isPending}>
        <label className="choice">
          <input type="checkbox" checked={form.enabled} onChange={(e) => setForm((f) => ({ ...f, enabled: e.target.checked }))} />
          <span>{tr('helpdesk.helpdeskSettings.takeRequestsFromAnyoneWithout', { v: project.visibility === 'members'
                ? t('helpdesk.helpdeskSettings.isMembersOnlyItsForm', { key: project.key })
                : '', t0: (c: ReactNode) => <small className="field-help">{c}</small> })}</span>
        </label>
        <div className="form-fields">
          <FormField label={t('helpdesk.helpdeskSettings.firstResponseWithinInHours')} help={t('helpdesk.helpdeskSettings.countedRoundTheClockFrom')}>
            {(id, help) => (
              <input
                id={id}
                type="number"
                min={0.25}
                max={1440}
                step={0.25}
                inputMode="decimal"
                value={form.hours}
                aria-describedby={help}
                aria-invalid={badHours || undefined}
                onChange={(e) => setForm((f) => ({ ...f, hours: e.target.value }))}
              />
            )}
          </FormField>
        </div>
        <FormField label={t('helpdesk.helpdeskSettings.wordsAboveTheForm')} help={t('helpdesk.helpdeskSettings.whatToAskHereAnd')}>
          {(id, help) => (
            <textarea id={id} rows={3} maxLength={2000} value={form.intro} aria-describedby={help} onChange={(e) => setForm((f) => ({ ...f, intro: e.target.value }))} />
          )}
        </FormField>
        <label className="choice">
          <input type="checkbox" checked={form.captcha} onChange={(e) => setForm((f) => ({ ...f, captcha: e.target.checked }))} />
          <span>{tr('helpdesk.helpdeskSettings.makeSureAPersonSent', { t0: (c: ReactNode) => <small className="field-help">{c}</small> })}</span>
        </label>
      </fieldset>
      {h.enabled ? (
        <div className="cluster">
          <a href={url} target="_blank" rel="noreferrer">{t('helpdesk.helpdeskSettings.openTheForm')}</a>
          <code>{url}</code>
          <CopyButton text={url} what={t('helpdesk.helpdeskSettings.theFormSAddress')} />
        </div>
      ) : null}
      <p className="note">
        {project.lead
          ? t('helpdesk.helpdeskSettings.leadsSoTheyReTold', { name: project.lead.name, key: project.key })
          : t('helpdesk.helpdeskSettings.hasNoLeadSoNobody', { key: project.key })}
      </p>
      {canEdit ? (
        <div className="cluster">
          <button type="submit" className="primary" disabled={!dirty || badHours || save.isPending}>
            {save.isPending ? t('helpdesk.helpdeskSettings.saving') : t('helpdesk.helpdeskSettings.saveTheHelpDesk')}
          </button>
          <Said text={badHours ? t('helpdesk.helpdeskSettings.theTargetIsBetweenA') : said?.text} tone={badHours || said?.bad ? 'bad' : undefined} />
        </div>
      ) : null}
    </form>
  );
}
