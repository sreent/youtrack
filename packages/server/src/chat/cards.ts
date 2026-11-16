/**
 * What chat shows of an issue (D42): the same facts for Teams' cards and Slack's blocks. Teams' cards
 * are Ocean's templates (teams/cards), bound here with a subset of Adaptive Cards' templating:
 * `${path}` for a value (`$root.` from anywhere, `$data` for the item in hand), `$when` to leave a part
 * out when its value is empty or false (`${!path}` the other way), and `$data` to repeat a part for each
 * item of a list.
 */
import type { IssueDetail, IssueField, TrackerEvent } from '@a4a/shared';
import changeTemplate from '@sreent/ocean/teams/cards/a4a-change.json' with { type: 'json' };
import issueTemplate from '@sreent/ocean/teams/cards/a4a-issue.json' with { type: 'json' };
import type { AppServices } from '../context';
import { excerpt } from '../lib/text';
import { actorName, eventDetail, eventVerb } from '../notify/words';
import type { SchemaSnapshot } from '../services/schema-cache';
import { issueUrl } from './common';
import type { Translator } from '@a4a/shared/i18n';
import { translatorFor } from '../i18n';

/** An issue as a card shows it. */
export interface CardIssue {
  id: string;
  summary: string;
  url: string;
  project: string;
  state: string | null;
  resolved: boolean;
  /** The key fields that have a value: Type, Priority, Assignee, and the like. */
  facts: { title: string; value: string }[];
  /** The project's states, for "Move to…". */
  states: string[];
}

/** What changed, as a channel is told it. */
export interface CardChange {
  who: string;
  did: string;
  details: string[];
  kind: 'created' | 'commented' | 'changed';
}

const KEY_FIELDS = ['Type', 'Priority', 'Assignee', 'Due date', 'Fix versions']; // not words: field names, as people named them

function fieldText(f: IssueField): string | null {
  const v = f.value as unknown;
  if (v === null || v === undefined || v === '') return null;
  if (Array.isArray(v)) {
    const parts = v.map((x) => (x && typeof x === 'object' ? String((x as { name?: string; login?: string }).name ?? (x as { login?: string }).login ?? '') : String(x)));
    return parts.filter(Boolean).join(', ') || null;
  }
  if (typeof v === 'object') {
    const o = v as { name?: string; login?: string; presentation?: string };
    return o.presentation ?? o.name ?? o.login ?? null;
  }
  return String(v);
}

/** An issue's facts for a card: its state, its key fields, and the project's states. */
export function cardIssue(app: AppServices, s: SchemaSnapshot, issue: IssueDetail): CardIssue {
  const state = issue.fields.find((f) => f.type === 'state');
  const facts: CardIssue['facts'] = [];
  for (const name of KEY_FIELDS) {
    const f = issue.fields.find((x) => x.name === name);
    const text = f ? fieldText(f) : null;
    if (f && text) facts.push({ title: f.name, value: excerpt(text, 120) });
  }
  const project = s.projectsByKey.get(issue.project.key.toUpperCase());
  const stateField = state ? [...s.fields.values()].find((f) => f.name === state.name && f.type === 'state') : undefined;
  const states = stateField && project ? (s.valuesByField.get(stateField.id) ?? []).filter((v) => v.projectId === null || v.projectId === project.id).map((v) => v.name) : [];
  return {
    id: issue.id,
    summary: excerpt(issue.summary, 300),
    url: issueUrl(app, issue.id),
    project: issue.project.name,
    state: state ? fieldText(state) : null,
    resolved: issue.resolvedAt !== null,
    facts,
    states: states.slice(0, 50),
  };
}

/** What an event did, in the words the inbox uses: never a requester's address. */
export function cardChange(event: TrackerEvent, tr: Translator = translatorFor(null)): CardChange {
  return {
    who: actorName(tr, event),
    did: eventVerb(tr, event),
    details: eventDetail(tr, event)
      .slice(0, 6)
      .map((d) => excerpt(d, 500)),
    kind: event.type === 'issue.created' ? 'created' : event.type === 'comment.created' ? 'commented' : 'changed',
  };
}

// ---------------------------------------------------------------------------
// Teams: Ocean's templates, bound
// ---------------------------------------------------------------------------

type Json = null | boolean | number | string | Json[] | { [key: string]: Json };

function lookup(expr: string, scope: unknown, root: unknown): unknown {
  let parts = expr.trim().split('.');
  let base: unknown = scope;
  if (parts[0] === '$root') {
    base = root;
    parts = parts.slice(1);
  } else if (parts[0] === '$data') {
    parts = parts.slice(1);
  }
  for (const p of parts) {
    if (base === null || typeof base !== 'object') return undefined;
    base = (base as Record<string, unknown>)[p];
  }
  return base;
}

function truthy(v: unknown): boolean {
  if (Array.isArray(v)) return v.length > 0;
  return v !== undefined && v !== null && v !== false && v !== '' && v !== 0;
}

function holds(when: string, scope: unknown, root: unknown): boolean {
  const m = /^\$\{\s*(!?)\s*([^}]+)\}$/.exec(when.trim());
  if (!m) return truthy(when);
  const v = truthy(lookup(m[2]!, scope, root));
  return m[1] ? !v : v;
}

function bindString(s: string, scope: unknown, root: unknown): Json {
  const whole = /^\$\{([^}]+)\}$/.exec(s);
  if (whole) {
    const v = lookup(whole[1]!, scope, root);
    return v === undefined ? '' : (v as Json);
  }
  return s.replace(/\$\{([^}]+)\}/g, (_, e: string) => {
    const v = lookup(e, scope, root);
    return v === null || v === undefined ? '' : String(v);
  });
}

/** A template bound to data; undefined for a part `$when` leaves out. */
export function bindTemplate(node: Json, scope: unknown, root: unknown = scope): Json | undefined {
  if (Array.isArray(node)) {
    const out: Json[] = [];
    for (const item of node) {
      if (item && typeof item === 'object' && !Array.isArray(item) && typeof item.$data === 'string') {
        const { $data, ...rest } = item;
        const list = lookup(String($data).replace(/^\$\{|\}$/g, ''), scope, root);
        for (const el of Array.isArray(list) ? list : list === undefined || list === null ? [] : [list]) {
          const bound = bindTemplate(rest, el, root);
          if (bound !== undefined) out.push(bound);
        }
        continue;
      }
      const bound = bindTemplate(item, scope, root);
      if (bound !== undefined) out.push(bound);
    }
    return out;
  }
  if (node && typeof node === 'object') {
    if (typeof node.$when === 'string' && !holds(node.$when, scope, root)) return undefined;
    const out: { [key: string]: Json } = {};
    for (const [k, v] of Object.entries(node)) {
      if (k === '$when' || k === '$schema') continue;
      const bound = bindTemplate(v, scope, root);
      if (bound !== undefined) out[k] = bound;
    }
    return out;
  }
  if (typeof node === 'string') return bindString(node, scope, root);
  return node;
}

/** How a card tells a state's meaning: resolved is good; the rest says nothing in colour. */
const stateStyle = (issue: CardIssue) => (issue.resolved ? 'Good' : 'Subtle'); // not words: Adaptive Card styles

export interface IssueCardOptions {
  /** Who it's for, alone, when it's one person's (Teams' user id): Teams refreshes it for them. */
  refreshFor?: string | null;
  /** What their action did, or why it didn't. */
  note?: { text: string; bad?: boolean } | null;
  /** Whether the actions are shown: not for someone a4a doesn't know, or can't act. */
  canAct?: boolean;
}

/** The issue card (a4a-issue.json), as one person sees the issue. */
export function teamsIssueCard(issue: CardIssue, opts: IssueCardOptions = {}): Json {
  const data = {
    ...issue,
    stateStyle: stateStyle(issue),
    refreshFor: opts.refreshFor ?? null,
    note: opts.note?.text ?? null,
    // not words: Adaptive Card icons and styles
    noteIcon: opts.note?.bad ? 'ErrorCircle' : 'CheckmarkCircle',
    // not words
    noteTone: opts.note?.bad ? 'Attention' : 'Good',
    canAct: opts.canAct !== false,
    canMove: opts.canAct !== false && issue.states.length > 0,
  };
  return bindTemplate(issueTemplate as unknown as Json, data) as Json;
}

/** The change card (a4a-change.json), as a channel is posted it. */
export function teamsChangeCard(issue: CardIssue, change: CardChange): Json {
  const data = {
    ...issue,
    ...change,
    stateStyle: stateStyle(issue),
    // not words: Adaptive Card icons and styles
    changeIcon: change.kind === 'created' ? 'AddCircle' : change.kind === 'commented' ? 'Comment' : 'Edit',
    // not words
    changeTone: 'Default',
    canAct: true,
    canMove: issue.states.length > 0,
  };
  return bindTemplate(changeTemplate as unknown as Json, data) as Json;
}

/** A card as a Teams attachment. */
export const cardAttachment = (content: Json) => ({ contentType: 'application/vnd.microsoft.card.adaptive', content });

// ---------------------------------------------------------------------------
// Slack: Block Kit
// ---------------------------------------------------------------------------

/** Text as Slack's mrkdwn reads it: its three control characters escaped. */
export const slackText = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

type Block = Record<string, unknown>;

/** An issue as blocks, with what changed above it when it's a channel's news. */
export function slackBlocks(issue: CardIssue, opts: { change?: CardChange; actions?: boolean; note?: string; tr?: Translator } = {}): Block[] {
  // A channel's card is in the server's language; a reply to a person, in theirs (D49).
  const tr = opts.tr ?? translatorFor(null);
  const blocks: Block[] = [];
  if (opts.change) {
    blocks.push({ type: 'context', elements: [{ type: 'mrkdwn', text: `*${slackText(opts.change.who)}* ${slackText(opts.change.did)}` }] });
    if (opts.change.details.length) {
      blocks.push({ type: 'section', text: { type: 'mrkdwn', text: opts.change.details.map((d) => `> ${slackText(d).replace(/\n/g, '\n> ')}`).join('\n') } });
    }
  }
  const head = `<${issue.url}|*${slackText(issue.id)}*> ${slackText(issue.summary)}`;
  // not words: the field's name, as people named it
  const facts = [...(issue.state ? [{ title: 'State', value: issue.state }] : []), ...issue.facts].slice(0, 10);
  blocks.push({
    type: 'section',
    text: { type: 'mrkdwn', text: `${head}\n_${slackText(issue.project)}_` },
    ...(facts.length ? { fields: facts.map((f) => ({ type: 'mrkdwn', text: `*${slackText(f.title)}*\n${slackText(f.value)}` })) } : {}),
  });
  if (opts.note) blocks.push({ type: 'context', elements: [{ type: 'mrkdwn', text: slackText(opts.note) }] });
  if (opts.actions !== false) {
    const elements: Block[] = [{ type: 'button', action_id: 'assign', text: { type: 'plain_text', text: tr.t('server.chat.assignToMe') }, value: issue.id }];
    if (issue.states.length) {
      elements.push({
        type: 'static_select',
        action_id: 'state',
        placeholder: { type: 'plain_text', text: tr.t('server.chat.moveTo') },
        options: issue.states.slice(0, 100).map((st) => ({ text: { type: 'plain_text', text: st.slice(0, 75) }, value: `${issue.id}|${st}`.slice(0, 150) })),
      });
    }
    elements.push({ type: 'button', action_id: 'open', text: { type: 'plain_text', text: tr.t('server.chat.openInA4a') }, url: issue.url });
    blocks.push({ type: 'actions', block_id: `issue:${issue.id}`, elements });
  }
  return blocks;
}

/** The line a notification and a screen reader read when the blocks can't be shown. */
export function fallbackText(issue: CardIssue, change?: CardChange): string {
  return change ? `${change.who} ${change.did}: ${issue.id} ${issue.summary}` : `${issue.id} ${issue.summary}`;
}
