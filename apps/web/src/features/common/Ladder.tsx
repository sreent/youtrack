import { useId } from 'react';

export interface Rung<V extends string> {
  value: V;
  /** The family's word for the rung: Observes, Suggests, Asks, Acts (or Off, where the agent doesn't run). */
  name: string;
  /** The product's own name for it, in mono: "ask", "auto". */
  lvl: string;
  about: string;
}

/**
 * Ocean's AutonomyLadder, as a choice: the rung the agent works on has the agent colour, the rungs
 * beyond it are dashed (allowed, not in force), and each rung is a radio a keyboard reaches.
 */
export function LadderChoice<V extends string>({
  legend,
  rungs,
  value,
  onChange,
  disabled,
  note,
}: {
  legend: string;
  rungs: Rung<V>[];
  value: V;
  onChange?: (value: V) => void;
  disabled?: boolean;
  note?: React.ReactNode;
}) {
  const name = useId();
  const at = rungs.findIndex((r) => r.value === value);
  return (
    <fieldset className="ladder-choice" disabled={disabled || !onChange}>
      <legend className="label">{legend}</legend>
      <div className="ladder-box">
        <ol className={rungs.length === 2 ? 'ladder two' : 'ladder'}>
          {rungs.map((r, i) => {
            const now = i === at;
            return (
              <li key={r.value} aria-current={now ? 'step' : undefined} className={i > at ? 'beyond' : disabled ? 'barred' : undefined}>
                <label className="rung">
                  <span className="lvl">
                    {r.lvl}
                    {now ? ' · now' : ''}
                  </span>
                  <span className="rung-name">
                    <input type="radio" name={name} value={r.value} checked={now} onChange={() => onChange?.(r.value)} />
                    <strong>{r.name}</strong>
                  </span>
                  <p>{r.about}</p>
                </label>
              </li>
            );
          })}
        </ol>
      </div>
      {note ? <p className="note ladder-note">{note}</p> : null}
    </fieldset>
  );
}
