import type { Attachment, User, WritingFor } from '@a4a/shared';
import { imagePath } from '@a4a/shared/markdown';
import { lazy, Suspense, useRef, useState } from 'react';
import { ApiError } from '../../api/client';
import { useUsers } from '../../api/queries';
import { ErrorLine } from '../../components/States';
import { contentPath, refusal, uploadFile, useAttachmentLimits } from '../attachments/api';
import { MentionField } from '../issues/MentionField';
import type { EditorHandle, Picked, Placed } from './VisualEditor';
import { carriedOn, useWritingHelp } from '../writing/WritingHelp';
import { t, problemWords } from '../../i18n';

// Fetched when someone first writes: pages that only read never load the editor.
const VisualEditor = lazy(() => import('./VisualEditor'));

type Mode = 'visual' | 'markdown';
const MODE_KEY = 'a4a.editor.mode';

function storedMode(): Mode {
  try {
    return localStorage.getItem(MODE_KEY) === 'markdown' ? 'markdown' : 'visual';
  } catch {
    return 'visual';
  }
}

function keepMode(mode: Mode) {
  try {
    localStorage.setItem(MODE_KEY, mode);
  } catch {
    // Not kept: the next field opens as the default.
  }
}

const RASTER = ['image/png', 'image/jpeg', 'image/gif', 'image/webp'];
export const isPicture = (f: File) => RASTER.includes(f.type);

/** A file's name as Markdown's words for a link or a picture: brackets and backslashes escaped. */
const words = (name: string) => name.replace(/[\r\n]+/g, ' ').replace(/[\\[\]]/g, '\\$&');

/** A picture's place while it waits for somewhere to upload to, as the editor writes it (D39). */
export const uploadingMark = (name: string, n: number) => `![Uploading ${words(name)}…](#uploading-${n})`;

export function placedMarkdown(p: Placed): string {
  return `${p.kind === 'image' ? '!' : ''}[${words(p.name)}](${p.href})`;
}

/**
 * Where Markdown is written (docs/architecture.md, D39): the visual editor by default, or the
 * Markdown itself, by a switch that's remembered. Either way the value is Markdown, and "@" offers
 * people as the composer always has. With `uploadTo`, a picture pasted or dropped is uploaded there
 * (an issue's or an article's files) and goes in the text where it was put; any other file goes in
 * as a link to it, unless `onOtherFiles` takes it (a new comment's own files, sent with it).
 */
export function RichField({
  id,
  label,
  value,
  onChange,
  rows = 4,
  placeholder,
  describedBy,
  autoFocus,
  people,
  uploadTo,
  onUploaded,
  onOtherFiles,
  tall,
  writing,
  writingEndpoint,
  holdPictures,
}: {
  id: string;
  /** The field's name, said by the visual editor (a label can't name an editable region). */
  label: string;
  value: string;
  onChange: (text: string) => void;
  rows?: number;
  placeholder?: string;
  describedBy?: string;
  autoFocus?: boolean;
  people?: User[];
  uploadTo?: string;
  onUploaded?: (file: Attachment) => void;
  onOtherFiles?: (files: File[]) => void;
  tall?: boolean;
  /** Where the text goes, for writing help (D59): offered only with it, and while the server has an AI provider. */
  writing?: WritingFor;
  /** Which route the ask goes to: a requester's pages ask the portal's own (D59's revisit). */
  writingEndpoint?: string;
  /** Pictures pasted before there's somewhere to upload them (a new issue): the host holds each, and puts them in once there is (D39). */
  holdPictures?: (files: File[], marks: string[]) => void;
}) {
  const [mode, setMode] = useState<Mode>(storedMode);
  const [status, setStatus] = useState<{ text: string; bad?: boolean } | null>(null);
  const limits = useAttachmentLimits();
  const everyone = useUsers({ enabled: !people });
  const latest = useRef(value);
  latest.current = value;
  const seq = useRef(0);
  const statusId = `${id}-status`;
  const described = [describedBy, status ? statusId : null].filter(Boolean).join(' ') || undefined;

  const say = (text: string, bad?: boolean) => setStatus(text ? { text, bad } : null);
  const change = (next: string) => {
    latest.current = next;
    onChange(next);
  };

  // What's selected, for writing help: the visual editor's, or the Markdown's from where to where.
  const editorHandle = useRef<EditorHandle | null>(null);
  const area = useRef({ start: 0, end: 0 });
  const [selected, setSelected] = useState(false);
  const fieldEl = () => document.getElementById(id);
  const help = useWritingHelp({
    at: writing,
    endpoint: writingEndpoint,
    value,
    selected,
    pick: (): Picked | null => {
      if (mode === 'visual') return editorHandle.current?.pick() ?? null;
      const { start, end } = area.current;
      if (end <= start) return null;
      const text = latest.current.slice(start, end);
      return {
        text,
        apply: (next) => {
          const now = latest.current;
          if (now.slice(start, end) !== text) return false;
          change(now.slice(0, start) + next + now.slice(end));
          // What was selected is gone: nothing is, until the next selection.
          area.current = { start: 0, end: 0 };
          setSelected(false);
          return true;
        },
      };
    },
    whole: (carryOn) => {
      const text = latest.current;
      return {
        text,
        apply: (next) => {
          if (latest.current !== text) return false;
          change(carryOn ? carriedOn(text, next) : next);
          return true;
        },
      };
    },
    focusField: () => (mode === 'visual' ? editorHandle.current?.focus() : fieldEl()?.focus()),
    say,
  });

  const place = uploadTo
    ? async (file: File): Promise<Placed | null> => {
        const no = refusal(file, limits.data, 0);
        if (no) {
          say(no, true);
          return null;
        }
        say(t('editor.richField.uploading', { name: file.name }));
        try {
          const stored = await uploadFile(uploadTo, file, (sent, total) => say(t('editor.richField.uploading2', { name: file.name, round: Math.round((sent / (total || 1)) * 100) })));
          onUploaded?.(stored);
          say(t('editor.richField.isInTheTextAnd', { name: stored.name }));
          // The server decides what's a picture, from the bytes: an SVG is a file to download, never drawn.
          return stored.inline ? { kind: 'image', name: stored.name, href: imagePath(stored.id) } : { kind: 'link', name: stored.name, href: contentPath(stored) };
        } catch (e) {
          say(e instanceof ApiError ? (problemWords(e) ?? (e.hint ? `${e.message}. ${e.hint}` : e.message)) : t('editor.richField.wasnTUploadedTryAgain', { name: file.name }), true);
          return null;
        }
      }
    : undefined;

  // Markdown's own: a mark where each file goes while it uploads, then the picture or the link in its place.
  const putFiles = async (files: File[], start: number, end: number) => {
    const others = onOtherFiles ? files.filter((f) => !isPicture(f)) : [];
    const mine = onOtherFiles ? files.filter(isPicture) : files;
    if (others.length) onOtherFiles!(others);
    if (!mine.length) return;
    const text = latest.current;
    const marks = mine.map((f) => `![Uploading ${words(f.name)}…](#uploading-${++seq.current})`);
    if (!place) {
      if (!holdPictures) return say(t('editor.richField.saveItFirstThenPictures'), true);
      // A new issue's description: the host holds them, and puts each where its mark is once the issue is there.
      change(text.slice(0, start) + marks.join('\n') + text.slice(end));
      holdPictures(mine, marks);
      return;
    }
    change(text.slice(0, start) + marks.join('\n') + text.slice(end));
    for (const [i, file] of mine.entries()) {
      const placed = await place(file);
      const now = latest.current;
      const at = now.indexOf(marks[i]!);
      // Taken out meanwhile: left out.
      if (at < 0) continue;
      change(now.slice(0, at) + (placed ? placedMarkdown(placed) : '') + now.slice(at + marks[i]!.length));
    }
  };

  const switcher = (
    <div className="modes editor-mode" role="group" aria-label={t('editor.richField.howToWriteIt')}>
      {(['visual', 'markdown'] as const).map((m) => (
        <button
          key={m}
          type="button"
          aria-pressed={mode === m}
          onClick={() => {
            setMode(m);
            keepMode(m);
            setSelected(false);
          }}
        >
          {m === 'visual' ? t('editor.richField.visual') : t('editor.richField.markdown')}
        </button>
      ))}
    </div>
  );

  return (
    <div className={tall ? 'editor tall' : 'editor'}>
      {mode === 'visual' ? (
        <Suspense
          fallback={
            <div className="editor-bar">
              <span className="note">{t('editor.richField.openingTheEditor')}</span>
              <span className="grow" />
              {help.button}
              {switcher}
            </div>
          }
        >
          <VisualEditor
            id={id}
            value={value}
            onChange={change}
            label={label}
            describedBy={described}
            placeholder={placeholder}
            autoFocus={autoFocus}
            tall={tall}
            people={people ?? everyone.data}
            place={place}
            onOtherFiles={onOtherFiles}
            onStatus={say}
            end={
              <>
                {help.button}
                {switcher}
              </>
            }
            handle={editorHandle}
            onSelection={setSelected}
          />
        </Suspense>
      ) : (
        <>
          <div className="editor-bar">
            <span className="note">{t('editor.richField.markdownAsItSKept')}</span>
            <span className="grow" />
            {help.button}
            {switcher}
          </div>
          <MentionField
            id={id}
            value={value}
            onChange={change}
            rows={tall ? Math.max(rows, 14) : rows}
            placeholder={placeholder}
            describedBy={described}
            autoFocus={autoFocus}
            people={people}
            onFiles={(files, start, end) => void putFiles(files, start, end)}
            onSelection={(start, end) => {
              area.current = { start, end };
              setSelected(end > start);
            }}
          />
        </>
      )}
      {help.panel}
      {status?.bad ? (
        <ErrorLine id={statusId}>{status.text}</ErrorLine>
      ) : (
        <p className="field-help editor-status" id={statusId} role="status">
          {status?.text ?? ''}
        </p>
      )}
    </div>
  );
}
