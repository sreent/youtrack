/**
 * The visual editor (docs/architecture.md, D39): Milkdown, over the Markdown a4a keeps. Milkdown
 * reads and writes Markdown with remark, the very parser the page renders with, so what is written
 * here reads the same there; and a text nobody changed is handed back as it came, never rewritten.
 *
 * Under a4a's strict CSP: nothing here sets a style attribute (table cells say their alignment
 * with data-align, not text-align), and a picture loads only when it's one of a4a's own.
 * Loaded on its own, when someone first writes, so pages that only read never fetch it.
 */
import type { User } from '@a4a/shared';
import { imageAttachment } from '@a4a/shared/markdown';
import { defaultValueCtx, Editor, editorViewCtx, editorViewOptionsCtx, remarkStringifyOptionsCtx, rootCtx, serializerCtx } from '@milkdown/kit/core';
import { clipboard } from '@milkdown/kit/plugin/clipboard';
import { history } from '@milkdown/kit/plugin/history';
import { upload, uploadConfig } from '@milkdown/kit/plugin/upload';
import {
  commonmark,
  imageSchema,
  listItemSchema,
  paragraphSchema,
  toggleEmphasisCommand,
  toggleInlineCodeCommand,
  toggleStrongCommand,
  turnIntoTextCommand,
  wrapInBlockquoteCommand,
  wrapInBulletListCommand,
  wrapInHeadingCommand,
  wrapInOrderedListCommand,
} from '@milkdown/kit/preset/commonmark';
import { gfm, insertTableCommand, tableCellSchema, tableHeaderSchema, toggleStrikethroughCommand } from '@milkdown/kit/preset/gfm';
import type { Node as PMNode, Schema } from '@milkdown/kit/prose/model';
import { Plugin, PluginKey, type EditorState } from '@milkdown/kit/prose/state';
import { Decoration, DecorationSet, type EditorView, type NodeView } from '@milkdown/kit/prose/view';
import { $prose, $view, callCommand, replaceAll } from '@milkdown/kit/utils';
import { useEffect, useId, useMemo, useRef, useState } from 'react';
import { flushSync } from 'react-dom';
import { Icon, type IconName } from '../../components/Icon';
import { Avatar } from '../../components/Who';
import { t } from '../../i18n';

/** What a file dropped or pasted becomes in the text, once it's uploaded. */
export interface Placed {
  name: string;
  /** A picture within the text (`/attachments/{id}/image`), or a link to download the file. */
  kind: 'image' | 'link';
  href: string;
}

export interface VisualEditorProps {
  id: string;
  value: string;
  onChange: (markdown: string) => void;
  label: string;
  describedBy?: string;
  placeholder?: string;
  autoFocus?: boolean;
  tall?: boolean;
  people?: User[];
  /** Upload one file and say what it became; null when it didn't go (and the reason was said). */
  place?: (file: File) => Promise<Placed | null>;
  /** Files the text doesn't take: anything but a picture, where the host keeps such files aside (a new comment's). */
  onOtherFiles?: (files: File[]) => void;
  /** Said under the editor: what's being uploaded, or why it wasn't. */
  onStatus: (text: string, bad?: boolean) => void;
  /** Drawn at the end of the toolbar: the switch to Markdown. */
  end?: React.ReactNode;
}

/** "@" and what's typed after it, ending at the caret: the person being named, if any (as MentionField reads it). */
const TYPING = /(^|[^\p{L}\p{N}_@./-])@([A-Za-z0-9._-]{0,40})$/u;

const RASTER = ['image/png', 'image/jpeg', 'image/gif', 'image/webp'];

/**
 * A text up to this size (in the document's positions, about its characters) is handed over as it's
 * typed, as a text area's is. A longer one, once typing settles, so writing a long article stays quick;
 * leaving the editor hands it over at once.
 */
const AS_TYPED = 12_000;
const SETTLE_MS = 120;

function matches(u: User, typed: string): boolean {
  if (!typed) return true;
  const t = typed.toLowerCase();
  return u.login.toLowerCase().startsWith(t) || u.name.toLowerCase().split(/\s+/).some((w) => w.startsWith(t));
}

interface Active {
  strong: boolean;
  emphasis: boolean;
  strike: boolean;
  code: boolean;
  heading: boolean;
  quote: boolean;
  bullet: boolean;
  ordered: boolean;
  task: boolean;
}

const NONE: Active = { strong: false, emphasis: false, strike: false, code: false, heading: false, quote: false, bullet: false, ordered: false, task: false };

/** Which tools are on where the caret is: its marks, and the blocks it's in (the nearest list says which list). */
function activeIn(state: EditorState): Active {
  const { $from, empty } = state.selection;
  const marks = empty ? (state.storedMarks ?? $from.marks()) : $from.marks();
  const has = (name: string) => marks.some((m) => m.type.name === name);
  const out = { ...NONE, strong: has('strong'), emphasis: has('emphasis'), strike: has('strike_through'), code: has('inlineCode') };
  let list = false;
  for (let d = $from.depth; d > 0; d--) {
    const n = $from.node(d);
    if (n.type.name === 'heading') out.heading = true;
    if (n.type.name === 'blockquote') out.quote = true;
    if (list || n.type.name !== 'list_item') continue;
    list = true;
    if (n.attrs.checked != null) out.task = true;
    else if ($from.node(d - 1).type.name === 'ordered_list') out.ordered = true;
    else out.bullet = true;
  }
  return out;
}

/**
 * An empty line, as Milkdown writes it, is `<br />`: raw HTML, which a4a's pages show as written. The
 * editor writes this mark in its place, and `withoutEmptyLines` takes it out: an empty line is a
 * blank line, as anywhere in Markdown (and a blank line more or less reads the same).
 */
const EMPTY_LINE = '<!--a4a-empty-line-->';

const emptyLines = paragraphSchema.extendSchema((prev) => (ctx) => {
  const base = prev(ctx);
  return {
    ...base,
    toMarkdown: {
      match: base.toMarkdown.match,
      runner: (state, node) => {
        if (node.content.size) return base.toMarkdown.runner(state, node);
        state.openNode('paragraph');
        state.addNode('html', undefined, EMPTY_LINE);
        state.closeNode();
      },
    },
  };
});

export function withoutEmptyLines(markdown: string): string {
  if (!markdown.includes(EMPTY_LINE)) return markdown;
  const lines = markdown.split('\n');
  const out: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    if (line.trim() === EMPTY_LINE) {
      // The line goes, with the blank line that set it apart.
      if (lines[i + 1] === '') i++;
      else if (out.at(-1) === '') out.pop();
      continue;
    }
    // In a list item or a quote: the item, or the quote's line, stays, empty.
    out.push(line.replace(EMPTY_LINE, ''));
  }
  return out.join('\n');
}

/** A table cell that says its alignment with data-align: a style attribute would break the page's CSP. */
function cellSchema(tag: 'td' | 'th') {
  return (prev: (ctx: never) => Record<string, unknown>) => (ctx: never) => ({
    ...prev(ctx),
    parseDOM: [
      {
        tag,
        getAttrs: (dom: HTMLElement) => ({
          colspan: Number(dom.getAttribute('colspan') ?? 1),
          rowspan: Number(dom.getAttribute('rowspan') ?? 1),
          alignment: dom.dataset.align || dom.getAttribute('align') || 'left',
        }),
      },
    ],
    toDOM: (node: PMNode) => {
      const attrs: Record<string, string> = {};
      if (node.attrs.colspan && node.attrs.colspan !== 1) attrs.colspan = String(node.attrs.colspan);
      if (node.attrs.rowspan && node.attrs.rowspan !== 1) attrs.rowspan = String(node.attrs.rowspan);
      if (node.attrs.alignment && node.attrs.alignment !== 'left') attrs['data-align'] = String(node.attrs.alignment);
      return [tag, attrs, 0];
    },
  });
}

/** A picture loads only when it's one of a4a's own; any other is named, never fetched (as the page does). */
const ownImages = imageSchema.extendSchema((prev) => (ctx) => {
  const base = prev(ctx);
  return {
    ...base,
    parseDOM: [
      ...(base.parseDOM ?? []),
      {
        tag: 'span.image-elsewhere[data-src]',
        getAttrs: (dom) => ({ src: (dom as HTMLElement).dataset.src ?? '', alt: (dom as HTMLElement).dataset.alt ?? '', title: '' }),
      },
    ],
    toDOM: (node) => {
      const { src, alt, title } = node.attrs as { src: string; alt: string; title: string };
      if (imageAttachment(src)) return ['img', { src, alt: alt || '', title: title || null, loading: 'lazy' }];
      return ['span', { class: 'image-elsewhere', 'data-src': src, 'data-alt': alt }, alt || src || 'A picture'];
    },
  };
});

/**
 * A list item. A checklist's has a box to tick (ticking it changes the item, so it's undone with
 * the rest); any other is the plain item. Turning one into the other draws it afresh.
 */
class ListItemView implements NodeView {
  dom: HTMLLIElement;
  contentDOM: HTMLElement;
  private box: HTMLInputElement | null = null;

  constructor(
    private node: PMNode,
    private view: EditorView,
    private getPos: () => number | undefined,
  ) {
    this.dom = document.createElement('li');
    if (node.attrs.checked == null) {
      this.contentDOM = this.dom;
    } else {
      this.dom.className = 'editor-task';
      const box = document.createElement('input');
      box.type = 'checkbox';
      box.contentEditable = 'false';
      box.addEventListener('mousedown', (e) => e.preventDefault());
      // The browser ticks the box; the item follows, so the box and the text agree.
      box.addEventListener('click', () => {
        const pos = this.getPos();
        if (pos === undefined) return;
        this.view.dispatch(this.view.state.tr.setNodeMarkup(pos, undefined, { ...this.node.attrs, checked: !this.node.attrs.checked }));
      });
      this.box = box;
      this.contentDOM = document.createElement('div');
      this.dom.append(box, this.contentDOM);
    }
    this.render();
  }

  private render() {
    const { checked, label, listType, spread } = this.node.attrs as { checked: boolean | null; label: string; listType: string; spread: boolean };
    // As the schema draws an item, so copying one out and pasting it back keeps what it is.
    this.dom.dataset.label = label;
    this.dom.dataset.listType = listType;
    this.dom.dataset.spread = String(spread);
    if (!this.box) return;
    this.dom.dataset.itemType = 'task';
    this.dom.dataset.checked = String(Boolean(checked));
    this.box.checked = Boolean(checked);
    this.box.setAttribute('aria-label', `Done: ${this.node.textContent.trim().slice(0, 80) || 'this item'}`);
  }

  update(node: PMNode) {
    if (node.type !== this.node.type || (node.attrs.checked == null) !== (this.node.attrs.checked == null)) return false;
    this.node = node;
    this.render();
    return true;
  }

  stopEvent(e: Event) {
    return e.target === this.box;
  }

  ignoreMutation(m: MutationRecord | { type: 'selection'; target: globalThis.Node }) {
    if (m.type === 'selection') return false;
    return m.target === this.box || (m.type === 'attributes' && m.target === this.dom);
  }
}

/** A tool on the toolbar, said by its name; a mark's or a block's says whether it's on. */
function Tool({ label, icon, glyph, pressed, onClick }: { label: string; icon?: IconName; glyph?: string; pressed?: boolean; onClick: () => void }) {
  return (
    <button
      type="button"
      className="editor-tool"
      aria-label={label}
      title={label}
      aria-pressed={pressed === undefined ? undefined : pressed}
      onMouseDown={(e) => e.preventDefault()}
      onClick={onClick}
    >
      {icon ? (
        <Icon name={icon} />
      ) : (
        <span className={`editor-glyph ${label.toLowerCase().replace(/\W+/g, '-')}`} aria-hidden="true">
          {glyph}
        </span>
      )}
    </button>
  );
}

export default function VisualEditor({ id, value, onChange, label, describedBy, placeholder, autoFocus, tall, people, place, onOtherFiles, onStatus, end }: VisualEditorProps) {
  const root = useRef<HTMLDivElement>(null);
  const editor = useRef<Editor | null>(null);
  /** The text last handed over or put in, and the document it reads as: that document, unchanged, is that text. */
  const kept = useRef<{ text: string; doc: PMNode | null }>({ text: value, doc: null });
  /** While a text from outside is put in: not handed back. */
  const applying = useRef(false);
  const listId = useId();
  const picker = useRef<HTMLInputElement>(null);
  const [active, setActive] = useState<Active>(NONE);
  const [typing, setTyping] = useState<{ from: number; to: number; typed: string } | null>(null);
  const [chosen, setChosen] = useState(0);
  const [dismissed, setDismissed] = useState<number | null>(null);
  const [dropping, setDropping] = useState(false);

  // What the editor's plugins read, kept current without making a new editor.
  const live = useRef({
    onChange,
    onStatus,
    place,
    onOtherFiles,
    placeholder,
    key: ((_e: KeyboardEvent) => false) as (e: KeyboardEvent) => boolean,
    files: (async (_files: File[]) => {}) as (files: File[]) => Promise<void>,
  });
  live.current.onChange = onChange;
  live.current.onStatus = onStatus;
  live.current.place = place;
  live.current.onOtherFiles = onOtherFiles;
  live.current.placeholder = placeholder;

  const offered = useMemo(() => {
    if (!typing) return [];
    return (people ?? [])
      .filter((u) => !u.banned && matches(u, typing.typed))
      .sort((a, b) => Number(a.isBot) - Number(b.isBot) || a.name.localeCompare(b.name))
      .slice(0, 8);
  }, [people, typing]);
  const open = Boolean(typing) && offered.length > 0 && dismissed !== typing?.from;

  const take = (u: User) => {
    const view = editor.current?.ctx.get(editorViewCtx);
    if (!view || !typing) return;
    view.dispatch(view.state.tr.insertText(`@${u.login} `, typing.from, typing.to));
    view.focus();
    setChosen(0);
  };

  live.current.key = (e: KeyboardEvent) => {
    if (!open) return false;
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      setChosen((a) => (e.key === 'ArrowDown' ? (a + 1) % offered.length : (a - 1 + offered.length) % offered.length));
      return true;
    }
    if ((e.key === 'Enter' || e.key === 'Tab') && !e.shiftKey) {
      take(offered[Math.min(chosen, offered.length - 1)]!);
      return true;
    }
    if (e.key === 'Escape') {
      setDismissed(typing!.from);
      return true;
    }
    return false;
  };

  /** Pictures go in the text; other files too, unless the host keeps them aside. Each where the caret is. */
  live.current.files = async (files: File[]) => {
    const view = editor.current?.ctx.get(editorViewCtx);
    if (!view) return;
    const others = onOtherFiles ? files.filter((f) => !RASTER.includes(f.type)) : [];
    if (others.length) onOtherFiles!(others);
    for (const file of files.filter((f) => !others.includes(f))) {
      if (!place) return onStatus('Save it first: then pictures and files can go in it.', true);
      const placed = await place(file);
      if (!placed) continue;
      const { schema } = view.state;
      const node = placed.kind === 'image' ? schema.nodes.image!.create({ src: placed.href, alt: placed.name }) : schema.text(placed.name, [schema.marks.link!.create({ href: placed.href })]);
      view.dispatch(view.state.tr.replaceSelectionWith(node, false).scrollIntoView());
    }
  };

  useEffect(() => {
    let made: Editor | null = null;
    let gone = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let lastSent = kept.current.text;

    /**
     * Hand the text over: the one that came in, when the document reads as it did; else the document,
     * written as Markdown. When typing settles, it's drawn at once (`now`), so a click that follows
     * (Save, say) never acts on the text as it was before.
     */
    const flush = (now = false) => {
      clearTimeout(timer);
      timer = undefined;
      const view = made?.ctx.get(editorViewCtx);
      if (!view || !made) return;
      const doc = view.state.doc;
      const text = kept.current.doc && doc.eq(kept.current.doc) ? kept.current.text : withoutEmptyLines(made.ctx.get(serializerCtx)(doc));
      if (text === lastSent) return;
      lastSent = text;
      kept.current = { text, doc };
      if (now) flushSync(() => live.current.onChange(text));
      else live.current.onChange(text);
    };

    const watch = $prose(
      () =>
        new Plugin({
          key: new PluginKey('a4a-watch'),
          view: () => ({
            update: (view, prev) => {
              setActive(activeIn(view.state));
              if (!view.state.doc.eq(prev.doc) && !applying.current) {
                clearTimeout(timer);
                if (view.state.doc.content.size <= AS_TYPED) flush();
                else timer = setTimeout(() => flush(true), SETTLE_MS);
              }
              const { $from, empty } = view.state.selection;
              if (!empty || !$from.parent.isTextblock || $from.parent.type.spec.code) return setTyping(null);
              const before = $from.parent.textBetween(Math.max(0, $from.parentOffset - 42), $from.parentOffset, undefined, '￼');
              const m = TYPING.exec(before);
              setTyping(m ? { from: $from.pos - m[2]!.length - 1, to: $from.pos, typed: m[2]! } : null);
            },
            destroy: () => flush(),
          }),
          props: {
            handleKeyDown: (_view, e) => live.current.key(e),
            handleDOMEvents: {
              blur: () => {
                flush();
                return false;
              },
            },
            // A picture copied from a page comes with its HTML and no words: the picture is what's meant.
            // Words copied with a picture of them (from a sheet, say) paste as the words.
            handlePaste: (_view, e) => {
              const files = [...(e.clipboardData?.files ?? [])];
              if (!files.length || !e.clipboardData?.getData('text/html') || e.clipboardData.getData('text/plain').trim()) return false;
              void live.current.files(files);
              return true;
            },
            // Shown while nothing is written: the field's own hint.
            decorations: (state) => {
              const doc = state.doc;
              const first = doc.firstChild;
              if (!live.current.placeholder || doc.childCount !== 1 || !first || !first.isTextblock || first.content.size) return null;
              return DecorationSet.create(doc, [Decoration.node(0, first.nodeSize, { class: 'is-empty', 'data-placeholder': live.current.placeholder })]);
            },
          },
        }),
    );

    const tasks = $view(listItemSchema.node, () => (node, view, getPos) => new ListItemView(node, view, getPos as () => number | undefined));
    const cells = tableCellSchema.extendSchema(cellSchema('td') as never);
    const heads = tableHeaderSchema.extendSchema(cellSchema('th') as never);

    // Pasted or dropped files, where they were put. Never throws: the upload's mark is taken away whatever happens.
    const uploader = async (files: FileList, schema: Schema) => {
      const nodes: PMNode[] = [];
      const others: File[] = [];
      try {
        for (const file of [...files]) {
          if (!RASTER.includes(file.type) && live.current.onOtherFiles) {
            others.push(file);
            continue;
          }
          if (!live.current.place) {
            live.current.onStatus('Save it first: then pictures and files can go in it.', true);
            continue;
          }
          const placed = await live.current.place(file);
          if (!placed) continue;
          if (placed.kind === 'image') nodes.push(schema.nodes.image!.create({ src: placed.href, alt: placed.name }));
          else nodes.push(schema.text(placed.name, [schema.marks.link!.create({ href: placed.href })]));
        }
      } catch {
        live.current.onStatus('That didn’t go in: try again.', true);
      }
      if (others.length) live.current.onOtherFiles?.(others);
      return nodes;
    };

    void Editor.make()
      .config((ctx) => {
        ctx.set(rootCtx, root.current!);
        ctx.set(defaultValueCtx, kept.current.text);
        // One way of writing what the editor writes: "-" bullets, "_" and "**", fenced code.
        ctx.update(remarkStringifyOptionsCtx, (prev) => ({ ...prev, bullet: '-', emphasis: '_', strong: '*', rule: '-', listItemIndent: 'one', fences: true }) as const);
        ctx.update(editorViewOptionsCtx, (prev) => ({
          ...prev,
          attributes: {
            id,
            class: tall ? 'editor-surface prose tall' : 'editor-surface prose',
            role: 'textbox',
            'aria-multiline': 'true',
            spellcheck: 'true',
          },
        }));
        ctx.update(uploadConfig.key, (prev) => ({
          ...prev,
          enableHtmlFileUploader: false,
          uploader,
          uploadWidgetFactory: (pos, spec) => {
            const el = document.createElement('span');
            el.className = 'editor-uploading';
            el.textContent = 'Uploading…';
            return Decoration.widget(pos, el, spec);
          },
        }));
      })
      .use(commonmark)
      .use(gfm)
      .use(emptyLines)
      .use(ownImages)
      .use(cells)
      .use(heads)
      .use(tasks)
      .use(history)
      .use(clipboard)
      .use(upload)
      .use(watch)
      .create()
      .then((e) => {
        if (gone) return void e.destroy();
        made = e;
        editor.current = e;
        const view = e.ctx.get(editorViewCtx);
        kept.current.doc = view.state.doc;
        name.current(view.dom);
        if (autoFocus) view.focus();
      });
    return () => {
      gone = true;
      clearTimeout(timer);
      made?.destroy();
      editor.current = null;
    };
    // The editor is made once; what changes later reaches it through `live`.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // A text changed from outside (a comment sent, the Markdown edited) is put in the editor.
  useEffect(() => {
    const ed = editor.current;
    if (!ed || value === kept.current.text) return;
    const view = ed.ctx.get(editorViewCtx);
    applying.current = true;
    try {
      ed.action(replaceAll(value));
    } finally {
      applying.current = false;
    }
    kept.current = { text: value, doc: view.state.doc };
  }, [value]);

  /** The editable region's name and what describes it, kept as the field's are. */
  const name = useRef((_dom: HTMLElement) => {});
  name.current = (dom: HTMLElement) => {
    dom.setAttribute('aria-label', label);
    if (describedBy) dom.setAttribute('aria-describedby', describedBy);
    else dom.removeAttribute('aria-describedby');
    if (open) {
      dom.setAttribute('aria-autocomplete', 'list');
      dom.setAttribute('aria-controls', listId);
      dom.setAttribute('aria-activedescendant', `${listId}-${Math.min(chosen, offered.length - 1)}`);
    } else {
      dom.removeAttribute('aria-autocomplete');
      dom.removeAttribute('aria-controls');
      dom.removeAttribute('aria-activedescendant');
    }
  };
  useEffect(() => {
    const dom = editor.current?.ctx.get(editorViewCtx).dom;
    if (dom) name.current(dom);
  });

  const run = (key: Parameters<typeof callCommand>[0], payload?: unknown) => editor.current?.action(callCommand(key as never, payload as never));

  // A checklist: the list item the caret is in becomes one (or stops being one); outside a list, a new one.
  const checklist = () => {
    const ed = editor.current;
    if (!ed) return;
    const view = ed.ctx.get(editorViewCtx);
    const itemAt = () => {
      const { $from } = view.state.selection;
      for (let d = $from.depth; d > 0; d--) if ($from.node(d).type.name === 'list_item') return { node: $from.node(d), pos: $from.before(d) };
      return null;
    };
    let item = itemAt();
    if (!item) {
      run(wrapInBulletListCommand.key);
      item = itemAt();
      if (!item) return;
      view.dispatch(view.state.tr.setNodeMarkup(item.pos, undefined, { ...item.node.attrs, checked: false }));
    } else {
      view.dispatch(view.state.tr.setNodeMarkup(item.pos, undefined, { ...item.node.attrs, checked: item.node.attrs.checked == null ? false : null }));
    }
    view.focus();
  };

  return (
    <div
      className={dropping ? 'composer editor-visual dropping' : 'composer editor-visual'}
      onDragEnter={(e) => {
        if (e.dataTransfer.types.includes('Files')) setDropping(true);
      }}
      onDragOver={(e) => {
        if (e.dataTransfer.types.includes('Files')) e.preventDefault();
      }}
      onDragLeave={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setDropping(false);
      }}
      onDrop={(e) => {
        setDropping(false);
        const files = [...e.dataTransfer.files];
        if (!files.length) return;
        // Taken here (the editor put them where they fell, or they go where the caret is): not by the form around it too.
        e.stopPropagation();
        if (e.defaultPrevented) return;
        e.preventDefault();
        void live.current.files(files);
      }}
    >
      <div className="editor-bar">
        <div className="editor-tools" role="group" aria-label={t('editor.visualEditor.words')}>
          <Tool label={t('editor.visualEditor.bold')} glyph="B" pressed={active.strong} onClick={() => run(toggleStrongCommand.key)} />
          <Tool label={t('editor.visualEditor.italic')} glyph="I" pressed={active.emphasis} onClick={() => run(toggleEmphasisCommand.key)} />
          <Tool label={t('editor.visualEditor.struckThrough')} glyph="S" pressed={active.strike} onClick={() => run(toggleStrikethroughCommand.key)} />
          <Tool label={t('editor.visualEditor.code')} icon="code" pressed={active.code} onClick={() => run(toggleInlineCodeCommand.key)} />
        </div>
        <div className="editor-tools" role="group" aria-label={t('editor.visualEditor.blocks')}>
          <Tool label={t('editor.visualEditor.heading')} glyph="H" pressed={active.heading} onClick={() => (active.heading ? run(turnIntoTextCommand.key) : run(wrapInHeadingCommand.key, 2))} />
          <Tool label={t('editor.visualEditor.quote')} icon="quote" pressed={active.quote} onClick={() => run(wrapInBlockquoteCommand.key)} />
          <Tool label={t('editor.visualEditor.bulletedList')} icon="list" pressed={active.bullet} onClick={() => run(wrapInBulletListCommand.key)} />
          <Tool label={t('editor.visualEditor.numberedList')} icon="numbered" pressed={active.ordered} onClick={() => run(wrapInOrderedListCommand.key)} />
          <Tool label={t('editor.visualEditor.checklist')} icon="tasks" pressed={active.task} onClick={checklist} />
        </div>
        <div className="editor-tools" role="group" aria-label={t('editor.visualEditor.insert')}>
          <Tool label={t('editor.visualEditor.table')} icon="table" onClick={() => run(insertTableCommand.key, { row: 3, col: 3 })} />
          <Tool label={t('editor.visualEditor.picture')} icon="picture" onClick={() => picker.current?.click()} />
          <input
            ref={picker}
            type="file"
            accept="image/png,image/jpeg,image/gif,image/webp"
            multiple
            hidden
            onChange={(e) => {
              void live.current.files([...(e.target.files ?? [])]);
              e.target.value = '';
            }}
          />
        </div>
        {end ? <span className="grow" /> : null}
        {end}
      </div>
      <div ref={root} className="editor-root" />
      {open ? (
        <ul className="popover options" id={listId} role="listbox" aria-label={t('editor.visualEditor.peopleToMention')}>
          {offered.map((u, i) => (
            <li
              key={u.id}
              id={`${listId}-${i}`}
              role="option"
              aria-selected={i === Math.min(chosen, offered.length - 1)}
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => take(u)}
              onMouseEnter={() => setChosen(i)}
            >
              <span className="who">
                <Avatar kind={u.isBot ? 'agent' : 'person'} name={u.name} small />
                <span className="who-name">{u.isBot ? u.login : u.name}</span>
              </span>
              <span className="option-kind mono">@{u.login}</span>
            </li>
          ))}
        </ul>
      ) : null}
      <span className="hidden" role="status">
        {open ? t('editor.visualEditor.toMentionUpAndDown', { length: offered.length, v: offered.length === 1 ? 'person' : 'people' }) : ''}
      </span>
    </div>
  );
}
