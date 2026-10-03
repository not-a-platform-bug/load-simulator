// Calibration: fit model parameters (DB contention curves by default) so simulated p99/throughput match measurements
// taken at several load levels. Coordinate search on a log grid, refined around the best value.
import { getPath, setPath } from './rawpath';
import { parseModel, type RawDoc } from './parse';
import { simulate } from './simulate';
import type { SimResult } from './types';

export interface Measurement {
  /** offered load in requests per second */
  rps: number;
  /** measured successful throughput (rps) */
  throughput?: number;
  /** measured p99 (ms), client side */
  p99?: number;
  p50?: number;
  errorRate?: number;
}

export interface ParamSpec {
  path: (string | number)[];
  min: number;
  max: number;
  log?: boolean;
  integer?: boolean;
  /** derived parameter: instead of writing `path`, rewrite the original doc with value v (e.g. scale every latency of a node) */
  apply?: (original: RawDoc, v: number) => RawDoc;
  /** starting value of a derived parameter */
  initial?: number;
}

const TIME = /^\s*([\d.]+)\s*(us|µs|ms|s)?\s*$/;

/** multiply a duration ("2ms", 0.5, "1s") or a { p50, p99, … } distribution by k */
function scaleTime(v: unknown, k: number): unknown {
  if (typeof v === 'number') return +(v * k).toPrecision(4);
  if (typeof v === 'string') {
    const m = TIME.exec(v);
    if (!m) return v;
    const ms = Number(m[1]) * (m[2] === 's' ? 1000 : m[2] === 'us' || m[2] === 'µs' ? 0.001 : 1);
    return `${+(ms * k).toPrecision(4)}ms`;
  }
  if (v && typeof v === 'object') {
    const o: Record<string, unknown> = { ...(v as Record<string, unknown>) };
    for (const key of ['p50', 'p90', 'p95', 'p99', 'p999', 'mean', 'min', 'max', 'value']) if (o[key] !== undefined) o[key] = scaleTime(o[key], k);
    if (o.latency !== undefined) o.latency = scaleTime(o.latency, k);
    return o;
  }
  return v;
}

function msOf(v: unknown): number {
  if (typeof v === 'number') return v;
  const m = TIME.exec(String(v));
  if (!m) return NaN;
  return Number(m[1]) * (m[2] === 's' ? 1000 : m[2] === 'us' || m[2] === 'µs' ? 0.001 : 1);
}

/** cpu + (t − cpu) × k for a duration or each quantile of a distribution */
function shiftScale(v: unknown, cpu: number, k: number): unknown {
  const one = (x: unknown) => {
    const t = msOf(x);
    return Number.isFinite(t) ? `${+(Math.min(t, cpu) + Math.max(0, t - cpu) * k).toPrecision(4)}ms` : x;
  };
  if (v && typeof v === 'object') {
    const o: Record<string, unknown> = { ...(v as Record<string, unknown>) };
    for (const key of ['p50', 'p90', 'p95', 'p99', 'p999', 'mean', 'min', 'max', 'value']) if (o[key] !== undefined) o[key] = one(o[key]);
    return o;
  }
  return one(v);
}

/** every service's own processing time (selfTime) × k */
function scaleService(name: string) {
  return (doc: RawDoc, k: number): RawDoc => {
    const d = structuredClone(doc);
    for (const ep of Object.values<any>(d.nodes[name].endpoints ?? {})) {
      const self = ep.selfTime ?? '2ms';
      const cpu = ep.cpu !== undefined ? msOf(ep.cpu) : NaN;
      // an explicit CPU time is a measured fact (profiling, app.cpu.*): only the time around it is uncertain
      ep.selfTime = Number.isFinite(cpu) ? shiftScale(self, cpu, k) : scaleTime(self, k);
    }
    return d;
  };
}

/** network round trips × k: the model-wide defaults and every edge that sets its own */
function scaleNetwork(doc: RawDoc, k: number): RawDoc {
  const d = structuredClone(doc);
  const g = (d.network ??= {});
  g.rtt = scaleTime(g.rtt ?? '0.5ms', k);
  g.jitter = scaleTime(g.jitter ?? '0.1ms', k);
  g.clientRtt = scaleTime(g.clientRtt ?? '2ms', k);
  g.clientJitter = scaleTime(g.clientJitter ?? '0.5ms', k);
  for (const e of Object.values<any>(d.edges ?? {})) {
    if (e?.network?.rtt !== undefined) e.network.rtt = scaleTime(e.network.rtt, k);
    if (e?.network?.jitter !== undefined) e.network.jitter = scaleTime(e.network.jitter, k);
  }
  return d;
}

/** cache command time × k */
function scaleCache(name: string) {
  return (doc: RawDoc, k: number): RawDoc => {
    const d = structuredClone(doc);
    d.nodes[name].opTime = scaleTime(d.nodes[name].opTime ?? { p50: '0.15ms', p99: '0.6ms' }, k);
    return d;
  };
}

/** every query latency of a DB × k */
function scaleDb(name: string) {
  return (doc: RawDoc, k: number): RawDoc => {
    const d = structuredClone(doc);
    const n = d.nodes[name];
    for (const [q, v] of Object.entries<any>(n.queries ?? {})) n.queries[q] = scaleTime(v, k);
    if (n.latency !== undefined) n.latency = scaleTime(n.latency, k);
    return d;
  };
}

export interface CalibrateOptions {
  params?: ParamSpec[];
  /** simulated ms per measurement point (default 20s, 5s warmup) */
  duration?: number;
  rounds?: number;
  onProgress?: (msg: string) => void;
}

export interface CalibrationResult {
  doc: RawDoc;
  params: { path: string; before: unknown; after: number }[];
  loss: { before: number; after: number };
  points: { rps: number; measured: Measurement; simulated: { throughput: number; p50: number; p99: number; errorRate: number } }[];
}

export function defaultParams(doc: RawDoc): ParamSpec[] {
  const out: ParamSpec[] = [];
  // base latencies first: they set p50 at low load, contention only matters once load rises
  out.push({ path: ['calibration', 'network', 'rtt×'], min: 0.05, max: 4, log: true, initial: 1, apply: scaleNetwork });
  for (const [name, n] of Object.entries<any>(doc.nodes ?? {})) {
    if (n?.kind === 'cache') out.push({ path: ['calibration', name, 'opTime×'], min: 0.1, max: 4, log: true, initial: 1, apply: scaleCache(name) });
    const kind = n?.kind ?? 'service';
    if (kind === 'service' && Object.keys(n.endpoints ?? {}).length)
      out.push({ path: ['calibration', name, 'selfTime×'], min: 0.1, max: 4, log: true, initial: 1, apply: scaleService(name) });
    if (kind === 'db' && Object.keys(n.queries ?? {}).length)
      out.push({ path: ['calibration', name, 'latency×'], min: 0.1, max: 4, log: true, initial: 1, apply: scaleDb(name) });
  }
  for (const [name, n] of Object.entries<any>(doc.nodes ?? {})) {
    if (n?.kind !== 'db') continue;
    out.push({ path: ['nodes', name, 'contention', 'saturation'], min: 4, max: 256, log: true, integer: true });
    out.push({ path: ['nodes', name, 'contention', 'latencyX'], min: 1.2, max: 12, log: true });
  }
  return out;
}

function runAt(doc: RawDoc, rps: number, duration: number): SimResult {
  const d = structuredClone(doc);
  d.scenario = { ...(d.scenario ?? {}), traffic: { ...(d.scenario?.traffic ?? {}), type: 'constant', rps }, faults: [], duration: `${duration}ms`, warmup: `${Math.round(duration / 4)}ms` };
  const model = parseModel(d);
  return simulate(model, model.scenario, model.scenario.seed, { particles: false });
}

function loss(doc: RawDoc, points: Measurement[], duration: number): { value: number; sims: SimResult[] } {
  let value = 0;
  const sims: SimResult[] = [];
  // the model is used to predict higher load: weight points by load. At very low load real hosts are slower
  // than steady state (idle CPU / VM wake-up, cold caches), which the model does not reproduce.
  const top = Math.max(...points.map((p) => p.rps));
  for (const m of points) {
    const r = runAt(doc, m.rps, duration);
    sims.push(r);
    const s = r.summary;
    const w = m.rps / top;
    const term = (sim: number, meas?: number) => (meas && meas > 0 && sim > 0 ? Math.log(sim / meas) ** 2 : 0);
    value += w * (term(s.p99, m.p99) + term(s.p50, m.p50) + term(s.throughput, m.throughput));
    if (m.errorRate !== undefined) value += w * 10 * (s.errorRate - m.errorRate) ** 2;
  }
  return { value, sims };
}

export function calibrate(doc: RawDoc, points: Measurement[], opts: CalibrateOptions = {}): CalibrationResult {
  const params = opts.params ?? defaultParams(doc);
  const duration = opts.duration ?? 20_000;
  const log = opts.onProgress ?? (() => {});
  // derived parameters are kept as values and re-applied to the original doc in order
  const derived = new Map<ParamSpec, number>(params.filter((p) => p.apply).map((p) => [p, p.initial ?? 1]));
  const build = (plain: RawDoc, vals: Map<ParamSpec, number>) => {
    let d = plain;
    for (const [p, v] of vals) d = p.apply!(d, v);
    return d;
  };
  let plain = structuredClone(doc); // doc with only the plain (path) parameters changed
  let best = build(plain, derived);
  const before = loss(best, points, duration).value;
  let bestLoss = before;
  const initial = params.map((p) => (p.apply ? p.initial ?? 1 : getPath(doc, p.path)));
  for (let round = 0; round < (opts.rounds ?? 2); round++) {
    for (const p of params) {
      const cur = p.apply ? derived.get(p)! : Number(getPath(plain, p.path) ?? (p.log ? Math.sqrt(p.min * p.max) : (p.min + p.max) / 2));
      // shrinking window around the current value
      const span = round === 0 ? 1 : 0.35 / round;
      const lo = p.log ? Math.max(p.min, cur * Math.pow(p.max / p.min, -span / 2)) : Math.max(p.min, cur - ((p.max - p.min) * span) / 2);
      const hi = p.log ? Math.min(p.max, cur * Math.pow(p.max / p.min, span / 2)) : Math.min(p.max, cur + ((p.max - p.min) * span) / 2);
      const grid = 7;
      for (let i = 0; i < grid; i++) {
        let v = p.log ? lo * Math.pow(hi / lo, i / (grid - 1)) : lo + ((hi - lo) * i) / (grid - 1);
        if (p.integer) v = Math.round(v);
        const candPlain = p.apply ? plain : setPath(plain, p.path, v);
        const candDerived = p.apply ? new Map(derived).set(p, v) : derived;
        const cand = build(candPlain, candDerived);
        const l = loss(cand, points, duration).value;
        if (l < bestLoss - 1e-9) {
          bestLoss = l;
          best = cand;
          plain = candPlain;
          if (p.apply) derived.set(p, v);
        }
      }
      const shown = p.apply ? derived.get(p)!.toFixed(3) : getPath(plain, p.path);
      log(`round ${round + 1} ${p.path.join('.')} = ${shown} (loss ${bestLoss.toFixed(4)})`);
    }
  }
  const final = loss(best, points, duration);
  return {
    doc: best,
    params: params.map((p, i) => ({ path: p.path.join('.'), before: initial[i], after: p.apply ? +derived.get(p)!.toFixed(3) : Number(getPath(best, p.path)) })),
    loss: { before, after: final.value },
    points: points.map((m, i) => {
      const s = final.sims[i].summary;
      return { rps: m.rps, measured: m, simulated: { throughput: s.throughput, p50: s.p50, p99: s.p99, errorRate: s.errorRate } };
    }),
  };
}
