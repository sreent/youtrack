/**
 * What every report chart needs: a frame (where the plot sits in the SVG, its words beside it),
 * a scale that ends on a round figure, and figures as people read them. Charts are SVG drawn from
 * attributes (Ocean's components/Burndown and the others): nothing here sets a style.
 */
import { useLayoutEffect, useRef, useState, type RefObject } from 'react';
import { hoursWords } from '../common/format';
import { t } from '../../i18n';

/**
 * The width a chart is shown at. Drawn at that width, one unit to a pixel, a chart's words keep
 * their size on a phone instead of shrinking with the picture.
 */
export function useChartWidth(fallback = 640): [RefObject<HTMLElement | null>, number] {
  const ref = useRef<HTMLElement | null>(null);
  const [width, setWidth] = useState(fallback);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const measure = () => {
      const w = Math.round(el.getBoundingClientRect().width);
      if (w > 0) setWidth(Math.max(280, Math.min(960, w)));
    };
    measure();
    if (typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  return [ref, width];
}

/** As many labels along the foot as fit, at about one per `room` pixels. */
export const labelRoom = (f: Frame, room = 72) => Math.max(2, Math.floor(plotWidth(f) / room));

export interface Frame {
  width: number;
  height: number;
  left: number;
  right: number;
  top: number;
  bottom: number;
}

export const plotWidth = (f: Frame) => f.width - f.left - f.right;
export const plotHeight = (f: Frame) => f.height - f.top - f.bottom;

/** A scale from 0 to a round figure past `max`, in 3 to 6 steps. */
export function niceScale(max: number, minStep = 1): { max: number; step: number; ticks: number[] } {
  if (!(max > 0)) return { max: minStep * 4, step: minStep, ticks: [0, minStep, minStep * 2, minStep * 3, minStep * 4] };
  const raw = max / 4;
  const power = 10 ** Math.floor(Math.log10(raw));
  const step = Math.max(minStep, ([1, 2, 2.5, 5, 10].map((m) => m * power).find((s) => s >= raw) ?? 10 * power));
  const top = Math.ceil(max / step) * step;
  const ticks: number[] = [];
  for (let v = 0; v <= top + step / 1000; v += step) ticks.push(Math.round(v * 1000) / 1000);
  return { max: top, step, ticks };
}

/** Indices of at most `most` labels spread over `n` positions, always the first and the last. */
export function labelled(n: number, most: number): Set<number> {
  const out = new Set<number>();
  if (n <= 0) return out;
  const step = Math.max(1, Math.ceil(n / most));
  let last = 0;
  for (let i = 0; i < n; i += step) {
    out.add(i);
    last = i;
  }
  if (last !== n - 1) {
    if (n - 1 - last < step / 2 && out.size > 1) out.delete(last); // the last two shouldn't crowd each other
    out.add(n - 1);
  }
  return out;
}

const round1 = (n: number) => Math.round(n * 10) / 10;

/** Hours from minutes, as a figure: "12h", "1.5h", "0h". */
export function hoursOf(minutes: number): string {
  return hoursWords(round1(minutes / 60));
}

/** Days as a figure: "2.5 days", "1 day", "6h" under a day. */
export function daysOf(days: number): string {
  if (days < 1) return hoursWords(Math.round(days * 24));
  const d = round1(days);
  return t('count.days', { n: d });
}

/** An SVG path through points, skipping none. */
export function pathThrough(points: [number, number][]): string {
  return points.map(([x, y], i) => `${i ? 'L' : 'M'}${x.toFixed(1)} ${y.toFixed(1)}`).join('');
}

/** A column with its data end rounded (4px) and its foot square, as Ocean's marks are. */
export function column(x: number, y: number, w: number, base: number, r = 4): string {
  const h = base - y;
  if (h <= 0 || w <= 0) return '';
  const rr = Math.min(r, w / 2, h);
  return `M${x.toFixed(1)} ${base.toFixed(1)}V${(y + rr).toFixed(1)}Q${x.toFixed(1)} ${y.toFixed(1)} ${(x + rr).toFixed(1)} ${y.toFixed(1)}H${(x + w - rr).toFixed(1)}Q${(x + w).toFixed(1)} ${y.toFixed(1)} ${(x + w).toFixed(1)} ${(y + rr).toFixed(1)}V${base.toFixed(1)}Z`;
}
