/**
 * Ranking on a board (D43, D53): an issue's place in the board's order, which its backlog and its
 * columns share, and its card's column and lane in the same change.
 */
import type { Board } from '@a4a/shared';
import { z } from 'zod';
import type { Ctx } from '../context';
import { AppError } from '../lib/errors';
import { rankIssue, type RankOutcome } from '../services/agile';
import { listBoards } from '../services/boards';
import { defineTool, type ToolDef } from './types';

/** A board by its name or id, as get_board finds it. */
async function boardNamed(ctx: Ctx, name: string): Promise<Board> {
  const boards = await listBoards(ctx);
  const b = boards.find((x) => x.id === name || x.name.toLowerCase() === name.trim().toLowerCase());
  // api only: an MCP tool's, met by agents alone
  if (!b) throw new AppError(404, 'not_found', `No board "${name}"`, `Boards: ${boards.map((x) => x.name).join(', ')}`);
  return b;
}

const input = z.object({
  board: z.string().max(200).describe('Board name or id'),
  issue: z.string().max(100).describe('The issue to place, e.g. BACK-12'),
  after: z.string().max(100).optional().describe('Put it just after this issue'),
  before: z.string().max(100).optional().describe('Put it just before this issue'),
  column: z.string().max(200).optional().describe("The column its card goes into, or is in, by name (see get_board): its column field becomes that column's first value"),
  lane: z.string().max(200).nullable().optional().describe("The swimlane its card goes into, by the lane's value (a login, or a value's name); null for the lane of no value"),
  sprint: z.string().max(100).optional().describe('The sprint whose cards you read, by id, when it is not the one the board shows first'),
  expected_version: z.number().int().optional().describe("The issue's version (from get_issue): a column or lane change is refused if it changed since"),
});

function where(i: z.infer<typeof input>): string {
  if (i.after) return `just after ${i.after.toUpperCase()}`;
  if (i.before) return `just before ${i.before.toUpperCase()}`;
  return i.column !== undefined || i.lane !== undefined ? 'where its place puts it' : 'at the top';
}

function said(i: z.infer<typeof input>, board: Board, outcome: RankOutcome): string {
  const id = i.issue.toUpperCase();
  const changed = outcome.changes.map((c) => `${c.field} ${c.from ?? '—'} → ${c.to ?? '—'}`).join('; ');
  const place = outcome.placed ? `placed ${where(i)}` : 'its place unchanged';
  return `${id} on ${board.name}: ${changed ? `${changed}, ` : ''}${place}`;
}

const rankIssueTool = defineTool({
  name: 'rank_issue',
  title: 'Rank an issue on a board',
  description:
    "Put an issue just after or before another in a board's order, which its backlog and every column share; with neither, at the top. " +
    "With column (and lane), its card moves into that column (and swimlane) in the same change: the board's column field becomes the column's first value, checked as any change is (a state machine or guard that refuses it refuses the whole move), and with neither after nor before it keeps its place. " +
    "On a board whose lanes keep their own order (get_board's lanes.ownOrder), a card moved with column is placed among its lane's cards, after or before one in that lane, and the backlog's order (without column) stays the board's. " +
    'Read the columns, lanes and their cards, in order, with get_board.',
  input,
  kind: 'changes',
  // Into another column, its state is overwritten.
  destructive: true,
  idempotent: true,
  async preview(ctx, i) {
    const board = await boardNamed(ctx, i.board);
    const outcome = await rankIssue(ctx, board.id, { ...i, expectedVersion: i.expected_version }, { dryRun: true });
    return `Rank ${said(i, board, outcome)}`;
  },
  async run(ctx, i) {
    const board = await boardNamed(ctx, i.board);
    const outcome = await rankIssue(ctx, board.id, { ...i, expectedVersion: i.expected_version });
    return {
      data: { issue: i.issue.toUpperCase(), board: board.name, placed: outcome.placed, changes: outcome.changes },
      summary: `Ranked ${said(i, board, outcome)}`,
    };
  },
});

export const boardTools = [rankIssueTool] as unknown as ToolDef[];
