/**
 * Just enough of XLSX (Office Open XML's SpreadsheetML) for a native speaker's sheet: written with
 * shared strings, styles, a frozen head, a filter, locked cells and a list to choose from, and read
 * back from whatever saved it (Excel, LibreOffice, Numbers, Google Sheets). Node's zlib does the
 * compression, so nothing is added to install.
 *
 * Reading takes a file from outside, so it is careful: a size cap on the file and on each part as it
 * inflates (a zip bomb stops at the cap), no DOCTYPE (so no entities but XML's five), no encrypted
 * or ZIP64 parts, and each part's CRC checked.
 */
import { crc32, deflateRawSync, inflateRawSync } from 'node:zlib';

export const MAX_FILE = 30 * 1024 * 1024;
const MAX_PART = 120 * 1024 * 1024;

// ---------------------------------------------------------------------------
// ZIP
// ---------------------------------------------------------------------------

/** A ZIP of `files` ([name, string | Buffer]), deflated, its times the DOS time of `when`. */
export function zip(files, when = new Date(0)) {
  const d = new Date(Math.max(when.getTime(), Date.UTC(1980, 0, 1)));
  const time = (d.getUTCHours() << 11) | (d.getUTCMinutes() << 5) | Math.floor(d.getUTCSeconds() / 2);
  const date = ((d.getUTCFullYear() - 1980) << 9) | ((d.getUTCMonth() + 1) << 5) | d.getUTCDate();
  const locals = [];
  const central = [];
  let offset = 0;
  for (const [name, content] of files) {
    const data = Buffer.isBuffer(content) ? content : Buffer.from(content, 'utf8');
    const packed = deflateRawSync(data, { level: 9 });
    const nameBytes = Buffer.from(name, 'utf8');
    const crc = crc32(data);
    const head = Buffer.alloc(30);
    head.writeUInt32LE(0x04034b50, 0);
    head.writeUInt16LE(20, 4);
    head.writeUInt16LE(0x0800, 6);
    head.writeUInt16LE(8, 8);
    head.writeUInt16LE(time, 10);
    head.writeUInt16LE(date, 12);
    head.writeUInt32LE(crc, 14);
    head.writeUInt32LE(packed.length, 18);
    head.writeUInt32LE(data.length, 22);
    head.writeUInt16LE(nameBytes.length, 26);
    locals.push(head, nameBytes, packed);
    const entry = Buffer.alloc(46);
    entry.writeUInt32LE(0x02014b50, 0);
    entry.writeUInt16LE(20, 4);
    entry.writeUInt16LE(20, 6);
    entry.writeUInt16LE(0x0800, 8);
    entry.writeUInt16LE(8, 10);
    entry.writeUInt16LE(time, 12);
    entry.writeUInt16LE(date, 14);
    entry.writeUInt32LE(crc, 16);
    entry.writeUInt32LE(packed.length, 20);
    entry.writeUInt32LE(data.length, 24);
    entry.writeUInt16LE(nameBytes.length, 28);
    entry.writeUInt32LE(offset, 42);
    central.push(entry, nameBytes);
    offset += head.length + nameBytes.length + packed.length;
  }
  const dir = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(files.length, 8);
  end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(dir.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, dir, end]);
}

/** A ZIP's parts by name, each read only when asked for, within the caps. */
export function unzip(buf) {
  if (buf.length > MAX_FILE) throw new Error(`it's ${Math.round(buf.length / 1048576)} MB, and a sheet is at most ${MAX_FILE / 1048576} MB`);
  let end = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 22 - 65535); i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) {
      end = i;
      break;
    }
  }
  if (end < 0) throw new Error("it isn't an XLSX file (no ZIP directory in it)");
  const count = buf.readUInt16LE(end + 10);
  let at = buf.readUInt32LE(end + 16);
  if (count === 0xffff || at === 0xffffffff) throw new Error('it is a ZIP64 file, which a sheet never needs: save it again as .xlsx');
  const parts = new Map();
  for (let n = 0; n < count; n++) {
    if (at + 46 > buf.length || buf.readUInt32LE(at) !== 0x02014b50) throw new Error("its ZIP directory is broken: save it again as .xlsx");
    const flags = buf.readUInt16LE(at + 8);
    const method = buf.readUInt16LE(at + 10);
    const crc = buf.readUInt32LE(at + 16);
    const packed = buf.readUInt32LE(at + 20);
    const size = buf.readUInt32LE(at + 24);
    const nameLength = buf.readUInt16LE(at + 28);
    const extra = buf.readUInt16LE(at + 30) + buf.readUInt16LE(at + 32);
    const local = buf.readUInt32LE(at + 42);
    const name = buf.toString(flags & 0x0800 ? 'utf8' : 'latin1', at + 46, at + 46 + nameLength);
    at += 46 + nameLength + extra;
    parts.set(name.replace(/^\/+/, ''), () => {
      if (flags & 1) throw new Error(`${name} is encrypted: save the sheet without a password`);
      if (size > MAX_PART) throw new Error(`${name} is too large to be a sheet's`);
      if (local + 30 > buf.length || buf.readUInt32LE(local) !== 0x04034b50) throw new Error(`${name} is broken: save the sheet again`);
      const start = local + 30 + buf.readUInt16LE(local + 26) + buf.readUInt16LE(local + 28);
      const raw = buf.subarray(start, start + packed);
      let data;
      if (method === 0) data = raw;
      else if (method === 8) data = inflateRawSync(raw, { maxOutputLength: MAX_PART });
      else throw new Error(`${name} is packed in a way XLSX doesn't use (method ${method})`);
      if (crc32(data) !== crc) throw new Error(`${name} is damaged (its checksum is wrong): save the sheet again`);
      return data;
    });
  }
  return parts;
}

// ---------------------------------------------------------------------------
// XML
// ---------------------------------------------------------------------------

/** Text for XML, with what XML can't hold written as OOXML's _xHHHH_ (and a literal "_x" kept as itself). */
export function xmlText(s) {
  return String(s)
    .replace(/_x([0-9A-Fa-f]{4})_/g, '_x005F_x$1_')
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F￾￿]/g, (c) => `_x${c.charCodeAt(0).toString(16).toUpperCase().padStart(4, '0')}_`)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

const ENTITIES = { lt: '<', gt: '>', amp: '&', quot: '"', apos: "'" };
function unescapeXml(s) {
  return s.replace(/&(#x[0-9A-Fa-f]+|#\d+|\w+);/g, (m, e) => {
    if (e[0] === '#') return String.fromCodePoint(e[1] === 'x' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10));
    if (e in ENTITIES) return ENTITIES[e];
    throw new Error(`it names an XML entity, &${e};, that XLSX never uses`);
  });
}
/** OOXML's own escape for characters XML can't hold: _x000D_ is a carriage return. */
const unescapeOoxml = (s) => s.replace(/_x([0-9A-Fa-f]{4})_/g, (m, h) => String.fromCharCode(parseInt(h, 16)));

/** A light tree of an XML part: { name (local), attrs, children, text }. */
export function parseXml(xml) {
  if (/<!DOCTYPE/i.test(xml)) throw new Error('a part declares a DOCTYPE, which XLSX never does');
  const root = { name: '#root', attrs: {}, children: [], text: '' };
  const stack = [root];
  const token = /<!\[CDATA\[([\s\S]*?)\]\]>|<!--[\s\S]*?-->|<\?[\s\S]*?\?>|<\/([^\s>]+)\s*>|<([^\s>/!?]+)((?:\s+[^\s=>]+\s*=\s*(?:"[^"]*"|'[^']*'))*)\s*(\/?)>|([^<]+)/g;
  let m;
  while ((m = token.exec(xml))) {
    const top = stack[stack.length - 1];
    if (m[1] !== undefined) top.children.push({ name: '#text', text: m[1] });
    else if (m[2] !== undefined) {
      if (stack.length > 1) stack.pop();
    } else if (m[3] !== undefined) {
      const attrs = {};
      for (const [, k, v1, v2] of m[4].matchAll(/([^\s=]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g)) attrs[k] = unescapeXml(v1 ?? v2);
      const el = { name: m[3].split(':').pop(), attrs, children: [], text: '' };
      top.children.push(el);
      if (!m[5]) stack.push(el);
    } else if (m[6] !== undefined && !m[0].startsWith('<')) top.children.push({ name: '#text', text: unescapeXml(m[6]) });
  }
  return root;
}

const kids = (el, name) => el.children.filter((c) => c.name === name);
const kid = (el, name) => el.children.find((c) => c.name === name);
/** An element's text: its own text runs, or its runs' (<r><t>), never its phonetic guides (<rPh>, Japanese Excel's furigana). */
function textOf(el) {
  if (!el) return '';
  let s = '';
  for (const c of el.children) {
    if (c.name === '#text') s += c.text;
    else if (c.name === 't' || c.name === 'r' || c.name === 'is') s += textOf(c);
  }
  return s;
}
const attr = (el, local) => {
  for (const [k, v] of Object.entries(el.attrs)) if (k === local || k.endsWith(`:${local}`)) return v;
  return undefined;
};

// ---------------------------------------------------------------------------
// A workbook, read back
// ---------------------------------------------------------------------------

/** Column letters to their index from 0: "A" 0, "AA" 26. */
export const colIndex = (letters) => [...letters.toUpperCase()].reduce((n, c) => n * 26 + c.charCodeAt(0) - 64, 0) - 1;
/** An index from 0 to its column's letters. */
export const colName = (i) => (i < 26 ? String.fromCharCode(65 + i) : colName(Math.floor(i / 26) - 1) + String.fromCharCode(65 + (i % 26)));

/**
 * Each sheet of a workbook, by name, as rows of cell text: [{ name, rows: Map<row, Map<col, text>> }].
 * A number is its digits; a formula, its last value; a cell's text is OOXML's own, unescaped.
 */
export function readWorkbook(buf) {
  const parts = unzip(buf);
  const part = (name) => {
    const get = parts.get(name);
    return get ? get().toString('utf8') : null;
  };
  const workbook = part('xl/workbook.xml');
  if (!workbook) throw new Error("it isn't an XLSX workbook (no xl/workbook.xml)");
  const rels = new Map();
  const relsXml = parseXml(part('xl/_rels/workbook.xml.rels') ?? '<Relationships/>');
  for (const r of kids(relsXml.children.find((c) => c.name === 'Relationships') ?? { children: [] }, 'Relationship')) {
    const target = r.attrs.Target ?? '';
    rels.set(r.attrs.Id, target.startsWith('/') ? target.slice(1) : `xl/${target}`.replace(/\/\.\//g, '/'));
  }
  const strings = [];
  const sst = part('xl/sharedStrings.xml');
  if (sst) for (const si of kids(parseXml(sst).children.find((c) => c.name === 'sst') ?? { children: [] }, 'si')) strings.push(unescapeOoxml(textOf(si)));
  const wb = parseXml(workbook).children.find((c) => c.name === 'workbook');
  const sheets = [];
  for (const s of kids(kid(wb, 'sheets') ?? { children: [] }, 'sheet')) {
    const target = rels.get(attr(s, 'id'));
    const xml = target && part(target);
    if (!xml) continue;
    const data = kid(parseXml(xml).children.find((c) => c.name === 'worksheet') ?? { children: [] }, 'sheetData');
    const rows = new Map();
    let rowAt = 0;
    for (const row of kids(data ?? { children: [] }, 'row')) {
      rowAt = row.attrs.r ? Number(row.attrs.r) : rowAt + 1;
      const cells = new Map();
      let colAt = -1;
      for (const c of kids(row, 'c')) {
        colAt = c.attrs.r ? colIndex(c.attrs.r.replace(/\d+$/, '')) : colAt + 1;
        const t = c.attrs.t ?? 'n';
        const v = textOf(kid(c, 'v'));
        let text;
        if (t === 's') text = strings[Number(v)] ?? '';
        else if (t === 'inlineStr') text = unescapeOoxml(textOf(kid(c, 'is')));
        else if (t === 'str') text = unescapeOoxml(v);
        else if (t === 'b') text = v === '1' ? 'TRUE' : 'FALSE';
        else text = v;
        if (text !== '') cells.set(colAt, text);
      }
      rows.set(rowAt, cells);
    }
    sheets.push({ name: s.attrs.name, rows });
  }
  return { sheets };
}

// ---------------------------------------------------------------------------
// A workbook, written
// ---------------------------------------------------------------------------

/**
 * Fonts by language, as the format can say a cell's language: a font made for its script, and the
 * Windows charset Excel takes as the text's language when it chooses a fallback (128 Japanese,
 * 129 Korean, 134 Simplified Chinese, 222 Thai, 163 Vietnamese). Han characters are drawn as each
 * language draws them only in that language's font, so Japanese and Chinese never share one.
 */
export const LANGUAGE_FONTS = {
  ja: { name: 'Yu Gothic', charset: 128, line: 18 },
  ko: { name: 'Malgun Gothic', charset: 129, line: 18 },
  zh: { name: 'Microsoft YaHei', charset: 134, line: 18 },
  th: { name: 'Leelawadee UI', charset: 222, line: 20 },
  vi: { name: 'Calibri', charset: 163, line: 15 },
};
const LATIN = { name: 'Calibri', line: 15 };

// Cell styles, by index in cellXfs below.
export const STYLE = { plain: 0, head: 1, english: 2, words: 3, input: 4, key: 5, tier: 6, title: 7, text: 8, label: 9, field: 10, small: 11, wordsInput: 12 };

function stylesXml(locale) {
  const lang = LANGUAGE_FONTS[locale] ?? LATIN;
  const font = (f, { bold = false, size = 11, color = null } = {}) =>
    `<font>${bold ? '<b/>' : ''}<sz val="${size}"/>${color ? `<color rgb="${color}"/>` : ''}<name val="${xmlText(f.name)}"/><family val="2"/>${f.charset ? `<charset val="${f.charset}"/>` : ''}</font>`;
  const fonts = [font(LATIN), font(LATIN, { bold: true }), font(lang), { raw: '<font><sz val="9"/><name val="Consolas"/><family val="3"/></font>' }, font(LATIN, { bold: true, size: 14 }), font(LATIN, { size: 9, color: 'FF6B6B6B' })];
  const top = '<alignment vertical="top" wrapText="1"/>';
  const xf = (fontId, { fill = 0, border = 0, numFmt = 0, align = top, locked = true } = {}) =>
    `<xf numFmtId="${numFmt}" fontId="${fontId}" fillId="${fill}" borderId="${border}" xfId="0" applyFont="1" applyAlignment="1"${fill ? ' applyFill="1"' : ''}${border ? ' applyBorder="1"' : ''}${numFmt ? ' applyNumberFormat="1"' : ''} applyProtection="1">${align}<protection locked="${locked ? 1 : 0}"/></xf>`;
  const xfs = [
    xf(0), // plain
    xf(1, { fill: 2, border: 1 }), // head
    xf(0), // english
    xf(2), // words, in the language's font
    xf(2, { fill: 3, numFmt: 49, locked: false }), // input: suggestion and note, typed as text
    xf(3), // key
    xf(0, { align: '<alignment horizontal="center" vertical="top"/>' }), // tier
    xf(4, { align: '<alignment vertical="top"/>' }), // title
    xf(0), // text
    xf(1), // label
    xf(0, { fill: 3, numFmt: 49, locked: false }), // field on Start here
    xf(5), // small
    xf(2, { fill: 3, numFmt: 49, locked: false }), // an answer or a better word, in the language's font
  ];
  return [
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>',
    '<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">',
    `<fonts count="${fonts.length}">${fonts.map((f) => (typeof f === 'string' ? f : f.raw)).join('')}</fonts>`,
    '<fills count="4"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill>',
    '<fill><patternFill patternType="solid"><fgColor rgb="FFE8E8E8"/><bgColor indexed="64"/></patternFill></fill>',
    '<fill><patternFill patternType="solid"><fgColor rgb="FFFFF6D5"/><bgColor indexed="64"/></patternFill></fill></fills>',
    '<borders count="2"><border><left/><right/><top/><bottom/><diagonal/></border><border><left/><right/><top/><bottom style="thin"><color rgb="FF9E9E9E"/></bottom><diagonal/></border></borders>',
    '<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>',
    `<cellXfs count="${xfs.length}">${xfs.join('')}</cellXfs>`,
    '<cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles>',
    '</styleSheet>',
  ].join('');
}

/** How wide a character is, in a column's units: CJK and full-width take two, Thai's marks none. */
function widthOf(text) {
  let w = 0;
  for (const ch of text) {
    const c = ch.codePointAt(0);
    if ((c >= 0x0e31 && c <= 0x0e3a && c !== 0x0e32 && c !== 0x0e33) || (c >= 0x0e47 && c <= 0x0e4e) || (c >= 0x0300 && c <= 0x036f)) continue;
    w += (c >= 0x1100 && c <= 0x115f) || (c >= 0x2e80 && c <= 0xa4cf) || (c >= 0xac00 && c <= 0xd7a3) || (c >= 0xf900 && c <= 0xfaff) || (c >= 0xff00 && c <= 0xff60) ? 2 : 1;
  }
  return w;
}
/** Lines a wrapped cell takes in a column `width` characters wide. */
export function linesIn(text, width) {
  return String(text)
    .split('\n')
    .reduce((n, line) => n + Math.max(1, Math.ceil((widthOf(line) * 1.1) / Math.max(4, width - 1))), 0);
}

/**
 * A workbook of sheets, each { name, cols: [{ width, hidden }], rows: [[{ v, s }]], freeze, filter,
 * protect, lists: [{ ref, items }], fit }, in `locale` (its fonts, and the file's dc:language).
 */
export function writeWorkbook({ sheets, locale, langTag, title, made }) {
  const strings = [];
  const index = new Map();
  const shared = (s) => {
    if (!index.has(s)) {
      index.set(s, strings.length);
      strings.push(s);
    }
    return index.get(s);
  };
  const langLine = (LANGUAGE_FONTS[locale] ?? LATIN).line;
  const sheetXml = (sheet) => {
    const widths = sheet.cols.map((c) => c.width);
    const out = [];
    sheet.rows.forEach((cells, r) => {
      let lines = 1;
      let line = LATIN.line;
      const xml = cells
        .map((cell, c) => {
          if (!cell || cell.v === undefined || cell.v === null || cell.v === '') return cell?.s !== undefined ? `<c r="${colName(c)}${r + 1}" s="${cell.s}"/>` : '';
          const ref = `${colName(c)}${r + 1}`;
          if (typeof cell.v === 'number') return `<c r="${ref}" s="${cell.s ?? 0}"><v>${cell.v}</v></c>`;
          if (!sheet.cols[c]?.hidden) {
            lines = Math.max(lines, linesIn(cell.v, widths[c] ?? 10));
            if ([STYLE.words, STYLE.input, STYLE.wordsInput].includes(cell.s)) line = Math.max(line, langLine);
          }
          return `<c r="${ref}" s="${cell.s ?? 0}" t="s"><v>${shared(String(cell.v))}</v></c>`;
        })
        .join('');
      const height = Math.min(409, Math.ceil(lines * line + 3));
      out.push(`<row r="${r + 1}"${lines > 1 || line > LATIN.line ? ` ht="${height}" customHeight="1"` : ''}>${xml}</row>`);
    });
    const last = `${colName(Math.max(0, sheet.cols.length - 1))}${Math.max(1, sheet.rows.length)}`;
    return [
      '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>',
      '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">',
      `<sheetPr>${sheet.fit ? '<pageSetUpPr fitToPage="1"/>' : ''}</sheetPr>`,
      `<dimension ref="A1:${last}"/>`,
      '<sheetViews><sheetView workbookViewId="0"',
      sheet.active ? ' tabSelected="1"' : '',
      '>',
      sheet.freeze
        ? `<pane ySplit="${sheet.freeze}" topLeftCell="A${sheet.freeze + 1}" activePane="bottomLeft" state="frozen"/><selection pane="bottomLeft" activeCell="${sheet.select ?? `A${sheet.freeze + 1}`}" sqref="${sheet.select ?? `A${sheet.freeze + 1}`}"/>`
        : `<selection activeCell="${sheet.select ?? 'A1'}" sqref="${sheet.select ?? 'A1'}"/>`,
      '</sheetView></sheetViews>',
      '<sheetFormatPr defaultRowHeight="15"/>',
      `<cols>${sheet.cols.map((c, i) => `<col min="${i + 1}" max="${i + 1}" width="${c.width}" customWidth="1"${c.hidden ? ' hidden="1"' : ''}/>`).join('')}</cols>`,
      `<sheetData>${out.join('')}</sheetData>`,
      sheet.protect ? '<sheetProtection sheet="1" objects="1" scenarios="1" formatCells="1" formatColumns="0" formatRows="0" sort="0" autoFilter="0"/>' : '',
      sheet.filter ? `<autoFilter ref="${sheet.filter}"/>` : '',
      sheet.lists?.length
        ? `<dataValidations count="${sheet.lists.length}">${sheet.lists.map((l) => `<dataValidation type="list" allowBlank="1" showInputMessage="1" showErrorMessage="1" sqref="${l.ref}"><formula1>${xmlText(`"${l.items.join(',')}"`)}</formula1></dataValidation>`).join('')}</dataValidations>`
        : '',
      '<pageMargins left="0.4" right="0.4" top="0.5" bottom="0.5" header="0.3" footer="0.3"/>',
      `<pageSetup paperSize="9" orientation="landscape"${sheet.fit ? ' fitToWidth="1" fitToHeight="0"' : ''}/>`,
      '</worksheet>',
    ].join('');
  };
  const sheetsXml = sheets.map(sheetXml);
  const names = sheets.map((s, i) => [s, i]).filter(([s]) => s.freeze && s.fit);
  const files = [
    [
      '[Content_Types].xml',
      '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>' +
        sheets.map((s, i) => `<Override PartName="/xl/worksheets/sheet${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`).join('') +
        '<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/><Override PartName="/xl/sharedStrings.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sharedStrings+xml"/><Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/><Override PartName="/docProps/app.xml" ContentType="application/vnd.openxmlformats-officedocument.extended-properties+xml"/></Types>',
    ],
    [
      '_rels/.rels',
      '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/><Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/extended-properties" Target="docProps/app.xml"/></Relationships>',
    ],
    [
      'docProps/core.xml',
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"><dc:title>${xmlText(title)}</dc:title><dc:creator>a4a</dc:creator><dc:language>${xmlText(langTag)}</dc:language><dcterms:created xsi:type="dcterms:W3CDTF">${made.toISOString().replace(/\.\d+Z$/, 'Z')}</dcterms:created></cp:coreProperties>`,
    ],
    ['docProps/app.xml', '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties"><Application>a4a</Application></Properties>'],
    [
      'xl/workbook.xml',
      '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><bookViews><workbookView activeTab="0"/></bookViews><sheets>' +
        sheets.map((s, i) => `<sheet name="${xmlText(s.name)}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`).join('') +
        '</sheets>' +
        (names.length || sheets.some((s) => s.filter)
          ? `<definedNames>${sheets
              .map((s, i) => (s.filter ? `<definedName name="_xlnm._FilterDatabase" localSheetId="${i}" hidden="1">'${xmlText(s.name)}'!$${s.filter.replace(':', ':$').replace(/(\d+)/g, '$$$1')}</definedName>` : ''))
              .join('')}${names.map(([s, i]) => `<definedName name="_xlnm.Print_Titles" localSheetId="${i}">'${xmlText(s.name)}'!$1:$${s.freeze}</definedName>`).join('')}</definedNames>`
          : '') +
        '</workbook>',
    ],
    [
      'xl/_rels/workbook.xml.rels',
      '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
        sheets.map((s, i) => `<Relationship Id="rId${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`).join('') +
        `<Relationship Id="rId${sheets.length + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/><Relationship Id="rId${sheets.length + 2}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/sharedStrings" Target="sharedStrings.xml"/></Relationships>`,
    ],
    ['xl/styles.xml', stylesXml(locale)],
    ...sheetsXml.map((x, i) => [`xl/worksheets/sheet${i + 1}.xml`, x]),
  ];
  const sst = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" count="${strings.length}" uniqueCount="${strings.length}">${strings
    .map((s) => `<si><t${/^\s|\s$|\n/.test(s) ? ' xml:space="preserve"' : ''}>${xmlText(s)}</t></si>`)
    .join('')}</sst>`;
  files.push(['xl/sharedStrings.xml', sst]);
  return zip(files, made);
}
