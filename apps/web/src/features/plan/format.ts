import { intlLocale } from '../../i18n';
/** Figures in words, as Ocean writes them: "1 task", "3 days", "$46,000", "6h". */

export function plural(n: number, one: string, many = `${one}s`): string {
  return `${n} ${n === 1 ? one : many}`;
}

/** Working days, as a span of time: "1 day", "3 days". */
export const days = (n: number) => plural(n, 'day');

/** "2 days later", "1 day earlier"; "as it was" for none. */
export function shift(n: number): string {
  if (n === 0) return 'as it was';
  return `${days(Math.abs(n))} ${n > 0 ? 'later' : 'earlier'}`;
}

const moneyFormats = new Map<string, Intl.NumberFormat>();

/** Whole units of the plan's currency: "$46,000", "€1,250". */
export function money(n: number, currency: string): string {
  let f = moneyFormats.get(currency);
  if (!f) {
    try {
      f = new Intl.NumberFormat(intlLocale(), { style: 'currency', currency, currencyDisplay: 'narrowSymbol', maximumFractionDigits: 0 });
    } catch {
      // not an ISO currency code: show the figure with the code beside it
      const plain = new Intl.NumberFormat(intlLocale(), { maximumFractionDigits: 0 });
      f = { format: (x: number) => `${plain.format(x)} ${currency}` } as Intl.NumberFormat;
    }
    moneyFormats.set(currency, f);
  }
  return f.format(Math.round(n)).replace('-', '−');
}

/** Hours with at most one decimal: "16h", "5.3h". */
export function hours(h: number): string {
  const r = Math.round(h * 10) / 10;
  return `${Number.isInteger(r) ? r : r.toFixed(1)}h`;
}

/** Minutes of effort as days and hours of a working day: "3d", "1d 4h", "6h". */
export function effort(minutes: number, hoursPerDay = 8): string {
  if (minutes <= 0) return '0h';
  const h = Math.round(minutes / 6) / 10;
  const d = Math.floor(h / hoursPerDay);
  const rest = Math.round((h - d * hoursPerDay) * 10) / 10;
  if (!d) return hours(rest);
  return rest ? `${d}d ${hours(rest)}` : `${d}d`;
}

/** "BACK-12, BACK-15 and BACK-19" */
export function andList(items: string[]): string {
  if (items.length <= 1) return items.join('');
  return `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`;
}
