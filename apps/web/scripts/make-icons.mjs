// Draws a4a's app icons (D47) from its mark, the favicon's: the first two characters of its name
// on Ocean's accent square, in IBM Plex Sans from Ocean's own fonts. Run it when the mark changes:
//
//   node apps/web/scripts/make-icons.mjs
//
// It writes apps/web/public/icons/: the icon at the sizes Android and iOS ask for, a maskable one
// (the mark within the middle 80%, the square to the edges), and a monochrome badge for Android's
// status bar. Chromium draws them, so the letters are the font's, not an approximation.
import { mkdirSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const out = path.join(here, '..', 'public', 'icons');
mkdirSync(out, { recursive: true });
const require = createRequire(import.meta.url);
// Ocean, where it really is (as vite.config.ts finds it): css/tokens.css is two folders in.
const fonts = path.join(path.dirname(path.dirname(require.resolve('@sreent/ocean/tokens.css'))), 'fonts');
const font = readFileSync(path.join(fonts, 'plex-sans-600.woff2')).toString('base64');
const { chromium } = require('playwright');

const ACCENT = '#1d5fb0'; // Ocean's --accent in light (ocean-600), the favicon's square
const TEXT = '#ffffff';

/** The mark: the square at `inset` from each edge with corners of `radius`, the letters at `size`. */
function mark({ px, inset = 0, radius = 0.22, letters = 0.47, square = ACCENT, ink = TEXT, background = 'transparent' }) {
  const side = px * (1 - 2 * inset);
  return `<!doctype html><html><head><style>
    @font-face { font-family: Plex; font-weight: 600; src: url(data:font/woff2;base64,${font}) format('woff2'); }
    html, body { margin: 0; width: ${px}px; height: ${px}px; background: ${background}; }
    .m { position: absolute; left: ${px * inset}px; top: ${px * inset}px; width: ${side}px; height: ${side}px;
         border-radius: ${side * radius}px; background: ${square}; color: ${ink}; display: grid; place-items: center;
         font: 600 ${side * letters}px/1 Plex; letter-spacing: -0.02em; }
  </style></head><body><div class="m">a4</div></body></html>`;
}

const icons = [
  // Square-cornered and transparent around: what a launcher draws as it is.
  { name: 'icon-192.png', px: 192, html: mark({ px: 192, inset: 0.04 }) },
  { name: 'icon-512.png', px: 512, html: mark({ px: 512, inset: 0.04 }) },
  // Maskable: the platform cuts its own shape, so the square reaches the edges and the letters keep to the middle.
  { name: 'maskable-512.png', px: 512, html: mark({ px: 512, inset: 0, radius: 0, letters: 0.36, background: ACCENT }) },
  { name: 'maskable-192.png', px: 192, html: mark({ px: 192, inset: 0, radius: 0, letters: 0.36, background: ACCENT }) },
  // iOS rounds the corners itself and doesn't do transparency: the square, full.
  { name: 'apple-touch-icon.png', px: 180, html: mark({ px: 180, inset: 0, radius: 0, letters: 0.42, background: ACCENT }) },
  // Android's status bar draws the badge's shape in one colour: white letters, nothing else.
  { name: 'badge-96.png', px: 96, html: mark({ px: 96, inset: 0, radius: 0, letters: 0.62, square: 'transparent' }) },
];

const browser = await chromium.launch();
try {
  const page = await browser.newPage();
  for (const icon of icons) {
    await page.setViewportSize({ width: icon.px, height: icon.px });
    await page.setContent(icon.html);
    await page.evaluate(() => document.fonts.ready);
    await page.screenshot({ path: path.join(out, icon.name), omitBackground: true });
    console.log(`  ${icon.name} (${icon.px}px)`);
  }
} finally {
  await browser.close();
}
