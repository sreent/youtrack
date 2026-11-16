import type { TriageMode } from '@a4a/shared';
import type { Rung } from '../common/Ladder';
import { t } from '../../i18n';

/**
 * How far triage may go in a project, as rungs of Ocean's ladder. "Off" isn't a rung of autonomy:
 * triage then reads nothing on its own, and works only when someone asks on an issue.
 */
export const TRIAGE_RUNGS: Rung<TriageMode>[] = [
  { value: 'off', name: 'Off', lvl: 'off', about: t('projects.triage.onlyWhenSomeoneAsksOn') },
  { value: 'suggest', name: 'Suggests', lvl: 'suggest', about: t('projects.triage.readsEachNewIssueAnd') },
  {
    value: 'auto',
    name: 'Acts',
    lvl: 'auto',
    about: t('projects.triage.fillsANewIssueS'),
  },
];

export const TRIAGE_WORDS: Record<TriageMode, string> = { off: t('projects.triage.off'), suggest: t('projects.triage.suggests'), auto: t('projects.triage.acts') };
