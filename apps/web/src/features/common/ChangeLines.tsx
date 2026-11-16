import type { Change } from '@a4a/shared';
import { excerpt } from './format';
import { t } from '../../i18n';

/** Fields whose change is something added or taken away, rather than one value for another. */
const ADDS = new Set(['links', 'comment', 'tags']);

/** What a change did to an issue, a line each, in the grammar of a change (Ocean's change lines). */
export function ChangeLines({ changes }: { changes: Change[] }) {
  if (!changes.length) return null;
  return (
    <ul className="change-lines">
      {changes.map((c, i) => {
        const adds = ADDS.has(c.field.toLowerCase());
        const from = c.from ? excerpt(c.from, 160) : null;
        const to = c.to ? excerpt(c.to, 160) : null;
        return (
          <li key={`${c.field}-${i}`}>
            <span className="change-field">{c.field}:</span>{' '}
            {from && to ? (
              <>
                <del>{from}</del> → <ins>{to}</ins>
              </>
            ) : to ? (
              adds ? (
                <>
                  <ins>{to}</ins> <span className="same">{t('common.changeLines.added')}</span>
                </>
              ) : (
                <>
                  <span className="same">{t('common.changeLines.none')}</span> → <ins>{to}</ins>
                </>
              )
            ) : from ? (
              adds ? (
                <>
                  <del>{from}</del> <span className="same">{t('common.changeLines.removed')}</span>
                </>
              ) : (
                <>
                  <del>{from}</del> → <span className="same">{t('common.changeLines.none')}</span>
                </>
              )
            ) : (
              <span className="same">{t('common.changeLines.cleared')}</span>
            )}
          </li>
        );
      })}
    </ul>
  );
}

/**
 * A change as the server words it in a preview ("State Open → Fixed", "Due date — → 2026-12-01"),
 * read back into its field, from and to, using the field names it knows (they may hold spaces).
 */
export function readChange(line: string, fieldNames: string[]): Change | null {
  const names = [...fieldNames, 'Summary', 'Description', 'Tags', 'Links', 'Comment'].sort((a, b) => b.length - a.length);
  const field = names.find((n) => line.toLowerCase().startsWith(`${n.toLowerCase()} `));
  if (!field) return null;
  const rest = line.slice(field.length + 1);
  const arrow = rest.indexOf(' → ');
  if (arrow < 0) return null;
  const from = rest.slice(0, arrow).trim();
  const to = rest.slice(arrow + 3).trim();
  return { field, from: from === '—' || from === '' ? null : from, to: to === '—' || to === '' ? null : to };
}
