/**
 * Issue ids in what people write in version control: commit messages, and pull requests' titles,
 * branches and descriptions. A commit can also give an issue a command, YouTrack's way: the
 * words after a "#" that follows the id, to the end of the line.
 *
 *   BACK-12 #Fixed
 *   Fix Safari login (BACK-12 #State Fixed Assignee anna)
 *   BACK-12 #Fixed BACK-14 #Open     two issues, each with its own command
 */

export interface Mention {
  /** The readable id, its key upper-cased: BACK-12. */
  id: string;
  /** The command after "#", without it ("Fixed"), or null. */
  command: string | null;
}

/** A key as projects have them (a letter, then letters and digits), a dash, and a number. */
const ID = /\b([A-Za-z][A-Za-z0-9]{1,9})-(\d{1,9})\b/g;
const MAX_COMMAND = 500;

/**
 * The issues `text` mentions, once each and in order, with the command the first mention gave.
 * Only keys in `keys` count (so "UTF-8" or "SHA-256" mean nothing in a project called BACK).
 * With `commands` false, as for pull requests, no command is read.
 */
export function mentions(text: string, keys: ReadonlySet<string>, commands = true): Mention[] {
  const out = new Map<string, Mention>();
  for (const line of text.split(/\r?\n/)) {
    const found: { id: string; start: number; end: number; hash: number | null }[] = [];
    for (const m of line.matchAll(ID)) {
      const key = m[1]!.toUpperCase();
      if (!keys.has(key)) continue;
      const end = m.index! + m[0].length;
      const hash = /^\s+#(?=\S)/.exec(line.slice(end));
      found.push({ id: `${key}-${Number(m[2])}`, start: m.index!, end, hash: hash ? end + hash[0].length : null });
    }
    found.forEach((f, i) => {
      let command: string | null = null;
      if (commands && f.hash !== null) {
        // To the line's end, or to the next issue that has a command of its own.
        const next = found.slice(i + 1).find((g) => g.hash !== null);
        command = tidyCommand(line.slice(f.hash, next ? next.start : line.length));
      }
      const seen = out.get(f.id);
      if (!seen) out.set(f.id, { id: f.id, command });
      else if (!seen.command && command) seen.command = command;
    });
  }
  return [...out.values()];
}

/**
 * A command as written in a sentence: without the punctuation that ends it, or a bracket it sits
 * in ("(BACK-12 #Fixed)"). "BACK-12 #45 …" refers to pull request 45: it gives no command.
 */
function tidyCommand(raw: string): string | null {
  let text = raw.trim();
  for (;;) {
    const before = text;
    text = text.replace(/[.,;:!?]+$/, '').trimEnd();
    for (const [open, close] of [['(', ')'], ['[', ']']] as const) {
      if (text.endsWith(close) && text.split(close).length > text.split(open).length) text = text.slice(0, -1).trimEnd();
    }
    if (text === before) break;
  }
  if (!text || /^\d+(\s|$)/.test(text)) return null;
  return text.slice(0, MAX_COMMAND);
}

/** The first line of a message, and the rest. */
export function splitMessage(message: string): { title: string; body: string } {
  const text = message.replace(/\r\n/g, '\n').trim();
  const nl = text.indexOf('\n');
  return nl < 0 ? { title: text, body: '' } : { title: text.slice(0, nl).trim(), body: text.slice(nl + 1).trim() };
}
