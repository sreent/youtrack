import type { Project } from '@a4a/shared';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { patch } from '../../api/client';
import { keys } from '../../api/queries';
import { errorText, FormField, Said } from '../common/bits';
import { CopyButton } from '../common/CopyButton';

/** A project's help desk: whether its public form takes requests, its first-response target, and its words. */
export function HelpdeskSettings({ project, canEdit }: { project: Project; canEdit: boolean }) {
  const qc = useQueryClient();
  const h = project.settings.helpdesk;
  const initial = { enabled: h.enabled, hours: h.firstResponseHours === null ? '' : String(h.firstResponseHours), intro: h.intro };
  const savedKey = JSON.stringify(initial);
  const [form, setForm] = useState(initial);
  const [said, setSaid] = useState<{ text: string; bad?: boolean } | null>(null);
  useEffect(() => setForm(JSON.parse(savedKey) as typeof initial), [savedKey]);
  const dirty = JSON.stringify(form) !== savedKey;
  const hours = form.hours.trim() === '' ? null : Number(form.hours);
  const badHours = hours !== null && (!Number.isFinite(hours) || hours < 0.25 || hours > 1440);
  const save = useMutation({
    mutationFn: () => patch<Project>(`/projects/${project.key}`, { settings: { helpdesk: { enabled: form.enabled, firstResponseHours: hours, intro: form.intro.trim() } } }),
    onSuccess: (p) => {
      qc.setQueryData(keys.project(p.key), p);
      void qc.invalidateQueries({ queryKey: keys.projects });
      setSaid({ text: p.settings.helpdesk.enabled ? 'Saved. The form takes requests.' : 'Saved. The form is closed; requests already in keep their pages.' });
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
          <span>
            Take requests from anyone, without signing in
            <small className="field-help">
              Each becomes an issue here, reported by the help desk for whoever asked, who follows it on a page of its own. Comments stay internal unless you make one
              public.
            </small>
          </span>
        </label>
        <div className="form-fields">
          <FormField label="First response within, in hours" help="Counted round the clock from when a request comes in. Empty for no target.">
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
        <FormField label="Words above the form" help="What to ask here, and what you need to know to help.">
          {(id, help) => (
            <textarea id={id} rows={3} maxLength={2000} value={form.intro} aria-describedby={help} onChange={(e) => setForm((f) => ({ ...f, intro: e.target.value }))} />
          )}
        </FormField>
      </fieldset>
      {h.enabled ? (
        <div className="cluster">
          <a href={url} target="_blank" rel="noreferrer">
            Open the form
          </a>
          <code>{url}</code>
          <CopyButton text={url} what="the form's address" />
        </div>
      ) : null}
      <p className="note">
        {project.lead
          ? `${project.lead.name} leads ${project.key}, so they're told of each request and watch it.`
          : `${project.key} has no lead, so nobody is told when a request comes in. Choose a lead under Details.`}
      </p>
      {canEdit ? (
        <div className="cluster">
          <button type="submit" className="primary" disabled={!dirty || badHours || save.isPending}>
            {save.isPending ? 'Saving…' : 'Save the help desk'}
          </button>
          <Said text={badHours ? 'The target is between a quarter of an hour and 60 days.' : said?.text} tone={badHours || said?.bad ? 'bad' : undefined} />
        </div>
      ) : null}
    </form>
  );
}
