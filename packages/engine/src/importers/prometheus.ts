// Prometheus / Micrometer exposition text → request rates, API mix, latency, CPU time and allocation per request.
// Counters are cumulative, so two scrapes some seconds apart are compared.
import { fmtDuration, slug, type ImportReport } from './util';

interface Sample {
  name: string;
  labels: Record<string, string>;
  value: number;
}

export function parseExposition(text: string): Sample[] {
  const out: Sample[] = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const m = /^([a-zA-Z_:][\w:]*)(?:\{(.*)\})?\s+([-+]?(?:[\d.]+(?:e[-+]?\d+)?|NaN|\+Inf|-Inf))/i.exec(line);
    if (!m) continue;
    const labels: Record<string, string> = {};
    if (m[2]) for (const lm of m[2].matchAll(/(\w+)="((?:[^"\\]|\\.)*)"/g)) labels[lm[1]] = lm[2];
    out.push({ name: m[1], labels, value: Number(m[3].replace('+Inf', 'Infinity')) });
  }
  return out;
}

const key = (s: Sample, drop: string[] = []) =>
  `${s.name}{${Object.entries(s.labels)
    .filter(([k]) => !drop.includes(k))
    .sort()
    .map(([k, v]) => `${k}=${v}`)
    .join(',')}}`;

export interface PrometheusOptions {
  service: string;
  /** seconds between the two scrapes */
  seconds: number;
  /** number of instances the scrapes are summed over (default 1) */
  instances?: number;
}

/** Quantile from cumulative histogram buckets (Micrometer percentiles-histogram). */
function bucketQuantile(buckets: { le: number; count: number }[], q: number): number {
  const b = buckets.sort((a, c) => a.le - c.le);
  const total = b[b.length - 1]?.count ?? 0;
  if (!total) return NaN;
  const target = q * total;
  let prevLe = 0;
  let prevCount = 0;
  for (const x of b) {
    if (x.count >= target) {
      if (!Number.isFinite(x.le)) return prevLe;
      const frac = (target - prevCount) / Math.max(1, x.count - prevCount);
      return prevLe + (x.le - prevLe) * frac;
    }
    prevLe = x.le;
    prevCount = x.count;
  }
  return prevLe;
}

export function importPrometheus(before: string, after: string, opts: PrometheusOptions): ImportReport {
  const a = parseExposition(before);
  const b = parseExposition(after);
  const prev = new Map(a.map((s) => [key(s), s.value]));
  const delta = (s: Sample) => s.value - (prev.get(key(s)) ?? 0);
  const notes: string[] = [];
  const svc = slug(opts.service);
  const node: any = { kind: 'service', endpoints: {} };
  const endpoints = node.endpoints;

  // requests per API: http_server_requests_seconds_count{method, uri, status}
  const perApi = new Map<string, { count: number; errors: number; sum: number; buckets: Map<number, number> }>();
  for (const s of b) {
    if (!s.name.startsWith('http_server_requests_seconds')) continue;
    const { method, uri, status = '200' } = s.labels;
    if (!method || !uri || uri === 'UNKNOWN' || uri.startsWith('/actuator')) continue;
    const api = `${method} ${uri}`;
    const e = perApi.get(api) ?? { count: 0, errors: 0, sum: 0, buckets: new Map() };
    perApi.set(api, e);
    const d = delta(s);
    if (s.name.endsWith('_count')) {
      e.count += d;
      if (status.startsWith('5')) e.errors += d;
    } else if (s.name.endsWith('_sum')) e.sum += d;
    else if (s.name.endsWith('_bucket')) {
      const le = s.labels.le === '+Inf' ? Infinity : Number(s.labels.le);
      e.buckets.set(le, (e.buckets.get(le) ?? 0) + d);
    }
  }
  let total = 0;
  for (const e of perApi.values()) total += e.count;
  const mix: Record<string, string> = {};
  for (const [api, e] of perApi) {
    if (e.count <= 0) continue;
    mix[`${svc}:${api}`] = `${((e.count / total) * 100).toFixed(1)}%`;
    const ep: any = { source: 'prometheus' };
    const buckets = [...e.buckets.entries()].map(([le, count]) => ({ le, count }));
    if (buckets.length > 2) {
      const p50 = bucketQuantile(buckets, 0.5) * 1000;
      const p99 = bucketQuantile(buckets, 0.99) * 1000;
      // the server-side latency includes downstream calls; it is only a ceiling for selfTime
      ep['x-observedLatency'] = { p50: fmtDuration(p50), p99: fmtDuration(p99) };
    } else if (e.sum > 0) ep['x-observedLatency'] = { mean: fmtDuration((e.sum / e.count) * 1000) };
    if (e.errors > 0) notes.push(`${api}: 5xx ${((e.errors / e.count) * 100).toFixed(2)}%`);
    endpoints[api] = ep;
  }

  const gauge = (name: string, f?: (s: Sample) => boolean) => b.filter((s) => s.name === name && (!f || f(s))).reduce((x, s) => x + s.value, 0);
  const counter = (name: string) => b.filter((s) => s.name === name).reduce((x, s) => x + delta(s), 0);
  const instances = opts.instances ?? 1;
  const runtime: any = {};
  const maxThreads = gauge('tomcat_threads_config_max_threads');
  if (maxThreads) runtime.threads = Math.round(maxThreads / instances);
  if (Object.keys(runtime).length) node.runtime = runtime;

  // CPU seconds and allocated bytes per request → endpoint cpu / alloc (same estimate for all APIs)
  const cpuNs = counter('process_cpu_time_ns_total');
  const cpuSeconds = cpuNs ? cpuNs / 1e9 : gauge('process_cpu_usage') * gauge('system_cpu_count') * opts.seconds;
  const allocated = counter('jvm_gc_memory_allocated_bytes_total');
  if (total > 0) {
    for (const ep of Object.values<any>(endpoints)) {
      if (cpuSeconds > 0) ep.cpu = fmtDuration((cpuSeconds * 1000) / total);
      if (allocated > 0) ep.alloc = `${Math.round(allocated / total / 1024)}kb`;
    }
    if (cpuSeconds > 0) notes.push(`요청당 CPU 시간 ${fmtDuration((cpuSeconds * 1000) / total)} (프로세스 전체 CPU ÷ 요청 수, API 구분 없음)`);
  }
  const vcpu = gauge('system_cpu_count');
  if (vcpu) node.os = { vcpu: vcpu / instances };
  const heapMax = gauge('jvm_memory_max_bytes', (s) => s.labels.area === 'heap' && s.value > 0);
  if (heapMax) (node.os ??= {}).heap = `${Math.round(heapMax / instances / 1024 / 1024)}m`;

  // HikariCP pools: the pool name rarely matches a node, so the merge step maps it to this service's DB connection
  const pools: Record<string, number> = {};
  for (const s of b.filter((x) => x.name === 'hikaricp_connections_max')) pools[s.labels.pool ?? 'db'] = Math.round(s.value / instances);
  if (Object.keys(pools).length) node['x-hikariPools'] = pools;

  const doc: any = { nodes: { [svc]: node } };
  if (total > 0) {
    doc.scenario = { traffic: { type: 'constant', rps: `${Math.round(total / opts.seconds)}rps`, mix } };
    notes.push(`${opts.seconds}초 동안 요청 ${Math.round(total).toLocaleString()}건 → ${Math.round(total / opts.seconds)} rps, API ${perApi.size}개`);
  } else notes.push('http_server_requests_seconds_count 증가분이 없어 트래픽을 계산하지 못했습니다.');
  return { doc, notes };
}
