import { describe, expect, it } from 'vitest';
import { addDays } from '../../src/lib/dates';
import {
  addWorkingDays,
  isWorkingDay,
  listWorkingDays,
  nextWorkingDay,
  prevWorkingDay,
  workingDaysBetween,
  workingDaysInclusive,
} from '../../src/planning';
import { calendar } from './fixtures';

const cal = calendar(); // Mon–Fri, Thu 2026-11-19 off

describe('working-day arithmetic', () => {
  it('knows weekends and holidays', () => {
    expect(isWorkingDay(cal, '2026-11-16')).toBe(true); // Monday
    expect(isWorkingDay(cal, '2026-11-19')).toBe(false); // holiday
    expect(isWorkingDay(cal, '2026-11-21')).toBe(false); // Saturday
  });

  it('rolls to the next or previous working day, keeping a working day as is', () => {
    expect(nextWorkingDay(cal, '2026-11-16')).toBe('2026-11-16');
    expect(nextWorkingDay(cal, '2026-11-19')).toBe('2026-11-20');
    expect(nextWorkingDay(cal, '2026-11-21')).toBe('2026-11-23');
    expect(prevWorkingDay(cal, '2026-11-22')).toBe('2026-11-20');
    expect(prevWorkingDay(cal, '2026-11-19')).toBe('2026-11-18');
    expect(prevWorkingDay(cal, '2026-11-18')).toBe('2026-11-18');
  });

  it('adds working days across weekends and holidays, in both directions', () => {
    expect(addWorkingDays(cal, '2026-11-16', 0)).toBe('2026-11-16');
    expect(addWorkingDays(cal, '2026-11-18', 1)).toBe('2026-11-20'); // skips the holiday
    expect(addWorkingDays(cal, '2026-11-20', 1)).toBe('2026-11-23'); // skips the weekend
    expect(addWorkingDays(cal, '2026-11-16', 4)).toBe('2026-11-23');
    expect(addWorkingDays(cal, '2026-11-23', -4)).toBe('2026-11-16');
    expect(addWorkingDays(cal, '2026-11-21', 1)).toBe('2026-11-23'); // from a Saturday
    expect(addWorkingDays(cal, '2026-11-21', -1)).toBe('2026-11-20');
  });

  it('counts working days from a to b, exclusive of a and inclusive of b, signed', () => {
    expect(workingDaysBetween(cal, '2026-11-16', '2026-11-16')).toBe(0);
    expect(workingDaysBetween(cal, '2026-11-16', '2026-11-23')).toBe(4); // 17, 18, 20, 23
    expect(workingDaysBetween(cal, '2026-11-23', '2026-11-16')).toBe(-4);
    expect(workingDaysBetween(cal, '2026-11-20', '2026-11-23')).toBe(1);
    expect(workingDaysBetween(cal, '2026-11-18', '2026-11-20')).toBe(1);
  });

  it('counts and lists the working days of a range', () => {
    expect(workingDaysInclusive(cal, '2026-11-16', '2026-11-20')).toBe(4);
    expect(workingDaysInclusive(cal, '2026-11-21', '2026-11-22')).toBe(0);
    expect(workingDaysInclusive(cal, '2026-11-20', '2026-11-16')).toBe(0);
    expect(listWorkingDays(cal, '2026-11-18', '2026-11-23')).toEqual(['2026-11-18', '2026-11-20', '2026-11-23']);
    expect(listWorkingDays(cal, '2026-11-21', '2026-11-22')).toEqual([]);
  });

  it('treats a calendar without working days as Monday to Friday', () => {
    const empty = calendar({ workingDays: [], holidays: [] });
    expect(isWorkingDay(empty, '2026-11-20')).toBe(true);
    expect(isWorkingDay(empty, '2026-11-21')).toBe(false);
    expect(addWorkingDays(empty, '2026-11-20', 1)).toBe('2026-11-23');
  });

  it('counts long ranges arithmetically, matching a day-by-day count', () => {
    const busy = calendar({ workingDays: [1, 2, 4, 6], holidays: ['2027-01-01', '2027-05-01', '2028-12-25', '2029-04-02'] });
    const ranges: [string, string][] = [
      ['2026-11-16', '2026-11-16'],
      ['2026-11-17', '2027-02-03'],
      ['2026-01-01', '2031-12-31'],
      ['2027-04-29', '2027-05-03'],
    ];
    for (const [from, to] of ranges) {
      let expected = 0;
      for (let d = from; d <= to; d = addDays(d, 1)) if (isWorkingDay(busy, d)) expected++;
      expect(workingDaysInclusive(busy, from, to)).toBe(expected);
    }
    expect(workingDaysBetween(cal, '1926-01-01', '2026-01-01')).toBeGreaterThan(26_000); // no step cap for counts
  });

  it('throws a clear error instead of looping when no working day can be reached', () => {
    const mondays: string[] = [];
    for (let d = '2026-11-23'; mondays.length < 3_000; d = addDays(d, 7)) mondays.push(d);
    const blocked = calendar({ workingDays: [1], holidays: mondays });
    expect(() => nextWorkingDay(blocked, '2026-11-17')).toThrow(/No working day within 20000 days after 2026-11-17/);
  });
});
