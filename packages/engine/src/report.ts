// Load-test style report (throughput, p50/p95/p99, error rate, resource saturation) as Markdown.

import { bottleneckName, rankSaturation, type CapacityResult } from './capacity';
import type { SimResult, Warning } from './types';
import { fmtMs } from './units';

const pct = (v: number) => `${(v * 100).toFixed(v < 0.01 && v > 0 ? 3 : 2)}%`;

export function markdownReport(res: SimResult, opts: { title?: string; warnings?: Warning[]; capacity?: CapacityResult } = {}): string {
  const s = res.summary;
  const lines: string[] = [];
  lines.push(`# ${opts.title ?? 'load-simulator 결과'}`, '');
  lines.push(`- 시뮬레이션 시간: ${fmtMs(res.duration)} (측정 구간 ${fmtMs(res.window[0])}–${fmtMs(res.window[1])})`);
  lines.push(`- 진입 요청: ${s.roots.toLocaleString()}건, 처리 사건: ${s.eventsProcessed.toLocaleString()}개, 계산 ${s.wallMs}ms`);
  lines.push(`- SLO: ${s.sloPass ? '✅ 충족' : '❌ 위반'}${s.sloViolations.length ? ` — ${s.sloViolations.join('; ')}` : ''}`);
  if (opts.capacity) lines.push(`- 용량: ${opts.capacity.summary}`);
  lines.push('');
  lines.push('## 전체', '');
  lines.push('| 처리량 | p50 | p95 | p99 | 최대 | 에러율 | fallback 응답 |');
  lines.push('|---:|---:|---:|---:|---:|---:|---:|');
  lines.push(`| ${s.throughput.toFixed(1)} rps | ${fmtMs(s.p50)} | ${fmtMs(s.p95)} | ${fmtMs(s.p99)} | ${fmtMs(s.max)} | ${pct(s.errorRate)} | ${s.degraded.toLocaleString()} |`);
  lines.push('');
  lines.push('## API별', '');
  lines.push('| API | 진입 | 처리량 | p50 | p95 | p99 | 에러율 | SLO |');
  lines.push('|---|:---:|---:|---:|---:|---:|---:|:---:|');
  for (const e of res.endpoints) {
    if (!e.count) continue;
    lines.push(
      `| ${e.node} \`${e.op}\` | ${e.entry ? '●' : ''} | ${e.throughput.toFixed(1)} | ${fmtMs(e.p50)} | ${fmtMs(e.p95)} | ${fmtMs(e.p99)} | ${pct(e.errorRate)} | ${e.slo ? (e.slo.pass ? '✅' : '❌') : ''} |`,
    );
  }
  lines.push('');
  lines.push('## 자원별 포화도 (측정 구간 평균)', '');
  lines.push('| 자원 | 사용률 | 평균 대기 |');
  lines.push('|---|---:|---:|');
  for (const b of rankSaturation(res).slice(0, 12)) {
    lines.push(`| ${bottleneckName(b)} — ${b.label} | ${pct(b.util)} | ${b.queue.toFixed(1)} |`);
  }
  if (s.errorCauses.length) {
    lines.push('', '## 실패 원인', '');
    lines.push('| 원인 | 건수 |');
    lines.push('|---|---:|');
    for (const c of s.errorCauses.slice(0, 10)) lines.push(`| ${c.cause} | ${c.count.toLocaleString()} |`);
  }
  const amp = res.edges.filter((e) => e.amplification > 0 && e.from !== 'client');
  if (amp.length) {
    lines.push('', '## 연결선 (진입 요청당 시도 수)', '');
    lines.push('| 연결선 | 시도 | 재시도 | timeout | fallback | 서킷 거부 | 증폭 |');
    lines.push('|---|---:|---:|---:|---:|---:|---:|');
    for (const e of amp) {
      lines.push(`| ${e.key} | ${e.attempts.toLocaleString()} | ${e.retries.toLocaleString()} | ${e.timeouts.toLocaleString()} | ${e.fallbacks.toLocaleString()} | ${e.cbRejected.toLocaleString()} | ×${e.amplification.toFixed(2)} |`);
    }
  }
  if (opts.warnings?.length) {
    lines.push('', '## 정적 검사', '');
    for (const w of opts.warnings) lines.push(`- **${w.level}** \`${w.code}\` ${w.message}`);
  }
  if (res.events.length) {
    const cb = res.events.filter((e) => e.type !== 'gc-old').slice(0, 30);
    if (cb.length) {
      lines.push('', '## 주요 사건', '');
      for (const e of cb) lines.push(`- ${(e.t / 1000).toFixed(1)}s ${e.target}: ${e.type === 'fault-start' ? '장애 시작 ' : e.type === 'fault-end' ? '장애 종료 ' : ''}${e.detail}`);
    }
  }
  lines.push('');
  return lines.join('\n');
}
