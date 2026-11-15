import { randomBytes } from 'node:crypto';

const ALPHABET = '0123456789abcdefghijklmnopqrstuvwxyz';

/** Short random id (16 chars, base36). */
export function newId(size = 16): string {
  const bytes = randomBytes(size);
  let out = '';
  for (let i = 0; i < size; i++) out += ALPHABET[bytes[i]! % ALPHABET.length];
  return out;
}

const PALETTE = [
  '#2563eb',
  '#7c3aed',
  '#db2777',
  '#dc2626',
  '#ea580c',
  '#ca8a04',
  '#16a34a',
  '#0d9488',
  '#0891b2',
  '#4f46e5',
];

export function colorFor(seed: string): string {
  let h = 0;
  for (let i = 0; i < seed.length; i++) h = (h * 31 + seed.charCodeAt(i)) >>> 0;
  return PALETTE[h % PALETTE.length]!;
}
