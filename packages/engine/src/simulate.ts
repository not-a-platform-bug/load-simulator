// Discrete-event simulation of application, OS and network layers sharing one event queue.
//
//   simulate(model, scenario, seed) → SimResult   (pure: same input ⇒ same output)
//
// Request flow for one call A → B (see docs/architecture.md):
//   Retry( CircuitBreaker( RateLimiter( TimeLimiter( Bulkhead( pool → network → B → network ))))) + Fallback
// B (service): kernel backlog → Tomcat connection → worker thread → CPU slot (GC-gated) → off-CPU time → downstream calls.

import { mean, sample, type Dist } from './dist';
import { EventQueue, type Action } from './heap';
import { Gauge, Histogram } from './metrics';
import { CLIENT, rpsAt } from './parse';
import { Rng } from './rng';
import type {
  CallSpec,
  CacheOpSpec,
  CacheSpec,
  QueueSpec,
  DbSpec,
  EdgeResult,
  EdgeSpec,
  EndpointResult,
  EndpointSpec,
  ErrorKind,
  ExternalSpec,
  LatencyStats,
  Model,
  NodeResult,
  ParticleTrace,
  ResourceKind,
  ResourceSeries,
  Scenario,
  ServiceSpec,
  StoreOpSpec,
  StoreSpec,
  SimEvent,
  SimResult,
} from './types';
import { ERROR_KINDS, forEachCall } from './types';

export interface SimOptions {
  /** record sampled request paths for the particle view (default true) */
  particles?: boolean;
  /** upper bound on recorded particle traces (default 2500) */
  maxParticles?: number;
  bucketMs?: number;
  /** safety valve against runaway models (default 30M events) */
  maxEvents?: number;
}

interface CallResult {
  ok: boolean;
  kind?: ErrorKind;
  miss?: boolean;
  degraded?: boolean;
  /** where the failure originated, e.g. "payment->payment-db pool_timeout" */
  cause?: string;
  /** cache miss with a keyspace model: call after the reload path finishes to store the entry */
  fill?: (ok: boolean) => void;
}

const OK: CallResult = { ok: true };
const MISS: CallResult = { ok: true, miss: true };
const DEGRADED: CallResult = { ok: true, degraded: true };
const fail = (kind: ErrorKind, cause?: string): CallResult => ({ ok: false, kind, cause });

type Done = (r: CallResult) => void;
const noop = () => {};

// ---------------------------------------------------------------------------
// Resources

interface Meter {
  busy: Gauge;
  wait: Gauge;
}

interface Waiter {
  grant: Action;
  reject: Action;
  done: boolean;
}

class Semaphore implements Meter {
  used = 0;
  waiting = 0;
  busy = new Gauge();
  wait = new Gauge();
  private waiters: Waiter[] = [];
  private head = 0;

  constructor(
    private sim: Sim,
    public cap: number,
  ) {}

  /** Grants synchronously when free; otherwise waits up to maxWait (ms) then rejects. */
  acquire(maxWait: number, grant: Action, reject: Action): void {
    const sim = this.sim;
    if (this.used < this.cap) {
      this.used++;
      this.busy.set(sim.now, this.used);
      grant();
      return;
    }
    if (maxWait <= 0) {
      reject();
      return;
    }
    const w: Waiter = { grant, reject, done: false };
    this.waiters.push(w);
    this.waiting++;
    this.wait.set(sim.now, this.waiting);
    if (Number.isFinite(maxWait)) {
      sim.q.push(sim.now + maxWait, () => {
        if (w.done) return;
        w.done = true;
        this.waiting--;
        this.wait.set(sim.now, this.waiting);
        reject();
      });
    }
  }

  release(): void {
    const sim = this.sim;
    this.used--;
    while (this.head < this.waiters.length) {
      const w = this.waiters[this.head++];
      if (w.done) continue;
      w.done = true;
      this.waiting--;
      this.wait.set(sim.now, this.waiting);
      this.used++;
      sim.q.push(sim.now, w.grant);
      break;
    }
    if (this.head > 1024 && this.head * 2 > this.waiters.length) {
      this.waiters = this.waiters.slice(this.head);
      this.head = 0;
    }
    this.busy.set(sim.now, this.used);
  }
}

class Breaker {
  state: 0 | 1 | 2 = 0; // CLOSED, OPEN, HALF_OPEN
  private ring: Uint8Array;
  private idx = 0;
  private n = 0;
  private fails = 0;
  private slows = 0;
  private openedAt = 0;
  private permits = 0;
  private hDone = 0;
  private hFails = 0;
  private hSlows = 0;
  // time-based window: one slot per second
  private tCalls: Int32Array | null = null;
  private tFails: Int32Array | null = null;
  private tSlows: Int32Array | null = null;
  private tSec: Float64Array | null = null;

  constructor(
    private sim: Sim,
    private edge: EdgeRt,
    private label: string,
  ) {
    const spec = edge.spec.circuitBreaker!;
    this.ring = new Uint8Array(spec.windowType === 'count' ? spec.window : 1);
    if (spec.windowType === 'time') {
      this.tCalls = new Int32Array(spec.window);
      this.tFails = new Int32Array(spec.window);
      this.tSlows = new Int32Array(spec.window);
      this.tSec = new Float64Array(spec.window).fill(-1);
    }
  }

  /** time-based sliding window: calls/failures/slow calls in the last `window` seconds */
  private recordTime(failed: boolean, slow: boolean): void {
    const sec = Math.floor(this.sim.now / 1000);
    const w = this.tSec!.length;
    const slot = sec % w;
    if (this.tSec![slot] !== sec) {
      this.tSec![slot] = sec;
      this.tCalls![slot] = this.tFails![slot] = this.tSlows![slot] = 0;
    }
    this.tCalls![slot]++;
    if (failed) this.tFails![slot]++;
    if (slow) this.tSlows![slot]++;
    let n = 0;
    let f = 0;
    let sl = 0;
    for (let i = 0; i < w; i++) {
      if (this.tSec![i] <= sec - w) continue;
      n += this.tCalls![i];
      f += this.tFails![i];
      sl += this.tSlows![i];
    }
    const s = this.spec;
    if (n >= s.minCalls && (f / n >= s.failureRate || sl / n >= s.slowCallRate)) this.transition(1);
  }

  private get spec() {
    return this.edge.spec.circuitBreaker!;
  }

  tryAcquire(): boolean {
    if (this.state === 1) {
      if (this.sim.now - this.openedAt < this.spec.openFor) return false;
      this.transition(2);
    }
    if (this.state === 2) {
      if (this.permits <= 0) return false;
      this.permits--;
    }
    return true;
  }

  record(failed: boolean, slow: boolean): void {
    const s = this.spec;
    if (this.state === 1) return;
    if (this.state === 2) {
      this.hDone++;
      if (failed) this.hFails++;
      if (slow) this.hSlows++;
      if (this.hDone >= s.halfOpenCalls) {
        const bad = this.hFails / this.hDone >= s.failureRate || this.hSlows / this.hDone >= s.slowCallRate;
        this.transition(bad ? 1 : 0);
      }
      return;
    }
    if (this.tSec) return this.recordTime(failed, slow);
    const v = (failed ? 1 : 0) | (slow ? 2 : 0);
    if (this.n === this.ring.length) {
      const old = this.ring[this.idx];
      if (old & 1) this.fails--;
      if (old & 2) this.slows--;
    } else this.n++;
    this.ring[this.idx] = v;
    this.idx = (this.idx + 1) % this.ring.length;
    if (failed) this.fails++;
    if (slow) this.slows++;
    if (this.n >= s.minCalls && (this.fails / this.n >= s.failureRate || this.slows / this.n >= s.slowCallRate)) {
      this.transition(1);
    }
  }

  private transition(to: 0 | 1 | 2): void {
    const sim = this.sim;
    const from = this.state;
    if (from === to) return;
    const e = this.edge;
    if (from === 1) e.cbOpen.add(sim.now, -1);
    if (from === 2) e.cbHalf.add(sim.now, -1);
    if (to === 1) e.cbOpen.add(sim.now, 1);
    if (to === 2) e.cbHalf.add(sim.now, 1);
    this.state = to;
    if (to === 1) this.openedAt = sim.now;
    if (to === 2) {
      this.permits = this.spec.halfOpenCalls;
      this.hDone = this.hFails = this.hSlows = 0;
    }
    if (to === 0) {
      this.ring.fill(0);
      this.idx = this.n = this.fails = this.slows = 0;
      this.tSec?.fill(-1);
    }
    const names = ['CLOSED', 'OPEN', 'HALF_OPEN'];
    sim.event('cb', e.spec.key, `${this.label}: ${names[from]} → ${names[to]}`);
  }
}

class RateLimiterRt {
  private granted = 0;
  constructor(private spec: NonNullable<EdgeSpec['rateLimiter']>) {}

  /** delay until the permit is usable, or -1 if it would exceed the wait timeout */
  acquire(now: number): number {
    const { limit, period, timeout } = this.spec;
    const k = Math.max(this.granted, Math.floor(now / period) * limit);
    const availAt = Math.floor(k / limit) * period;
    const delay = Math.max(0, availAt - now);
    if (delay > timeout) return -1;
    this.granted = k + 1;
    return delay;
  }
}

// ---------------------------------------------------------------------------
// Runtime structures

interface Inst {
  svc: SvcRt;
  idx: number;
  label: string;
  threads: Semaphore;
  cpu: Semaphore;
  cpuScale: number;
  async: Semaphore;
  conns: number;
  backlog: Action[];
  backlogHead: number;
  backlogGauge: Gauge;
  backlogMeter: Meter;
  pausedUntil: number;
  young: number;
  old: number;
  /** webflux event loops / virtual-thread carriers; null for tomcat */
  lanes: Semaphore | null;
  /** cgroup CFS accounting */
  periodIdx: number;
  periodUsed: number;
  fd: Gauge;
  fdUsed: number;
  ports: Gauge;
  portsUsed: number;
  healthy: boolean;
  hcFails: number;
  hcOks: number;
  /** WebSocket sessions held by this instance */
  sessions: Set<Session>;
  /** mesh outlier detection */
  consecutiveErrors: number;
  ejectedUntil: number;
  ejections: number;
  /** per outgoing edge state, indexed by edge id */
  edges: (EdgeInstRt | undefined)[];
}

interface SvcRt {
  kind: 'service';
  spec: ServiceSpec;
  index: number;
  insts: Inst[];
  rr: number;
  gcPause: number;
  gcCount: number;
  synDrops: number;
  throttled: number;
  served: number;
  rrByCaller: Map<string, number>;
  wsConnects: number;
  wsDrops: number;
}

interface DbRt {
  kind: 'db';
  spec: DbSpec;
  index: number;
  /** shard s owns members s·(1+replicas) .. s·(1+replicas)+replicas; each member runs its own queries */
  members: Semaphore[];
  /** current primary member per shard */
  primaries: number[];
  rr: number[];
  served: number;
}

interface CacheKeyspace {
  spec: CacheOpSpec;
  expires: Float64Array;
  /** keys being reloaded (single flight) → callers waiting for the value */
  loading: Map<number, Done[]>;
}

interface CacheRt {
  kind: 'cache';
  spec: CacheSpec;
  index: number;
  /** one command executor per shard */
  shards: Semaphore[];
  served: number;
  spaces: Map<string, CacheKeyspace>;
  b: { hits: number; misses: number; loads: number; waits: number };
}

interface Message {
  t0: number;
  attempts: number;
}

interface QueueRt {
  kind: 'queue';
  spec: QueueSpec;
  index: number;
  served: number;
  msgs: Message[];
  head: number;
  depth: Gauge;
  /** messages delivered and not yet acked */
  unacked: number;
  workers: Meter & { busy: Gauge; wait: Gauge };
  busyWorkers: number;
  /** consumer instances with free listener threads */
  consumers: { inst: Inst; free: number }[];
  rr: number;
  b: { published: number; acked: number; redelivered: number; dlq: number; rebalanceMs: number };
  kafka: KafkaRt | null;
  /** RabbitMQ node currently hosting the queue (leader) */
  rabbitLeader: number;
}

interface KafkaPartition {
  msgs: Message[];
  head: number;
}

interface KafkaThread {
  inst: Inst;
  parts: number[];
  rr: number;
  busy: boolean;
}

interface KafkaRt {
  parts: KafkaPartition[];
  /** current leader broker per partition */
  leaders: number[];
  threads: KafkaThread[];
  /** consumption is stopped until this time (group rebalance) */
  rebalancingUntil: number;
  wakeScheduled: boolean;
  idle: number;
}

interface ExtRt {
  kind: 'external';
  spec: ExternalSpec;
  index: number;
  slots: Semaphore;
  windowStart: number;
  windowCount: number;
  served: number;
  rejected: number;
}

interface StoreRt {
  kind: 'nosql';
  spec: StoreSpec;
  index: number;
  /** request slots per node (instance i = node i) */
  members: Semaphore[];
  /** current primary per partition (leader engines) */
  leaders: number[];
  /** replica members per partition */
  replicas: number[][];
  rr: number;
  served: number;
  /** per-partition request counts in the current second (throughput limits) */
  rateWindow: number;
  reads: Float64Array;
  writes: Float64Array;
  /** requests per partition over the whole run (hot partition detection) */
  hits: Float64Array;
  b: { throttled: number; rejected: number; unavailable: number };
}

type NodeRt = SvcRt | DbRt | CacheRt | ExtRt | QueueRt | StoreRt;

interface EdgeInstRt {
  cb: Breaker | null;
  bulkhead: Semaphore | null;
  pool: Semaphore | null;
  rl: RateLimiterRt | null;
}

interface EdgeRt {
  id: number;
  spec: EdgeSpec;
  target: NodeRt;
  callerInstances: number;
  cbOpen: Gauge;
  cbHalf: Gauge;
  b: { attempts: number; retries: number; failures: number };
  tot: { attempts: number; calls: number; retries: number; timeouts: number; failures: number; fallbacks: number; cbRejected: number; meshRetries: number };
  series: EdgeResult['series'];
  /** state for calls whose caller is the external client */
  clientState?: EdgeInstRt;
}

interface Root {
  id: number;
  t0: number;
  ep: EpStats;
  path: number[] | null;
  /** WebSocket connect attempt this request belongs to */
  session?: Session;
}

interface Session {
  id: number;
  inst: Inst | null;
  /** instance that served the handshake (becomes `inst` when the upgrade succeeds) */
  pending: Inst | null;
  attempts: number;
  /** bumps on every (re)connect so stale message timers stop */
  epoch: number;
}

interface Ctx {
  root: Root;
  parent: Ctx | null;
  detached: boolean;
}

interface Token {
  settled: boolean;
  connDeadline: number;
  /** instance that took the request (set by the serving side; used for mesh outlier detection) */
  inst?: Inst;
  /** instances already tried by mesh retries (Envoy previous_hosts predicate) */
  avoid?: Inst[];
  /** zone of the calling member (for zone-aware routing and cross-zone latency) */
  fromZone?: string | null;
  /** the caller's own load-balancer state (round-robin counters are per caller, not global) */
  caller?: string;
  /** zone of the member that served the call */
  zone?: string | null;
}

interface EpStats {
  id: string;
  node: string;
  op: string;
  entry: boolean;
  window: Histogram;
  count: number;
  ok: number;
  errors: number;
  degraded: number;
  rlWindow: number;
  rlCount: number;
  // entry endpoints only
  bOk?: number[];
  bDeg?: number[];
  bErr?: number[];
  bHist?: (Histogram | undefined)[];
}

interface ResourceRt {
  series: ResourceSeries;
  meters: Meter[];
}

interface ActiveFault {
  latencyX: number;
  errorRate: number;
  down: boolean;
  /** when the current down period began (for failover / election timing) */
  downSince: number;
  hang: boolean;
  loss: number;
  pause: boolean;
}

const NO_FAULT: ActiveFault = { latencyX: 1, errorRate: 0, down: false, downSince: Infinity, hang: false, loss: 0, pause: false };

// GC model constants (see docs/architecture.md#gc)
const YOUNG_RATIO = 0.3;
const OLD_RATIO = 0.65;
const LIVE_RATIO = 0.25;
const PROMOTION = 0.03;
const SYN_RETRIES = 6;

/**
 * DB latency multiplier at concurrency c. Two points (c=1 → 1×, c=saturation → latencyX×) joined by a power curve;
 * past saturation latency grows linearly with c, i.e. throughput plateaus (the server is busy, not collapsing).
 */
export function contention(c: number, saturation: number, latencyX: number, shape: number, retrograde = 0): number {
  if (c <= saturation) return 1 + (latencyX - 1) * Math.pow(Math.max(0, c - 1) / (saturation - 1), shape);
  // optional retrograde (coherency) term: past saturation each extra query also slows the others down
  return ((latencyX * c) / saturation) * (1 + (retrograde * (c - saturation)) / saturation);
}

// ---------------------------------------------------------------------------

class Sim {
  now = 0;
  q = new EventQueue();
  rng: Rng;
  private netRng: Rng;
  private svcRng: Rng;
  private trafficRng: Rng;

  private nodes = new Map<string, NodeRt>();
  private nodeOrder: string[] = [];
  private edges = new Map<string, EdgeRt>();
  private edgeList: EdgeRt[] = [];
  private eps = new Map<string, EpStats>();
  private resources: ResourceRt[] = [];
  private events: SimEvent[] = [];
  private eventCount = 0;

  private bucketMs: number;
  private buckets: number;
  private bucket = 0;
  private series: SimResult['series'];
  private bHist: (Histogram | undefined)[] = [];
  private bArrivals: number[];
  private bDegraded: number[];
  private winHist = new Histogram();
  private win = { count: 0, ok: 0, errors: 0, degraded: 0 };
  private causes = new Map<string, number>();
  private nodeSeries = new Map<string, NodeResult>();

  private roots = new Map<number, Root>();
  private rootSeq = 0;
  private sampleEvery = 1;
  private traces: ParticleTrace[] = [];
  private entryCalls: { call: CallSpec; weight: number; ep: EpStats }[] = [];
  private callTargets = new Map<CallSpec, { edge: EdgeRt; reqSize: number; respSize: number }>();
  private faultIndex = new Map<string, Scenario['faults']>();
  /** faults that take down a whole zone ("*" target) */
  private zoneFaults: Scenario['faults'] = [];
  /** services whose pods run a mesh sidecar */
  private meshPods = new Set<string>();
  private faultCache = new Map<string, { t: number; f: ActiveFault }>();
  private warmup: number;

  constructor(
    private model: Model,
    private sc: Scenario,
    seed: number,
    private opts: Required<SimOptions>,
  ) {
    this.rng = new Rng(seed);
    this.netRng = this.rng.fork('network');
    this.svcRng = this.rng.fork('service');
    this.trafficRng = this.rng.fork('traffic');
    this.bucketMs = opts.bucketMs;
    this.buckets = Math.ceil(sc.duration / this.bucketMs);
    this.warmup = Math.min(sc.warmup, sc.duration * 0.9);
    const z = () => new Array<number>(this.buckets).fill(0);
    this.series = {
      arrivals: z(),
      throughput: z(),
      errors: z(),
      degraded: z(),
      errorRate: z(),
      p50: z(),
      p95: z(),
      p99: z(),
      byKind: Object.fromEntries(ERROR_KINDS.map((k) => [k, z()])) as Record<ErrorKind, number[]>,
    };
    this.bArrivals = this.series.arrivals;
    this.bDegraded = this.series.degraded;
    this.build();
  }

  event(type: SimEvent['type'], target: string, detail: string): void {
    if (this.events.length < 5000) this.events.push({ t: this.now, type, target, detail });
  }

  // -------------------------------------------------------------------------
  // Construction

  private resource(kind: ResourceKind, node: string, label: string, capacity: number, meters: Meter[], edge?: string, member?: string): void {
    const series: ResourceSeries = {
      id: (edge ? `${edge}:${kind}` : `${node}:${kind}`) + (member ? `#${member}` : ''),
      kind,
      node,
      edge,
      member,
      label,
      capacity,
      util: [],
      queue: [],
      queueMax: [],
    };
    this.resources.push({ series, meters });
  }

  private build(): void {
    const m = this.model;
    let index = 0;
    for (const spec of Object.values(m.nodes)) {
      const i = index++;
      this.nodeOrder.push(spec.name);
      const z = () => new Array<number>(this.buckets).fill(0);
      const nr: NodeResult = { name: spec.name, kind: spec.kind, instances: 1, saturation: z(), served: z() };
      this.nodeSeries.set(spec.name, nr);
      switch (spec.kind) {
        case 'service': {
          const svc: SvcRt = { kind: 'service', spec, index: i, insts: [], rr: 0, gcPause: 0, gcCount: 0, synDrops: 0, throttled: 0, served: 0, rrByCaller: new Map(), wsConnects: 0, wsDrops: 0 };
          const cpuCap = Math.max(1, Math.round(spec.vcpu));
          const laneCap = spec.model === 'webflux' ? spec.eventLoops : spec.model === 'virtual' ? cpuCap : 0;
          for (let k = 0; k < spec.instances; k++) {
            const backlogGauge = new Gauge();
            svc.insts.push({
              svc,
              idx: k,
              label: spec.instances > 1 ? `${spec.name}#${k + 1}` : spec.name,
              // webflux / virtual threads do not park a platform thread per request
              threads: new Semaphore(this, spec.model === 'tomcat' ? spec.threads : Infinity),
              cpu: new Semaphore(this, cpuCap),
              cpuScale: cpuCap / spec.vcpu,
              async: new Semaphore(this, spec.asyncThreads),
              conns: 0,
              backlog: [],
              backlogHead: 0,
              backlogGauge,
              backlogMeter: { busy: backlogGauge, wait: new Gauge() },
              pausedUntil: 0,
              young: 0,
              old: spec.heapMb * LIVE_RATIO,
              lanes: laneCap ? new Semaphore(this, laneCap) : null,
              periodIdx: -1,
              periodUsed: 0,
              fd: new Gauge(),
              fdUsed: 0,
              ports: new Gauge(),
              portsUsed: 0,
              healthy: true,
              hcFails: 0,
              hcOks: 0,
              sessions: new Set(),
              consecutiveErrors: 0,
              ejectedUntil: 0,
              ejections: 0,
              edges: [],
            });
          }
          nr.instances = spec.instances;
          if (this.sc.websocket?.service === spec.name) nr.ws = { connections: z(), maxPerInstance: z(), minPerInstance: z(), connects: z(), drops: z() };
          nr.os = {
            cpu: z(),
            gcPauseMs: z(),
            backlog: z(),
            synDrops: z(),
            gcCount: z(),
            throttledMs: z(),
            fdUsed: z(),
            portsInUse: z(),
            healthy: new Array<number>(this.buckets).fill(spec.instances),
          };
          this.nodes.set(spec.name, svc);
          const n = spec.instances;
          if (spec.model === 'tomcat')
            this.resource('threads', spec.name, `워커 스레드 (${spec.threads}×${n})`, spec.threads * n, svc.insts.map((x) => x.threads));
          else
            this.resource(
              'loop',
              spec.name,
              spec.model === 'webflux' ? `이벤트 루프 (${laneCap}×${n})` : `캐리어 스레드 (${laneCap}×${n})`,
              laneCap * n,
              svc.insts.map((x) => x.lanes!),
            );
          this.resource('fd', spec.name, `파일 디스크립터 (ulimit ${spec.ulimit})`, spec.ulimit * n, svc.insts.map((x) => ({ busy: x.fd, wait: new Gauge() })));
          this.resource('ports', spec.name, `임시 포트 (${spec.ephemeralPorts})`, spec.ephemeralPorts * n, svc.insts.map((x) => ({ busy: x.ports, wait: new Gauge() })));
          this.resource('cpu', spec.name, `CPU (${spec.vcpu} vCPU×${n})`, cpuCap * n, svc.insts.map((x) => x.cpu));
          const backlogCap = Math.min(spec.acceptCount, spec.somaxconn);
          this.resource('backlog', spec.name, `커널 backlog (${backlogCap}×${n})`, Math.max(1, backlogCap) * n, svc.insts.map((x) => x.backlogMeter));
          if (Object.values(spec.endpoints).some((e) => {
            let a = false;
            forEachCall(e.calls, (c) => (a ||= c.async));
            return a;
          }))
            this.resource('async', spec.name, `@Async 풀 (${spec.asyncThreads}×${n})`, spec.asyncThreads * n, svc.insts.map((x) => x.async));
          break;
        }
        case 'db': {
          const per = 1 + spec.cluster.replicas;
          const shards = spec.cluster.shards;
          const count = shards * per;
          const db: DbRt = {
            kind: 'db',
            spec,
            index: i,
            members: Array.from({ length: count }, () => new Semaphore(this, spec.maxConnections)),
            primaries: Array.from({ length: shards }, (_, s) => s * per),
            rr: new Array(shards).fill(0),
            served: 0,
          };
          this.nodes.set(spec.name, db);
          if (count === 1) this.resource('db', spec.name, `동시 쿼리 (포화점 ${spec.contention.saturation})`, spec.contention.saturation, [db.members[0]]);
          else
            db.members.forEach((m, k) => {
              const sh = Math.floor(k / per);
              const role = k % per === 0 ? 'primary' : `replica-${k % per}`;
              const member = shards > 1 ? `shard-${sh}-${role}` : role;
              this.resource('db', spec.name, `${member} 동시 쿼리 (포화점 ${spec.contention.saturation})`, spec.contention.saturation, [m], undefined, member);
            });
          nr.instances = count;
          break;
        }
        case 'cache': {
          const c: CacheRt = {
            kind: 'cache',
            spec,
            index: i,
            shards: Array.from({ length: spec.cluster.shards }, () => new Semaphore(this, spec.threads)),
            served: 0,
            spaces: new Map(),
            b: { hits: 0, misses: 0, loads: 0, waits: 0 },
          };
          this.nodes.set(spec.name, c);
          nr.cache = { hits: z(), misses: z(), loads: z(), waits: z() };
          if (spec.cluster.shards === 1) this.resource('cache', spec.name, `명령 처리 스레드 (${spec.threads})`, spec.threads, [c.shards[0]]);
          else c.shards.forEach((sh, k) => this.resource('cache', spec.name, `shard ${k} 명령 처리 (${spec.threads})`, spec.threads, [sh], undefined, `shard-${k}`));
          nr.instances = spec.cluster.shards;
          break;
        }
        case 'nosql': {
          const per = spec.replication;
          const replicas = Array.from({ length: spec.partitions }, (_, p) =>
            Array.from({ length: per }, (_, j) => (spec.placement === 'group' ? p * per + j : (p + j) % spec.nodes)),
          );
          const st: StoreRt = {
            kind: 'nosql',
            spec,
            index: i,
            members: Array.from({ length: spec.nodes }, () => new Semaphore(this, spec.concurrency)),
            leaders: replicas.map((r) => r[0]),
            replicas,
            rr: 0,
            served: 0,
            rateWindow: -1,
            reads: new Float64Array(spec.partitions),
            writes: new Float64Array(spec.partitions),
            hits: new Float64Array(spec.partitions),
            b: { throttled: 0, rejected: 0, unavailable: 0 },
          };
          this.nodes.set(spec.name, st);
          nr.store = { throttled: z(), rejected: z(), unavailable: z(), hottestPartitionShare: 0 };
          nr.instances = spec.nodes;
          if (Number.isFinite(spec.concurrency)) {
            if (spec.nodes === 1) this.resource('store', spec.name, `동시 처리 (${spec.concurrency})`, spec.concurrency, [st.members[0]]);
            else st.members.forEach((m, k) => this.resource('store', spec.name, `node ${k} 동시 처리 (${spec.concurrency})`, spec.concurrency, [m], undefined, `node-${k}`));
          }
          break;
        }
        case 'external': {
          const e: ExtRt = {
            kind: 'external',
            spec,
            index: i,
            slots: new Semaphore(this, spec.concurrency),
            windowStart: 0,
            windowCount: 0,
            served: 0,
            rejected: 0,
          };
          this.nodes.set(spec.name, e);
          if (Number.isFinite(spec.concurrency))
            this.resource('external', spec.name, `상대 측 동시 처리 (${spec.concurrency})`, spec.concurrency, [e.slots]);
          break;
        }
        case 'queue': {
          const q: QueueRt = {
            kind: 'queue',
            spec,
            index: i,
            served: 0,
            msgs: [],
            head: 0,
            depth: new Gauge(),
            unacked: 0,
            workers: { busy: new Gauge(), wait: new Gauge() },
            busyWorkers: 0,
            consumers: [],
            rr: 0,
            b: { published: 0, acked: 0, redelivered: 0, dlq: 0, rebalanceMs: 0 },
            kafka: spec.kafka
              ? {
                  parts: Array.from({ length: spec.kafka.partitions }, () => ({ msgs: [], head: 0 })),
                  leaders: Array.from({ length: spec.kafka.partitions }, (_, p) => p % spec.kafka!.brokers),
                  threads: [],
                  rebalancingUntil: 0,
                  wakeScheduled: false,
                  idle: 0,
                }
              : null,
            rabbitLeader: 0,
          };
          this.nodes.set(spec.name, q);
          nr.queue = { depth: z(), published: z(), acked: z(), redelivered: z(), dlq: z(), oldestAgeMs: z() };
          if (spec.kafka) {
            nr.queue.maxPartitionLag = z();
            nr.queue.idleConsumers = z();
            nr.queue.rebalanceMs = z();
          }
          break;
        }
      }
    }

    // queue consumers: listener threads on every instance of the consumer service
    for (const n of this.nodes.values()) {
      if (n.kind !== 'queue' || !n.spec.consumer) continue;
      const svc = this.nodes.get(n.spec.consumer.service) as SvcRt;
      n.consumers = svc.insts.map((inst) => ({ inst, free: n.spec.consumer!.concurrency }));
      if (n.kafka) {
        for (const inst of svc.insts) for (let k = 0; k < n.spec.consumer.concurrency; k++) n.kafka.threads.push({ inst, parts: [], rr: 0, busy: false });
        this.assignPartitions(n);
      }
      const total = n.spec.consumer.concurrency * svc.insts.length;
      this.resource('consumers', n.spec.name, `컨슈머 (${svc.spec.name} ${n.spec.consumer.concurrency}×${svc.insts.length})`, total, [n.workers]);
    }

    for (const spec of Object.values(m.edges)) {
      const z = () => new Array<number>(this.buckets).fill(0);
      const callerNode = spec.from === CLIENT ? null : this.nodes.get(spec.from);
      const callerInstances = callerNode && callerNode.kind === 'service' ? callerNode.spec.instances : 1;
      const e: EdgeRt = {
        id: this.edgeList.length,
        spec,
        target: this.nodes.get(spec.to)!,
        callerInstances,
        cbOpen: new Gauge(),
        cbHalf: new Gauge(),
        b: { attempts: 0, retries: 0, failures: 0 },
        tot: { attempts: 0, calls: 0, retries: 0, timeouts: 0, failures: 0, fallbacks: 0, cbRejected: 0, meshRetries: 0 },
        series: { attempts: z(), retries: z(), failures: z(), cbOpen: z(), cbHalfOpen: z() },
      };
      this.edges.set(spec.key, e);
      this.edgeList.push(e);
      // per caller instance state
      const states: EdgeInstRt[] = [];
      if (callerNode && callerNode.kind === 'service') {
        for (const inst of callerNode.insts) {
          const st = this.edgeInstState(e, inst.label);
          inst.edges[e.id] = st;
          states.push(st);
        }
      } else if (spec.from === CLIENT) {
        e.clientState = this.edgeInstState(e, 'client');
        states.push(e.clientState);
      }
      if (spec.pool) {
        const what = e.target.kind === 'db' ? 'HikariCP 커넥션풀' : 'HTTP 커넥션풀';
        this.resource('pool', spec.from, `${what} → ${spec.to} (${spec.pool.size}×${callerInstances})`, spec.pool.size * callerInstances, states.map((s) => s.pool!), spec.key);
      }
      if (spec.bulkhead) {
        this.resource('bulkhead', spec.from, `Bulkhead → ${spec.to} (${spec.bulkhead.maxConcurrent}×${callerInstances})`, spec.bulkhead.maxConcurrent * callerInstances, states.map((s) => s.bulkhead!), spec.key);
      }
    }

    for (const e of Object.values(m.edges)) if (e.mesh) this.meshPods.add(e.from).add(e.to);

    // endpoint stats
    for (const n of this.nodes.values()) {
      if (n.kind !== 'service') continue;
      for (const op of Object.keys(n.spec.endpoints)) this.epStats(n.spec.name, op);
    }
    for (const mx of this.sc.mix) {
      const ep = this.epStats(mx.ref.node, mx.ref.op);
      ep.entry = true;
      ep.bOk = new Array(this.buckets).fill(0);
      ep.bErr = new Array(this.buckets).fill(0);
      ep.bDeg = new Array(this.buckets).fill(0);
      ep.bHist = [];
      this.entryCalls.push({
        call: { target: mx.ref.node, op: mx.ref.op, prob: 1, count: { kind: 'const', value: 1 }, optional: false, async: false, onMiss: [], parallel: [], work: null, workCpu: 0 },
        weight: mx.weight,
        ep,
      });
    }

    // faults
    for (const f of this.sc.faults) {
      if (f.target === '*') this.zoneFaults.push(f);
      else {
        const list = this.faultIndex.get(f.target) ?? [];
        list.push(f);
        this.faultIndex.set(f.target, list);
      }
      const desc = [
        f.latencyX !== 1 ? `지연 ×${f.latencyX}` : '',
        f.errorRate ? `오류 ${(f.errorRate * 100).toFixed(1)}%` : '',
        f.loss ? `손실 ${(f.loss * 100).toFixed(1)}%` : '',
        f.down ? '단절' : '',
      ]
        .filter(Boolean)
        .join(', ');
      const where = f.target === '*' ? `존 ${f.zone}` : f.zone !== null ? `${f.target} (존 ${f.zone})` : f.instance !== null ? `${f.target}#${f.instance + 1}` : f.target;
      const desc2 = [desc, f.hang ? '무응답' : '', f.flush ? '전체 만료(flush)' : '', f.pause ? '컨슈머 정지' : ''].filter(Boolean).join(', ');
      const target = this.nodes.get(f.target);
      if (f.down && target?.kind === 'queue') {
        const q = target;
        const wake = f.at + (q.spec.kafka?.electionTime ?? q.spec.rabbit?.electionTime ?? 5000) + 1;
        if (wake < this.sc.duration) this.q.push(wake, () => this.dispatch(q));
      }
      if (f.down && target?.kind === 'db' && f.at + target.spec.cluster.failoverTime < this.sc.duration) {
        const db = target;
        this.q.push(f.at + db.spec.cluster.failoverTime, () => this.dbFailover(db));
      }
      const zonal = f.zone !== null;
      const membership = () => {
        if (!f.down) return;
        for (const n of this.nodes.values())
          if (n.kind === 'queue' && n.kafka && (n.spec.consumer?.service === f.target || (zonal && n.spec.consumer && this.model.placement[n.spec.consumer.service]?.includes(f.zone!))))
            this.rebalance(n);
      };
      if (f.down && zonal) {
        // a zone outage hits every member placed there: schedule failovers / elections / consumer wake-ups everywhere
        for (const n of this.nodes.values()) {
          if (n.kind === 'db' && f.at + n.spec.cluster.failoverTime < this.sc.duration) this.q.push(f.at + n.spec.cluster.failoverTime, () => this.dbFailover(n));
          if (n.kind === 'queue') {
            const wake = f.at + (n.spec.kafka?.electionTime ?? n.spec.rabbit?.electionTime ?? 5000) + 1;
            if (wake < this.sc.duration) this.q.push(wake, () => this.dispatch(n));
          }
        }
      }
      if (f.at < this.sc.duration)
        this.q.push(f.at, () => {
          this.event('fault-start', where, desc2);
          if (f.down) this.wsCheckDead();
          if (f.flush && target?.kind === 'cache') this.flushCache(target);
          if (target?.kind === 'queue') this.dispatch(target);
          membership();
        });
      if (f.until < this.sc.duration)
        this.q.push(f.until, () => {
          this.event('fault-end', where, desc2);
          membership();
          // consumers that were paused or down pick up again
          for (const n of this.nodes.values()) if (n.kind === 'queue') this.dispatch(n);
        });
    }

    // particle sampling
    if (this.opts.particles) {
      let expected = 0;
      for (let t = 0; t < this.sc.duration; t += 1000) expected += rpsAt(this.sc.traffic, t) * Math.min(1, (this.sc.duration - t) / 1000);
      this.sampleEvery = Math.max(1, Math.ceil(expected / this.opts.maxParticles));
    }
  }

  private edgeInstState(e: EdgeRt, label: string): EdgeInstRt {
    const s = e.spec;
    return {
      cb: s.circuitBreaker ? new Breaker(this, e, label) : null,
      bulkhead: s.bulkhead ? new Semaphore(this, s.bulkhead.maxConcurrent) : null,
      pool: s.pool ? new Semaphore(this, s.pool.size) : null,
      rl: s.rateLimiter ? new RateLimiterRt(s.rateLimiter) : null,
    };
  }

  private epStats(node: string, op: string): EpStats {
    const id = `${node}:${op}`;
    let s = this.eps.get(id);
    if (!s) {
      s = { id, node, op, entry: false, window: new Histogram(), count: 0, ok: 0, errors: 0, degraded: 0, rlWindow: -1, rlCount: 0 };
      this.eps.set(id, s);
    }
    return s;
  }

  // -------------------------------------------------------------------------
  // Helpers

  private inWindow(t: number): boolean {
    return t >= this.warmup;
  }

  private bucketOf(t: number): number {
    return Math.min(this.buckets - 1, Math.floor(t / this.bucketMs));
  }

  /** Schedule fn after d ms of the instance's own time: a GC pause on the instance freezes it. */
  private after(inst: Inst | null, d: number, fn: Action): void {
    this.q.push(this.now + d, fn, inst);
  }

  /** zone of member `idx` of a node (null without a topology) */
  private memberZone(node: string, idx: number): string | null {
    const z = this.model.placement[node];
    return z && z.length ? z[idx % z.length] : null;
  }

  /** Active faults on a node/edge; `instance` also includes faults scoped to that member (by index or by zone). */
  private fault(target: string, instance = -1): ActiveFault {
    const own = this.faultIndex.get(target);
    const zonal = instance >= 0 ? this.zoneFaults : null;
    const list = zonal?.length ? [...(own ?? []), ...zonal] : own;
    if (!list) return NO_FAULT;
    const key = instance < 0 ? target : `${target}#${instance}`;
    const cached = this.faultCache.get(key);
    if (cached && cached.t === this.now) return cached.f;
    let f = NO_FAULT;
    for (const x of list) {
      if (this.now < x.at || this.now >= x.until) continue;
      if (x.instance !== null && x.instance !== instance) continue;
      if (x.zone !== null && (instance < 0 || (x.target !== '*' && x.target !== target) || this.memberZone(target, instance) !== x.zone)) continue;
      if (f === NO_FAULT) f = { ...NO_FAULT };
      f.latencyX *= x.latencyX;
      f.errorRate = 1 - (1 - f.errorRate) * (1 - x.errorRate);
      f.loss = 1 - (1 - f.loss) * (1 - x.loss);
      if (x.down) f.downSince = Math.min(f.downSince, x.at);
      f.down = f.down || x.down;
      f.hang = f.hang || (x.down && x.hang);
      f.pause = f.pause || x.pause;
    }
    this.faultCache.set(key, { t: this.now, f });
    return f;
  }

  private trace(ctx: Ctx | null, node: number): void {
    if (!ctx || !ctx.root.path) return;
    for (let c: Ctx | null = ctx; c; c = c.parent) if (c.detached) return;
    ctx.root.path!.push(this.now, node);
  }

  private nodeIndex(name: string): number {
    return name === CLIENT ? -1 : this.nodes.get(name)!.index;
  }

  private count(d: Dist): number {
    const v = sample(d, this.svcRng);
    return Math.max(0, d.kind === 'uniform' ? Math.floor(v) : Math.round(v));
  }

  // -------------------------------------------------------------------------
  // Network

  /** One-way network time for a message of `size` bytes on an edge. Infinity = never arrives. */
  private oneWay(e: EdgeRt, size: number, connect: boolean): number {
    const n = e.spec.network;
    const f = this.fault(e.spec.key);
    if (f.down) return Infinity;
    const rng = this.netRng;
    const loss = 1 - (1 - n.loss) * (1 - f.loss);
    let d = (n.rtt / 2) * f.latencyX + (n.jitter > 0 ? rng.exp(n.jitter / 2) : 0) + size / n.bandwidth;
    // service mesh: the message passes the caller's outbound and the callee's inbound sidecar
    if (e.spec.mesh) d += sample(this.model.mesh!.sidecarLatency, rng) * 2;
    if (connect && !n.keepAlive) {
      for (let i = 0; i < n.handshakeRtts; i++) {
        d += n.rtt * f.latencyX;
        // a lost SYN waits for the initial 1s RTO
        if (i === 0 && loss > 0 && rng.chance(loss)) d += 1000;
      }
    }
    if (loss > 0) {
      const segs = Math.max(1, Math.ceil(size / 1460));
      // a loss in the middle of a stream is repaired by fast retransmit (3 duplicate ACKs → +1 RTT);
      // a loss among the last segments (tail loss) has nothing behind it and waits for the RTO
      const tail = Math.min(3, segs);
      const pFast = 1 - Math.pow(1 - loss, segs - tail);
      if (pFast > 0 && rng.chance(pFast)) d += n.rtt * f.latencyX;
      let p = 1 - Math.pow(1 - loss, tail);
      let rto = Math.max(n.rtoMin, n.rtt * 2);
      for (let k = 0; k < 6 && rng.chance(p); k++) {
        d += rto;
        rto *= 2;
        p = loss;
      }
    }
    return d;
  }

  // -------------------------------------------------------------------------
  // Calls across an edge (caller side): resilience policies + network

  private resolve(callerName: string, call: CallSpec): { edge: EdgeRt; reqSize: number; respSize: number } {
    let r = this.callTargets.get(call);
    if (!r) {
      const edge = this.edges.get(`${callerName}->${call.target}`)!;
      const t = edge.target;
      let respSize = 256;
      let reqSize = 256;
      if (t.kind === 'service') {
        const ep = t.spec.endpoints[call.op];
        respSize = ep.responseSize;
        reqSize = ep.requestSize;
      } else if (t.kind === 'db') respSize = (t.spec.queries[call.op] ?? t.spec.defaultQuery).responseSize;
      else if (t.kind === 'queue') respSize = 64;
      else if (t.kind === 'nosql') respSize = (t.spec.ops[call.op] ?? t.spec.defaultOp).write ? 128 : Math.min(1 << 20, (t.spec.ops[call.op] ?? t.spec.defaultOp).size);
      else if (t.kind === 'external') respSize = 1024;
      r = { edge, reqSize, respSize };
      this.callTargets.set(call, r);
    }
    return r;
  }

  private callEdge(inst: Inst | null, callerName: string, call: CallSpec, ctx: Ctx | null, done: Done): void {
    const { edge, reqSize, respSize } = this.resolve(callerName, call);
    const spec = edge.spec;
    const st = inst ? inst.edges[edge.id]! : edge.clientState!;
    const callerIdx = this.nodeIndex(callerName);
    const targetIdx = edge.target.index;
    const timeout = callerName === CLIENT ? Math.min(spec.timeout, this.sc.clientTimeout) : spec.timeout;
    const connectTimeout = Math.min(spec.connectTimeout, timeout);
    edge.tot.calls++;

    const attemptDone = (n: number, res: CallResult) => {
      if (res.ok) return done(res);
      edge.tot.failures++;
      edge.b.failures++;
      const r = spec.retry;
      if (r && n < r.maxAttempts && r.on.includes(res.kind!)) {
        let wait = r.backoff === 'exponential' ? r.wait * Math.pow(r.multiplier, n - 1) : r.wait;
        wait = Math.min(wait, r.maxWait);
        if (r.jitter > 0) wait *= 1 + r.jitter * (2 * this.svcRng.next() - 1);
        this.after(inst, wait, () => attempt(n + 1));
        return;
      }
      if (spec.fallback) {
        edge.tot.fallbacks++;
        this.after(inst, sample(spec.fallback.latency, this.svcRng), () => done(DEGRADED));
        return;
      }
      done(res.cause ? res : fail(res.kind!, `${spec.key} ${res.kind}`));
    };

    const attempt = (n: number) => {
      edge.tot.attempts++;
      edge.b.attempts++;
      if (n > 1) {
        edge.tot.retries++;
        edge.b.retries++;
      }
      if (st.cb && !st.cb.tryAcquire()) {
        edge.tot.cbRejected++;
        this.q.push(this.now, () => attemptDone(n, fail('cb_open')));
        return;
      }
      const cb = st.cb;
      if (st.rl) {
        const delay = st.rl.acquire(this.now);
        if (delay < 0) {
          cb?.record(true, false);
          this.q.push(this.now, () => attemptDone(n, fail('rate_limited')));
          return;
        }
        if (delay > 0) {
          this.after(inst, delay, () => bulkheadStep(n));
          return;
        }
      }
      bulkheadStep(n);
    };

    const bulkheadStep = (n: number) => {
      const bh = st.bulkhead;
      if (!bh) return send(n, null);
      bh.acquire(
        spec.bulkhead!.maxWait,
        () => send(n, bh),
        () => {
          st.cb?.record(true, false);
          this.q.push(this.now, () => attemptDone(n, fail('rejected')));
        },
      );
    };

    const send = (n: number, bh: Semaphore | null) => {
      const t0 = this.now;
      const token: Token = { settled: false, connDeadline: t0 + connectTimeout };
      const attCtx: Ctx | null = ctx ? { root: ctx.root, parent: ctx, detached: false } : null;
      let pooled: Semaphore | null = null;
      // A JDBC connection stays busy until the DB finishes the statement, even if the caller gave up.
      // An HTTP connection is closed on timeout and returns to the pool immediately.
      const holdConnUntilDone = edge.target.kind === 'db';

      let fdHeld = false;
      // eslint-disable-next-line prefer-const
      let settleRef: (res: CallResult) => void;
      const settle = (res: CallResult) => {
        if (token.settled) return;
        token.settled = true;
        if (fdHeld && inst) {
          inst.fdUsed--;
          inst.fd.set(this.now, inst.fdUsed);
        }
        if (pooled && !holdConnUntilDone) {
          pooled.release();
          pooled = null;
        }
        if (bh) bh.release();
        const dur = this.now - t0;
        if (res.kind === 'timeout') edge.tot.timeouts++;
        st.cb?.record(!res.ok, dur >= (spec.circuitBreaker?.slowCall ?? Infinity));
        if (attCtx) {
          if (!res.ok) attCtx.detached = true;
          this.trace(ctx, callerIdx);
        }
        attemptDone(n, res);
      };

      settleRef = settle;
      if (Number.isFinite(timeout)) this.after(inst, timeout, () => settleRef(fail('timeout')));

      if (inst) {
        const os = inst.svc.spec;
        if (inst.fdUsed >= os.ulimit) {
          this.q.push(this.now, () => settle(fail('conn', `${inst.label} EMFILE (ulimit -n ${os.ulimit})`)));
          return;
        }
        if (!spec.network.keepAlive) {
          // every call opens a new connection whose local port then sits in TIME_WAIT
          if (inst.portsUsed >= os.ephemeralPorts) {
            this.q.push(this.now, () => settle(fail('conn', `${inst.label} EADDRNOTAVAIL (임시 포트 고갈)`)));
            return;
          }
          inst.portsUsed++;
          inst.ports.set(this.now, inst.portsUsed);
          const releasePort = () =>
            this.q.push(this.now + os.timeWait, () => {
              inst.portsUsed--;
              inst.ports.set(this.now, inst.portsUsed);
            });
          const inner = settle;
          let portReleased = false;
          const wrapped = (res: CallResult) => {
            if (!portReleased && !token.settled) {
              portReleased = true;
              releasePort();
            }
            inner(res);
          };
          settleRef = wrapped;
        }
        inst.fdUsed++;
        inst.fd.set(this.now, inst.fdUsed);
        fdHeld = true;
      }

      // mesh sidecar retries happen inside this application attempt, each try with its own per-try timeout
      const meshRetry = spec.mesh ? this.model.mesh?.retries ?? null : null;
      const tried: Inst[] = [];
      const fromZone = inst ? this.memberZone(inst.svc.spec.name, inst.idx) : null;
      token.fromZone = fromZone;
      token.caller = inst ? inst.label : CLIENT;
      const transmit = (k = 1) => {
        const tryToken: Token = meshRetry ? { settled: false, connDeadline: token.connDeadline, avoid: tried, fromZone, caller: token.caller } : token;
        let tryDone = false;
        const finishTry = (res: CallResult) => {
          if (tryDone || token.settled) return;
          tryDone = true;
          if (meshRetry) tryToken.settled = true;
          if (spec.mesh) this.outlierRecord(tryToken.inst, res.ok);
          if (tryToken.inst) tried.push(tryToken.inst);
          if (!res.ok && meshRetry && k < meshRetry.attempts && meshRetry.on.includes(res.kind!)) {
            edge.tot.meshRetries++;
            this.after(inst, meshRetry.backoff * (0.5 + this.netRng.next()), () => {
              if (!token.settled) transmit(k + 1);
            });
            return;
          }
          settleRef(res);
        };
        if (meshRetry && Number.isFinite(meshRetry.perTryTimeout)) this.after(inst, meshRetry.perTryTimeout, () => finishTry(fail('timeout')));
        const out = this.oneWay(edge, reqSize, true);
        if (!Number.isFinite(out)) {
          // partition: SYN never answered → connect timeout (or hang forever, like a real client without one)
          if (Number.isFinite(connectTimeout)) this.after(inst, connectTimeout, () => finishTry(fail('conn')));
          return;
        }
        this.trace(attCtx, targetIdx);
        this.q.push(this.now + out, () =>
          this.serve(edge.target, call.op, attCtx, tryToken, (res) => {
            if (pooled && holdConnUntilDone) {
              pooled.release();
              pooled = null;
            }
            let back = this.oneWay(edge, res.ok ? respSize : 200, false);
            // crossing availability zones costs a round trip's worth of extra latency
            const topo = this.model.topology;
            if (topo && fromZone && tryToken.zone && tryToken.zone !== fromZone) back += topo.crossZoneRtt;
            if (Number.isFinite(back)) this.q.push(this.now + back, () => finishTry(res));
          }),
        );
      };

      const pool = st.pool;
      if (pool) {
        pool.acquire(
          spec.pool!.timeout,
          () => {
            if (token.settled) {
              // the attempt already timed out while waiting; give the connection back
              pool.release();
              return;
            }
            pooled = pool;
            transmit(1);
          },
          () => settleRef(fail('pool_timeout')),
        );
      } else transmit(1);
    };

    attempt(1);
  }

  // -------------------------------------------------------------------------
  // Serving side

  private serve(node: NodeRt, op: string, ctx: Ctx | null, token: Token, done: Done): void {
    switch (node.kind) {
      case 'service':
        return this.serveService(node, op, ctx, token, done);
      case 'db':
        return this.serveDb(node, op, token, done);
      case 'cache':
        return this.serveCache(node, op, token, done);
      case 'external':
        return this.serveExternal(node, done);
      case 'nosql':
        return this.serveStore(node, op, token, done);
      case 'queue':
        return this.serveQueue(node, done);
    }
  }

  private pick(svc: SvcRt, avoid?: Inst[], fromZone?: string | null, caller = ''): Inst {
    let insts = svc.insts;
    if (insts.length === 1) return insts[0];
    // topology-aware routing: stay in the caller's zone when a healthy local instance exists
    if (fromZone && this.model.topology?.zoneAware) {
      const local = insts.filter((x) => this.memberZone(svc.spec.name, x.idx) === fromZone && x.healthy && x.ejectedUntil <= this.now && !this.fault(svc.spec.name, x.idx).down);
      if (local.length) insts = local;
    }
    if (avoid?.length) {
      const fresh = insts.filter((x) => !avoid.includes(x));
      if (fresh.length) insts = fresh;
    }
    // the load balancer only knows what health checks told it
    if (svc.spec.healthCheck) {
      const up = insts.filter((x) => x.healthy);
      if (up.length) insts = up;
    }
    // hosts ejected by mesh outlier detection
    if (this.model.mesh?.outlier) {
      const ok = insts.filter((x) => x.ejectedUntil <= this.now);
      if (ok.length) insts = ok;
    }
    if (insts.length === 1) return insts[0];
    if (svc.spec.lb === 'random') return insts[Math.floor(this.netRng.next() * insts.length)];
    if (svc.spec.lb === 'p2c') {
      // power of two choices: pick two at random, keep the less busy one
      const a = insts[Math.floor(this.netRng.next() * insts.length)];
      const b = insts[Math.floor(this.netRng.next() * insts.length)];
      return a.conns + a.sessions.size <= b.conns + b.sessions.size ? a : b;
    }
    if (svc.spec.lb === 'least-conn') {
      let best = insts[0];
      // open WebSocket connections count as connections too
      for (const x of insts) if (x.conns + x.sessions.size < best.conns + best.sessions.size) best = x;
      return best;
    }
    const n = svc.rrByCaller.get(caller) ?? 0;
    svc.rrByCaller.set(caller, n + 1);
    return insts[n % insts.length];
  }

  /** Envoy-style passive health checking: consecutive errors eject a host for a growing time. */
  private outlierRecord(inst: Inst | undefined, ok: boolean): void {
    const o = this.model.mesh?.outlier;
    if (!o || !inst) return;
    if (ok) {
      inst.consecutiveErrors = 0;
      return;
    }
    if (++inst.consecutiveErrors < o.consecutiveErrors || inst.ejectedUntil > this.now) return;
    const all = inst.svc.insts;
    const ejected = all.filter((x) => x.ejectedUntil > this.now).length;
    if (ejected + 1 > Math.max(1, Math.floor(o.maxEjectionPercent * all.length))) return;
    inst.ejections++;
    inst.ejectedUntil = this.now + o.ejectionTime * inst.ejections;
    inst.consecutiveErrors = 0;
    this.event('eject', inst.svc.spec.name, `${inst.label} 연속 오류로 ${(o.ejectionTime * inst.ejections / 1000).toFixed(0)}초 제외 (outlier detection)`);
  }

  /** Periodic LB health probes: an instance leaves rotation after `threshold` failures, returns after `riseThreshold` successes. */
  private startHealthChecks(): void {
    for (const n of this.nodes.values()) {
      if (n.kind !== 'service' || !n.spec.healthCheck) continue;
      const hc = n.spec.healthCheck;
      for (const inst of n.insts) {
        const probe = () => {
          const f = this.fault(n.spec.name, inst.idx);
          const ok = !f.down;
          if (ok) {
            inst.hcFails = 0;
            inst.hcOks++;
            if (!inst.healthy && inst.hcOks >= hc.riseThreshold) {
              inst.healthy = true;
              this.event('health', n.spec.name, `${inst.label} 로드밸런서에 복귀`);
            }
          } else {
            inst.hcOks = 0;
            inst.hcFails++;
            if (inst.healthy && inst.hcFails >= hc.threshold) {
              inst.healthy = false;
              this.event('health', n.spec.name, `${inst.label} 헬스체크 ${hc.threshold}회 실패 → 제외`);
            }
          }
          if (this.now + hc.interval < this.sc.duration) this.q.push(this.now + hc.interval, probe);
        };
        // probes of different instances are not aligned
        this.q.push(hc.interval * (inst.idx + 1) / (n.insts.length + 1), probe);
      }
    }
  }

  private serveService(svc: SvcRt, op: string, ctx: Ctx | null, token: Token, done: Done): void {
    const inst = this.pick(svc, token.avoid, token.fromZone, token.caller);
    token.inst = inst;
    token.zone = this.memberZone(svc.spec.name, inst.idx);
    const f = this.fault(svc.spec.name, inst.idx);
    if (f.down) {
      // a crashed process refuses connections; a hung one accepts and never answers (caller's timeout decides)
      if (!f.hang) this.q.push(this.now, () => done(fail('conn', `${inst.label} down`)));
      return;
    }
    const ep = svc.spec.endpoints[op];
    this.admit(
      inst,
      token,
      0,
      () =>
        this.runEndpoint(inst, ep, ctx, true, (res) => {
          this.releaseConn(inst);
          done(res);
        }),
      (why) => done(fail('conn', `${inst.label} ${why}`)),
    );
  }

  /** Kernel socket queue: Tomcat connection slots → listen backlog → SYN drop with exponential retransmit. */
  private admit(inst: Inst, token: Token, k: number, accept: Action, reject: (why: string) => void): void {
    const s = inst.svc.spec;
    if (inst.conns < s.maxConnections) {
      if (inst.fdUsed >= s.ulimit) {
        // accept() fails with EMFILE; the client sees a reset
        this.q.push(this.now, () => reject(`EMFILE (ulimit -n ${s.ulimit})`));
        return;
      }
      inst.conns++;
      inst.fdUsed++;
      inst.fd.set(this.now, inst.fdUsed);
      accept();
      return;
    }
    const cap = Math.min(s.acceptCount, s.somaxconn);
    if (inst.backlog.length - inst.backlogHead < cap) {
      inst.backlog.push(accept);
      inst.backlogGauge.set(this.now, inst.backlog.length - inst.backlogHead);
      return;
    }
    inst.svc.synDrops++;
    if (token.settled) {
      this.q.push(this.now, () => reject('SYN drop'));
      return;
    }
    // client retransmits the SYN after 1s, 2s, 4s, ... until its connect timeout
    const delay = 1000 * Math.pow(2, k);
    if (k >= SYN_RETRIES || this.now + delay > token.connDeadline) {
      this.q.push(Math.max(this.now, Math.min(this.now + delay, token.connDeadline)), () => reject('SYN drop (backlog 가득)'));
      return;
    }
    this.q.push(this.now + delay, () => this.admit(inst, token, k + 1, accept, reject));
  }

  private releaseConn(inst: Inst): void {
    inst.conns--;
    inst.fdUsed--;
    inst.fd.set(this.now, inst.fdUsed);
    if (inst.backlogHead < inst.backlog.length) {
      const next = inst.backlog[inst.backlogHead++];
      if (inst.backlogHead > 1024 && inst.backlogHead * 2 > inst.backlog.length) {
        inst.backlog = inst.backlog.slice(inst.backlogHead);
        inst.backlogHead = 0;
      }
      inst.backlogGauge.set(this.now, inst.backlog.length - inst.backlogHead);
      inst.conns++;
      inst.fdUsed++;
      inst.fd.set(this.now, inst.fdUsed);
      this.q.push(this.now, next);
    }
  }

  private allocate(inst: Inst, mb: number): void {
    const s = inst.svc.spec;
    inst.young += mb;
    const youngCap = s.heapMb * YOUNG_RATIO;
    if (inst.young < youngCap) return;
    inst.young = 0;
    inst.old += youngCap * PROMOTION;
    let pause = sample(s.youngGc, this.svcRng);
    if (inst.old + inst.sessions.size * (this.sc.websocket?.connMemory ?? 0) >= s.heapMb * OLD_RATIO) {
      const p = sample(s.oldGc, this.svcRng);
      pause += p;
      inst.old = s.heapMb * LIVE_RATIO;
      this.event('gc-old', s.name, `${inst.label} old/mixed GC ${p.toFixed(0)}ms`);
    }
    const start = Math.max(this.now, inst.pausedUntil);
    inst.pausedUntil = start + pause;
    inst.svc.gcPause += pause;
    inst.svc.gcCount++;
  }

  private runEndpoint(inst: Inst, ep: EndpointSpec, ctx: Ctx | null, useThreadPool: boolean, done: Done): void {
    const svc = inst.svc;
    const stats = this.eps.get(`${svc.spec.name}:${ep.name}`)!;
    const t0 = this.now;
    svc.served++;
    // per-API rate limit (gateway route limits, Bucket4j): rejected before taking a thread
    if (Number.isFinite(ep.rateLimit)) {
      const w = Math.floor(this.now / 1000);
      if (stats.rlWindow !== w) {
        stats.rlWindow = w;
        stats.rlCount = 0;
      }
      if (++stats.rlCount > ep.rateLimit) {
        stats.count++;
        stats.errors++;
        this.q.push(this.now, () => done(fail('too_many_requests', `${svc.spec.name} ${ep.name} rate limit`)));
        return;
      }
    }

    // WebSocket upgrade: remember which instance will hold this client's connection
    if (ep.handshake && ctx?.root.session) ctx.root.session.pending = inst;

    const finish = (res: CallResult) => {
      if (useThreadPool) inst.threads.release();
      stats.count++;
      if (this.inWindow(this.now)) stats.window.add(this.now - t0);
      if (res.ok) {
        stats.ok++;
        if (res.degraded) stats.degraded++;
        done(res);
      } else {
        stats.errors++;
        // any downstream failure surfaces as HTTP 500 to our caller
        done(res.kind === 'error' ? res : fail('error', res.cause));
      }
    };

    const work = () => {
      this.allocate(inst, ep.alloc);
      const f = this.fault(svc.spec.name, inst.idx);
      // a meshed pod also runs its sidecar (inbound + outbound proxy work) on the same CPU
      const sidecar = this.meshPods.has(svc.spec.name) ? this.model.mesh!.sidecarCpu * 2 : 0;
      const self = sample(ep.selfTime, this.svcRng) * f.latencyX + sidecar;
      const cpu = Math.min(self, (ep.cpu ? sample(ep.cpu, this.svcRng) : (self - sidecar) * ep.cpuRatio) + sidecar);
      const afterCpu = () =>
        this.after(inst, self - cpu, () => {
          if (f.errorRate > 0 && this.svcRng.chance(f.errorRate)) return finish(fail('error', `${svc.spec.name} fault`));
          this.runCalls(inst, ep.calls, ctx, finish);
        });
      if (cpu <= 0) return afterCpu();
      this.compute(inst, cpu, afterCpu);
    };

    if (useThreadPool) inst.threads.acquire(Infinity, work, noop);
    else work();
  }

  /** Run `cpu` ms of work on a core (webflux: on an event loop; virtual threads: on a carrier thread). */
  private compute(inst: Inst, cpu: number, cont: () => void): void {
    const lanes = inst.lanes;
    const onCpu = () =>
      inst.cpu.acquire(
        Infinity,
        () => {
          // context switching: more runnable threads than cores makes every slice more expensive
          const runnable = inst.cpu.used + inst.cpu.waiting;
          const over = runnable / inst.cpu.cap;
          const cs = over > 1 ? 1 + inst.svc.spec.csOverhead * Math.log(over) : 1;
          const used = cpu * cs;
          this.after(inst, used * inst.cpuScale, () => {
            inst.cpu.release();
            lanes?.release();
            this.chargeCpu(inst, used);
            cont();
          });
        },
        noop,
      );
    if (lanes) lanes.acquire(Infinity, onCpu, noop);
    else onCpu();
  }

  /** cgroup CFS quota: once the instance used `cpuLimit × period` of CPU in a period, all of it stalls until the next one. */
  private chargeCpu(inst: Inst, used: number): void {
    const s = inst.svc.spec;
    if (!Number.isFinite(s.cpuLimit)) return;
    const idx = Math.floor(this.now / s.cfsPeriod);
    if (idx !== inst.periodIdx) {
      inst.periodIdx = idx;
      inst.periodUsed = 0;
    }
    inst.periodUsed += used;
    if (inst.periodUsed >= s.cpuLimit * s.cfsPeriod) {
      const end = (idx + 1) * s.cfsPeriod;
      if (end > inst.pausedUntil) {
        inst.svc.throttled += end - Math.max(this.now, inst.pausedUntil);
        inst.pausedUntil = end;
      }
    }
  }

  private runCalls(inst: Inst, calls: CallSpec[], ctx: Ctx | null, done: Done): void {
    let i = 0;
    let reps = -1;
    let rep = 0;
    let degraded = false;
    const name = inst.svc.spec.name;
    const step = (): void => {
      while (i < calls.length) {
        const c = calls[i];
        if (reps < 0) {
          reps = c.prob >= 1 || this.svcRng.chance(c.prob) ? this.count(c.count) : 0;
          rep = 0;
        }
        if (rep >= reps) {
          i++;
          reps = -1;
          continue;
        }
        rep++;
        if (c.work) {
          // local processing between calls: part of it on a core, the rest waiting (I/O-free blocking, locks, serialization)
          const t = sample(c.work, this.svcRng) * this.fault(name, inst.idx).latencyX;
          const cpu = t * c.workCpu;
          const rest = () => this.after(inst, t - cpu, step);
          if (cpu > 0) this.compute(inst, cpu, rest);
          else rest();
          return;
        }
        if (c.parallel.length) {
          // fork every branch, join when all have finished; a failed required branch fails the group
          let left = c.parallel.length;
          let failed: CallResult | null = null;
          for (const branch of c.parallel)
            this.runCalls(inst, [branch], ctx, (r) => {
              if (r.degraded) degraded = true;
              if (!r.ok && !failed) failed = r;
              if (--left > 0) return;
              if (failed && !c.optional) return done(failed);
              step();
            });
          return;
        }
        if (c.async) {
          inst.async.acquire(
            Infinity,
            () => this.callEdge(inst, name, c, null, () => inst.async.release()),
            noop,
          );
          continue;
        }
        // a blocking call parks the event loop (webflux) or, when pinned, the carrier thread (virtual threads)
        const svcSpec = inst.svc.spec;
        const lanes = inst.lanes;
        const holdsLane =
          lanes !== null &&
          this.resolve(name, c).edge.spec.blocking &&
          (svcSpec.model === 'webflux' || (svcSpec.pinning > 0 && this.svcRng.chance(svcSpec.pinning)));
        const call = () =>
          this.callEdge(inst, name, c, ctx, (res) => {
            if (holdsLane) lanes!.release();
            if (res.degraded) degraded = true;
            if (res.ok && res.miss) {
              if (!c.onMiss.length) {
                res.fill?.(true);
                return step();
              }
              this.runCalls(inst, c.onMiss, ctx, (r2) => {
                res.fill?.(r2.ok);
                if (r2.degraded) degraded = true;
                if (!r2.ok && !c.optional) return done(r2);
                step();
              });
              return;
            }
            if (!res.ok && !c.optional) return done(res);
            step();
          });
        if (holdsLane) lanes!.acquire(Infinity, call, noop);
        else call();
        return;
      }
      done(degraded ? DEGRADED : OK);
    };
    step();
  }

  /** Promote an alive replica of a shard once its primary has been down for failoverTime. */
  private dbFailover(db: DbRt): void {
    const name = db.spec.name;
    const per = 1 + db.spec.cluster.replicas;
    for (let sh = 0; sh < db.primaries.length; sh++) {
      const p = this.fault(name, db.primaries[sh]);
      if (!p.down || this.now - p.downSince < db.spec.cluster.failoverTime) continue;
      for (let k = sh * per; k < (sh + 1) * per; k++) {
        if (k === db.primaries[sh] || this.fault(name, k).down) continue;
        this.event('failover', name, `${db.primaries.length > 1 ? `shard ${sh} ` : ''}primary 장애 → member ${k}를 primary로 승격`);
        db.primaries[sh] = k;
        break;
      }
    }
  }

  private serveDb(db: DbRt, op: string, token: Token, done: Done): void {
    const q = db.spec.queries[op] ?? db.spec.defaultQuery;
    this.dbFailover(db);
    const shards = db.primaries.length;
    if (shards > 1 && q.scatter) {
      // cross-shard query: fan out to every shard and wait for the slowest
      let remaining = shards;
      let failed: CallResult | null = null;
      for (let sh = 0; sh < shards; sh++)
        this.serveShard(db, sh, q, token, (res) => {
          if (!res.ok) failed ??= res;
          if (--remaining === 0) done(failed ?? OK);
        });
      return;
    }
    const u = this.svcRng.next();
    const skew = db.spec.cluster.keySkew;
    const sh = shards > 1 ? Math.min(shards - 1, Math.floor(shards * (skew > 0 ? Math.pow(u, 1 + skew * 3) : u))) : 0;
    this.serveShard(db, sh, q, token, done);
  }

  private serveShard(db: DbRt, sh: number, q: DbSpec['defaultQuery'], token: Token, done: Done): void {
    const name = db.spec.name;
    const per = 1 + db.spec.cluster.replicas;
    // reads go to the shard's replicas (round robin over live ones) when read/write splitting is on; writes to its primary
    let member = db.primaries[sh];
    if (q.read && db.spec.cluster.readSplit && per > 1) {
      for (let k = 0; k < per; k++) {
        const cand = sh * per + ((db.rr[sh] + k) % per);
        if (cand === db.primaries[sh] || this.fault(name, cand).down) continue;
        member = cand;
        db.rr[sh] = (cand - sh * per) + 1;
        break;
      }
    }
    token.zone = this.memberZone(name, member);
    const f = this.fault(name, member);
    if (f.down) {
      this.q.push(this.now, () =>
        done(fail('conn', member === db.primaries[sh] && per > 1 ? `${name}${db.primaries.length > 1 ? ` shard ${sh}` : ''} primary 장애 (failover 대기)` : `${name} down`)),
      );
      return;
    }
    db.served++;
    const slots = db.members[member];
    slots.acquire(Infinity, () => {
      const c = slots.used;
      const { saturation, latencyX, shape } = db.spec.contention;
      const mult = contention(c, saturation, latencyX, shape, db.spec.contention.retrograde);
      const lat = sample(q.latency, this.svcRng) * mult * f.latencyX;
      this.q.push(this.now + lat, () => {
        slots.release();
        if (f.errorRate > 0 && this.svcRng.chance(f.errorRate)) done(fail('error', `${name} fault`));
        else done(OK);
      });
    }, noop);
  }

  private serveCache(c: CacheRt, op: string, token: Token, done: Done): void {
    const name = c.spec.name;
    const spec = c.spec.ops[op] ?? c.spec.defaults;
    const keyed = Number.isFinite(spec.ttl);
    // the key decides the hash slot, i.e. the shard (hot keys → hot shard)
    const u = this.svcRng.next();
    const keys = keyed ? spec.keys : 16384;
    const key = Math.min(keys - 1, Math.floor(keys * Math.pow(u, 1 + spec.skew * 3)));
    const shard = c.shards.length > 1 ? key % c.shards.length : 0;
    token.zone = this.memberZone(name, shard);
    const f = this.fault(name, shard);
    // a dead shard is unavailable until a replica takes over (or until it comes back if it has none)
    if (f.down && !(c.spec.cluster.replicas > 0 && this.now - f.downSince >= c.spec.cluster.failoverTime)) {
      this.q.push(this.now, () => done(fail('conn', c.shards.length > 1 ? `${name} shard ${shard} 장애` : `${name} down`)));
      return;
    }
    c.served++;
    const slots = c.shards[shard];
    slots.acquire(Infinity, () => {
      this.q.push(this.now + sample(c.spec.opTime, this.svcRng) * f.latencyX, () => {
        slots.release();
        if (f.errorRate > 0 && this.svcRng.chance(f.errorRate)) return done(fail('error', `${name} fault`));
        if (!keyed) {
          const hit = this.svcRng.chance(spec.hitRate);
          if (hit) c.b.hits++;
          else c.b.misses++;
          return done(hit ? OK : MISS);
        }
        this.lookup(c, op, spec, key, done);
      });
    }, noop);
  }

  private keyspace(c: CacheRt, op: string, spec: CacheOpSpec): CacheKeyspace {
    let ks = c.spaces.get(op);
    if (!ks) {
      // warmed at start: without jitter every entry expires at the same moment
      const expires = new Float64Array(spec.keys);
      for (let i = 0; i < spec.keys; i++) expires[i] = spec.ttl * (1 + spec.ttlJitter * (2 * this.svcRng.next() - 1));
      ks = { spec, expires, loading: new Map() };
      c.spaces.set(op, ks);
    }
    return ks;
  }

  private lookup(c: CacheRt, op: string, spec: CacheOpSpec, key: number, done: Done): void {
    const ks = this.keyspace(c, op, spec);
    if (ks.expires[key] > this.now) {
      c.b.hits++;
      return done(OK);
    }
    const waiters = ks.loading.get(key);
    if (spec.singleFlight && waiters) {
      // someone is already reloading this key: wait for its result instead of hitting the DB
      c.b.waits++;
      waiters.push(done);
      return;
    }
    c.b.misses++;
    if (spec.singleFlight) ks.loading.set(key, []);
    done({
      ok: true,
      miss: true,
      fill: (ok) => {
        if (ok) {
          ks.expires[key] = this.now + spec.ttl * (1 + spec.ttlJitter * (2 * this.svcRng.next() - 1));
          c.b.loads++;
        }
        const w = ks.loading.get(key);
        ks.loading.delete(key);
        if (w) for (const d of w) this.q.push(this.now, () => d(ok ? OK : MISS));
      },
    });
  }

  private flushCache(c: CacheRt): void {
    for (const ks of c.spaces.values()) ks.expires.fill(0);
    // keyspaces not touched yet start empty too
    for (const [op, spec] of Object.entries(c.spec.ops)) if (Number.isFinite(spec.ttl)) this.keyspace(c, op, spec).expires.fill(0);
    this.event('cache-flush', c.spec.name, '모든 항목 만료');
  }

  // -------------------------------------------------------------------------
  // Message queue: publish → broker FIFO → listener threads on consumer instances

  private serveQueue(q: QueueRt, done: Done): void {
    const f = this.fault(q.spec.name);
    if (f.down) {
      this.q.push(this.now, () => done(fail('conn', `${q.spec.name} down`)));
      return;
    }
    q.served++;
    let latency = sample(q.spec.publishTime, this.svcRng) * f.latencyX;
    // replicated writes: acks=all waits for followers; quorum queues for a majority
    if (q.spec.kafka?.acks === 'all' && q.spec.kafka.replicationFactor > 1) latency += sample(q.spec.kafka.replicationTime, this.svcRng);
    if (q.spec.rabbit?.queueType === 'quorum' && q.spec.rabbit.nodes > 1) latency *= 2;
    let partition = 0;
    if (q.kafka) {
      const P = q.kafka.parts.length;
      const skew = q.spec.kafka!.keySkew;
      const u = this.svcRng.next();
      partition = Math.min(P - 1, Math.floor(P * (skew > 0 ? Math.pow(u, 1 + skew * 3) : u)));
    }
    const deadline = this.now + (q.spec.kafka?.deliveryTimeout ?? 5_000);
    const attempt = () => {
      const down = this.unavailable(q, partition, true);
      if (down) {
        // the producer blocks and retries until a leader is back or its delivery timeout passes
        const retry = Math.min(down.retryAt, this.now + 500);
        if (!Number.isFinite(down.retryAt) && !q.kafka) return done(fail('conn', down.reason));
        if (retry > deadline) return this.q.push(Math.max(this.now, deadline), () => done(fail('timeout', down.reason)));
        return this.q.push(retry, attempt);
      }
      publish();
    };
    const publish = () => {
      if (q.spec.capacity > 0 && this.backlog(q) >= q.spec.capacity) {
        return done(fail('rejected', `${q.spec.name} 가득 참`));
      }
      if (q.kafka) {
        const p = partition;
        q.kafka.parts[p].msgs.push({ t0: this.now, attempts: 0 });
        q.b.published++;
        q.depth.set(this.now, this.backlog(q));
        this.dispatch(q);
        return done(OK);
      }
      q.msgs.push({ t0: this.now, attempts: 0 });
      q.b.published++;
      q.depth.set(this.now, q.msgs.length - q.head + q.unacked);
      this.dispatch(q);
      done(OK);
    };
    this.q.push(this.now + latency, attempt);
  }

  /**
   * Broker-side availability. Kafka: per partition — the leader must be alive, or a new leader elected among the
   * replicas after electionTime; with acks=all, fewer in-sync replicas than min.insync.replicas rejects writes.
   * RabbitMQ: classic queues are lost while their node is down; quorum queues need a majority and re-elect a leader.
   * Returns null if available, else { retryAt, reason } (retryAt Infinity = not until something recovers).
   */
  private unavailable(q: QueueRt, partition: number, forWrite: boolean): { retryAt: number; reason: string } | null {
    const name = q.spec.name;
    if (q.kafka) {
      const ks = q.spec.kafka!;
      const B = ks.brokers;
      const replicas = Array.from({ length: Math.min(ks.replicationFactor, B) }, (_, j) => (partition + j) % B);
      const alive = replicas.filter((b) => !this.fault(name, b).down);
      const leader = q.kafka.leaders[partition];
      const lf = this.fault(name, leader);
      if (lf.down) {
        if (!alive.length) return { retryAt: Infinity, reason: `${name} 파티션 ${partition}의 모든 레플리카 장애` };
        const electedAt = lf.downSince + ks.electionTime;
        if (this.now < electedAt) return { retryAt: electedAt, reason: `${name} 파티션 ${partition} 리더 선출 중` };
        q.kafka.leaders[partition] = alive[0];
      }
      if (forWrite && ks.acks === 'all' && alive.length < ks.minInsyncReplicas)
        return { retryAt: Infinity, reason: `${name} NotEnoughReplicas (ISR ${alive.length} < ${ks.minInsyncReplicas})` };
      return null;
    }
    const r = q.spec.rabbit;
    if (!r) return null;
    const lf = this.fault(name, q.rabbitLeader);
    if (r.queueType === 'classic') return lf.down ? { retryAt: Infinity, reason: `${name} 노드 장애 (classic 큐)` } : null;
    let alive = 0;
    for (let k = 0; k < r.nodes; k++) if (!this.fault(name, k).down) alive++;
    if (alive < Math.floor(r.nodes / 2) + 1) return { retryAt: Infinity, reason: `${name} quorum 상실 (${alive}/${r.nodes})` };
    if (lf.down) {
      const electedAt = lf.downSince + r.electionTime;
      if (this.now < electedAt) return { retryAt: electedAt, reason: `${name} quorum 리더 선출 중` };
      for (let k = 0; k < r.nodes; k++)
        if (!this.fault(name, k).down) {
          q.rabbitLeader = k;
          break;
        }
    }
    return null;
  }

  /** messages published and not yet acknowledged (RabbitMQ: ready + unacked; Kafka: total consumer lag) */
  private backlog(q: QueueRt): number {
    if (!q.kafka) return q.msgs.length - q.head + q.unacked;
    let n = 0;
    for (const p of q.kafka.parts) n += p.msgs.length - p.head;
    return n;
  }

  /** Spread partitions over the consumer threads of live instances (round robin); extra threads stay idle. */
  private assignPartitions(q: QueueRt): void {
    const k = q.kafka!;
    const svc = q.spec.consumer!.service;
    const alive = k.threads.filter((t) => !this.fault(svc, t.inst.idx).down);
    for (const t of k.threads) t.parts = [];
    for (let p = 0; p < k.parts.length && alive.length; p++) alive[p % alive.length].parts.push(p);
    k.idle = alive.filter((t) => t.parts.length === 0).length;
  }

  /** Group membership changed: everyone stops consuming for the rebalance, then partitions are reassigned. */
  private rebalance(q: QueueRt): void {
    const k = q.kafka!;
    const until = this.now + q.spec.kafka!.rebalanceTime;
    const start = Math.max(this.now, k.rebalancingUntil);
    k.rebalancingUntil = Math.max(k.rebalancingUntil, until);
    q.b.rebalanceMs += Math.max(0, k.rebalancingUntil - start);
    this.event('rebalance', q.spec.name, `컨슈머 그룹 리밸런스 (${(q.spec.kafka!.rebalanceTime / 1000).toFixed(0)}초 정지)`);
    this.q.push(k.rebalancingUntil, () => {
      if (this.now < k.rebalancingUntil) return;
      this.assignPartitions(q);
      this.dispatch(q);
    });
  }

  private dispatchKafka(q: QueueRt): void {
    const k = q.kafka!;
    const cs = q.spec.consumer!;
    const ks = q.spec.kafka!;
    if (this.now < k.rebalancingUntil) return;
    const svc = q.consumers[0].inst.svc;
    const ep = svc.spec.endpoints[cs.endpoint];
    for (const t of k.threads) {
      if (t.busy || !t.parts.length || this.fault(svc.spec.name, t.inst.idx).down) continue;
      // next assigned partition with records (a thread polls its partitions in turn)
      let pi = -1;
      for (let j = 0; j < t.parts.length; j++) {
        const cand = t.parts[(t.rr + j) % t.parts.length];
        if (k.parts[cand].head < k.parts[cand].msgs.length && !this.unavailable(q, cand, false)) {
          pi = cand;
          t.rr = (t.rr + j + 1) % t.parts.length;
          break;
        }
      }
      if (pi < 0) continue;
      const part = k.parts[pi];
      const msg = part.msgs[part.head];
      t.busy = true;
      q.busyWorkers++;
      q.workers.busy.set(this.now, q.busyWorkers);
      const batch = Math.min(ks.maxPollRecords, part.msgs.length - part.head);
      const overhead = cs.deliveryRtt / batch;
      const next = () => {
        t.busy = false;
        q.busyWorkers--;
        q.workers.busy.set(this.now, q.busyWorkers);
        q.depth.set(this.now, this.backlog(q));
        this.dispatch(q);
      };
      const advance = () => {
        part.head++;
        if (part.head > 1024 && part.head * 2 > part.msgs.length) {
          part.msgs = part.msgs.slice(part.head);
          part.head = 0;
        }
      };
      this.after(t.inst, overhead, () =>
        this.runEndpoint(t.inst, ep, null, false, (res) => {
          if (res.ok) {
            q.b.acked++;
            advance();
            return next();
          }
          msg.attempts++;
          if (ks.onError === 'skip' || msg.attempts > cs.maxRetries) {
            if (cs.dlq) q.b.dlq++;
            advance();
            return next();
          }
          // DefaultErrorHandler: seek back and retry the same record — the whole partition waits behind it
          q.b.redelivered++;
          this.q.push(this.now + ks.retryBackoff, next);
        }),
      );
    }
  }

  private dispatch(q: QueueRt): void {
    const cs = q.spec.consumer;
    if (!cs || !q.consumers.length) return;
    if (this.fault(q.spec.name).pause) return;
    if (q.kafka) return this.dispatchKafka(q);
    if (this.unavailable(q, 0, false)) return;
    const svc = q.consumers[0].inst.svc;
    const ep = svc.spec.endpoints[cs.endpoint];
    while (q.head < q.msgs.length) {
      let chosen: QueueRt['consumers'][number] | null = null;
      for (let k = 0; k < q.consumers.length; k++) {
        const cand = q.consumers[(q.rr + k) % q.consumers.length];
        if (cand.free > 0 && !this.fault(svc.spec.name, cand.inst.idx).down) {
          chosen = cand;
          q.rr = (q.rr + k + 1) % q.consumers.length;
          break;
        }
      }
      if (!chosen) return;
      const msg = q.msgs[q.head++];
      if (q.head > 1024 && q.head * 2 > q.msgs.length) {
        q.msgs = q.msgs.slice(q.head);
        q.head = 0;
      }
      q.unacked++;
      chosen.free--;
      q.busyWorkers++;
      q.workers.busy.set(this.now, q.busyWorkers);
      const worker = chosen;
      // a broker round trip per delivery, amortised over the prefetch window
      const overhead = cs.deliveryRtt / cs.prefetch;
      this.after(worker.inst, overhead, () =>
        this.runEndpoint(worker.inst, ep, null, false, (res) => {
          worker.free++;
          q.busyWorkers--;
          q.unacked--;
          q.workers.busy.set(this.now, q.busyWorkers);
          if (res.ok) q.b.acked++;
          else if (cs.ack === 'manual') {
            msg.attempts++;
            if (msg.attempts > cs.maxRetries) {
              if (cs.dlq) q.b.dlq++;
            } else {
              // nack + requeue: the poison message comes back, forever if maxRetries is infinite
              q.b.redelivered++;
              this.q.push(this.now + cs.retryDelay, () => {
                q.msgs.push(msg);
                q.depth.set(this.now, q.msgs.length - q.head + q.unacked);
                this.dispatch(q);
              });
            }
          }
          q.depth.set(this.now, q.msgs.length - q.head + q.unacked);
          this.dispatch(q);
        }),
      );
    }
  }

  // -------------------------------------------------------------------------
  // Partitioned stores (NoSQL, search, object storage)

  private serveStore(st: StoreRt, opName: string, token: Token, done: Done): void {
    const spec = st.spec;
    const op = spec.ops[opName] ?? spec.defaultOp;
    st.served++;
    const P = spec.partitions;
    if (op.scatter && P > 1) {
      // search / scan: every partition answers, the slowest decides
      let left = P;
      let failed: CallResult | null = null;
      for (let p = 0; p < P; p++)
        this.servePartition(st, p, op, token, (r) => {
          if (!r.ok) failed ??= r;
          if (--left === 0) done(failed ?? OK);
        });
      return;
    }
    const u = this.svcRng.next();
    const skew = spec.keySkew;
    const p = P > 1 ? Math.min(P - 1, Math.floor(P * (skew > 0 ? Math.pow(u, 1 + skew * 3) : u))) : 0;
    this.servePartition(st, p, op, token, done);
  }

  /** Current primary of a partition; promotes a live replica once the old one has been down for failoverTime. */
  private storeLeader(st: StoreRt, p: number): number | null {
    const name = st.spec.name;
    const cur = st.leaders[p];
    const f = this.fault(name, cur);
    if (!f.down) return cur;
    if (this.now - f.downSince < st.spec.failoverTime) return null;
    for (const m of st.replicas[p]) {
      if (m === cur || this.fault(name, m).down) continue;
      st.leaders[p] = m;
      this.event('failover', name, `${st.spec.partitions > 1 ? `partition ${p} ` : ''}primary node ${cur} 장애 → node ${m}를 primary로 선출`);
      return m;
    }
    return null;
  }

  private servePartition(st: StoreRt, p: number, op: StoreOpSpec, token: Token, done: Done): void {
    const spec = st.spec;
    const name = spec.name;
    st.hits[p]++;
    // per-partition throughput limit (DynamoDB partition capacity, S3 per-prefix request rate)
    const limit = op.write ? spec.partitionRate.write : spec.partitionRate.read;
    if (Number.isFinite(limit)) {
      const w = Math.floor(this.now / 1000);
      if (st.rateWindow !== w) {
        st.rateWindow = w;
        st.reads.fill(0);
        st.writes.fill(0);
      }
      const used = op.write ? ++st.writes[p] : ++st.reads[p];
      if (used > limit) {
        st.b.throttled++;
        const why = spec.engine === 's3' ? '503 SlowDown (prefix 요청 한도)' : 'ProvisionedThroughputExceeded (파티션 처리량 한도)';
        this.q.push(this.now, () => done(fail('too_many_requests', `${name}${spec.partitions > 1 ? ` partition ${p}` : ''} ${why}`)));
        return;
      }
    }
    const replicas = st.replicas[p];
    const alive = replicas.filter((m) => !this.fault(name, m).down);
    const unavailable = (why: string) => {
      st.b.unavailable++;
      this.q.push(this.now, () => done(fail('conn', `${name}${spec.partitions > 1 ? ` partition ${p}` : ''} ${why}`)));
    };
    // waits for `need` successes out of `n` replica requests
    const quorum = (n: number, need: number): Done => {
      let ok = 0;
      let bad = 0;
      let settled = false;
      return (r) => {
        if (settled) return;
        if (r.ok) ok++;
        else bad++;
        if (ok >= need) {
          settled = true;
          done(OK);
        } else if (bad > n - need) {
          settled = true;
          done(r);
        }
      };
    };
    if (spec.leader && (op.write || spec.readFrom === 'leader')) {
      const leader = this.storeLeader(st, p);
      if (leader === null) return unavailable('primary 장애 (선출 대기)');
      token.zone = this.memberZone(name, leader);
      if (!op.write) return this.storeRequest(st, leader, op, done);
      // write: primary first, then replicate; acknowledged once `acks` copies have it
      const followers = alive.filter((m) => m !== leader);
      if (followers.length + 1 < op.acks) return unavailable(`쓰기 확인 ${op.acks}/${spec.replication} 불가 (살아 있는 복제본 ${followers.length + 1})`);
      this.storeRequest(st, leader, op, (r) => {
        if (!r.ok || op.acks <= 1) {
          done(r);
          // replication still happens in the background
          if (r.ok) for (const m of followers) this.storeRequest(st, m, op, noop);
          return;
        }
        const ack = quorum(followers.length, op.acks - 1);
        for (const m of followers) this.storeRequest(st, m, op, ack);
      });
      return;
    }
    // leaderless (Cassandra, DynamoDB eventually consistent reads) or reads from any copy
    if (alive.length < op.acks) return unavailable(`일관성 ${op.acks}/${spec.replication} 불가 (살아 있는 복제본 ${alive.length})`);
    if (op.write) {
      const ack = quorum(alive.length, op.acks);
      for (const m of alive) this.storeRequest(st, m, op, ack);
      return;
    }
    const start = st.rr++ % alive.length;
    const ack = quorum(op.acks, op.acks);
    for (let k = 0; k < op.acks; k++) {
      const m = alive[(start + k) % alive.length];
      if (k === 0) token.zone = this.memberZone(name, m);
      this.storeRequest(st, m, op, ack);
    }
  }

  private storeRequest(st: StoreRt, member: number, op: StoreOpSpec, done: Done): void {
    const spec = st.spec;
    const name = spec.name;
    const f = this.fault(name, member);
    if (f.down) {
      this.q.push(this.now, () => done(fail('conn', `${name} node ${member} down`)));
      return;
    }
    const slots = st.members[member];
    // a full queue rejects instead of waiting (ES search queue → 429, Cassandra Overloaded)
    if (slots.used >= slots.cap && slots.waiting >= spec.queue) {
      st.b.rejected++;
      this.q.push(this.now, () =>
        done(spec.engine === 'elasticsearch' ? fail('too_many_requests', `${name} node ${member} 429 es_rejected_execution (큐 ${spec.queue})`) : fail('rejected', `${name} node ${member} 과부하 (큐 ${spec.queue})`)),
      );
      return;
    }
    slots.acquire(
      Infinity,
      () => {
        const lat = sample(op.latency, this.svcRng) * f.latencyX + op.size / spec.bandwidth;
        this.q.push(this.now + lat, () => {
          slots.release();
          if (f.errorRate > 0 && this.svcRng.chance(f.errorRate)) done(fail('error', `${name} fault`));
          else done(OK);
        });
      },
      noop,
    );
  }

  private serveExternal(x: ExtRt, done: Done): void {
    const f = this.fault(x.spec.name);
    if (f.down) {
      this.q.push(this.now, () => done(fail('conn', `${x.spec.name} down`)));
      return;
    }
    x.served++;
    if (Number.isFinite(x.spec.rateLimit)) {
      if (this.now - x.windowStart >= 1000) {
        x.windowStart = Math.floor(this.now / 1000) * 1000;
        x.windowCount = 0;
      }
      if (++x.windowCount > x.spec.rateLimit) {
        x.rejected++;
        this.q.push(this.now + 1, () => done(fail('too_many_requests', `${x.spec.name} 429`)));
        return;
      }
    }
    x.slots.acquire(Infinity, () => {
      this.q.push(this.now + sample(x.spec.latency, this.svcRng) * f.latencyX, () => {
        x.slots.release();
        const p = 1 - (1 - x.spec.failureRate) * (1 - f.errorRate);
        done(p > 0 && this.svcRng.chance(p) ? fail('error', `${x.spec.name} 5xx`) : OK);
      });
    }, noop);
  }

  // -------------------------------------------------------------------------
  // WebSocket: long-lived connections pinned to one instance

  private wsSessionSeq = 0;
  private wsConnectEp: EpStats | null = null;
  private wsMessageEp: EpStats | null = null;
  private wsConnectCall: CallSpec | null = null;

  private startWebSocket(): void {
    const ws = this.sc.websocket;
    if (!ws) return;
    this.wsConnectEp = this.entryStats(ws.connect.node, ws.connect.op);
    this.wsMessageEp = this.entryStats(ws.message.node, ws.message.op);
    this.wsConnectCall = { target: ws.connect.node, op: ws.connect.op, prob: 1, count: { kind: 'const', value: 1 }, optional: false, async: false, onMiss: [], parallel: [], work: null, workCpu: 0 };
    for (let i = 0; i < ws.clients; i++) {
      const session: Session = { id: this.wsSessionSeq++, inst: null, pending: null, attempts: 0, epoch: 0 };
      const t = (ws.connectOver * i) / ws.clients + this.trafficRng.next() * (ws.connectOver / ws.clients);
      if (t < this.sc.duration) this.q.push(t, () => this.wsConnect(session));
    }
  }

  /** stats for an API that receives client traffic outside the HTTP mix (WebSocket connect / messages) */
  private entryStats(node: string, op: string): EpStats {
    const ep = this.epStats(node, op);
    if (!ep.entry) {
      ep.entry = true;
      ep.bOk = new Array(this.buckets).fill(0);
      ep.bErr = new Array(this.buckets).fill(0);
      ep.bDeg = new Array(this.buckets).fill(0);
      ep.bHist = [];
    }
    return ep;
  }

  private wsConnect(session: Session): void {
    const id = this.rootSeq++;
    const root: Root = { id, t0: this.now, ep: this.wsConnectEp!, path: null, session };
    this.roots.set(id, root);
    this.bArrivals[this.bucketOf(this.now)]++;
    session.epoch++;
    session.pending = null;
    const epoch = session.epoch;
    this.callEdge(null, CLIENT, this.wsConnectCall!, { root, parent: null, detached: false }, (res) => {
      this.complete(root, res);
      if (epoch !== session.epoch) return;
      const inst = session.pending;
      if (res.ok && inst && !this.fault(inst.svc.spec.name, inst.idx).down && inst.fdUsed < inst.svc.spec.ulimit) {
        session.inst = inst;
        session.attempts = 0;
        inst.sessions.add(session);
        inst.fdUsed++;
        inst.fd.set(this.now, inst.fdUsed);
        inst.svc.wsConnects++;
        this.wsNextMessage(session, epoch);
      } else this.wsReconnect(session);
    });
  }

  private wsReconnect(session: Session): void {
    const r = this.sc.websocket!.reconnect;
    session.attempts++;
    let delay = Math.min(r.maxDelay, r.delay * Math.pow(r.multiplier, session.attempts - 1));
    // full jitter at 1: uniform(0, delay); without jitter every dropped client comes back at the same instant
    if (r.jitter > 0) delay *= 1 - r.jitter * this.trafficRng.next();
    if (this.now + delay < this.sc.duration) this.q.push(this.now + delay, () => this.wsConnect(session));
  }

  private wsDrop(session: Session): void {
    const inst = session.inst;
    if (!inst) return;
    inst.sessions.delete(session);
    inst.fdUsed--;
    inst.fd.set(this.now, inst.fdUsed);
    inst.svc.wsDrops++;
    session.inst = null;
    session.epoch++;
    this.wsReconnect(session);
  }

  /** members that just died lose their connections (immediately when down, after the heartbeat timeout when hung) */
  private wsCheckDead(): void {
    const ws = this.sc.websocket;
    if (!ws) return;
    const svc = this.nodes.get(ws.service) as SvcRt;
    for (const inst of svc.insts) {
      const f = this.fault(svc.spec.name, inst.idx);
      if (!f.down || !inst.sessions.size) continue;
      if (f.hang && this.now - f.downSince < ws.heartbeatTimeout) {
        this.q.push(f.downSince + ws.heartbeatTimeout, () => this.wsCheckDead());
        continue;
      }
      for (const s of [...inst.sessions]) this.wsDrop(s);
    }
  }

  private wsNextMessage(session: Session, epoch: number): void {
    const ws = this.sc.websocket!;
    if (ws.messageRate <= 0) return;
    const t = this.now + this.trafficRng.exp(1000 / ws.messageRate);
    if (t < this.sc.duration) this.q.push(t, () => this.wsMessage(session, epoch));
  }

  private wsMessage(session: Session, epoch: number): void {
    if (epoch !== session.epoch || !session.inst) return;
    this.wsNextMessage(session, epoch);
    const inst = session.inst;
    const ws = this.sc.websocket!;
    const ep = inst.svc.spec.endpoints[ws.message.op];
    const id = this.rootSeq++;
    const root: Root = { id, t0: this.now, ep: this.wsMessageEp!, path: null };
    this.roots.set(id, root);
    this.bArrivals[this.bucketOf(this.now)]++;
    const edge = this.edges.get(`${CLIENT}->${ws.connect.node}`);
    const leg = (size: number) => (edge ? this.oneWay(edge, size, false) : 1);
    // the frame travels over the existing connection: no load balancer decision, no handshake
    this.q.push(this.now + leg(ep.requestSize), () => {
      if (!session.inst || session.inst !== inst) return this.complete(root, fail('conn', `${inst.label} 연결 끊김`));
      this.runEndpoint(inst, ep, null, true, (res) => {
        if (res.ok && ep.broadcast) this.wsBroadcast(ep.broadcast);
        this.q.push(this.now + leg(res.ok ? ep.responseSize : 64), () => this.complete(root, res));
      });
    });
  }

  /** deliver to `fanout` subscribers, spread over instances by how many connections each holds */
  private wsBroadcast(b: { fanout: number; cpu: number }): void {
    const svc = this.nodes.get(this.sc.websocket!.service) as SvcRt;
    let total = 0;
    for (const x of svc.insts) total += x.sessions.size;
    if (!total) return;
    for (const x of svc.insts) {
      if (!x.sessions.size) continue;
      const work = b.cpu * b.fanout * (x.sessions.size / total) * x.cpuScale;
      x.cpu.acquire(Infinity, () => this.after(x, work, () => x.cpu.release()), noop);
    }
  }

  // -------------------------------------------------------------------------
  // Traffic

  private nextArrival(): void {
    const sc = this.sc;
    let t = this.now;
    for (let guard = 0; guard < 1000; guard++) {
      const r = rpsAt(sc.traffic, t);
      if (r > 0) {
        const gap = sc.arrival === 'poisson' ? this.trafficRng.exp(1000 / r) : 1000 / r;
        // if the rate changes inside the gap (spike), re-sample from the change point
        const r2 = rpsAt(sc.traffic, t + gap);
        if (r2 > r * 1.5 && gap > 50) {
          t += 50;
          continue;
        }
        t += gap;
        break;
      }
      t += 100;
    }
    if (t < sc.duration) this.q.push(t, () => this.arrive());
  }

  private arrive(): void {
    this.nextArrival();
    const u = this.trafficRng.next();
    let acc = 0;
    let entry = this.entryCalls[this.entryCalls.length - 1];
    for (const e of this.entryCalls) {
      acc += e.weight;
      if (u < acc) {
        entry = e;
        break;
      }
    }
    const id = this.rootSeq++;
    const sampled = this.opts.particles && id % this.sampleEvery === 0;
    const root: Root = { id, t0: this.now, ep: entry.ep, path: sampled ? [this.now, -1] : null };
    this.roots.set(id, root);
    this.bArrivals[this.bucketOf(this.now)]++;
    const ctx: Ctx | null = sampled ? { root, parent: null, detached: false } : null;
    this.callEdge(null, CLIENT, entry.call, ctx, (res) => this.complete(root, res));
  }

  private complete(root: Root, res: CallResult): void {
    this.roots.delete(root.id);
    const lat = this.now - root.t0;
    const b = this.bucketOf(this.now);
    const ep = root.ep;
    let h = this.bHist[b];
    if (!h) h = this.bHist[b] = new Histogram();
    h.add(lat);
    let eh = ep.bHist![b];
    if (!eh) eh = ep.bHist![b] = new Histogram();
    eh.add(lat);
    const inWin = this.inWindow(this.now);
    if (inWin) {
      this.winHist.add(lat);
      this.win.count++;
    }
    if (res.ok) {
      this.series.throughput[b]++;
      ep.bOk![b]++;
      if (res.degraded) ep.bDeg![b]++;
      if (res.degraded) this.bDegraded[b]++;
      if (inWin) {
        this.win.ok++;
        if (res.degraded) this.win.degraded++;
      }
    } else {
      this.series.errors[b]++;
      ep.bErr![b]++;
      this.series.byKind[res.kind!][b]++;
      const cause = res.cause ?? res.kind!;
      this.causes.set(cause, (this.causes.get(cause) ?? 0) + 1);
      if (inWin) this.win.errors++;
    }
    if (root.path && this.traces.length < this.opts.maxParticles) {
      root.path.push(this.now, -1);
      this.traces.push({ t0: root.t0, t1: this.now, status: res.ok ? (res.degraded ? 'degraded' : 'ok') : 'error', path: root.path, api: root.ep.id });
    }
  }

  private startSchedules(): void {
    for (const s of this.sc.schedules) {
      const svc = this.nodes.get(s.ref.node) as SvcRt;
      const ep = svc.spec.endpoints[s.ref.op];
      const tick = () => {
        // @Scheduled runs on its own scheduler thread (not Tomcat's), on one instance (e.g. ShedLock)
        this.runEndpoint(svc.insts[0], ep, null, false, noop);
        if (this.now + s.every < this.sc.duration) this.q.push(this.now + s.every, tick);
      };
      if (s.at < this.sc.duration) this.q.push(s.at, tick);
    }
  }

  // -------------------------------------------------------------------------
  // Metrics

  private flush(t: number): void {
    const b = this.bucket++;
    const span = this.bucketMs;
    for (const r of this.resources) {
      let busy = 0;
      let wait = 0;
      let waitMax = 0;
      for (const m of r.meters) {
        busy += m.busy.flush(t, span)[0];
        const [wa, wm] = m.wait.flush(t, span);
        wait += wa;
        waitMax += wm;
      }
      r.series.util.push(busy / r.series.capacity);
      r.series.queue.push(wait);
      r.series.queueMax.push(waitMax);
      const ns = this.nodeSeries.get(r.series.node)!;
      let sat = r.series.util[b];
      if (r.series.kind === 'backlog') sat = busy > 0.5 ? 1 + Math.min(1, busy / r.series.capacity) : 0;
      else if (wait > 0.5) sat = Math.max(sat, 1 + Math.min(1, wait / r.series.capacity));
      if (r.series.kind === 'db') sat = Math.min(sat, 2);
      if (sat > ns.saturation[b]) ns.saturation[b] = sat;
      if (ns.os) {
        if (r.series.kind === 'cpu') ns.os.cpu[b] = r.series.util[b];
        if (r.series.kind === 'backlog') ns.os.backlog[b] = busy;
        if (r.series.kind === 'fd') ns.os.fdUsed[b] = busy;
        if (r.series.kind === 'ports') ns.os.portsInUse[b] = busy;
      }
    }
    for (const n of this.nodes.values()) {
      const ns = this.nodeSeries.get(n.spec.name)!;
      ns.served[b] = n.served;
      n.served = 0;
      if (n.kind === 'service') {
        ns.os!.gcPauseMs[b] = n.gcPause / n.spec.instances;
        ns.os!.gcCount[b] = n.gcCount;
        ns.os!.synDrops[b] = n.synDrops;
        ns.os!.throttledMs[b] = n.throttled / n.spec.instances;
        ns.os!.healthy[b] = n.insts.filter((x) => x.healthy).length;
        if (ns.ws) {
          const sizes = n.insts.map((x) => x.sessions.size);
          ns.ws.connections[b] = sizes.reduce((a, c) => a + c, 0);
          ns.ws.maxPerInstance[b] = Math.max(...sizes);
          ns.ws.minPerInstance[b] = Math.min(...sizes);
          ns.ws.connects[b] = n.wsConnects;
          ns.ws.drops[b] = n.wsDrops;
          n.wsConnects = n.wsDrops = 0;
        }
        n.gcPause = n.gcCount = n.synDrops = n.throttled = 0;
      } else if (n.kind === 'nosql') {
        const st = ns.store!;
        st.throttled[b] = n.b.throttled;
        st.rejected[b] = n.b.rejected;
        st.unavailable[b] = n.b.unavailable;
        n.b = { throttled: 0, rejected: 0, unavailable: 0 };
        let sum = 0;
        let max = 0;
        for (const h of n.hits) {
          sum += h;
          if (h > max) max = h;
        }
        st.hottestPartitionShare = sum ? max / sum : 0;
      } else if (n.kind === 'cache') {
        const c = ns.cache!;
        c.hits[b] = n.b.hits;
        c.misses[b] = n.b.misses;
        c.loads[b] = n.b.loads;
        c.waits[b] = n.b.waits;
        n.b = { hits: 0, misses: 0, loads: 0, waits: 0 };
      } else if (n.kind === 'queue') {
        const qs = ns.queue!;
        const depth = n.depth.flush(t, span)[0];
        qs.depth[b] = depth;
        qs.published[b] = n.b.published;
        qs.acked[b] = n.b.acked;
        qs.redelivered[b] = n.b.redelivered;
        qs.dlq[b] = n.b.dlq;
        if (n.kafka) {
          let oldest = 0;
          let maxLag = 0;
          for (const p of n.kafka.parts) {
            const lag = p.msgs.length - p.head;
            if (lag > maxLag) maxLag = lag;
            if (lag > 0) oldest = Math.max(oldest, t - p.msgs[p.head].t0);
          }
          qs.oldestAgeMs[b] = oldest;
          qs.maxPartitionLag![b] = maxLag;
          qs.idleConsumers![b] = n.kafka.idle;
          qs.rebalanceMs![b] = Math.min(span, n.b.rebalanceMs);
        } else qs.oldestAgeMs[b] = n.head < n.msgs.length ? t - n.msgs[n.head].t0 : 0;
        n.b = { published: 0, acked: 0, redelivered: 0, dlq: 0, rebalanceMs: Math.max(0, n.b.rebalanceMs - span) };
        // a growing backlog is saturation even if consumers look "busy but fine"
        if (depth > 100) ns.saturation[b] = Math.max(ns.saturation[b], 1 + Math.min(1, depth / 10_000));
      }
    }
    for (const e of this.edgeList) {
      e.series.attempts[b] = e.b.attempts;
      e.series.retries[b] = e.b.retries;
      e.series.failures[b] = e.b.failures;
      e.b.attempts = e.b.retries = e.b.failures = 0;
      if (e.spec.circuitBreaker) {
        e.series.cbOpen[b] = e.cbOpen.flush(t, span)[0] / e.callerInstances;
        e.series.cbHalfOpen[b] = e.cbHalf.flush(t, span)[0] / e.callerInstances;
      }
    }
    if (this.bucket < this.buckets) this.q.push(Math.min(this.sc.duration, (this.bucket + 1) * this.bucketMs), () => this.flush(this.now));
  }

  // -------------------------------------------------------------------------

  run(): SimResult {
    const wall = Date.now();
    const sc = this.sc;
    this.q.push(Math.min(sc.duration, this.bucketMs), () => this.flush(this.now));
    this.q.push(0, () => this.nextArrival());
    this.startSchedules();
    this.startHealthChecks();
    this.startWebSocket();

    let processed = 0;
    const max = this.opts.maxEvents;
    while (this.q.size > 0 && this.q.peekTime() <= sc.duration) {
      const t = this.q.peekTime();
      this.now = t;
      const action = this.q.pop();
      const gate = this.q.gate;
      // the instance is frozen in a GC pause: run this when it resumes
      if (gate !== null && gate.pausedUntil > t) this.q.push(gate.pausedUntil, action, gate);
      else action();
      if (++processed > max) throw new Error(`사건 수가 한도(${max.toLocaleString()})를 넘었습니다. 트래픽이나 반복 호출을 줄이세요.`);
    }
    this.now = sc.duration;
    while (this.bucket < this.buckets) this.flush(this.now);
    this.eventCount = processed;
    return this.result(Date.now() - wall);
  }

  private stats(h: Histogram, c: { count: number; ok: number; errors: number; degraded: number }): LatencyStats {
    return {
      count: c.count,
      ok: c.ok,
      errors: c.errors,
      errorRate: c.count ? c.errors / c.count : 0,
      degraded: c.degraded,
      mean: h.mean(),
      p50: h.quantile(0.5),
      p95: h.quantile(0.95),
      p99: h.quantile(0.99),
      max: h.max,
    };
  }

  private result(wallMs: number): SimResult {
    const sc = this.sc;
    const s = this.series;
    for (let b = 0; b < this.buckets; b++) {
      const h = this.bHist[b];
      const done = s.throughput[b] + s.errors[b];
      s.errorRate[b] = done ? s.errors[b] / done : 0;
      s.p50[b] = h ? h.quantile(0.5) : NaN;
      s.p95[b] = h ? h.quantile(0.95) : NaN;
      s.p99[b] = h ? h.quantile(0.99) : NaN;
    }

    // requests still in flight are censored observations: count their age so a jammed system can't look fast
    const winHist = this.winHist;
    const perEpOpen = new Map<EpStats, Histogram>();
    for (const r of this.roots.values()) {
      const age = this.now - r.t0;
      if (age > 0) {
        winHist.add(age);
        let h = perEpOpen.get(r.ep);
        if (!h) perEpOpen.set(r.ep, (h = new Histogram()));
        h.add(age);
      }
      if (r.path && this.traces.length < this.opts.maxParticles) {
        this.traces.push({ t0: r.t0, t1: this.now, status: 'open', path: r.path, api: r.ep.id });
      }
    }

    const winSec = (sc.duration - this.warmup) / 1000;
    const violations: string[] = [];
    const endpoints: EndpointResult[] = [];
    for (const ep of this.eps.values()) {
      let st: LatencyStats;
      if (ep.entry) {
        // client-observed latency for entry endpoints
        const h = new Histogram();
        let deg = 0;
        let ok = 0;
        let err = 0;
        const firstB = this.bucketOf(this.warmup);
        for (let b = firstB; b < this.buckets; b++) {
          const bh = ep.bHist![b];
          if (bh) h.merge(bh);
          ok += ep.bOk![b];
          deg += ep.bDeg![b];
          err += ep.bErr![b];
        }
        const open = perEpOpen.get(ep);
        if (open) h.merge(open);
        st = this.stats(h, { count: ok + err, ok, errors: err, degraded: deg });
      } else st = this.stats(ep.window, ep);
      const spec = (this.nodes.get(ep.node) as SvcRt).spec.endpoints[ep.op];
      const r: EndpointResult = {
        ...st,
        id: ep.id,
        node: ep.node,
        op: ep.op,
        entry: ep.entry,
        observed: spec.observed,
        source: spec.source,
        throughput: st.ok / winSec,
      };
      if (ep.entry) {
        const slo = sc.slo.endpoints[ep.id] ?? sc.slo;
        const p99Ok = !(st.p99 > slo.p99);
        const errorOk = st.errorRate <= slo.errorRate;
        r.slo = { p99: slo.p99, errorRate: slo.errorRate, p99Ok, errorOk, pass: p99Ok && errorOk };
        if (!p99Ok) violations.push(`${ep.op}: p99 ${st.p99.toFixed(0)}ms > ${slo.p99}ms`);
        if (!errorOk) violations.push(`${ep.op}: 에러율 ${(st.errorRate * 100).toFixed(2)}% > ${(slo.errorRate * 100).toFixed(2)}%`);
        r.series = {
          throughput: ep.bOk!,
          errors: ep.bErr!,
          p50: ep.bHist!.map((h) => (h ? h.quantile(0.5) : NaN)),
          p99: ep.bHist!.map((h) => (h ? h.quantile(0.99) : NaN)),
        };
        // pad sparse array
        for (let b = 0; b < this.buckets; b++) {
          if (r.series.p50[b] === undefined) r.series.p50[b] = NaN;
          if (r.series.p99[b] === undefined) r.series.p99[b] = NaN;
        }
      }
      endpoints.push(r);
    }

    const rootsTotal = this.rootSeq;
    const edges: EdgeResult[] = this.edgeList.map((e) => ({
      key: e.spec.key,
      from: e.spec.from,
      to: e.spec.to,
      implicit: e.spec.implicit,
      ...e.tot,
      amplification: rootsTotal ? e.tot.attempts / rootsTotal : 0,
      series: e.series,
    }));

    const summaryStats = this.stats(winHist, this.win);
    return {
      duration: sc.duration,
      bucketMs: this.bucketMs,
      buckets: this.buckets,
      window: [this.warmup, sc.duration],
      time: Array.from({ length: this.buckets }, (_, i) => ((i + 1) * this.bucketMs) / 1000),
      series: s,
      summary: {
        ...summaryStats,
        roots: rootsTotal,
        throughput: this.win.ok / winSec,
        inFlightAtEnd: this.roots.size,
        sloPass: violations.length === 0,
        sloViolations: violations,
        errorCauses: [...this.causes.entries()].map(([cause, count]) => ({ cause, count })).sort((a, b) => b.count - a.count),
        eventsProcessed: this.eventCount,
        wallMs,
      },
      endpoints,
      resources: this.resources.map((r) => r.series),
      edges,
      nodes: this.nodeOrder.map((n) => this.nodeSeries.get(n)!),
      events: this.events,
      particles: { sampleEvery: this.sampleEvery, nodes: this.nodeOrder, traces: this.traces },
    };
  }
}

/**
 * Run the simulation. Pure and deterministic: identical (model, scenario, seed) always yields an identical result
 * (apart from summary.wallMs).
 */
export function simulate(model: Model, scenario: Scenario = model.scenario, seed: number = scenario.seed, opts: SimOptions = {}): SimResult {
  const o: Required<SimOptions> = {
    particles: opts.particles ?? true,
    maxParticles: opts.maxParticles ?? 2500,
    bucketMs: opts.bucketMs ?? 1000,
    maxEvents: opts.maxEvents ?? 30_000_000,
  };
  return new Sim(model, scenario, seed, o).run();
}

/** Expected mean of a distribution — re-exported for analytical checks. */
export const distMean = mean;
