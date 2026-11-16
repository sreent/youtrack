// The issue's logged time, added up by who logged it, most first.
const totals = {};
for (const w of issue.workItems) {
  const who = w.author || 'someone';
  totals[who] = (totals[who] || 0) + w.minutes;
}
const rows = Object.keys(totals)
  .map((person) => ({ person, minutes: totals[person] }))
  .sort((a, b) => b.minutes - a.minutes || a.person.localeCompare(b.person));
respond({ issue: issue.id, rows, total: rows.reduce((n, r) => n + r.minutes, 0) });
