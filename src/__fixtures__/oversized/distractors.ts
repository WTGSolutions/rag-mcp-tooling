// Diverse small utilities (TASK-030 distractor corpus).
//
// Normal-sized single-chunk functions providing realistic top-5 competition,
// including topical neighbours of the colour-conversion and string tails so a
// truncated head embedding does not falsely rank for a tail query. Not A/B targets.

export function parseHexColor(hex: string): { r: number; g: number; b: number } | null {
  // Parse a #RRGGBB / #RGB hex colour string into 8-bit RGB channels.
  const cleaned = hex.trim().replace(/^#/, '');
  const expanded = cleaned.length === 3 ? cleaned.split('').map((c) => c + c).join('') : cleaned;
  if (!/^[0-9a-fA-F]{6}$/.test(expanded)) return null;
  return {
    r: parseInt(expanded.slice(0, 2), 16),
    g: parseInt(expanded.slice(2, 4), 16),
    b: parseInt(expanded.slice(4, 6), 16),
  };
}

export function relativeLuminance(r: number, g: number, b: number): number {
  // WCAG relative luminance of an sRGB colour, channels in 0..255.
  const channel = (v: number): number => {
    const s = v / 255;
    return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
  };
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
}

export function clamp(value: number, lo: number, hi: number): number {
  // Constrain a value to the inclusive [lo, hi] range.
  return Math.max(lo, Math.min(hi, value));
}

export function slugify(text: string): string {
  // Turn arbitrary text into a url-safe lowercase slug.
  return text
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

export function chunkArray<T>(items: T[], size: number): T[][] {
  // Split an array into consecutive chunks of at most `size` elements.
  if (size <= 0) throw new Error('chunk size must be positive');
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) {
    out.push(items.slice(i, i + size));
  }
  return out;
}

export function groupBy<T, K extends string>(items: T[], keyFn: (item: T) => K): Record<K, T[]> {
  // Group array elements into a record keyed by a derived key.
  const out = {} as Record<K, T[]>;
  for (const item of items) {
    const key = keyFn(item);
    (out[key] ??= []).push(item);
  }
  return out;
}
