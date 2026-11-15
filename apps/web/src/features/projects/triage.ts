import type { TriageMode } from '@a4a/shared';
import type { Rung } from '../common/Ladder';

/**
 * How far triage may go in a project, as rungs of Ocean's ladder. "Off" isn't a rung of autonomy:
 * triage then reads nothing on its own, and works only when someone asks on an issue.
 */
export const TRIAGE_RUNGS: Rung<TriageMode>[] = [
  { value: 'off', name: 'Off', lvl: 'off', about: 'Only when someone asks, on an issue. New issues wait for a person.' },
  { value: 'suggest', name: 'Suggests', lvl: 'suggest', about: 'Reads each new issue and suggests its fields, tags and duplicates. A person applies them.' },
  { value: 'auto', name: 'Acts', lvl: 'auto', about: "Fills a new issue's empty fields on its own, and says so in its history. It never changes what a person chose." },
];

export const TRIAGE_WORDS: Record<TriageMode, string> = { off: 'Off', suggest: 'Suggests', auto: 'Acts' };
