/**
 * Icons: Ocean's line icons (24-unit square, stroke 1.8, round caps and joins, no
 * fill, in currentColor), plus a few a4a draws the same way. The agent's mark
 * is for agents alone.
 */
const OCEAN: Record<string, string[]> = {
  tasks: ['M10 6.5h10', 'M10 12h10', 'M10 17.5h10', 'M4 6.5l1.5 1.5 2.5-2.5', 'M4 12l1.5 1.5 2.5-2.5', 'M4 17.5l1.5 1.5 2.5-2.5'],
  agent: ['M7 8.5h10a2.5 2.5 0 0 1 2.5 2.5v6A2.5 2.5 0 0 1 17 19.5H7A2.5 2.5 0 0 1 4.5 17v-6A2.5 2.5 0 0 1 7 8.5z', 'M12 4.5v4', 'M9.5 13.5h.01', 'M14.5 13.5h.01', 'M9.5 16.5h5'],
  audit: ['M12 3l7.5 3v6c0 4.5-3.2 7.8-7.5 9-4.3-1.2-7.5-4.5-7.5-9V6z', 'M9 12l2.2 2.2L15.5 10'],
  decide: ['M12 3.5a8.5 8.5 0 1 0 0 17 8.5 8.5 0 0 0 0-17z', 'M8 12.2l2.7 2.7L16.2 9.4'],
  settings: ['M4 7h9', 'M17 7h3', 'M4 17h3', 'M11 17h9', 'M15 4.5v5', 'M9 14.5v5'],
  tool: ['M14.5 5.5a4 4 0 0 0-5 5L4.5 15.5l4 4 5-5a4 4 0 0 0 5-5l-2.5 2.5-2.5-.5-.5-2.5z'],
  people: ['M9 11a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7z', 'M3 20a6 6 0 0 1 12 0', 'M16.5 4.3a3.5 3.5 0 0 1 0 6.4', 'M18.5 14.5a6 6 0 0 1 2.5 5.5'],
  book: ['M5 4.5h10.5a3 3 0 0 1 3 3V20H8a3 3 0 0 1-3-3z', 'M5 17a3 3 0 0 1 3-3h10.5'],
  report: ['M6 3.5h9l3 3v14H6z', 'M9 12.5h6', 'M9 16h6', 'M9 9h3'],
  send: ['M12 19.5v-15', 'M5.5 11L12 4.5l6.5 6.5'],
  clock: ['M12 3.5a8.5 8.5 0 1 0 0 17 8.5 8.5 0 0 0 0-17z', 'M12 7.5V12l3 2'],
  check: ['M5.5 12.5l4 4 9-9'],
  cross: ['M7 7l10 10', 'M17 7L7 17'],
  pause: ['M9 6.5v11', 'M15 6.5v11'],
  back: ['M14.5 6l-6 6 6 6'],
  run: ['M8 5.5l10 6.5-10 6.5z'],
  trace: ['M6 15.8a2.2 2.2 0 1 0 0 4.4 2.2 2.2 0 0 0 0-4.4z', 'M18 3.8a2.2 2.2 0 1 0 0 4.4 2.2 2.2 0 0 0 0-4.4z', 'M7.6 16.4l8.8-8.8'],
  chat: ['M4 5.5h16v10.5H9l-5 4z'],
};

/** Drawn for a4a in Ocean's manner. */
const A4A: Record<string, string[]> = {
  board: ['M4 4.5h4.5v15H4z', 'M10.75 4.5h4.5v10h-4.5z', 'M17.5 4.5H20v7h-2.5z'],
  timeline: ['M4 4v16', 'M7 7.5h7', 'M10 12h9', 'M8 16.5h6'],
  search: ['M10.5 4.5a6 6 0 1 0 0 12 6 6 0 0 0 0-12z', 'M15 15l5 5'],
  plus: ['M12 5v14', 'M5 12h14'],
  link: ['M10 14a4 4 0 0 0 5.7 0l2.8-2.8a4 4 0 0 0-5.7-5.7L11.5 6.8', 'M14 10a4 4 0 0 0-5.7 0l-2.8 2.8a4 4 0 0 0 5.7 5.7l1.3-1.3'],
  load: ['M5 20v-8', 'M10 20V6', 'M15 20v-9', 'M20 20V4'],
  cost: ['M12 3.5a8.5 8.5 0 1 0 0 17 8.5 8.5 0 0 0 0-17z', 'M14.5 9.2c-.5-.8-1.4-1.2-2.5-1.2-1.5 0-2.5.8-2.5 1.9 0 2.6 5 1.4 5 4.2 0 1.1-1.1 1.9-2.5 1.9-1.2 0-2.1-.5-2.6-1.3', 'M12 6.5V8', 'M12 16v1.5'],
  calendar: ['M4.5 6.5h15v13h-15z', 'M4.5 10.5h15', 'M8.5 4v5', 'M15.5 4v5'],
  chevron: ['M6 9.5l6 6 6-6'],
  more: ['M6 12h.01', 'M12 12h.01', 'M18 12h.01'],
  logout: ['M14 4.5h5.5v15H14', 'M10 8l-4 4 4 4', 'M6 12h9'],
  command: ['M5 7l5 5-5 5', 'M12 17h7'],
  key: ['M8.5 11.5a4 4 0 1 0 0 8 4 4 0 0 0 0-8z', 'M11.4 12.6L19 5', 'M16 8l2 2', 'M14 10l1.5 1.5'],
  person: ['M12 11a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7z', 'M5.5 20a6.5 6.5 0 0 1 13 0'],
  dashboard: ['M4.5 4.5h6.5v8H4.5z', 'M13 4.5h6.5v4.5H13z', 'M13 11.5h6.5v8H13z', 'M4.5 15h6.5v4.5H4.5z'],
  import: ['M12 4v10', 'M7.5 9.5L12 14l4.5-4.5', 'M4.5 15v4.5h15V15'],
};

const PATHS: Record<string, string[]> = { ...OCEAN, ...A4A };
export type IconName = keyof typeof OCEAN | keyof typeof A4A;

export function Icon({ name, label, className }: { name: IconName; label?: string; className?: string }) {
  return (
    <svg viewBox="0 0 24 24" className={className ? `icon ${className}` : 'icon'} aria-hidden={label ? undefined : true} role={label ? 'img' : undefined} aria-label={label}>
      {(PATHS[name] ?? []).map((d) => (
        <path key={d} d={d} />
      ))}
    </svg>
  );
}
