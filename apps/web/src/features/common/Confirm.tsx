import { useId, useRef, useState } from 'react';
import { t } from '../../i18n';

/**
 * Ocean's Confirm: a button that asks first, in the browser's own dialog, before what can't be
 * undone. The question names the thing; the safe answer comes first and has the focus; Escape
 * keeps it.
 *
 * With `typed`, the dialog also asks for a word typed again (a project's new key), for a change
 * everyone meets at once: the confirming answer waits for it, and the field has the focus.
 */
export function Confirm({
  label,
  title,
  about,
  confirm,
  onConfirm,
  disabled,
  small,
  name,
  typed,
  danger = true,
}: {
  /** The button's word: "Revoke it". */
  label: string;
  /** Its name for screen readers, where the word alone repeats down a list: "Delete report.log". */
  name?: string;
  /** A question that names the thing: "Revoke the token claude-code?" */
  title: string;
  /** What goes with it, and that nobody can bring it back. */
  about: string;
  /** The confirming answer: "Revoke it". */
  confirm: string;
  onConfirm: () => void;
  disabled?: boolean;
  small?: boolean;
  /** A word to type again before the confirming answer turns on, and its field's label. Letter case doesn't count. */
  typed?: { label: string; value: string };
  /** The danger colour, for what nobody can bring back; a change that can be taken back asks in the plain one. */
  danger?: boolean;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const keep = useRef<HTMLButtonElement>(null);
  const field = useRef<HTMLInputElement>(null);
  const [again, setAgain] = useState('');
  const id = useId();
  const matches = !typed || again.trim().toUpperCase() === typed.value.trim().toUpperCase();
  const open = () => {
    setAgain('');
    dialog.current?.showModal();
    (typed ? field.current : keep.current)?.focus();
  };
  const go = () => {
    if (!matches) return;
    dialog.current?.close();
    onConfirm();
  };
  const tone = danger ? 'danger' : '';
  return (
    <>
      <button type="button" className={[tone, small ? 'small' : ''].filter(Boolean).join(' ') || undefined} onClick={open} disabled={disabled} aria-label={name}>
        {label}
      </button>
      <dialog ref={dialog} className="dialog" aria-labelledby={`${id}-title`} aria-describedby={`${id}-about`}>
        <h2 id={`${id}-title`}>{title}</h2>
        <p id={`${id}-about`}>{about}</p>
        {typed ? (
          <div className="form-field">
            <label htmlFor={`${id}-typed`}>{typed.label}</label>
            <input
              id={`${id}-typed`}
              ref={field}
              className="mono"
              value={again}
              autoComplete="off"
              autoCapitalize="characters"
              spellCheck={false}
              onChange={(e) => setAgain(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault();
                  go();
                }
              }}
            />
          </div>
        ) : null}
        <div className="dialog-actions">
          <button type="button" ref={keep} onClick={() => dialog.current?.close()}>{t('common.confirm.keepIt')}</button>
          <button type="button" className={`${tone} primary`.trim()} disabled={!matches} onClick={go}>
            {confirm}
          </button>
        </div>
      </dialog>
    </>
  );
}
