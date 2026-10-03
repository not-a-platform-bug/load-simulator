import { Rng } from './rng';
import { time } from './units';

/** A latency/size distribution. Values are in ms for time distributions. */
export type Dist =
  | { kind: 'const'; value: number }
  | { kind: 'exp'; mean: number }
  | { kind: 'lognormal'; mu: number; sigma: number }
  | { kind: 'uniform'; min: number; max: number };

const Z99 = 2.3263478740408408;

/**
 * Accepts:
 *   "8ms" | 8                                  → constant
 *   { dist: lognormal, p50: 8ms, p99: 40ms }   → lognormal fitted to two quantiles
 *   { dist: lognormal, mean: 10ms, sigma: 0.5 }
 *   { dist: exp, mean: 5ms }
 *   { dist: uniform, min: 1ms, max: 3ms }
 *   { dist: const, value: 5ms }
 */
export function parseDist(v: unknown, convert: (x: unknown) => number = (x) => time(x)): Dist {
  if (v === undefined || v === null) throw new Error('분포가 비어 있습니다');
  if (typeof v === 'number' || typeof v === 'string') return { kind: 'const', value: convert(v) };
  const o = v as Record<string, unknown>;
  const kind = String(o.dist ?? (o.p50 !== undefined ? 'lognormal' : o.mean !== undefined ? 'exp' : 'const'));
  switch (kind) {
    case 'const':
    case 'fixed':
      return { kind: 'const', value: convert(o.value ?? o.p50 ?? o.mean) };
    case 'exp':
    case 'exponential':
      return { kind: 'exp', mean: convert(o.mean) };
    case 'uniform':
      return { kind: 'uniform', min: convert(o.min), max: convert(o.max) };
    case 'lognormal': {
      if (o.p50 !== undefined) {
        const p50 = convert(o.p50);
        const p99 = o.p99 !== undefined ? convert(o.p99) : p50 * 3;
        const mu = Math.log(Math.max(p50, 1e-9));
        const sigma = p99 > p50 ? Math.log(p99 / p50) / Z99 : 0;
        return { kind: 'lognormal', mu, sigma };
      }
      const mean = convert(o.mean);
      const sigma = Number(o.sigma ?? 0.5);
      return { kind: 'lognormal', mu: Math.log(mean) - (sigma * sigma) / 2, sigma };
    }
    default:
      throw new Error(`알 수 없는 분포: "${kind}"`);
  }
}

export function sample(d: Dist, rng: Rng): number {
  switch (d.kind) {
    case 'const':
      return d.value;
    case 'exp':
      return rng.exp(d.mean);
    case 'uniform':
      return d.min + (d.max - d.min) * rng.next();
    case 'lognormal':
      return d.sigma === 0 ? Math.exp(d.mu) : Math.exp(d.mu + d.sigma * rng.normal());
  }
}

export function mean(d: Dist): number {
  switch (d.kind) {
    case 'const':
      return d.value;
    case 'exp':
      return d.mean;
    case 'uniform':
      return (d.min + d.max) / 2;
    case 'lognormal':
      return Math.exp(d.mu + (d.sigma * d.sigma) / 2);
  }
}

export function quantile(d: Dist, q: number): number {
  switch (d.kind) {
    case 'const':
      return d.value;
    case 'exp':
      return -Math.log(1 - q) * d.mean;
    case 'uniform':
      return d.min + (d.max - d.min) * q;
    case 'lognormal':
      return Math.exp(d.mu + d.sigma * normInv(q));
  }
}

/** Acklam's approximation of the inverse standard normal CDF. */
function normInv(p: number): number {
  const a = [-39.6968302866538, 220.946098424521, -275.928510446969, 138.357751867269, -30.6647980661472, 2.50662827745924];
  const b = [-54.4760987982241, 161.585836858041, -155.698979859887, 66.8013118877197, -13.2806815528857];
  const c = [-0.00778489400243029, -0.322396458041136, -2.40075827716184, -2.54973253934373, 4.37466414146497, 2.93816398269878];
  const dd = [0.00778469570904146, 0.32246712907004, 2.445134137143, 3.75440866190742];
  const pl = 0.02425;
  if (p < pl) {
    const q = Math.sqrt(-2 * Math.log(p));
    return (((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) / ((((dd[0] * q + dd[1]) * q + dd[2]) * q + dd[3]) * q + 1);
  }
  if (p > 1 - pl) {
    const q = Math.sqrt(-2 * Math.log(1 - p));
    return -(((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) / ((((dd[0] * q + dd[1]) * q + dd[2]) * q + dd[3]) * q + 1);
  }
  const q = p - 0.5;
  const r = q * q;
  return ((((((a[0] * r + a[1]) * r + a[2]) * r + a[3]) * r + a[4]) * r + a[5]) * q) / (((((b[0] * r + b[1]) * r + b[2]) * r + b[3]) * r + b[4]) * r + 1);
}
