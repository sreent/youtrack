/**
 * The Teams app package an administrator uploads in Teams' admin center (D42): a manifest naming the
 * bot and a4a's address, and its two icons, zipped. Made here, so it always names this a4a's bot.
 */
import { crc32, deflateSync } from 'node:zlib';
import { APP_FULL_NAME, APP_NAME } from '@a4a/shared';
import tokens from '@sreent/ocean/tokens.json' with { type: 'json' };
import type { AppServices } from '../context';
import { notFound } from '../lib/errors';

/** Ocean's blue for what someone can do, as Teams' accent colour and the icon's ground. */
function accent(): string {
  const t = (tokens as { color?: { tokens?: { name: string; value?: string }[] } }).color?.tokens?.find((x) => x.name === 'ocean-600');
  return /^#[0-9a-f]{6}$/i.test(t?.value ?? '') ? t!.value! : '#1d5fb0';
}

const rgb = (hex: string): [number, number, number] => [parseInt(hex.slice(1, 3), 16), parseInt(hex.slice(3, 5), 16), parseInt(hex.slice(5, 7), 16)];

function chunk(type: string, data: Buffer): Buffer {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

/** A PNG, RGBA, from a function giving each pixel. */
function png(size: number, pixel: (x: number, y: number) => [number, number, number, number]): Buffer {
  const raw = Buffer.alloc((size * 4 + 1) * size);
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0;
    for (let x = 0; x < size; x++) raw.set(pixel(x, y), y * (size * 4 + 1) + 1 + x * 4);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr.set([8, 6, 0, 0, 0], 8);
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}

/** a4a's mark: a ring, with a dot at its centre. */
function mark(size: number, x: number, y: number): number {
  const c = (size - 1) / 2;
  const d = Math.hypot(x - c, y - c) / size;
  const ring = Math.abs(d - 0.3) < 0.055;
  const dot = d < 0.09;
  return ring || dot ? 255 : 0;
}

export function teamsIcons(): { color: Buffer; outline: Buffer } {
  const [r, g, b] = rgb(accent());
  const color = png(192, (x, y) => (mark(192, x, y) ? [255, 255, 255, 255] : [r, g, b, 255]));
  // Teams' outline icon: white on transparent, 32 by 32.
  const outline = png(32, (x, y) => [255, 255, 255, mark(32, x, y)]);
  return { color, outline };
}

/** A zip of files stored as they are: what Teams' admin center takes. */
export function zip(files: { name: string; data: Buffer }[]): Buffer {
  const locals: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;
  for (const f of files) {
    const name = Buffer.from(f.name, 'utf8');
    const crc = crc32(f.data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6);
    local.writeUInt16LE(0, 8);
    local.writeUInt16LE(0, 10);
    local.writeUInt16LE(0x21, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(f.data.length, 18);
    local.writeUInt32LE(f.data.length, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28);
    locals.push(local, name, f.data);
    const dir = Buffer.alloc(46);
    dir.writeUInt32LE(0x02014b50, 0);
    dir.writeUInt16LE(20, 4);
    dir.writeUInt16LE(20, 6);
    dir.writeUInt16LE(0x0800, 8);
    dir.writeUInt16LE(0, 10);
    dir.writeUInt16LE(0, 12);
    dir.writeUInt16LE(0x21, 14);
    dir.writeUInt32LE(crc, 16);
    dir.writeUInt32LE(f.data.length, 20);
    dir.writeUInt32LE(f.data.length, 24);
    dir.writeUInt16LE(name.length, 28);
    dir.writeUInt32LE(offset, 42);
    central.push(dir, name);
    offset += 30 + name.length + f.data.length;
  }
  const dirSize = central.reduce((n, b) => n + b.length, 0);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(files.length, 8);
  end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(dirSize, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, ...central, end]);
}

/** The manifest for this a4a's bot (Teams' app manifest, version 1.17). */
export function teamsManifest(app: AppServices): Record<string, unknown> {
  const cfg = app.config.teams;
  if (!cfg) throw notFound('Teams bot', 'Set TEAMS_APP_ID, TEAMS_APP_PASSWORD and TEAMS_TENANT_ID first.').said('chat.teamsBotNotSetUp');
  const site = app.config.publicUrl;
  const host = new URL(site).hostname;
  const commands = [
    { title: 'help', description: 'What I understand' },
    { title: 'search', description: 'Find issues with the query language' },
    { title: 'new', description: 'Report an issue: new BACK The export times out' },
    { title: 'subscribe', description: 'Tell this channel of a project’s issues: subscribe BACK' },
    { title: 'link', description: 'Link your Teams account to your a4a account' },
  ];
  return {
    $schema: 'https://developer.microsoft.com/json-schemas/teams/v1.17/MicrosoftTeams.schema.json',
    manifestVersion: '1.17',
    version: '1.0.0',
    id: cfg.appId,
    developer: { name: APP_NAME, websiteUrl: site, privacyUrl: site, termsOfUseUrl: site },
    name: { short: APP_NAME, full: `${APP_NAME}: ${APP_FULL_NAME}` },
    description: {
      short: 'Your issues, in Teams: their news in channels, and changes as you.',
      full: 'a4a tells the channels you subscribe of new issues, state changes, assignments and comments, and lets you report, find and change issues by talking to it, as yourself.',
    },
    icons: { color: 'color.png', outline: 'outline.png' },
    accentColor: accent(),
    bots: [{ botId: cfg.appId, scopes: ['personal', 'team', 'groupChat'], supportsFiles: false, isNotificationOnly: false, commandLists: [{ scopes: ['personal', 'team', 'groupChat'], commands }] }],
    permissions: ['identity', 'messageTeamMembers'],
    validDomains: [host],
  };
}

/** The package, zipped. */
export function teamsAppPackage(app: AppServices): Buffer {
  const icons = teamsIcons();
  return zip([
    { name: 'manifest.json', data: Buffer.from(JSON.stringify(teamsManifest(app), null, 2)) },
    { name: 'color.png', data: icons.color },
    { name: 'outline.png', data: icons.outline },
  ]);
}
