import { useId, useRef } from 'react';

/**
 * Ocean's Confirm: a danger button that asks first, in the browser's own dialog, before what
 * can't be undone. The question names the thing; the safe answer comes first and has the focus;
 * Escape keeps it.
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
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const keep = useRef<HTMLButtonElement>(null);
  const id = useId();
  const open = () => {
    dialog.current?.showModal();
    keep.current?.focus();
  };
  return (
    <>
      <button type="button" className={small ? 'danger small' : 'danger'} onClick={open} disabled={disabled} aria-label={name}>
        {label}
      </button>
      <dialog ref={dialog} className="dialog" aria-labelledby={`${id}-title`} aria-describedby={`${id}-about`}>
        <h2 id={`${id}-title`}>{title}</h2>
        <p id={`${id}-about`}>{about}</p>
        <div className="dialog-actions">
          <button type="button" ref={keep} onClick={() => dialog.current?.close()}>
            Keep it
          </button>
          <button
            type="button"
            className="danger primary"
            onClick={() => {
              dialog.current?.close();
              onConfirm();
            }}
          >
            {confirm}
          </button>
        </div>
      </dialog>
    </>
  );
}
