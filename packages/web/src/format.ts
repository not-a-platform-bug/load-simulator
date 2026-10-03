export function ms(v: number): string {
  if (v === undefined || Number.isNaN(v)) return '—';
  if (!Number.isFinite(v)) return '∞';
  if (v >= 10_000) return `${(v / 1000).toFixed(0)}s`;
  if (v >= 1000) return `${(v / 1000).toFixed(1)}s`;
  if (v >= 10) return `${v.toFixed(0)}ms`;
  return `${v.toFixed(1)}ms`;
}

export function pct(v: number, digits = 1): string {
  if (v === undefined || Number.isNaN(v)) return '—';
  if (v > 0 && v < 0.001) return '<0.1%';
  return `${(v * 100).toFixed(digits)}%`;
}

export function num(v: number): string {
  if (v === undefined || Number.isNaN(v)) return '—';
  if (v >= 10_000) return `${(v / 1000).toFixed(1)}k`;
  return v >= 100 ? v.toFixed(0) : v.toFixed(v >= 10 ? 1 : 2).replace(/\.?0+$/, '');
}

/** Parse "3s" / "500ms" / 1200 into ms (UI side, mirrors engine units). */
export function toMs(v: unknown, d = 0): number {
  if (v === undefined || v === null || v === '') return d;
  if (typeof v === 'number') return v;
  const m = /^\s*([\d.]+)\s*(us|ms|s|m|min|h)?\s*$/.exec(String(v));
  if (!m) return d;
  const k: Record<string, number> = { us: 0.001, ms: 1, s: 1000, m: 60000, min: 60000, h: 3600000 };
  return Number(m[1]) * k[m[2] ?? 'ms'];
}

export function fmtDur(msv: number): string {
  if (msv >= 1000 && msv % 1000 === 0) return `${msv / 1000}s`;
  if (msv >= 1000) return `${+(msv / 1000).toFixed(2)}s`;
  return `${+msv.toFixed(2)}ms`;
}

/** Parse "0.1%" / 0.001 / 50 (percent) into a 0..1 ratio. */
export function toRatio(v: unknown, d = 0, numbersArePercent = false): number {
  if (v === undefined || v === null || v === '') return d;
  if (typeof v === 'number') return numbersArePercent || v > 1 ? v / 100 : v;
  const s = String(v).trim();
  if (s.endsWith('%')) return Number(s.slice(0, -1)) / 100;
  const n = Number(s);
  return numbersArePercent || n > 1 ? n / 100 : n;
}

export function toMb(v: unknown, d = 1024): number {
  if (v === undefined || v === null) return d;
  if (typeof v === 'number') return v;
  const m = /^\s*([\d.]+)\s*([kmg]b?|b)?\s*$/i.exec(String(v));
  if (!m) return d;
  const u = (m[2] ?? 'm').toLowerCase()[0];
  return Number(m[1]) * (u === 'g' ? 1024 : u === 'k' ? 1 / 1024 : u === 'b' ? 1 / 1024 / 1024 : 1);
}
