/**
 * One engine across projects' calendars (D73): each task on its own project's calendar, then its
 * assignee's week and days away; plan-level numbers on the union of the plan's calendars.
 *
 * Two projects, from Monday 16 November 2026 (today):
 *
 *            Sun Mon Tue Wed Thu Fri Sat Sun Mon Tue Wed Thu Fri Sat Sun Mon
 *             15  16  17  18  19  20  21  22  23  24  25  26  27  28  29  30
 *   EU  Mon–Fri    x   x   x   -   x           x   x   x   x   x           x    (Thu 19 a holiday)
 *   ME  Sun–Thu    x   x   x   x           x   x   -   x   x       x   x        (Tue 24 a holiday)
 *   union      .   x   x   x   x   x       x   x   x   x   x   x       x   x    (a day either works)
 */
import { describe, expect, it } from 'vitest';
import { addDays } from '../../src/lib/dates';
import { computeCosts, computeLoad, computeSchedule, levelResources, PLAN_CALENDAR_KEY, whatIf } from '../../src/planning';
import type { PlanAbsence, PlanCalendar, PlanInput, PlanResource, PlanTaskInput } from '../../src/planning';
import { anna, ben, calendar, get, hours, span, task, TODAY } from './fixtures';

const EU = calendar(); // Monday to Friday, 8 hours, Thursday 19 off, EUR
const ME = calendar({ workingDays: [0, 1, 2, 3, 4], holidays: ['2026-11-24'] });

function across(tasks: PlanTaskInput[], fields: Partial<PlanInput> = {}, calendars: Record<string, PlanCalendar> = { EU, ME }): PlanInput {
  return { today: TODAY, calendar: EU, calendars, tasks, resources: [anna, ben], workItems: [], baseline: null, ...fields };
}

const on = (calendarId: string, id: string, fields: Partial<PlanTaskInput> = {}): PlanTaskInput => task(id, { calendarId, ...fields });

describe('scheduling across calendars', () => {
  // EU-1 (32h): Mon 16, Tue 17, Wed 18, Fri 20 (Thu 19 off in EU).
  // ME-1 (32h) after EU-1: ME's next working day after Fri 20 is Sun 22 (EU's would be Mon 23); then
  //   Mon 23, Wed 25 (Tue 24 off in ME), Thu 26.
  // EU-2 (8h) after ME-1: EU's next working day after Thu 26 is Fri 27 (ME's would be Sun 29).
  // ME-2 (8h) is on its own: Mon 16.
  const chain = (): PlanTaskInput[] => [
    on('EU', 'EU-1', { effortMinutes: hours(32) }),
    on('ME', 'ME-1', { effortMinutes: hours(32), predecessors: ['EU-1'] }),
    on('EU', 'EU-2', { effortMinutes: hours(8), predecessors: ['ME-1'] }),
    on('ME', 'ME-2', { effortMinutes: hours(8) }),
  ];

  it('measures a dependency on the successor’s calendar, each way', () => {
    const s = computeSchedule(across(chain()));
    expect(span(s, 'EU-1')).toEqual(['2026-11-16', '2026-11-20']);
    expect(span(s, 'ME-1')).toEqual(['2026-11-22', '2026-11-26']);
    expect(span(s, 'EU-2')).toEqual(['2026-11-27', '2026-11-27']);
    expect(span(s, 'ME-2')).toEqual(['2026-11-16', '2026-11-16']);
    expect([get(s, 'EU-1').durationDays, get(s, 'ME-1').durationDays]).toEqual([4, 4]);
    expect(get(s, 'ME-1').scheduledFrom).toBe('dependencies');
    expect([s.start, s.finish, s.warnings]).toEqual(['2026-11-16', '2026-11-27', []]);
  });

  it('counts slack on each task’s own days, so a chain across calendars has none to spare', () => {
    const s = computeSchedule(across(chain()));
    // Going back, EU-1 may finish by the last EU day before ME-1's late start (Sun 22): Fri 20, its finish.
    // (Measured on ME's calendar it would be Thu 19, an EU holiday, so Wed 18: a day of false lateness.)
    expect([get(s, 'EU-1').lateStart, get(s, 'EU-1').lateFinish, get(s, 'EU-1').slackDays]).toEqual(['2026-11-16', '2026-11-20', 0]);
    expect([get(s, 'ME-1').lateStart, get(s, 'ME-1').lateFinish, get(s, 'ME-1').slackDays]).toEqual(['2026-11-22', '2026-11-26', 0]);
    // ME-2 may finish by ME's last day up to the plan's finish (Fri 27): Thu 26. Its slack is the ME days
    // after Mon 16 up to then: Tue 17, Wed 18, Thu 19, Sun 22, Mon 23, Wed 25, Thu 26 (on EU's it would be 8).
    expect([get(s, 'ME-2').lateFinish, get(s, 'ME-2').slackDays, get(s, 'ME-2').critical]).toEqual(['2026-11-26', 7, false]);
    expect(s.criticalPath).toEqual(['EU-1', 'ME-1', 'EU-2']);
  });

  it('spans a summary over subtasks on other calendars, counting its days on its own', () => {
    // S-EU (40h, EU): Mon 16, Tue 17, Wed 18, Fri 20, Mon 23, and the plan's finish. S-ME (16h, ME): Mon 16, Tue 17.
    // The summary S is ME's: it spans Mon 16 – Mon 23, which is 6 ME days (Mon, Tue, Wed, Thu, Sun, Mon), 5 EU ones.
    // X-EU (16h, EU) runs as S-ME does; its slack is EU's Wed 18, Fri 20, Mon 23: 3. S-ME's is ME's
    // Wed 18, Thu 19, Sun 22, Mon 23: 4.
    const s = computeSchedule(
      across([
        on('ME', 'S'),
        on('EU', 'S-EU', { parent: 'S', effortMinutes: hours(40) }),
        on('ME', 'S-ME', { parent: 'S', effortMinutes: hours(16) }),
        on('EU', 'X-EU', { effortMinutes: hours(16) }),
      ]),
    );
    const summary = get(s, 'S');
    expect([summary.start, summary.finish, summary.durationDays, summary.slackDays, summary.critical]).toEqual(['2026-11-16', '2026-11-23', 6, 0, true]);
    expect(span(s, 'S-ME')).toEqual(span(s, 'X-EU'));
    expect([get(s, 'S-ME').slackDays, get(s, 'X-EU').slackDays, get(s, 'S-EU').slackDays]).toEqual([4, 3, 0]);
    expect(s.criticalPath).toEqual(['S-EU']);
  });

  it('gives each project its own start', () => {
    // EU begins at its earliest Start date (Wed 18); ME has none, so it begins on its first day from today, Mon 16.
    // Planned as one calendar, ME-1 would have waited for EU's Wednesday too.
    const s = computeSchedule(
      across([on('EU', 'EU-1', { effortMinutes: hours(8), startConstraint: '2026-11-18' }), on('EU', 'EU-2', { effortMinutes: hours(8) }), on('ME', 'ME-1', { effortMinutes: hours(8) })]),
    );
    expect([span(s, 'EU-2')[0], span(s, 'ME-1')[0], s.start]).toEqual(['2026-11-18', '2026-11-16', '2026-11-16']);
    // ME's own start date holds for ME only: Sun 22.
    const dated = computeSchedule(across([on('EU', 'EU-2', { effortMinutes: hours(8) }), on('ME', 'ME-1', { effortMinutes: hours(8) })], {}, { EU, ME: { ...ME, startDate: '2026-11-22' } }));
    expect([span(dated, 'EU-2')[0], span(dated, 'ME-1')[0], dated.start]).toEqual(['2026-11-16', '2026-11-22', '2026-11-16']);
  });

  it('plans a task whose calendar the plan doesn’t have on the plan’s own, and says which', () => {
    const s = computeSchedule(across([on('NOPE', 'X-1', { effortMinutes: hours(16) }), task('X-2', { effortMinutes: hours(8) })]));
    expect(s.warnings).toEqual(['X-1 is on the calendar NOPE, which this plan doesn’t have; planned on the plan’s own calendar']);
    expect(span(s, 'X-1')).toEqual(['2026-11-16', '2026-11-17']); // EU's days, the plan's own
  });

  it('names the calendar to check when it has no working day', () => {
    const mondays: string[] = [];
    for (let d = '2026-11-16'; mondays.length < 3_000; d = addDays(d, 7)) mondays.push(d);
    const blocked = { ...ME, workingDays: [1], holidays: mondays };
    expect(() => computeSchedule(across([on('ME', 'ME-1', { effortMinutes: hours(8) })], {}, { EU, ME: blocked }))).toThrow(/check the calendar ME \(working days and holidays\)/);
  });
});

describe('numbers of the whole plan, on the union calendar', () => {
  it('moves the plan’s finish by the union’s days, and each task by its own', () => {
    // Delaying ME-1 a day: it starts Mon 23 and runs Mon 23, Wed 25, Thu 26, Sun 29; EU-2 then goes to Mon 30.
    // Each moved one day of its own calendar. The plan's finish went from Fri 27 to Mon 30: two days of the
    // union (Sun 29, which ME works, and Mon 30), though one of EU's, the plan's own calendar.
    const tasks = [
      on('EU', 'EU-1', { effortMinutes: hours(32) }),
      on('ME', 'ME-1', { effortMinutes: hours(32), predecessors: ['EU-1'] }),
      on('EU', 'EU-2', { effortMinutes: hours(8), predecessors: ['ME-1'] }),
    ];
    // Its plan of record ended Thu 26; Mon 30 is three union days later: Fri 27, Sun 29, Mon 30.
    const baseline = { id: 'bl', name: 'Agreed', tasks: [{ id: 'EU-2', start: '2026-11-26', finish: '2026-11-26', effortMinutes: hours(8), cost: 0 }] };
    const r = whatIf(across(tasks, { baseline }), [{ id: 'ME-1', delayDays: 1 }]);
    expect([r.before.finish, r.after.finish, r.finishDeltaDays]).toEqual(['2026-11-27', '2026-11-30', 2]);
    expect(span(r.after, 'ME-1')).toEqual(['2026-11-23', '2026-11-29']);
    expect(r.impacted.map((i) => [i.id, i.startDeltaDays, i.finishDeltaDays])).toEqual([
      ['ME-1', 1, 1],
      ['EU-2', 1, 1],
    ]);
    expect(r.after.baseline).toMatchObject({ finish: '2026-11-26', finishVarianceDays: 3 });
    // EU-2's own variance is in EU's days: Fri 27, Mon 30.
    expect(get(r.after, 'EU-2').variance).toMatchObject({ startDays: 2, finishDays: 2 });
  });
});

describe('one person in two projects', () => {
  // Pat works Sunday to Wednesday, a half day on Thursday, and not on Friday (D43), and is away Tuesday
  // 17th's afternoon (D36). In EU Pat works Mon–Thu (EU's days on which Pat has hours); in ME, Sun–Thu.
  const pat: PlanResource = { id: 'u-pat', login: 'pat', name: 'Pat Kim', capacityHoursPerDay: 8, hourlyRate: 90, week: [8, 8, 8, 8, 4, 0, 0] };
  const afternoon: PlanAbsence = { resourceId: pat.id, from: '2026-11-17', to: '2026-11-17', half: 'afternoon' };
  const both = (): PlanInput =>
    across([on('EU', 'EU-A', { assigneeId: pat.id, effortMinutes: hours(16), priorityOrdinal: 1 }), on('ME', 'ME-A', { assigneeId: pat.id, effortMinutes: hours(16), priorityOrdinal: 2 })], {
      resources: [pat],
      absences: [afternoon],
    });

  it('plans each task on that project’s days and Pat’s', () => {
    // Each: 8h Monday, 4h Tuesday morning, the last 4h on Wednesday.
    const s = computeSchedule(both());
    expect([span(s, 'EU-A'), span(s, 'ME-A')]).toEqual([
      ['2026-11-16', '2026-11-18'],
      ['2026-11-16', '2026-11-18'],
    ]);
  });

  it('levels Pat’s hours across both projects, never booking a day twice', () => {
    // Unlevelled, both spread 16h over Mon 16 (1), Tue 17 (½) and Wed 18 (1): 6.4h, 3.2h, 6.4h each, so
    // Mon 12.8h of 8, Tue 6.4h of 4, Wed 12.8h of 8: three days over.
    // EU-A goes first (priority) and keeps Mon 16 – Wed 18. ME-A can't start Mon 16 (Monday is full), Tue 17
    // (4h more on a 4h afternoon-away day), or Wed 18 (full): it starts Thu 19, a holiday in EU but a day ME
    // works, on which Pat has 4h: Thu 19 (4h), Sun 22 (8h), Mon 23 (the last 4h), each with room.
    const p = levelResources(both(), 'allow_delay');
    expect(p.changes.map((c) => [c.id, c.toStart, c.toFinish, c.delayDays, c.movedBy])).toEqual([['ME-A', '2026-11-19', '2026-11-23', 3, 'resources']]);
    expect([p.overallocatedDaysBefore, p.overallocatedDaysAfter, p.finishBefore, p.finishAfter]).toEqual([3, 0, '2026-11-18', '2026-11-23']);
    expect(p.levelledStarts).toEqual({ 'ME-A': '2026-11-19' });
    // ME has no start date of its own: written, ME-A's start would become where ME begins, so it keeps Mon 16.
    expect([p.keepStart, p.keepStarts]).toEqual([null, { ME: '2026-11-16' }]);
    // Within its slack nothing fits: ME-A is critical, and Pat's days are taken.
    expect(levelResources(both(), 'within_slack')).toMatchObject({ changes: [], unresolved: ['ME-A'], overallocatedDaysAfter: 3 });
  });

  it('shows Pat’s load on the days either project works, against Pat’s own capacity', () => {
    const input = both();
    const applied = computeSchedule(input, [{ id: 'ME-A', start: '2026-11-19' }]);
    expect(span(applied, 'ME-A')).toEqual(['2026-11-19', '2026-11-23']);
    const row = computeLoad(input, applied, '2026-11-16', '2026-11-23').resources[0]!;
    // Thu 19 is EU's holiday but ME's day: ME-A's 3.2h fill half of Pat's 4h. Friday is a day EU works and Pat
    // doesn't: capacity 0. Saturday no calendar works.
    expect(row.days.map((d) => [d.date, d.hours, d.capacity, d.away])).toEqual([
      ['2026-11-16', 6.4, 8, null],
      ['2026-11-17', 3.2, 4, 'afternoon'],
      ['2026-11-18', 6.4, 8, null],
      ['2026-11-19', 3.2, 4, null],
      ['2026-11-20', 0, 0, null],
      ['2026-11-22', 6.4, 8, null],
      ['2026-11-23', 6.4, 8, null],
    ]);
    expect([row.overallocatedDays, row.totalHours]).toEqual([0, 32]);
  });

  it('keeps each project’s start when levelling would move it, and the plan applied is the plan proposed', () => {
    // EU begins at EU-1's Start date, Wed 18, and EU-2 (no date, first by priority) starts then too, on Anna's
    // Wednesday. EU-1 moves to Fri 20 (Thu 19 is EU's holiday). Written, EU would begin Fri 20 and take EU-2
    // with it, so EU keeps Wed 18. ME, which begins Mon 16 either way, keeps nothing.
    const tasks = [
      on('EU', 'EU-1', { assigneeId: anna.id, effortMinutes: hours(8), startConstraint: '2026-11-18', priorityOrdinal: 2 }),
      on('EU', 'EU-2', { assigneeId: anna.id, effortMinutes: hours(8), priorityOrdinal: 1 }),
      on('ME', 'ME-1', { assigneeId: ben.id, effortMinutes: hours(8) }),
    ];
    const p = levelResources(across(tasks), 'allow_delay');
    expect(p.changes.map((c) => [c.id, c.toStart, c.delayDays])).toEqual([['EU-1', '2026-11-20', 1]]);
    expect([p.keepStart, p.keepStarts]).toEqual([null, { EU: '2026-11-18' }]);
    const written = tasks.map((t) => (p.levelledStarts[t.id] ? { ...t, startConstraint: p.levelledStarts[t.id]! } : t));
    const applied = computeSchedule(across(written, {}, { EU: { ...EU, startDate: p.keepStarts!.EU! }, ME }));
    expect([span(applied, 'EU-1'), span(applied, 'EU-2'), span(applied, 'ME-1')]).toEqual([
      ['2026-11-20', '2026-11-20'],
      ['2026-11-18', '2026-11-18'],
      ['2026-11-16', '2026-11-16'],
    ]);
  });
});

describe('costs across calendars', () => {
  // EU: 8 hours a day, a budget of 3000 EUR. US: Monday to Friday, 6 hours a day, no holidays, 2000 USD.
  // Anna (100 an hour) has EU-T1 (16h, 200 fixed) and US-T2 (16h); Ben (80 an hour) is on US-T1 (12h, 3h done).
  // The summary S is EU's, over EU-T1 and US-T2.
  const US = calendar({ hoursPerDay: 6, holidays: [], budget: 2000, currency: 'USD' });
  const costPlan = (fields: Partial<PlanInput> = {}): PlanInput =>
    across(
      [
        on('EU', 'S'),
        on('EU', 'EU-T1', { parent: 'S', assigneeId: anna.id, effortMinutes: hours(16), fixedCost: 200 }),
        on('US', 'US-T2', { parent: 'S', assigneeId: anna.id, effortMinutes: hours(16) }),
        on('US', 'US-T1', { assigneeId: ben.id, effortMinutes: hours(12), firstWorkDate: '2026-11-13', spentMinutes: hours(3) }),
      ],
      { workItems: [{ taskId: 'US-T1', authorId: ben.id, date: '2026-11-13', minutes: hours(3), hourlyRate: null }], ...fields },
      { EU: { ...EU, budget: 3000 }, US },
    );

  it('plans each task at its calendar’s hours a day', () => {
    // EU-T1: 16h at 8h a day, Mon 16 – Tue 17. US-T2: 16h at 6h, three days, Mon 16 – Wed 18. US-T1: 9h left at
    // 6h, two days from today, Mon 16 – Tue 17.
    const s = computeSchedule(costPlan());
    expect([span(s, 'EU-T1'), span(s, 'US-T2'), span(s, 'US-T1')]).toEqual([
      ['2026-11-16', '2026-11-17'],
      ['2026-11-16', '2026-11-18'],
      ['2026-11-13', '2026-11-17'],
    ]);
    // The summary counts its own currency's money: EU-T1's 1600 + 200, not US-T2's 1600 dollars.
    expect([get(s, 'S').plannedCost, get(s, 'US-T2').plannedCost]).toEqual([1800, 1600]);
  });

  it('totals each currency on its own, gives each calendar its budget, and never converts', () => {
    const input = costPlan();
    const c = computeCosts(input, computeSchedule(input));
    // EUR: EU-T1 planned 16h × 100 + 200 = 1800, nothing spent. USD: US-T2 16h × 100 = 1600 and US-T1
    // 12h × 80 = 960, so 2560; 3h × 80 = 240 spent; forecast 240 + 9h × 80 + 1600 = 2560.
    expect(c.byCalendar).toEqual([
      { calendarId: 'EU', currency: 'EUR', budget: 3000, plannedCost: 1800, actualCost: 0, forecastCost: 1800, budgetVariance: 1200 },
      { calendarId: 'US', currency: 'USD', budget: 2000, plannedCost: 2560, actualCost: 240, forecastCost: 2560, budgetVariance: -560 },
    ]);
    expect(c.byCurrency!.map((x) => [x.currency, x.plannedCost, x.actualCost, x.forecastCost])).toEqual([
      ['EUR', 1800, 0, 1800],
      ['USD', 2560, 240, 2560],
    ]);
    // The report's own figures are in the plan's own currency, EUR; with several calendars it has no budget.
    expect([c.currency, c.budget, c.budgetVariance, c.plannedCost, c.actualCost, c.forecastCost]).toEqual(['EUR', null, null, 1800, 0, 1800]);
    expect(c.warnings).toEqual(['Some costs are in USD: the totals are in EUR, and each currency is totalled on its own, never converted']);
    expect(c.byTask.map((t) => [t.id, t.plannedCost, t.actualCost])).toEqual([
      ['US-T1', 960, 240],
      ['EU-T1', 1800, 0],
      ['US-T2', 1600, 0],
    ]);
    // A person's rate is read in the currency their work is in.
    expect(c.byPerson).toEqual([
      { resourceId: anna.id, hourlyRate: 100, plannedHours: 32, actualHours: 0, plannedCost: 1600, actualCost: 0, byCurrency: [{ currency: 'EUR', plannedCost: 1600, actualCost: 0 }, { currency: 'USD', plannedCost: 1600, actualCost: 0 }] },
      { resourceId: ben.id, hourlyRate: 80, plannedHours: 12, actualHours: 3, plannedCost: 0, actualCost: 0, byCurrency: [{ currency: 'USD', plannedCost: 960, actualCost: 240 }] },
    ]);
  });

  it('earns value per currency, each task’s planned share on its own calendar', () => {
    const baseline = {
      id: 'bl',
      name: 'Agreed',
      tasks: [
        { id: 'EU-T1', start: '2026-11-16', finish: '2026-11-17', effortMinutes: hours(16), cost: 1800 },
        { id: 'US-T2', start: '2026-11-16', finish: '2026-11-20', effortMinutes: hours(16), cost: 1600 },
        { id: 'US-T1', start: '2026-11-16', finish: '2026-11-17', effortMinutes: hours(12), cost: 960 },
      ],
    };
    const input = costPlan({ baseline });
    const c = computeCosts(input, computeSchedule(input));
    // EUR: EU-T1 is 1 of its 2 days in by Mon 16: PV 900; nothing earned or spent.
    expect(c.evm).toMatchObject({ bac: 1800, pv: 900, ev: 0, ac: 0, cpi: null, sv: -900 });
    // USD: US-T2 is 1 of 5 US days in (on EU's days it would be 1 of 4): 320; US-T1 1 of 2: 480. PV 800.
    // EV: US-T1 is 25% done, 240. AC 240.
    expect(c.byCurrency!.find((x) => x.currency === 'USD')!.evm).toMatchObject({ bac: 2560, pv: 800, ev: 240, ac: 240, cpi: 1, spi: 0.3, eac: 2560 });
  });

  it('keeps a plan of one calendar’s budget and currency, named by a key or not', () => {
    const US1 = calendar({ budget: 500, currency: 'USD' });
    const tasks = [on('US', 'US-1', { assigneeId: anna.id, effortMinutes: hours(8) })];
    const keyed = across(tasks, {}, { US: US1 });
    const c = computeCosts(keyed, computeSchedule(keyed));
    expect([c.currency, c.budget, c.plannedCost, c.budgetVariance, c.warnings]).toEqual(['USD', 500, 800, -300, []]);
    expect(c.byCalendar).toEqual([{ calendarId: 'US', currency: 'USD', budget: 500, plannedCost: 800, actualCost: 0, forecastCost: 800, budgetVariance: -300 }]);
    // Tasks that name no calendar are on the plan's own, keyed '' where a result says per calendar.
    const own = across([task('T-1', { assigneeId: anna.id, effortMinutes: hours(8) })], {}, {});
    expect(computeCosts(own, computeSchedule(own)).byCalendar!.map((x) => x.calendarId)).toEqual([PLAN_CALENDAR_KEY]);
  });
});
