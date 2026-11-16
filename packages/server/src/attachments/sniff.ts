/**
 * What a file is, read from its first bytes: never from its name, nor from what the
 * uploader said it is. And its name, made safe to show and to send back in a header.
 */
import { INLINE_IMAGE_TYPES, PLAYABLE_AUDIO_TYPES, PLAYABLE_VIDEO_TYPES, type PlayKind } from '@a4a/shared';

/** How much of a file's start is read to tell what it is. */
export const SNIFF_BYTES = 8192;

const at = (b: Buffer, sig: number[], offset = 0) => b.length >= offset + sig.length && sig.every((x, i) => b[offset + i] === x);
const ascii = (b: Buffer, s: string, offset = 0) => b.length >= offset + s.length && b.toString('latin1', offset, offset + s.length) === s;

/** Signatures of binary formats, checked in order; the first that matches names the type. */
const BINARY: [string, (b: Buffer) => boolean][] = [
  ['image/png', (b) => at(b, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])],
  ['image/jpeg', (b) => at(b, [0xff, 0xd8, 0xff])],
  ['image/gif', (b) => ascii(b, 'GIF87a') || ascii(b, 'GIF89a')],
  ['image/webp', (b) => ascii(b, 'RIFF') && ascii(b, 'WEBP', 8)],
  ['image/bmp', (b) => ascii(b, 'BM') && b.length >= 26 && at(b, [0, 0, 0, 0], 6)],
  ['image/tiff', (b) => at(b, [0x49, 0x49, 0x2a, 0x00]) || at(b, [0x4d, 0x4d, 0x00, 0x2a])],
  ['image/x-icon', (b) => at(b, [0x00, 0x00, 0x01, 0x00]) && b.length >= 22],
  ['application/pdf', (b) => ascii(b, '%PDF-')],
  ['application/zip', (b) => at(b, [0x50, 0x4b, 0x03, 0x04]) || at(b, [0x50, 0x4b, 0x05, 0x06])],
  ['application/gzip', (b) => at(b, [0x1f, 0x8b, 0x08])],
  ['application/x-bzip2', (b) => ascii(b, 'BZh') && b.length > 3 && b[3]! >= 0x31 && b[3]! <= 0x39],
  ['application/x-xz', (b) => at(b, [0xfd, 0x37, 0x7a, 0x58, 0x5a, 0x00])],
  ['application/zstd', (b) => at(b, [0x28, 0xb5, 0x2f, 0xfd])],
  ['application/x-7z-compressed', (b) => at(b, [0x37, 0x7a, 0xbc, 0xaf, 0x27, 0x1c])],
  ['application/vnd.rar', (b) => ascii(b, 'Rar!\x1a\x07')],
  ['application/x-tar', (b) => ascii(b, 'ustar', 257)],
  ['application/vnd.sqlite3', (b) => ascii(b, 'SQLite format 3\0')],
  ['application/x-ole-storage', (b) => at(b, [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1])],
  ['application/wasm', (b) => at(b, [0x00, 0x61, 0x73, 0x6d])],
  ['application/x-elf', (b) => at(b, [0x7f, 0x45, 0x4c, 0x46])],
  ['application/x-msdownload', (b) => ascii(b, 'MZ') && b.length >= 64],
  // EBML: WebM says so in its header's DocType; any other is Matroska, which browsers don't all play.
  ['video/webm', (b) => at(b, [0x1a, 0x45, 0xdf, 0xa3]) && b.toString('latin1', 4, 64).includes('webm')],
  ['video/x-matroska', (b) => at(b, [0x1a, 0x45, 0xdf, 0xa3])],
  ['audio/ogg', (b) => ascii(b, 'OggS')],
  ['audio/flac', (b) => ascii(b, 'fLaC')],
  ['audio/mpeg', (b) => ascii(b, 'ID3')],
  ['audio/wav', (b) => ascii(b, 'RIFF') && ascii(b, 'WAVE', 8)],
  ['video/x-msvideo', (b) => ascii(b, 'RIFF') && ascii(b, 'AVI ', 8)],
  ['audio/mpeg', mpegAudioFrame],
  ['audio/aac', adtsFrame],
];

/**
 * An MP3 without an ID3 tag starts with a frame: 11 sync bits, a version that isn't reserved,
 * layer III, a bitrate that isn't "free" or "bad", and a sample rate that isn't reserved. (No
 * text starts with 0xFF, and the UTF-16 mark 0xFF 0xFE says layer I, so neither is taken for one.)
 */
function mpegAudioFrame(b: Buffer): boolean {
  if (b.length < 4 || b[0] !== 0xff || (b[1]! & 0xe0) !== 0xe0) return false;
  const version = (b[1]! >> 3) & 3;
  const layer = (b[1]! >> 1) & 3;
  const bitrate = b[2]! >> 4;
  const rate = (b[2]! >> 2) & 3;
  return version !== 1 && layer === 1 && bitrate !== 0 && bitrate !== 15 && rate !== 3;
}

/** AAC in ADTS frames, as .aac files are: 12 sync bits, layer 0, and a sample rate index in range. */
function adtsFrame(b: Buffer): boolean {
  if (b.length < 7 || b[0] !== 0xff || (b[1]! & 0xf6) !== 0xf0) return false;
  return ((b[2]! >> 2) & 0xf) < 13;
}

/** ISO media files name their brand after "ftyp". */
function isoMedia(b: Buffer): string | null {
  if (!ascii(b, 'ftyp', 4)) return null;
  const brand = b.toString('latin1', 8, 12);
  if (brand === 'avif' || brand === 'avis') return 'image/avif';
  if (['heic', 'heix', 'heim', 'heis', 'hevc', 'mif1', 'msf1'].includes(brand)) return 'image/heic';
  if (brand.startsWith('qt')) return 'video/quicktime';
  if (brand.startsWith('M4A')) return 'audio/mp4';
  return 'video/mp4';
}

/**
 * Bytes no text has (WHATWG MIME Sniffing's "binary data bytes"): controls other than
 * tab, line feed, form feed, carriage return and escape.
 */
function hasBinaryByte(b: Buffer): boolean {
  for (const x of b) {
    if (x <= 0x08 || x === 0x0b || (x >= 0x0e && x <= 0x1a) || (x >= 0x1c && x <= 0x1f)) return true;
  }
  return false;
}

function utf8(b: Buffer): boolean {
  try {
    // stream: a character cut in two at the end of what was read is not an error
    new TextDecoder('utf-8', { fatal: true }).decode(b, { stream: true });
    return true;
  } catch {
    return false;
  }
}

/** HTML as browsers would take it (WHATWG MIME Sniffing's patterns), anywhere it starts. */
const HTML_START = /^<(!doctype html|html|head|script|iframe|h1|div|font|table|a|style|title|b|body|br|p|!--)[\s>]/i;
const MARKUP_ANYWHERE = /<(script|iframe|object|embed|html|body|svg|meta|link|form|img)[\s/>]/i;

/** What the first bytes of a file say it is. */
export function sniffContentType(head: Buffer): string {
  for (const [type, test] of BINARY) if (test(head)) return type;
  const iso = isoMedia(head);
  if (iso) return iso;

  let charset: 'utf-8' | 'utf-16le' | 'utf-16be' | null = null;
  let text: string;
  if (at(head, [0xef, 0xbb, 0xbf])) {
    charset = 'utf-8';
    text = head.subarray(3).toString('utf8');
  } else if (at(head, [0xff, 0xfe])) {
    charset = 'utf-16le';
    text = head.subarray(2).toString('utf16le');
  } else if (at(head, [0xfe, 0xff])) {
    charset = 'utf-16be';
    text = Buffer.from(head.subarray(2, 2 + ((head.length - 2) & ~1))).swap16().toString('utf16le');
  } else {
    if (hasBinaryByte(head)) return 'application/octet-stream';
    charset = utf8(head) ? 'utf-8' : null;
    text = head.toString(charset ? 'utf8' : 'latin1');
  }
  const start = text.trimStart();
  if (HTML_START.test(start)) return 'text/html';
  const lower = start.toLowerCase();
  if (lower.startsWith('<') && /<svg[\s>]/i.test(start)) return 'image/svg+xml';
  if (lower.startsWith('<?xml')) return 'application/xml';
  // Text with live markup further in is still HTML to a browser that guesses; call it that.
  if (MARKUP_ANYWHERE.test(start) && /^\s*</.test(text)) return 'text/html';
  if (lower.startsWith('%!ps')) return 'application/postscript';
  return charset ? `text/plain; charset=${charset}` : 'text/plain';
}

/** The type without its parameters: "text/plain". */
export function baseType(contentType: string): string {
  return contentType.split(';')[0]!.trim().toLowerCase();
}

/** A raster image a browser may show in place. */
export function isInline(contentType: string): boolean {
  return (INLINE_IMAGE_TYPES as readonly string[]).includes(baseType(contentType));
}

/**
 * Sound or video the page plays in its own player (D35): a format every current browser
 * decodes. Served as it always is, with nosniff, so its bytes are taken for nothing else.
 */
export function playableAs(contentType: string): PlayKind | null {
  const t = baseType(contentType);
  if ((PLAYABLE_AUDIO_TYPES as readonly string[]).includes(t)) return 'audio';
  if ((PLAYABLE_VIDEO_TYPES as readonly string[]).includes(t)) return 'video';
  return null;
}

/** Text an agent or a script may read as text. */
export function isText(contentType: string): boolean {
  const t = baseType(contentType);
  return t.startsWith('text/') || t === 'application/xml' || t === 'image/svg+xml' || t === 'application/json' || t === 'application/postscript';
}

/** "a PNG image", "a PDF", "a ZIP archive": for errors that say why a file can't be read as text. */
export function describeType(contentType: string): string {
  const t = baseType(contentType);
  if (t.startsWith('image/')) return `an image (${t.slice(6).toUpperCase()})`;
  if (t.startsWith('video/')) return 'a video';
  if (t.startsWith('audio/')) return 'a sound file';
  if (t === 'application/pdf') return 'a PDF';
  if (/zip|gzip|bzip2|xz|zstd|7z|rar|tar/.test(t)) return 'an archive';
  return 'binary data';
}

const BIDI = /[\u200e\u200f\u202a-\u202e\u2066-\u2069]/g;
// Control characters, as a class built from code points (a literal would hold the raw bytes).
const CONTROL = new RegExp(`[${String.fromCharCode(0)}-${String.fromCharCode(0x1f)}${String.fromCharCode(0x7f)}-${String.fromCharCode(0x9f)}]`, 'g');
const RESERVED = /[<>:"/\\|?*]/g;
const MAX_NAME = 200;

/**
 * A file name as people will see it, and safe wherever it goes: no folders (the last
 * part of any path is kept), no control or direction-changing characters (which could
 * disguise "txt.exe" as "exe.txt"), no characters file systems reserve, no leading
 * dots, and 200 characters at most, keeping its extension. Storage never uses it: a
 * file is kept under a random key, so a name can't reach outside the store.
 */
export function safeFileName(raw: string | undefined | null): string {
  let name = (raw ?? '').normalize('NFC');
  name = name.split(/[/\\]/).pop() ?? '';
  name = name.replace(CONTROL, '').replace(BIDI, '').replace(RESERVED, '_');
  name = name.replace(/\s+/g, ' ').trim().replace(/^[.\s]+/, '').replace(/[.\s]+$/, '');
  if (!name) return 'file';
  if (name.length > MAX_NAME) {
    const dot = name.lastIndexOf('.');
    const ext = dot > 0 && name.length - dot <= 16 ? name.slice(dot) : '';
    name = name.slice(0, MAX_NAME - ext.length).trimEnd() + ext;
  }
  return name;
}

/**
 * Content-Disposition with the name both ways (RFC 6266): an ASCII fallback in quotes,
 * and the exact name as UTF-8 in filename*.
 */
export function contentDisposition(kind: 'inline' | 'attachment', name: string): string {
  const fallback = name
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '') // accents, once split from their letters: "é" reads as "e"
    .replace(/[^\x20-\x7e]/g, '_')
    .replace(/["\\%]/g, '_');
  const exact = encodeURIComponent(name).replace(/['()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
  return `${kind}; filename="${fallback}"; filename*=UTF-8''${exact}`;
}

/** "12.3 KB", "4 MB": sizes as people read them, in units of 1024. */
export function formatBytes(n: number): string {
  if (n < 1024) return `${n} ${n === 1 ? 'byte' : 'bytes'}`;
  const units = ['KB', 'MB', 'GB'];
  let v = n / 1024;
  let u = 0;
  while (v >= 1024 && u < units.length - 1) {
    v /= 1024;
    u++;
  }
  return `${v >= 10 || Number.isInteger(v) ? Math.round(v) : v.toFixed(1)} ${units[u]}`;
}
