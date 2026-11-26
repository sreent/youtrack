import type { Change } from '@a4a/shared';
import { formatItems, t } from '../i18n';

/**
 * a4a's own names in a help desk request's history (D56), said in the page's language: its customer
 * group, and its being kept from the group, whose values are yes and no. Fields people named stay theirs.
 * Several values on a side (a multi-value field's, the tags) are listed as the page's language lists them (D49).
 */
function said(change: Change): Change {
  const c = { ...change, from: change.fromList ? formatItems(change.fromList) : change.from, to: change.toList ? formatItems(change.toList) : change.to };
  if (c.field === 'Customer group') return { ...c, field: t('ui.changes.customerGroup') };
  if (c.field !== 'Private') return c;
  const yesNo = (v: string | null) => (v === null ? null : v === 'yes' ? t('ui.changes.yes') : t('ui.changes.no'));
  return { field: t('ui.changes.keptFromGroup'), from: yesNo(c.from), to: yesNo(c.to) };
}

/** A change in Ocean's grammar: what it was struck through, what it becomes in `--changes`. */
export function ChangeLines({ changes, same }: { changes: Change[]; same?: string[] }) {
  if (!changes.length && !same?.length) return null;
  return (
    <ul className="change-lines">
      {changes.map(said).map((c, i) => (
        <li key={`${c.field}-${i}`}>
          <span className="change-field">{t('ui.changes.fieldLabel', { field: c.field })}</span>{' '}
          {c.from !== null && c.to !== null ? (
            <>
              <del>{c.from}</del> → <ins>{c.to}</ins>
            </>
          ) : c.to !== null ? (
            <>
              <ins>{c.to}</ins> <span className="same">{t('ui.changes.added')}</span>
            </>
          ) : (
            <>
              <del>{c.from}</del> <span className="same">{t('ui.changes.removed')}</span>
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
