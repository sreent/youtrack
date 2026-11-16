// Asks the app's own handler for the issue's time, by person, and lays it out as Ocean's figures.
(async () => {
  const said = document.getElementById('said');
  const table = document.getElementById('table');
  const hours = (m) => (m >= 60 ? `${Math.floor(m / 60)}h${m % 60 ? ` ${m % 60}m` : ''}` : `${m}m`);
  try {
    await window.a4a.ready();
    const { response } = await window.a4a.handler('by-person');
    if (!response.rows.length) {
      said.textContent = 'Nobody has logged time on it yet.';
      return;
    }
    const body = table.querySelector('tbody');
    for (const r of response.rows) {
      const tr = document.createElement('tr');
      const who = document.createElement('td');
      who.textContent = r.person;
      const time = document.createElement('td');
      time.className = 'num';
      time.textContent = hours(r.minutes);
      tr.append(who, time);
      body.append(tr);
    }
    said.textContent = `${hours(response.total)} in all.`;
    table.hidden = false;
  } catch (e) {
    said.textContent = e.message;
  }
})();
