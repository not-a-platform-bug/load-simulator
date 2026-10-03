// Simulation vs. real load test: per-metric error against the accuracy targets in docs/accuracy.md.
import { rankSaturation } from './capacity';
import type { SimResult } from './types';

export interface Measured {
  /** SLO-limit RPS found by the real test (optional) */
  capacityRps?: number;
  throughput?: number;
  p50?: number;
  p99?: number;
  errorRate?: number;
  /** resource id or a node name, e.g. "payment->payment-db:pool" or "order:cpu" */
  firstBottleneck?: string;
  /** seconds from start when a breaker first opened */
  cbOpenAt?: number;
}

export interface ComparisonRow {
  metric: string;
  simulated: number | string;
  measured: number | string;
  error: string;
  target: string;
  pass: boolean | null;
}

const relErr = (sim: number, meas: number) => (meas === 0 ? (sim === 0 ? 0 : Infinity) : (sim - meas) / meas);

export function compareWithMeasurement(sim: SimResult, measured: Measured, simCapacityRps?: number): ComparisonRow[] {
  const rows: ComparisonRow[] = [];
  const pct = (e: number) => `${e >= 0 ? '+' : ''}${(e * 100).toFixed(1)}%`;
  if (measured.capacityRps !== undefined && simCapacityRps !== undefined) {
    const e = relErr(simCapacityRps, measured.capacityRps);
    rows.push({ metric: 'SLO 한계 RPS', simulated: simCapacityRps, measured: measured.capacityRps, error: pct(e), target: '±10%', pass: Math.abs(e) <= 0.1 });
  }
  if (measured.throughput !== undefined) {
    const e = relErr(sim.summary.throughput, measured.throughput);
    rows.push({ metric: '처리량 (rps)', simulated: +sim.summary.throughput.toFixed(1), measured: measured.throughput, error: pct(e), target: '±10%', pass: Math.abs(e) <= 0.1 });
  }
  if (measured.p50 !== undefined) {
    const e = relErr(sim.summary.p50, measured.p50);
    rows.push({ metric: 'p50 (ms)', simulated: +sim.summary.p50.toFixed(1), measured: measured.p50, error: pct(e), target: '±15%', pass: Math.abs(e) <= 0.15 });
  }
  if (measured.p99 !== undefined) {
    const e = relErr(sim.summary.p99, measured.p99);
    rows.push({ metric: 'p99 (ms)', simulated: +sim.summary.p99.toFixed(1), measured: measured.p99, error: pct(e), target: '±15%', pass: Math.abs(e) <= 0.15 });
  }
  if (measured.errorRate !== undefined) {
    const d = sim.summary.errorRate - measured.errorRate;
    rows.push({
      metric: '에러율',
      simulated: `${(sim.summary.errorRate * 100).toFixed(2)}%`,
      measured: `${(measured.errorRate * 100).toFixed(2)}%`,
      error: `${d >= 0 ? '+' : ''}${(d * 100).toFixed(2)}%p`,
      target: '±0.5%p',
      pass: Math.abs(d) <= 0.005,
    });
  }
  if (measured.firstBottleneck) {
    const top = rankSaturation(sim)[0];
    const simB = top ? top.resource : '-';
    const ok = !!top && (top.resource === measured.firstBottleneck || top.node === measured.firstBottleneck || top.edge === measured.firstBottleneck);
    rows.push({ metric: '첫 병목 자원', simulated: simB, measured: measured.firstBottleneck, error: ok ? '일치' : '불일치', target: '일치', pass: ok });
  }
  if (measured.cbOpenAt !== undefined) {
    const ev = sim.events.find((e) => e.type === 'cb' && e.detail.includes('→ OPEN'));
    const t = ev ? ev.t / 1000 : NaN;
    const d = t - measured.cbOpenAt;
    rows.push({
      metric: '서킷 OPEN 시점 (s)',
      simulated: Number.isFinite(t) ? +t.toFixed(1) : '없음',
      measured: measured.cbOpenAt,
      error: Number.isFinite(d) ? `${d >= 0 ? '+' : ''}${d.toFixed(1)}s` : '—',
      target: '±2s',
      pass: Number.isFinite(d) ? Math.abs(d) <= 2 : false,
    });
  }
  return rows;
}

export function comparisonMarkdown(title: string, rows: ComparisonRow[]): string {
  const lines = [`### ${title}`, '', '| 지표 | 시뮬레이션 | 실측 | 오차 | 목표 | 판정 |', '|---|---:|---:|---:|---:|:---:|'];
  for (const r of rows) lines.push(`| ${r.metric} | ${r.simulated} | ${r.measured} | ${r.error} | ${r.target} | ${r.pass === null ? '' : r.pass ? '✅' : '❌'} |`);
  return lines.join('\n') + '\n';
}
