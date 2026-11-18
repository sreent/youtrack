import { intlLocale, t } from '../../i18n';
import { hoursWords } from '../common/format';
/** Figures in words, as Ocean writes them: "1 task", "3 days", "$46,000", "6h". */

/** "2 days later", "1 day earlier"; "as it was" for none. A count is a message's own plural (D49). */
export function shift(n: number): string {
  if (n === 0) return t('plan.format.asItWas');
  return t(n > 0 ? 'plan.format.daysLater' : 'plan.format.daysEarlier', { n: Math.abs(n) });
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
  return hoursWords(h);
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
