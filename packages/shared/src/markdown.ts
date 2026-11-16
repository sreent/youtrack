/**
 * What the visual editor (docs/architecture.md, D39) and the page that shows Markdown agree on:
 * where a picture within text points, and which checklist item is which. Its own path, so the
 * browser's bundle takes it without the zod contract.
 *
 * Checklist items are found with the very grammar the page renders with (micromark's GFM, as
 * remark-gfm reads it), so the third box the page draws is the third item here, whatever code
 * blocks, quotes or nested lists come between.
 */
import { fromMarkdown } from 'mdast-util-from-markdown';
import { gfmFromMarkdown } from 'mdast-util-gfm';
import { gfm } from 'micromark-extension-gfm';

/** Where a picture within text points: a raster image of a4a's own, served by `/attachments/{id}/image`. */
export function imagePath(attachmentId: string): string {
  return `/api/v1/attachments/${attachmentId}/image`;
}

const IMAGE_PATH = /^\/api\/v1\/attachments\/([A-Za-z0-9_-]{1,64})\/image$/;

/** The attachment a picture shows, if it's one a4a shows: its own path, never another origin's. */
export function imageAttachment(src: string | null | undefined): string | null {
  return src ? (IMAGE_PATH.exec(src)?.[1] ?? null) : null;
}

/** One checklist item: whether it's ticked, and where its box is in the text. */
export interface TaskItem {
  /** Its place among the text's checklist items, from 0, in the order they're read. */
  index: number;
  checked: boolean;
  /** The offset of the character between the brackets: " " or "x". */
  at: number;
}

interface Node {
  type: string;
  checked?: boolean | null;
  position?: { start: { offset?: number } };
  children?: Node[];
}

const MARKER = /^(?:[-*+]|\d{1,9}[.)])[ \t]+\[([ xX])\]/;

/** The text's checklist items ("- [ ] …", "1. [x] …"), in order. */
export function taskItems(markdown: string): TaskItem[] {
  const tree = fromMarkdown(markdown, { extensions: [gfm()], mdastExtensions: [gfmFromMarkdown()] }) as Node;
  const out: TaskItem[] = [];
  const walk = (node: Node) => {
    if (node.type === 'listItem' && typeof node.checked === 'boolean') {
      const start = node.position?.start.offset;
      if (start !== undefined) {
        const m = MARKER.exec(markdown.slice(start, start + 24));
        if (m) out.push({ index: out.length, checked: node.checked, at: start + m[0].length - 2 });
      }
    }
    for (const child of node.children ?? []) walk(child);
  };
  walk(tree);
  return out;
}

/** The text with its `index`th checklist item ticked, or not; null when there's no such item. */
export function toggleTask(markdown: string, index: number, checked: boolean): string | null {
  const item = taskItems(markdown)[index];
  if (!item) return null;
  return markdown.slice(0, item.at) + (checked ? 'x' : ' ') + markdown.slice(item.at + 1);
}
