import { WELL_KNOWN_FIELDS, type Tone } from '@tracklet/shared';
import { eq, sql } from 'drizzle-orm';
import { fields, linkTypes, users } from './schema';
import type { Db } from './client';
import { createFieldRaw } from '../services/fields';
import { insertUser } from '../services/users';
import { newId } from '../lib/ids';

/** The agent that triages new issues. Agents go by their id in lower case. */
export const TRIAGE_BOT = 'triage';

const v = (name: string, tone: Tone | null = null, isResolved = false) => ({ name, tone, isResolved });

/** Create the standard fields, link types and the triage agent on first start. Idempotent. */
export async function ensureDefaults(db: Db): Promise<void> {
  const [{ n } = { n: 0 }] = await db.select({ n: sql<number>`count(*)::int` }).from(fields);
  if (Number(n) === 0) {
    let ordinal = 0;
    await createFieldRaw(db, {
      name: WELL_KNOWN_FIELDS.state,
      type: 'state',
      ordinal: ordinal++,
      description: 'Where the work stands. Resolved states close the issue.',
      values: [
        v('Submitted'),
        v('Open'),
        v('In Progress'),
        v('In Review', 'warn'),
        v('Blocked', 'warn'),
        v('Fixed', 'good', true),
        v('Verified', 'good', true),
        v('Done', 'good', true),
        v("Won't fix", 'idle', true),
        v('Duplicate', 'idle', true),
        v('Obsolete', 'idle', true),
      ],
    });
    await createFieldRaw(db, {
      name: WELL_KNOWN_FIELDS.priority,
      type: 'enum',
      ordinal: ordinal++,
      description: 'How much it matters, most important first.',
      values: [v('Show-stopper'), v('Critical'), v('Major'), v('Normal'), v('Minor')],
    });
    await createFieldRaw(db, {
      name: WELL_KNOWN_FIELDS.type,
      type: 'enum',
      ordinal: ordinal++,
      description: 'What kind of work it is.',
      values: [v('Bug'), v('Feature'), v('Task'), v('Epic'), v('Milestone')],
    });
    await createFieldRaw(db, { name: WELL_KNOWN_FIELDS.assignee, type: 'user', ordinal: ordinal++, description: 'Who does the work.' });
    await createFieldRaw(db, {
      name: WELL_KNOWN_FIELDS.subsystem,
      type: 'enum',
      ordinal: ordinal++,
      description: 'The part of the product. Each project has its own values.',
    });
    await createFieldRaw(db, {
      name: WELL_KNOWN_FIELDS.fixVersions,
      type: 'version',
      multi: true,
      ordinal: ordinal++,
      description: 'The releases that carry the fix.',
    });
    await createFieldRaw(db, { name: WELL_KNOWN_FIELDS.estimation, type: 'period', ordinal: ordinal++, description: 'Effort planned, e.g. 2d 4h.' });
    await createFieldRaw(db, { name: WELL_KNOWN_FIELDS.startDate, type: 'date', ordinal: ordinal++, description: 'Start no earlier than this date.' });
    await createFieldRaw(db, { name: WELL_KNOWN_FIELDS.dueDate, type: 'date', ordinal: ordinal++, description: 'The date it is due.' });
    await createFieldRaw(db, { name: WELL_KNOWN_FIELDS.fixedCost, type: 'float', ordinal: ordinal++, description: 'Costs other than people’s time.' });
  }

  const [{ n: links } = { n: 0 }] = await db.select({ n: sql<number>`count(*)::int` }).from(linkTypes);
  if (Number(links) === 0) {
    await db.insert(linkTypes).values([
      { id: newId(), name: 'Relates', outward: 'relates to', inward: 'relates to', directed: false, ordinal: 0 },
      { id: newId(), name: 'Depend', outward: 'depends on', inward: 'is required for', directed: true, ordinal: 1 },
      { id: newId(), name: 'Duplicate', outward: 'duplicates', inward: 'is duplicated by', directed: true, ordinal: 2 },
      { id: newId(), name: 'Subtask', outward: 'parent for', inward: 'subtask of', directed: true, aggregation: true, ordinal: 3 },
    ]);
  }

  const [bot] = await db.select().from(users).where(eq(users.login, TRIAGE_BOT));
  if (!bot) {
    await insertUser(db, { login: TRIAGE_BOT, name: TRIAGE_BOT, role: 'member', isBot: true, capacityHoursPerDay: 0 });
  }
}
