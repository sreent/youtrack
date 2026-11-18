import { useEffect, useRef, useState } from 'react';
import { t } from '../../i18n';

async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    // No clipboard permission (or an insecure origin): the old way, from a selection.
    const area = document.createElement('textarea');
    area.value = text;
    area.setAttribute('readonly', '');
    area.className = 'hidden';
    document.body.appendChild(area);
    area.select();
    let ok = false;
    try {
      ok = document.execCommand('copy');
    } catch {
      ok = false;
    }
    area.remove();
    return ok;
  }
}

/**
 * Copies a value, and says so where a screen reader hears it. Once copied, the button itself says
 * "Copied" and the sentence is for the screen reader alone; a copy that failed says why beside it.
 * Which is which is the outcome, not the sentence's first word, which is English's alone.
 */
export function CopyButton({ text, label = t('common.copyButton.copy'), what }: { text: string; label?: string; what: string }) {
  const [said, setSaid] = useState<{ text: string; copied: boolean } | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
    },
    [],
  );
  const copy = async () => {
    const ok = await copyText(text);
    setSaid({ text: ok ? t('common.copyButton.copied', { what: what }) : t('common.copyButton.couldnTCopySelectIt', { what: what }), copied: ok });
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => setSaid(null), 3000);
  };
  return (
    <span className="copy">
      <button type="button" onClick={copy}>
        {said?.copied ? t('common.copyButton.copied2') : label}
      </button>
      <span role="status" className="copy-said">
        {said && !said.copied ? said.text : <span className="hidden">{said?.text ?? ''}</span>}
      </span>
    </span>
  );
}
