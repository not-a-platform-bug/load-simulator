// Shared helpers for importers. Importers take strings/objects (no file system) so they run in the browser too.
import type { RawDoc } from '../parse';

/** Spring durations: "10s", "500ms", "PT1.5S", "1m", or a bare number in `unit` (Spring defaults vary: ms or s). */
export function springDuration(v: unknown, unit: 'ms' | 's' = 'ms'): number | undefined {
  if (v === undefined || v === null || v === '') return undefined;
  if (typeof v === 'number') return unit === 's' ? v * 1000 : v;
  const s = String(v).trim();
  const iso = /^P(?:T)?(?:(\d+(?:\.\d+)?)H)?(?:(\d+(?:\.\d+)?)M)?(?:(\d+(?:\.\d+)?)S)?$/i.exec(s);
  if (iso && s.toUpperCase().startsWith('PT')) return (Number(iso[1] ?? 0) * 3600 + Number(iso[2] ?? 0) * 60 + Number(iso[3] ?? 0)) * 1000;
  const m = /^(\d+(?:\.\d+)?)\s*(ns|us|ms|s|m|h|d)?$/i.exec(s);
  if (!m) return undefined;
  const k: Record<string, number> = { ns: 1e-6, us: 1e-3, ms: 1, s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000 };
  return Number(m[1]) * k[(m[2] ?? unit).toLowerCase()];
}

export function fmtDuration(ms: number): string {
  if (ms >= 1000 && Number.isInteger(ms / 1000)) return `${ms / 1000}s`;
  if (ms >= 1) return `${+ms.toFixed(2)}ms`;
  return `${+(ms * 1000).toFixed(0)}us`;
}

/** Read a Spring property allowing relaxed binding (kebab, camel, snake) along a dotted path. */
export function prop(obj: any, path: string): any {
  let o = obj;
  for (const part of path.split('.')) {
    if (o == null || typeof o !== 'object') return undefined;
    const variants = [part, part.replace(/-([a-z])/g, (_, c) => c.toUpperCase()), part.replace(/-/g, '_'), part.replace(/-/g, '')];
    const key = Object.keys(o).find((k) => variants.includes(k) || k.toLowerCase().replace(/[-_]/g, '') === part.toLowerCase().replace(/[-_]/g, ''));
    o = key === undefined ? undefined : o[key];
  }
  return o;
}

/** Flatten "a.b.c: 1" style keys (Spring allows both nested and dotted) into nested objects. */
export function expandDotted(o: any): any {
  if (Array.isArray(o)) return o.map(expandDotted);
  if (o === null || typeof o !== 'object') return o;
  const out: any = {};
  for (const [k, v] of Object.entries(o)) {
    const parts = k.split('.');
    let cur = out;
    for (let i = 0; i < parts.length - 1; i++) cur = cur[parts[i]] ??= {};
    const last = parts[parts.length - 1];
    const val = expandDotted(v);
    cur[last] = cur[last] && typeof cur[last] === 'object' && typeof val === 'object' ? deepMerge(cur[last], val) : val;
  }
  return out;
}

export function deepMerge<T extends Record<string, any>>(base: T, over: Record<string, any>): T {
  const out: any = Array.isArray(base) ? [...base] : { ...base };
  for (const [k, v] of Object.entries(over)) {
    if (v === undefined) continue;
    if (v && typeof v === 'object' && !Array.isArray(v) && out[k] && typeof out[k] === 'object' && !Array.isArray(out[k])) out[k] = deepMerge(out[k], v);
    else out[k] = v;
  }
  return out;
}

export function quantiles(values: number[]): { p50: number; p99: number; count: number } {
  const v = [...values].sort((a, b) => a - b);
  const q = (p: number) => v[Math.min(v.length - 1, Math.max(0, Math.ceil(p * v.length) - 1))];
  return { p50: q(0.5), p99: q(0.99), count: v.length };
}

export function distOf(values: number[]): { p50: string; p99: string } | string {
  const { p50, p99 } = quantiles(values);
  const lo = Math.max(p50, 0.01);
  if (p99 <= lo * 1.05) return fmtDuration(lo);
  return { p50: fmtDuration(lo), p99: fmtDuration(Math.max(p99, lo)) };
}

/** A partial document: any subset of nodes / edges / scenario. */
export type DocPatch = Partial<RawDoc>;

export interface ImportReport {
  doc: DocPatch;
  /** human readable notes about what was found or guessed */
  notes: string[];
}

export function slug(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/^-+|-+$/g, '') || 'node';
}
