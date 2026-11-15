import type { Change } from '@a4a/shared';

/** A change in Ocean's grammar: what it was struck through, what it becomes in `--changes`. */
export function ChangeLines({ changes, same }: { changes: Change[]; same?: string[] }) {
  if (!changes.length && !same?.length) return null;
  return (
    <ul className="change-lines">
      {changes.map((c, i) => (
        <li key={`${c.field}-${i}`}>
          <span className="change-field">{c.field}:</span>{' '}
          {c.from !== null && c.to !== null ? (
            <>
              <del>{c.from}</del> → <ins>{c.to}</ins>
            </>
          ) : c.to !== null ? (
            <>
              <ins>{c.to}</ins> <span className="same">added</span>
            </>
          ) : (
            <>
              <del>{c.from}</del> <span className="same">removed</span>
            </>
          )}
        </li>
      ))}
      {same?.map((s) => (
        <li key={s} className="same">
          {s}
        </li>
      ))}
    </ul>
  );
}
