export function excerpt(text: string, max = 280): string {
  const clean = text.replace(/\s+/g, ' ').trim();
  return clean.length > max ? `${clean.slice(0, max - 1)}…` : clean;
}

/** Levenshtein distance, for "did you mean" hints. */
export function editDistance(a: string, b: string): number {
  const m = a.length;
  const n = b.length;
  if (!m) return n;
  if (!n) return m;
  let prev = Array.from({ length: n + 1 }, (_, i) => i);
  for (let i = 1; i <= m; i++) {
    const cur = [i];
    for (let j = 1; j <= n; j++) {
      cur[j] = Math.min(prev[j]! + 1, cur[j - 1]! + 1, prev[j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    prev = cur;
  }
  return prev[n]!;
}

export function didYouMean(input: string, options: Iterable<string>): string | undefined {
  const lower = input.toLowerCase();
  let best: string | undefined;
  let bestScore = Infinity;
  for (const option of options) {
    const o = option.toLowerCase();
    if (lower.length >= 2 && o.startsWith(lower)) return option;
    const d = editDistance(lower, o);
    if (d < bestScore) {
      bestScore = d;
      best = option;
    }
  }
  return best !== undefined && bestScore <= Math.max(2, Math.floor(input.length / 3)) ? best : undefined;
}

export function normalizeName(s: string): string {
  return s.trim().replace(/\s+/g, ' ').toLowerCase();
}
