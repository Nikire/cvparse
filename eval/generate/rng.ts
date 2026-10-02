/**
 * Seeded pseudo-random numbers for the dataset generator. Never use Math.random in eval/generate:
 * every value must come from an {@link Rng} so that regenerating the dataset is byte-identical.
 */

/** mulberry32: tiny, fast, good enough for synthetic data. Returns floats in [0, 1). */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** FNV-1a 32-bit hash, used to derive per-entry seeds from stable strings. */
export function hashString(text: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

export class Rng {
  private readonly next: () => number;

  constructor(seed: number | string) {
    this.next = mulberry32(typeof seed === "string" ? hashString(seed) : seed);
  }

  /** Float in [0, 1). */
  float(): number {
    return this.next();
  }

  /** Integer in [min, max] (inclusive). */
  int(min: number, max: number): number {
    return min + Math.floor(this.next() * (max - min + 1));
  }

  chance(probability: number): boolean {
    return this.next() < probability;
  }

  pick<T>(items: readonly T[]): T {
    if (items.length === 0) throw new Error("pick() on an empty list");
    return items[Math.floor(this.next() * items.length)] as T;
  }

  /** Fisher-Yates on a copy. */
  shuffle<T>(items: readonly T[]): T[] {
    const out = [...items];
    for (let i = out.length - 1; i > 0; i--) {
      const j = Math.floor(this.next() * (i + 1));
      [out[i], out[j]] = [out[j] as T, out[i] as T];
    }
    return out;
  }

  /** `count` distinct items (or all of them when the list is shorter). */
  sample<T>(items: readonly T[], count: number): T[] {
    return this.shuffle(items).slice(0, Math.min(count, items.length));
  }

  /** Random digit string of the given length (first digit may be restricted). */
  digits(length: number, firstFrom = 0): string {
    let out = String(this.int(firstFrom, 9));
    for (let i = 1; i < length; i++) out += String(this.int(0, 9));
    return out;
  }
}
