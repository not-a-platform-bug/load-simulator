// Parsing of human-friendly quantities used in the YAML model.
// Internal units: time = milliseconds, size = bytes, memory = megabytes, rate = per second, ratio = 0..1.

const TIME: Record<string, number> = { us: 0.001, ms: 1, s: 1000, m: 60_000, min: 60_000, h: 3_600_000 };
const SIZE: Record<string, number> = { b: 1, kb: 1024, k: 1024, mb: 1024 ** 2, m: 1024 ** 2, gb: 1024 ** 3, g: 1024 ** 3 };

function split(input: string): [number, string] {
  const m = /^\s*(-?[\d.]+(?:e[-+]?\d+)?)\s*([a-zA-Z%/]*)\s*$/.exec(input);
  if (!m) throw new Error(`숫자를 해석할 수 없습니다: "${input}"`);
  return [Number(m[1]), m[2].toLowerCase()];
}

/** "8ms", "2s", 1500 (bare number = ms) → ms */
export function time(v: unknown, fallbackUnit = 'ms'): number {
  if (v === undefined || v === null) return NaN;
  if (typeof v === 'number') return v * TIME[fallbackUnit];
  if (v === 'none' || v === 'infinite' || v === 'inf') return Infinity;
  const [n, u] = split(String(v));
  const k = TIME[u || fallbackUnit];
  if (k === undefined) throw new Error(`알 수 없는 시간 단위: "${v}"`);
  return n * k;
}

/** "500rps", "500", 500 → 500 per second */
export function rate(v: unknown): number {
  if (typeof v === 'number') return v;
  const [n, u] = split(String(v));
  if (u === '' || u === 'rps' || u === '/s' || u === 'qps') return n;
  if (u === 'rpm' || u === '/m') return n / 60;
  throw new Error(`알 수 없는 처리율 단위: "${v}"`);
}

/** "0.1%" → 0.001, 0.25 → 0.25, 50 (number > 1 for a percentage field) → 0.5 */
export function ratio(v: unknown, numbersArePercent = false): number {
  if (typeof v === 'number') return numbersArePercent || v > 1 ? v / 100 : v;
  const [n, u] = split(String(v));
  if (u === '%') return n / 100;
  if (u === '') return numbersArePercent || n > 1 ? n / 100 : n;
  throw new Error(`비율을 해석할 수 없습니다: "${v}"`);
}

/** "2g", "512m", 2048 (bare number = MB) → MB */
export function memoryMb(v: unknown): number {
  if (typeof v === 'number') return v;
  const [n, u] = split(String(v));
  if (u === '') return n;
  const k = SIZE[u];
  if (k === undefined) throw new Error(`알 수 없는 메모리 단위: "${v}"`);
  return (n * k) / 1024 ** 2;
}

/** "4kb", 512 (bare number = bytes) → bytes */
export function bytes(v: unknown): number {
  if (typeof v === 'number') return v;
  const [n, u] = split(String(v));
  const k = SIZE[u || 'b'];
  if (k === undefined) throw new Error(`알 수 없는 크기 단위: "${v}"`);
  return n * k;
}

/** "100mbps", "1gbps", 100 (bare number = Mbps) → bytes per ms */
export function bandwidth(v: unknown): number {
  let mbps: number;
  if (typeof v === 'number') mbps = v;
  else {
    const [n, u] = split(String(v));
    if (u === '' || u === 'mbps') mbps = n;
    else if (u === 'gbps') mbps = n * 1000;
    else if (u === 'kbps') mbps = n / 1000;
    else throw new Error(`알 수 없는 대역폭 단위: "${v}"`);
  }
  return (mbps * 1_000_000) / 8 / 1000;
}

export function fmtMs(ms: number): string {
  if (!Number.isFinite(ms)) return '∞';
  if (ms >= 10_000) return `${(ms / 1000).toFixed(0)}s`;
  if (ms >= 1000) return `${(ms / 1000).toFixed(1)}s`;
  if (ms >= 10) return `${ms.toFixed(0)}ms`;
  return `${ms.toFixed(1)}ms`;
}
