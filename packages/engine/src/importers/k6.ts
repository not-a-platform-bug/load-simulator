// Existing k6 script → traffic pattern and API mix (reuse the same load profile in simulation).
import { slug, type ImportReport } from './util';

export function importK6(script: string, opts: { service?: string } = {}): ImportReport {
  const notes: string[] = [];
  const num = (re: RegExp, s = script) => {
    const m = re.exec(s);
    return m ? Number(m[1]) : undefined;
  };
  const dur = (s: string) => {
    let ms = 0;
    for (const m of s.matchAll(/(\d+(?:\.\d+)?)(ms|s|m|h)/g)) ms += Number(m[1]) * { ms: 1, s: 1000, m: 60_000, h: 3_600_000 }[m[2] as 'ms']!;
    return ms;
  };
  const timeUnit = /timeUnit\s*:\s*['"`]([^'"`]+)['"`]/.exec(script)?.[1] ?? '1s';
  const perSec = 1000 / Math.max(1, dur(timeUnit));
  let traffic: any;
  let duration: number | undefined;
  if (/ramping-arrival-rate/.test(script)) {
    const start = (num(/startRate\s*:\s*(\d+(?:\.\d+)?)/) ?? 0) * perSec;
    const stagesSrc = /stages\s*:\s*\[([\s\S]*?)\]/.exec(script)?.[1] ?? '';
    const steps: { at: string; rps: number }[] = [{ at: '0s', rps: start }];
    let t = 0;
    let prev = start;
    for (const m of stagesSrc.matchAll(/\{[^}]*?target\s*:\s*(\d+(?:\.\d+)?)[^}]*?duration\s*:\s*['"`]([^'"`]+)['"`][^}]*\}|\{[^}]*?duration\s*:\s*['"`]([^'"`]+)['"`][^}]*?target\s*:\s*(\d+(?:\.\d+)?)[^}]*\}/g)) {
      const target = Number(m[1] ?? m[4]) * perSec;
      const d = dur(m[2] ?? m[3]);
      // linear ramp approximated by 1-second steps
      const n = Math.max(1, Math.round(d / 1000));
      for (let i = 1; i <= n; i++) steps.push({ at: `${(t + (d * i) / n) / 1000}s`, rps: Math.round(prev + ((target - prev) * i) / n) });
      t += d;
      prev = target;
    }
    traffic = { type: 'steps', steps: compress(steps) };
    duration = t;
    notes.push(`ramping-arrival-rate 단계 ${stagesSrc.split('target').length - 1}개를 계단형 트래픽으로 옮겼습니다.`);
  } else if (/constant-arrival-rate/.test(script)) {
    const rate = (num(/[^a-zA-Z]rate\s*:\s*(\d+(?:\.\d+)?)/) ?? 100) * perSec;
    traffic = { type: 'constant', rps: `${Math.round(rate)}rps` };
    const d = /duration\s*:\s*['"`]([^'"`]+)['"`]/.exec(script)?.[1];
    if (d) duration = dur(d);
  } else {
    const vus = num(/vus\s*:\s*(\d+)/) ?? 10;
    traffic = { type: 'constant', rps: `${vus * 10}rps` };
    notes.push(`VU 기반(closed model) 스크립트입니다. VU ${vus}개 × 초당 10회로 가정했습니다 — 시뮬레이터는 도착률(open model)로 계산하므로 rps를 확인하세요.`);
  }

  // requests: http.get(`${BASE}/x`), http.post('.../x'), http.request('PUT', ...)
  const mix: Record<string, number> = {};
  const add = (method: string, url: string) => {
    const path = url.replace(/^\$\{[^}]+\}/, '').replace(/^https?:\/\/[^/]+/, '').replace(/\$\{[^}]+\}/g, '{id}').split('?')[0] || '/';
    const api = `${method.toUpperCase()} ${path.startsWith('/') ? path : `/${path}`}`;
    mix[api] = (mix[api] ?? 0) + 1;
  };
  for (const m of script.matchAll(/http\.(get|post|put|patch|del|delete|head)\s*\(\s*(['"`])(.*?)\2/g)) add(m[1] === 'del' ? 'DELETE' : m[1], m[3]);
  for (const m of script.matchAll(/http\.request\s*\(\s*['"`](\w+)['"`]\s*,\s*(['"`])(.*?)\2/g)) add(m[1], m[3]);
  const weights = /weight\s*:\s*\d/.test(script);
  if (!Object.keys(mix).length) notes.push('HTTP 호출을 찾지 못했습니다. traffic.mix를 직접 채우세요.');
  else notes.push(`요청 ${Object.keys(mix).length}종을 찾았습니다${weights ? ' (가중치 표현은 해석하지 않았습니다 — 비율을 확인하세요)' : ', 호출 횟수 비율로 믹스를 정했습니다'}.`);
  const total = Object.values(mix).reduce((a, b) => a + b, 0);
  const prefix = opts.service ? `${slug(opts.service)}:` : '';
  traffic.mix = Object.fromEntries(Object.entries(mix).map(([k, v]) => [`${prefix}${k}`, `${((v / total) * 100).toFixed(1)}%`]));
  const scenario: any = { traffic };
  if (duration) scenario.duration = `${Math.round(duration / 1000)}s`;
  const p99 = /p\(99\)\s*<\s*(\d+)/.exec(script)?.[1];
  const failed = /rate\s*<\s*(0?\.\d+)/.exec(script)?.[1];
  if (p99 || failed) scenario.slo = { ...(p99 ? { p99: `${p99}ms` } : {}), ...(failed ? { errorRate: Number(failed) } : {}) };
  return { doc: { scenario }, notes };
}

function compress(steps: { at: string; rps: number }[]) {
  return steps.filter((s, i) => i === 0 || s.rps !== steps[i - 1].rps).map((s) => ({ at: s.at, rps: `${s.rps}rps` }));
}
