import type { PortalMe } from '@a4a/shared';
import { isLocale, langTag, LOCALE_NAMES, LOCALES, matchLocale } from '@a4a/shared/i18n';
import { useQueryClient } from '@tanstack/react-query';
import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { patch } from '../../api/client';
import { Lone } from '../../app/Auth';
import { ErrorNote } from '../../components/States';
import { choosePortalLocale, keepPortalLocale, portalChoice, serverDefaultLocale, t } from '../../i18n';
import { FormField } from '../common/bits';

/**
 * The language of the help desk's pages (D63's revisit), on every page a requester reaches, signed in
 * or out: first their browser's, then each language by its own name, with its `lang`, so someone who
 * can't read the page still finds theirs. Signed in, it's the requester's, on every device and in every
 * email; signed out, this browser's alone, until a sign-in makes it theirs.
 *
 * Choosing reloads the page into the language (D49), so it waits for the button: a select that reloaded
 * on change would leave the page at a keyboard's first arrow through it.
 */
export function PortalLanguage({ me, busy }: { me?: PortalMe | null; busy?: boolean }) {
  const qc = useQueryClient();
  const current = me ? (me.locale ?? '') : (portalChoice() ?? '');
  const [picked, setPicked] = useState<string>(current);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<unknown>(null);
  useEffect(() => setPicked(current), [current]);
  const browser = useMemo(() => matchLocale(navigator.languages?.length ? navigator.languages : [navigator.language], me?.defaultLocale ?? serverDefaultLocale()), [me?.defaultLocale]);
  const choose = async (e: React.FormEvent) => {
    e.preventDefault();
    const locale = isLocale(picked) ? picked : null;
    if (!me) return choosePortalLocale(locale);
    setSaving(true);
    setError(null);
    try {
      const next = await patch<PortalMe>('/portal/me', { locale });
      qc.setQueryData(['portal', 'me'], next);
      keepPortalLocale(next.locale, next.defaultLocale);
    } catch (err) {
      setError(err);
    } finally {
      setSaving(false);
    }
  };
  return (
    <form className="cluster end" onSubmit={(e) => void choose(e)}>
      <FormField label={t('helpdesk.portalLanguage.label')} className="inline">
        {(id) => (
          <select id={id} value={picked} disabled={busy || saving} onChange={(e) => setPicked(e.target.value)}>
            <option value="">{t('helpdesk.portalLanguage.browsers', { name: LOCALE_NAMES[browser] })}</option>
            {LOCALES.map((l) => (
              // Each by its own name, so whoever can't read this page still finds theirs.
              <option key={l} value={l} lang={langTag(l)}>
                {LOCALE_NAMES[l]}
              </option>
            ))}
          </select>
        )}
      </FormField>
      <button type="submit" disabled={busy || saving || picked === current}>
        {t('helpdesk.portalLanguage.change')}
      </button>
      {error ? <ErrorNote error={error} /> : null}
    </form>
  );
}

/** A requester's page (D45): one card, its language at its head, where someone who can't read it looks first. */
export function RequesterLone({ children, wide, me, busy }: { children: ReactNode; wide?: boolean; me?: PortalMe | null; busy?: boolean }) {
  return (
    <Lone wide={wide}>
      <PortalLanguage me={me} busy={busy} />
      {children}
    </Lone>
  );
}
