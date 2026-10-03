// Capacity search: raise constant traffic (same API mix) by bisection until an entry API breaks its SLO,
// then report which API broke first and which resource saturated first.

import { simulate } from './simulate';
import type { Model, ResourceKind, Scenario, SimResult, SloSpec } from './types';
import { fmtMs } from './units';

export interface CapacityOptions {
  slo?: Partial<SloSpec>;
  /** simulated seconds per probe, including warmup (default 30s) */
  duration?: number;
  warmup?: number;
  /** relative precision of the answer (default 0.03) */
  tolerance?: number;
  maxRps?: number;
  startRps?: number;
  /** keep the scenario's faults during the search (default false: capacity under normal conditions) */
  includeFaults?: boolean;
  seed?: number;
  onProbe?: (p: CapacityProbe) => void;
}

export interface CapacityProbe {
  rps: number;
  pass: boolean;
  p99: number;
  errorRate: number;
  /** entry API furthest from its SLO */
  worst: { endpoint: string; p99: number; errorRate: number; ratio: number };
}

export interface Bottleneck {
  resource: string;
  label: string;
  kind: ResourceKind;
  node: string;
  edge?: string;
  util: number;
  queue: number;
}

export interface CapacityResult {
  maxRps: number;
  /** first rate found to violate the SLO */
  failRps: number;
  limitedBy: { endpoint: string; metric: 'p99' | 'errorRate'; value: number; limit: number } | null;
  bottleneck: Bottleneck | null;
  /** resources ranked by saturation at failRps */
  saturation: Bottleneck[];
  probes: CapacityProbe[];
  summary: string;
}

/** Resources that tend to be the root cause rank before those that are merely symptoms (threads waiting on them). */
const PRIORITY: Record<ResourceKind, number> = {
  cpu: 0,
  loop: 0,
  fd: 1,
  ports: 1,
  db: 1,
  store: 1,
  pool: 2,
  cache: 3,
  external: 4,
  bulkhead: 5,
  async: 6,
  threads: 7,
  consumers: 7,
  backlog: 8,
};

const KIND_KO: Record<ResourceKind, string> = {
  cpu: 'CPU',
  db: 'DB 동시 쿼리',
  store: 'NoSQL·검색 노드 동시 처리',
  pool: '커넥션풀',
  cache: '캐시 처리 스레드',
  external: '외부 API 동시 처리',
  bulkhead: 'Bulkhead',
  async: '@Async 풀',
  threads: '워커 스레드',
  backlog: '커널 backlog',
  loop: '이벤트 루프/캐리어 스레드',
  fd: '파일 디스크립터',
  ports: '임시 포트',
  consumers: '큐 컨슈머',
};

export function rankSaturation(res: SimResult): Bottleneck[] {
  const from = Math.floor(res.window[0] / res.bucketMs);
  const out: Bottleneck[] = [];
  for (const r of res.resources) {
    let u = 0;
    let q = 0;
    let n = 0;
    for (let b = from; b < r.util.length; b++) {
      u += r.util[b];
      q += r.queue[b];
      n++;
    }
    if (!n) continue;
    out.push({ resource: r.id, label: r.label, kind: r.kind, node: r.node, edge: r.edge, util: u / n, queue: q / n });
  }
  const score = (b: Bottleneck) => Math.min(1.5, b.util) + (b.queue > 0.5 ? 1 : 0);
  return out.sort((a, b) => {
    const d = score(b) - score(a);
    if (Math.abs(d) > 0.1) return d;
    return PRIORITY[a.kind] - PRIORITY[b.kind];
  });
}

export function bottleneckName(b: Bottleneck): string {
  if (b.kind === 'pool' && b.edge) {
    const to = b.edge.split('->')[1];
    return `${b.node} → ${to} ${KIND_KO.pool}`;
  }
  return `${b.node} ${KIND_KO[b.kind]}`;
}

function constantScenario(sc: Scenario, rps: number, opts: CapacityOptions): Scenario {
  return {
    ...sc,
    duration: opts.duration ?? 30_000,
    warmup: opts.warmup ?? 10_000,
    traffic: { type: 'constant', rps },
    faults: opts.includeFaults ? sc.faults : [],
    slo: { ...sc.slo, ...opts.slo, endpoints: { ...sc.slo.endpoints, ...(opts.slo?.endpoints ?? {}) } },
  };
}

function probe(model: Model, rps: number, opts: CapacityOptions): { p: CapacityProbe; res: SimResult } {
  const sc = constantScenario(model.scenario, rps, opts);
  const res = simulate(model, sc, opts.seed ?? sc.seed, { particles: false });
  let worst = { endpoint: '', p99: 0, errorRate: 0, ratio: -1 };
  for (const e of res.endpoints) {
    if (!e.entry || !e.slo) continue;
    const ratio = Math.max(e.p99 / e.slo.p99, e.slo.errorRate > 0 ? e.errorRate / e.slo.errorRate : e.errorRate > 0 ? Infinity : 0);
    if (ratio > worst.ratio) worst = { endpoint: e.op, p99: e.p99, errorRate: e.errorRate, ratio };
  }
  const p: CapacityProbe = { rps, pass: res.summary.sloPass, p99: res.summary.p99, errorRate: res.summary.errorRate, worst };
  opts.onProbe?.(p);
  return { p, res };
}

export function findCapacity(model: Model, opts: CapacityOptions = {}): CapacityResult {
  const tol = opts.tolerance ?? 0.03;
  const maxRps = opts.maxRps ?? 200_000;
  const probes: CapacityProbe[] = [];
  const run = (rps: number) => {
    const r = probe(model, Math.round(rps), opts);
    probes.push(r.p);
    return r;
  };

  let lo = 0;
  let hi = 0;
  let hiRes: SimResult | null = null;
  let rps = opts.startRps ?? 100;
  // exponential search for a failing rate
  for (let i = 0; i < 24; i++) {
    const r = run(rps);
    if (r.p.pass) {
      lo = rps;
      if (rps >= maxRps) break;
      rps = Math.min(maxRps, rps * 2);
    } else {
      hi = rps;
      hiRes = r.res;
      break;
    }
  }
  if (!hiRes) {
    return {
      maxRps: lo,
      failRps: NaN,
      limitedBy: null,
      bottleneck: null,
      saturation: [],
      probes,
      summary: `${lo.toLocaleString()} RPS까지 SLO를 지켰습니다 (탐색 상한).`,
    };
  }
  // bisection
  while (hi - lo > Math.max(1, hi * tol)) {
    const mid = (lo + hi) / 2;
    const r = run(mid);
    if (r.p.pass) lo = Math.round(mid);
    else {
      hi = Math.round(mid);
      hiRes = r.res;
    }
  }

  const failing = probes.filter((p) => !p.pass).sort((a, b) => a.rps - b.rps)[0];
  const ep = hiRes.endpoints.find((e) => e.entry && e.op === failing.worst.endpoint);
  let limitedBy: CapacityResult['limitedBy'] = null;
  if (ep?.slo) {
    limitedBy = !ep.slo.p99Ok
      ? { endpoint: ep.op, metric: 'p99', value: ep.p99, limit: ep.slo.p99 }
      : { endpoint: ep.op, metric: 'errorRate', value: ep.errorRate, limit: ep.slo.errorRate };
  }
  const saturation = rankSaturation(hiRes);
  const bottleneck = saturation[0] ?? null;

  let summary = `최대 ${lo.toLocaleString()} RPS에서 SLO를 지킵니다.`;
  if (limitedBy) {
    const what =
      limitedBy.metric === 'p99'
        ? `p99 ${fmtMs(limitedBy.limit)}를 넘는다 (${fmtMs(limitedBy.value)})`
        : `에러율 ${(limitedBy.limit * 100).toFixed(2)}%를 넘는다 (${(limitedBy.value * 100).toFixed(2)}%)`;
    summary = `${limitedBy.endpoint}는 ${hi.toLocaleString()} RPS에서 ${what}. 최대 ${lo.toLocaleString()} RPS.`;
  }
  if (bottleneck) summary += ` 첫 병목은 ${bottleneckName(bottleneck)}.`;

  return { maxRps: lo, failRps: hi, limitedBy, bottleneck, saturation, probes, summary };
}
