import { useId, useState } from 'react';

/**
 * Ocean's Hint: one sentence on what something means, for whoever points at its trigger or tabs
 * to it. Escape hides it. Never for what someone must read to act.
 */
export function Hint({ label, hint }: { label: string; hint: string }) {
  const [open, setOpen] = useState(false);
  const id = useId();
  return (
    <span className="hint-anchor" onMouseEnter={() => setOpen(true)} onMouseLeave={() => setOpen(false)}>
      <button
        type="button"
        className="link"
        aria-describedby={id}
        onFocus={() => setOpen(true)}
        onBlur={() => setOpen(false)}
        onKeyDown={(e) => {
          if (e.key === 'Escape') setOpen(false);
        }}
        onClick={() => setOpen((o) => !o)}
      >
        {label}
      </button>
      <span className="hint" role="tooltip" id={id} hidden={!open}>
        {hint}
      </span>
    </span>
  );
}
