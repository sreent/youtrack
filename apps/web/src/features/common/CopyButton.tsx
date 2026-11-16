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

/** Copies a value, and says so where a screen reader hears it. */
export function CopyButton({ text, label = 'Copy', what }: { text: string; label?: string; what: string }) {
  const [said, setSaid] = useState('');
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
    },
    [],
  );
  const copy = async () => {
    const ok = await copyText(text);
    setSaid(ok ? t('common.copyButton.copied', { what: what }) : t('common.copyButton.couldnTCopySelectIt', { what: what }));
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => setSaid(''), 3000);
  };
  return (
    <span className="copy">
      <button type="button" onClick={copy}>
        {said.startsWith('Copied') ? t('common.copyButton.copied2') : label}
      </button>
      <span role="status" className="copy-said">
        {said && !said.startsWith('Copied') ? said : <span className="hidden">{said}</span>}
      </span>
    </span>
  );
}
