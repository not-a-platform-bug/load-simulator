// Seeded PRNG (xoshiro128**). All randomness in the engine flows through this so runs are deterministic.

export class Rng {
  private a: number;
  private b: number;
  private c: number;
  private d: number;

  constructor(seed: number | string) {
    let h = typeof seed === 'number' ? seed >>> 0 : hashString(seed);
    const next = () => {
      // splitmix32 for state initialisation
      h = (h + 0x9e3779b9) | 0;
      let z = h;
      z = Math.imul(z ^ (z >>> 16), 0x85ebca6b);
      z = Math.imul(z ^ (z >>> 13), 0xc2b2ae35);
      return (z ^ (z >>> 16)) >>> 0;
    };
    this.a = next();
    this.b = next();
    this.c = next();
    this.d = next();
  }

  /** uniform [0, 1) */
  next(): number {
    const r = Math.imul(rotl(Math.imul(this.b, 5), 7), 9);
    const t = this.b << 9;
    this.c ^= this.a;
    this.d ^= this.b;
    this.b ^= this.c;
    this.a ^= this.d;
    this.c ^= t;
    this.d = rotl(this.d, 11);
    return (r >>> 0) / 4294967296;
  }

  /** Derive an independent stream, e.g. one per component, so adding a component doesn't reshuffle others. */
  fork(label: string): Rng {
    return new Rng((hashString(label) ^ Math.floor(this.next() * 4294967296)) >>> 0);
  }

  normal(): number {
    let u = 0;
    while (u === 0) u = this.next();
    const v = this.next();
    return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
  }

  exp(mean: number): number {
    return -Math.log(1 - this.next()) * mean;
  }

  chance(p: number): boolean {
    return p > 0 && this.next() < p;
  }
}

function rotl(x: number, k: number): number {
  return (x << k) | (x >>> (32 - k));
}

export function hashString(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}
