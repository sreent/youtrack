/**
 * @mentions: "@anna" names the person whose login is anna. The server reads them to notify and
 * to watch; the web app reads them to show the person's name. Both read them the same way here.
 *
 * - An @ counts only where a word doesn't run into it, so an email address ("anna@example.com")
 *   and a path ("/@anna") mention nobody.
 * - A login may hold dots, dashes and underscores; one that ends a sentence ("@anna.") is anna.
 * - In Markdown, code (fenced or inline) mentions nobody.
 */

/** "@" and what follows it: group 1 is what came before, group 2 the login as typed. */
export const MENTION = /(^|[^\p{L}\p{N}_@./-])@([A-Za-z0-9][A-Za-z0-9._-]{0,63})/gu;

/** Code in Markdown: fenced blocks and inline spans, which mention nobody. */
const CODE = /(```[\s\S]*?```|~~~[\s\S]*?~~~|`[^`\n]*`)/;

/**
 * The login a mention names, or null: the longest known login that the typed text starts with,
 * giving up only trailing dots, dashes and underscores ("anna." → "anna").
 */
export function mentionLogin(typed: string, known: (login: string) => string | null): string | null {
  let login = typed;
  while (login) {
    const found = known(login);
    if (found) return found;
    if (!/[._-]$/.test(login)) return null;
    login = login.slice(0, -1);
  }
  return null;
}

/**
 * Who a text mentions, each once, in the order they first appear. `known` takes a login as typed
 * and gives the login as it is stored, or null when nobody has it (it should ignore case).
 */
export function findMentions(markdown: string, known: (login: string) => string | null): string[] {
  const out: string[] = [];
  const parts = markdown.split(CODE);
  for (let i = 0; i < parts.length; i += 2) {
    for (const m of parts[i]!.matchAll(MENTION)) {
      const login = mentionLogin(m[2]!, known);
      if (login && !out.includes(login)) out.push(login);
    }
  }
  return out;
}

/** Logins mentioned in `after` and not in `before`, as when a description or comment is edited. */
export function newMentions(before: string, after: string, known: (login: string) => string | null): string[] {
  const had = new Set(findMentions(before, known));
  return findMentions(after, known).filter((l) => !had.has(l));
}
