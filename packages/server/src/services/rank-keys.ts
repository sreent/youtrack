/**
 * A board's keys in SQL (D65): `keyAt(n)` of `@a4a/shared/ranks`, worked out by the database, so a
 * board's keys are written afresh in one statement, its rows never brought out. The migration that
 * turned ranks into keys says the same expression in its own words (0044_board_ranks_keys.sql), and
 * the tests hold the three to one answer.
 */
import { RANK_DIGITS, RANK_KEY_CLASSES } from '@a4a/shared/ranks';
import { sql, type SQL } from 'drizzle-orm';
import type { Db } from '../db/client';

/** The digit of `n` (a bigint expression) at `power` of 62, as one character. */
const digitSql = (n: SQL, power: number): SQL => sql`substr(${RANK_DIGITS}, (${n} / ${62 ** power}::bigint % 62)::int + 1, 1)`;

/** `keyAt(n)` for a bigint expression `n`, from 0: `a0` … `az`, `b00` … */
export function rankKeySql(n: SQL): SQL {
  const parts = RANK_KEY_CLASSES.map(({ head, from, digits }, i) => {
    const rest = sql`(${n} - ${from}::bigint)`;
    const word = sql.join([sql`${head}`, ...Array.from({ length: digits }, (_, d) => digitSql(rest, digits - 1 - d))], sql` || `);
    const last = i === RANK_KEY_CLASSES.length - 1;
    return last ? sql`ELSE ${word}` : sql`WHEN ${n} < ${RANK_KEY_CLASSES[i + 1]!.from}::bigint THEN ${word}`;
  });
  return sql`(CASE ${sql.join(parts, sql` `)} END)`;
}

/**
 * Writes a board's keys afresh, in the order they're in (ties, which a move under the board's lock
 * never makes, by issue): one statement, inside the move's transaction and under its lock. With a
 * lane, only that lane's places (D65).
 */
export async function rewriteKeys(tx: Db, boardId: string, lane?: string): Promise<void> {
  const key = rankKeySql(sql`r.n`);
  if (lane === undefined) {
    await tx.execute(sql`
      UPDATE board_ranks AS br SET key = ${key}
      FROM (SELECT issue_id, row_number() OVER (ORDER BY key, issue_id) - 1 AS n FROM board_ranks WHERE board_id = ${boardId}) AS r
      WHERE br.board_id = ${boardId} AND br.issue_id = r.issue_id`);
    return;
  }
  await tx.execute(sql`
    UPDATE board_lane_ranks AS br SET key = ${key}
    FROM (SELECT issue_id, row_number() OVER (ORDER BY key, issue_id) - 1 AS n FROM board_lane_ranks WHERE board_id = ${boardId} AND lane = ${lane}) AS r
    WHERE br.board_id = ${boardId} AND br.issue_id = r.issue_id`);
}
