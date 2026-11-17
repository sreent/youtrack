/**
 * The whiteboard as a list (Ocean's Whiteboard outline): sections with what lies in each, what lies in
 * none, then the arrows, in reading order, the keyboard's order on the canvas too. Each row chooses its
 * element and takes the focus to it on the canvas; it's what a screen reader and a phone start from.
 */
import type { WhiteboardElement } from '@a4a/shared';
import { whiteboardOutline } from '@a4a/shared/whiteboard';
import { Icon, type IconName } from '../../components/Icon';
import { t } from '../../i18n';
import type { Elements } from './model';

const ICON = new Map<WhiteboardElement['kind'], IconName>([
  ['note', 'message'],
  ['text', 'quote'],
  ['section', 'board'],
  ['issue', 'tasks'],
  ['article', 'book'],
  ['arrow', 'link'],
]);

export function Outline({
  id,
  elements,
  chosen,
  onPick,
  kindOf,
  wordsOf,
}: {
  id: string;
  elements: Elements;
  chosen: ReadonlySet<string>;
  /** Choose it alone, or (with Shift or Ctrl) beside what's chosen. */
  onPick: (id: string, toggle: boolean) => void;
  kindOf: (e: WhiteboardElement) => string;
  wordsOf: (e: WhiteboardElement) => string;
}) {
  const o = whiteboardOutline([...elements.values()]);
  const row = (e: WhiteboardElement) => (
    <button type="button" className="whiteboard-row" aria-pressed={chosen.has(e.id)} onClick={(ev) => onPick(e.id, ev.shiftKey || ev.ctrlKey || ev.metaKey)}>
      <Icon name={ICON.get(e.kind) ?? 'list'} />
      <span className="whiteboard-row-text">
        <span className="whiteboard-row-kind">{kindOf(e)}</span>
        <span className="whiteboard-row-words">{wordsOf(e)}</span>
      </span>
    </button>
  );
  return (
    <nav className="whiteboard-outline" aria-labelledby={`${id}-title`}>
      <h2 id={`${id}-title`}>{t('whiteboards.outline.title')}</h2>
      {!elements.size ? <p className="note">{t('whiteboards.outline.empty')}</p> : null}
      <ol>
        {o.sections.map((s) => (
          <li key={s.section.id}>
            {row(s.section)}
            {s.inside.length ? <ol>{s.inside.map((e) => <li key={e.id}>{row(e)}</li>)}</ol> : null}
          </li>
        ))}
        {o.loose.map((e) => (
          <li key={e.id}>{row(e)}</li>
        ))}
        {o.arrows.map((e) => (
          <li key={e.id}>{row(e)}</li>
        ))}
      </ol>
    </nav>
  );
}
