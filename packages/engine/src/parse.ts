import { parse as parseYaml } from 'yaml';
import { parseDist, type Dist } from './dist';
import { bandwidth, bytes, memoryMb, rate, ratio, time } from './units';
import type {
  WebSocketSpec,
  TopologySpec,
  MeshSpec,
  CacheOpSpec,
  CacheSpec,
  QueueSpec,
  RuntimeModel,
  CallSpec,
  CircuitBreakerSpec,
  DbSpec,
  EdgeSpec,
  EndpointRef,
  EndpointSpec,
  ErrorKind,
  ExternalSpec,
  FaultSpec,
  GcKind,
  Model,
  NetworkSpec,
  NodeSpec,
  RetrySpec,
  Scenario,
  ServiceSpec,
  StoreEngine,
  StoreOpSpec,
  StoreSpec,
  TrafficPattern,
} from './types';
import { ERROR_KINDS, forEachCall } from './types';

/** The raw YAML/JSON document as the user wrote it. The web UI edits this object directly. */
export type RawDoc = Record<string, any>;

export class ModelError extends Error {
  constructor(
    message: string,
    public path: string,
  ) {
    super(path ? `${path}: ${message}` : message);
  }
}

export const CLIENT = 'client';

export function parseYamlDoc(text: string): RawDoc {
  const doc = parseYaml(text);
  if (!doc || typeof doc !== 'object') throw new ModelError('YAML 최상위는 객체여야 합니다', '');
  return doc as RawDoc;
}

export function loadModel(text: string): Model {
  return parseModel(parseYamlDoc(text));
}

function at<T>(path: string, fn: () => T): T {
  try {
    return fn();
  } catch (e) {
    if (e instanceof ModelError) throw e;
    throw new ModelError((e as Error).message, path);
  }
}

const isOff = (v: any) => v === false || v === null || (typeof v === 'object' && v !== null && v.enabled === false);
const num = (v: any, d: number) => (v === undefined || v === null ? d : Number(v));
const dur = (v: any, d: number) => (v === undefined || v === null ? d : time(v));
const cnt = (v: any, d: number) => (v === undefined || v === null || v === 'unlimited' ? d : Number(v));

// ---------------------------------------------------------------------------

export function parseModel(doc: RawDoc): Model {
  const rawNodes = doc.nodes ?? {};
  if (typeof rawNodes !== 'object') throw new ModelError('nodes는 객체여야 합니다', 'nodes');
  const vars: Record<string, Dist> = {};
  for (const [k, v] of Object.entries(doc.scenario?.vars ?? {})) {
    vars[k] = at(`scenario.vars.${k}`, () => parseDist(v, (x) => Number(x)));
  }

  networkDefaults = doc.network && typeof doc.network === 'object' ? doc.network : {};
  const nodes: Record<string, NodeSpec> = {};
  const FRONT_ORDER: Record<string, number> = { pooler: 0, gateway: 1, loadbalancer: 2, lb: 2, cdn: 3 };
  const isFront = (raw: any) => raw?.kind in FRONT_ORDER;
  for (const [name, raw] of Object.entries<any>(rawNodes)) {
    if (name === CLIENT) throw new ModelError(`"${CLIENT}"는 예약된 이름입니다`, `nodes.${name}`);
    if (isFront(raw)) continue;
    nodes[name] = at(`nodes.${name}`, () => parseNode(name, raw ?? {}, vars));
  }
  // gateways and load balancers route to nodes parsed above; their route policies become edges
  const frontEdges: Record<string, any> = {};
  // gateways route to services; load balancers may front a service or a gateway, so they come last
  const fronts = Object.entries<any>(rawNodes)
    .filter(([, raw]) => isFront(raw))
    .sort(([, a], [, b]) => FRONT_ORDER[a.kind] - FRONT_ORDER[b.kind]);
  for (const [name, raw] of fronts) {
    nodes[name] = at(`nodes.${name}`, () =>
      raw.kind === 'gateway'
        ? parseGateway(name, raw, nodes, vars, frontEdges)
        : raw.kind === 'cdn'
          ? parseCdn(name, raw, nodes, vars, frontEdges)
          : raw.kind === 'pooler'
            ? parsePooler(name, raw, nodes, vars, frontEdges)
            : parseLoadBalancer(name, raw, nodes, vars, frontEdges),
    );
  }

  // validate calls
  for (const n of Object.values(nodes)) {
    if (n.kind !== 'service') continue;
    for (const ep of Object.values(n.endpoints)) {
      const check = (c: CallSpec) => {
        const path = `nodes.${n.name}.endpoints.${ep.name}.calls`;
        const t = nodes[c.target];
        if (!t) throw new ModelError(`호출 대상 노드 "${c.target}"가 없습니다`, path);
        if (t.kind === 'service' && !t.endpoints[c.op])
          throw new ModelError(`"${c.target}"에 엔드포인트 "${c.op}"가 없습니다`, path);
        if (c.target === n.name) throw new ModelError(`자기 자신(${n.name})을 호출할 수 없습니다`, path);
      };
      forEachCall(ep.calls, check);
    }
  }

  // queue consumers
  for (const q of Object.values(nodes)) {
    if (q.kind !== 'queue' || !q.consumer) continue;
    const c = nodes[q.consumer.service];
    const path = `nodes.${q.name}.consumer`;
    if (!c || c.kind !== 'service') throw new ModelError(`컨슈머 서비스 "${q.consumer.service}"가 없습니다`, path);
    if (!c.endpoints[q.consumer.endpoint]) throw new ModelError(`"${c.name}"에 리스너 엔드포인트 "${q.consumer.endpoint}"가 없습니다`, path);
  }

  const mesh = doc.mesh === undefined || isOff(doc.mesh) ? null : at('mesh', () => parseMesh(doc.mesh));
  const edges: Record<string, EdgeSpec> = {};
  const rawEdges: Record<string, any> = { ...frontEdges };
  for (const [key, raw] of Object.entries<any>(doc.edges ?? {})) {
    const [a, b] = splitEdgeKey(key);
    rawEdges[`${a}->${b}`] = { ...(frontEdges[`${a}->${b}`] ?? {}), ...(raw ?? {}) };
  }
  for (const [key, raw] of Object.entries<any>(rawEdges)) {
    const [from, to] = splitEdgeKey(key);
    if (from !== CLIENT && !nodes[from]) throw new ModelError(`노드 "${from}"가 없습니다`, `edges.${key}`);
    if (!nodes[to]) throw new ModelError(`노드 "${to}"가 없습니다`, `edges.${key}`);
    edges[`${from}->${to}`] = at(`edges.${key}`, () => parseEdge(from, to, raw ?? {}, nodes[to], false));
  }
  // implicit edges for every call relation
  const ensure = (from: string, to: string) => {
    const k = `${from}->${to}`;
    if (!edges[k]) edges[k] = parseEdge(from, to, {}, nodes[to], true);
  };
  for (const n of Object.values(nodes)) {
    if (n.kind !== 'service') continue;
    for (const ep of Object.values(n.endpoints)) {
      forEachCall(ep.calls, (c) => ensure(n.name, c.target));
    }
  }

  const scenario = at('scenario', () => parseScenario(doc.scenario ?? {}, nodes, vars));
  for (const m of scenario.mix) ensure(CLIENT, m.ref.node);
  if (mesh) for (const e of Object.values(edges)) applyMesh(e, mesh, nodes, rawEdges[e.key]);
  const topology = doc.topology && !isOff(doc.topology) ? at('topology', () => parseTopology(doc.topology)) : null;
  const placement: Record<string, string[]> = {};
  if (topology) {
    for (const [name, raw] of Object.entries<any>(rawNodes)) {
      const n = nodes[name];
      if (!n || n.kind === 'external') continue;
      const z = raw?.zones === undefined ? topology.zones : (Array.isArray(raw.zones) ? raw.zones : [raw.zones]).map(String);
      for (const zone of z) if (!topology.zones.includes(zone)) throw new ModelError(`존 "${zone}"이 topology.zones에 없습니다`, `nodes.${name}.zones`);
      placement[name] = z;
    }
  }
  for (const f of scenario.faults) {
    if (f.zone !== null) {
      if (!topology?.zones.includes(f.zone)) throw new ModelError(`장애 존 "${f.zone}"이 topology.zones에 없습니다`, 'scenario.faults');
      if (f.target === '*') continue;
    }
    if (!nodes[f.target] && !edges[f.target]) throw new ModelError(`장애 대상 "${f.target}"가 없습니다`, 'scenario.faults');
    const n = nodes[f.target];
    if (f.instance !== null) {
      const members = !n
        ? 0
        : n.kind === 'service'
          ? n.instances
          : n.kind === 'db'
            ? n.cluster.shards * (1 + n.cluster.replicas)
            : n.kind === 'cache'
              ? n.cluster.shards
              : n.kind === 'queue'
                ? n.kafka?.brokers ?? n.rabbit?.nodes ?? 1
                : n.kind === 'nosql'
                  ? n.nodes
                  : 1;
      if (f.instance >= members) throw new ModelError(`장애 대상 "${f.target}"에 멤버 #${f.instance}가 없습니다 (0부터, 멤버 ${members}개)`, 'scenario.faults');
    }
  }
  return { nodes, edges, scenario, mesh, topology, placement };
}

function parseWebSocket(w: any, nodes: Record<string, NodeSpec>): WebSocketSpec {
  const message = resolveEndpoint(String(w.message), nodes);
  const svc = nodes[message.node] as ServiceSpec;
  const connect = resolveEndpoint(String(w.connect ?? Object.keys(svc.endpoints).find((e) => svc.endpoints[e].handshake) ?? ''), nodes);
  if (!Object.values(svc.endpoints).some((e) => e.handshake)) throw new Error(`${svc.name}에 handshake: true인 API가 없습니다 (연결을 붙잡을 인스턴스를 정하는 API)`);
  const r = w.reconnect ?? {};
  let jitter = 0;
  if (r.jitter === true) jitter = 1;
  else if (r.jitter !== undefined && r.jitter !== false) jitter = Math.min(1, ratio(r.jitter));
  return {
    connect,
    service: svc.name,
    message,
    clients: Math.max(1, Math.round(num(w.clients, 1000))),
    connectOver: dur(w.connectOver, 10_000),
    messageRate: num(w.messageRate, 0.1),
    reconnect: { delay: dur(r.delay, 1000), multiplier: num(r.multiplier, 1), maxDelay: dur(r.maxDelay, 30_000), jitter },
    connMemory: w.connMemory !== undefined ? bytes(w.connMemory) / 1024 ** 2 : 0.05,
    heartbeatTimeout: dur(w.heartbeatTimeout, 30_000),
  };
}

function parseTopology(t: any): TopologySpec {
  const zones = (Array.isArray(t.zones) ? t.zones : String(t.zones ?? 'a,b,c').split(',')).map((z: unknown) => String(z).trim()).filter(Boolean);
  if (!zones.length) throw new Error('zones가 비어 있습니다');
  return { zones, crossZoneRtt: dur(t.crossZoneRtt, 1), zoneAware: !!t.zoneAware };
}

// ---------------------------------------------------------------------------
// API gateway, load balancer, service mesh

function frontRuntime(raw: any, model: string) {
  return { model, eventLoops: raw.runtime?.eventLoops, threads: raw.runtime?.threads, maxConnections: raw.maxConnections ?? raw.runtime?.maxConnections, acceptCount: raw.runtime?.acceptCount ?? 1024 };
}

/** "GET /orders/**" or "/orders/**" against "POST /orders/{id}" */
function routeMatches(pattern: string, endpoint: string): boolean {
  const [pm, pp] = pattern.includes(' ') ? pattern.split(/\s+/, 2) : ['', pattern];
  const [em, ep] = endpoint.includes(' ') ? endpoint.split(/\s+/, 2) : ['', endpoint];
  if (pm && pm !== '*' && em && pm.toUpperCase() !== em.toUpperCase()) return false;
  const re = new RegExp(
    '^' +
      pp
        .split('/')
        .map((seg) => (seg === '**' ? '.*' : seg === '*' ? '[^/]+' : seg.replace(/\{[^}]+\}/g, '[^/]+').replace(/[.+?^$()|[\]\\]/g, '\\$&')))
        .join('/')
        .replace(/\/\.\*$/, '(/.*)?') +
      '$',
  );
  return re.test(ep.replace(/\{[^}]+\}/g, 'x'));
}

const POLICY_KEYS = ['timeout', 'connectTimeout', 'retry', 'circuitBreaker', 'bulkhead', 'fallback', 'rateLimiter', 'network', 'pool'];

function parseGateway(name: string, raw: any, nodes: Record<string, NodeSpec>, vars: Record<string, Dist>, edges: Record<string, any>): ServiceSpec {
  const endpoints: Record<string, any> = {};
  // per-request work of the gateway itself; by default mostly CPU (filters, routing, serialization)
  const cpuMs = time(raw.cpu ?? '0.3ms');
  const overhead = raw.overhead ?? { p50: `${Math.max(0.5, cpuMs * 1.3)}ms`, p99: `${Math.max(3, cpuMs * 5)}ms` };
  const routes: [string, any][] = Array.isArray(raw.routes) ? raw.routes.map((r: any) => [r.path ?? r.match, r]) : Object.entries<any>(raw.routes ?? {});
  for (const [pattern, r0] of routes) {
    const r = typeof r0 === 'string' ? { to: r0 } : r0 ?? {};
    const to = String(r.to ?? '');
    const i = to.indexOf(':');
    const svc = (i > 0 ? to.slice(0, i) : to).trim();
    const target = nodes[svc];
    if (!target) throw new ModelError(`라우트 "${pattern}"의 대상 "${svc}"가 없습니다`, `nodes.${name}.routes`);
    const ops = i > 0 ? [to.slice(i + 1).trim()] : target.kind === 'service' ? Object.keys(target.endpoints).filter((ep) => routeMatches(pattern, ep)) : [pattern];
    if (!ops.length) throw new ModelError(`라우트 "${pattern}"에 맞는 ${svc}의 API가 없습니다`, `nodes.${name}.routes`);
    for (const op of ops) {
      const ep = i > 0 ? pattern : op;
      endpoints[ep] = { selfTime: overhead, cpu: `${cpuMs}ms`, alloc: raw.alloc ?? '32kb', calls: [`${svc}:${op}`], ...(r.rateLimit !== undefined ? { rateLimit: r.rateLimit } : {}) };
    }
    const policy = Object.fromEntries(POLICY_KEYS.filter((k) => r[k] !== undefined).map((k) => [k, r[k]]));
    if (Object.keys(policy).length) edges[`${name}->${svc}`] = { ...policy, ...(edges[`${name}->${svc}`] ?? {}) };
  }
  if (!Object.keys(endpoints).length) throw new Error('게이트웨이에는 routes가 하나 이상 필요합니다');
  const spec = parseService(name, { ...raw, kind: 'service', runtime: frontRuntime(raw, raw.runtime?.model ?? 'webflux'), endpoints }, vars);
  spec.role = 'gateway';
  return spec;
}

function parseLoadBalancer(name: string, raw: any, nodes: Record<string, NodeSpec>, vars: Record<string, Dist>, edges: Record<string, any>): ServiceSpec {
  const target = nodes[String(raw.target)];
  if (!target || target.kind !== 'service') throw new Error(`target: 로드밸런서 뒤의 서비스 "${raw.target}"가 없습니다`);
  const l7 = Number(raw.layer ?? 7) !== 4;
  const endpoints: Record<string, any> = {};
  for (const op of Object.keys(target.endpoints)) {
    if (op.startsWith('@')) continue; // listeners / scheduled jobs are not behind the LB
    endpoints[op] = { selfTime: raw.overhead ?? (l7 ? { p50: '0.3ms', p99: '1.5ms' } : { p50: '0.05ms', p99: '0.3ms' }), cpu: l7 ? '0.1ms' : '0.02ms', alloc: 0, calls: [`${target.name}:${op}`] };
  }
  // the LB decides how requests spread over the target's instances and which instances are healthy
  if (raw.algorithm) target.lb = parseLbAlgorithm(raw.algorithm);
  if (raw.healthCheck !== undefined && !isOff(raw.healthCheck)) {
    const hc = raw.healthCheck;
    target.healthCheck = { interval: dur(hc.interval, 10_000), threshold: Math.max(1, num(hc.threshold, 3)), riseThreshold: Math.max(1, num(hc.riseThreshold, 2)) };
  }
  const key = `${name}->${target.name}`;
  edges[key] = { ...(raw.timeout !== undefined ? { timeout: raw.timeout } : {}), network: { rtt: raw.rtt ?? '0.2ms' }, ...(edges[key] ?? {}) };
  const spec = parseService(name, { ...raw, kind: 'service', os: { gc: 'zgc', vcpu: 4, ...(raw.os ?? {}) }, runtime: frontRuntime(raw, 'webflux'), endpoints }, vars);
  spec.role = 'lb';
  return spec;
}

/**
 * CDN in front of an origin (service, gateway or load balancer). Cache hits are answered at the edge;
 * misses (and uncacheable methods) go to the origin over a longer network path.
 *   hitRate: 90%                         # default for GET / HEAD
 *   rules: { "GET /products/**": 98%, "GET /cart/**": 0 }
 */
function parseCdn(name: string, raw: any, nodes: Record<string, NodeSpec>, vars: Record<string, Dist>, edges: Record<string, any>): ServiceSpec {
  const target = nodes[String(raw.origin ?? raw.target)];
  if (!target || target.kind !== 'service') throw new Error(`origin: CDN 뒤의 오리진 "${raw.origin ?? raw.target}"가 없습니다 (서비스·게이트웨이·LB)`);
  const def = raw.hitRate !== undefined ? ratio(raw.hitRate) : 0.9;
  const rules: [string, number][] = Object.entries<any>(raw.rules ?? {}).map(([k, v]) => [k, ratio(typeof v === 'object' ? v.hitRate : v)]);
  const endpoints: Record<string, any> = {};
  for (const op of Object.keys(target.endpoints)) {
    if (op.startsWith('@')) continue;
    const rule = rules.find(([pattern]) => routeMatches(pattern, op));
    const cacheable = /^(GET|HEAD)\s/i.test(op) || !op.includes(' ');
    const hit = rule ? rule[1] : cacheable ? def : 0;
    endpoints[op] = {
      selfTime: raw.edgeLatency ?? { p50: '1ms', p99: '6ms' },
      cpu: '0.01ms',
      alloc: 0,
      calls: hit >= 1 ? [] : [hit > 0 ? `${target.name}:${op} @${+((1 - hit) * 100).toFixed(4)}%` : `${target.name}:${op}`],
    };
  }
  const key = `${name}->${target.name}`;
  edges[key] = { timeout: raw.originTimeout ?? '30s', network: { rtt: raw.originRtt ?? '30ms' }, ...(edges[key] ?? {}) };
  // the edge network itself is effectively unlimited: many PoPs, many machines
  const spec = parseService(name, { kind: 'service', instances: raw.pops ?? 20, os: { gc: 'zgc', vcpu: 32 }, runtime: { model: 'webflux', eventLoops: 64, maxConnections: 1_000_000, acceptCount: 65535 }, endpoints }, vars);
  spec.role = 'cdn';
  return spec;
}

/**
 * Connection pooler in front of a DB (PgBouncer, ProxySQL, RDS Proxy). Callers use the DB's query names on it;
 * many client connections are multiplexed onto `poolSize` server connections (transaction pooling).
 */
function parsePooler(name: string, raw: any, nodes: Record<string, NodeSpec>, vars: Record<string, Dist>, edges: Record<string, any>): ServiceSpec {
  const db = nodes[String(raw.target ?? raw.db)];
  if (!db || db.kind !== 'db') throw new Error(`target: 커넥션 풀러 뒤의 DB "${raw.target ?? raw.db}"가 없습니다`);
  const engine = String(raw.engine ?? 'pgbouncer').toLowerCase();
  const endpoints: Record<string, any> = {};
  for (const q of [...Object.keys(db.queries), 'query']) {
    if (endpoints[q]) continue;
    endpoints[q] = { selfTime: { p50: '0.05ms', p99: '0.3ms' }, cpu: '0.02ms', alloc: 0, calls: [`${db.name}:${q}`] };
  }
  const key = `${name}->${db.name}`;
  edges[key] = {
    pool: { size: Math.max(1, num(raw.poolSize ?? raw.defaultPoolSize, 20)), timeout: raw.queryWaitTimeout ?? '120s' },
    network: { rtt: raw.rtt ?? '0.2ms' },
    // the pooler speaks the wire protocol asynchronously: waiting on a server connection does not stall its loop
    blocking: false,
    ...(edges[key] ?? {}),
  };
  // PgBouncer is a single-threaded event loop; ProxySQL / RDS Proxy use a few worker threads
  const spec = parseService(
    name,
    {
      kind: 'service',
      instances: raw.instances ?? 1,
      os: { gc: 'zgc', vcpu: raw.vcpu ?? 2 },
      runtime: { model: 'webflux', eventLoops: raw.threads ?? (engine === 'pgbouncer' ? 1 : 4), maxConnections: Math.max(1, num(raw.maxClientConn, engine === 'pgbouncer' ? 100 : 2048)), acceptCount: 1 },
      endpoints,
    },
    vars,
  );
  spec.role = 'pooler';
  return spec;
}

// ---------------------------------------------------------------------------
// Partitioned stores

const STORE_PRESETS: Record<StoreEngine, any> = {
  dynamodb: { nodes: 4, partitions: 4, replication: 3, placement: 'ring', leader: true, readFrom: 'any', concurrency: 2000, queue: Infinity, partitionRate: { read: 3000, write: 1000 }, failoverTime: 0, read: 'ONE', write: 'QUORUM', latency: { p50: '4ms', p99: '12ms' } },
  cassandra: { nodes: 3, partitions: 48, replication: 3, placement: 'ring', leader: false, readFrom: 'any', concurrency: 128, queue: 1024, partitionRate: { read: Infinity, write: Infinity }, failoverTime: 0, read: 'QUORUM', write: 'QUORUM', latency: { p50: '1ms', p99: '6ms' } },
  mongodb: { nodes: 3, partitions: 1, replication: 3, placement: 'group', leader: true, readFrom: 'leader', concurrency: 128, queue: Infinity, partitionRate: { read: Infinity, write: Infinity }, failoverTime: 12_000, read: 'ONE', write: 'majority', latency: { p50: '2ms', p99: '10ms' } },
  elasticsearch: { nodes: 3, partitions: 5, replication: 2, placement: 'ring', leader: true, readFrom: 'any', concurrency: 7, queue: 1000, partitionRate: { read: Infinity, write: Infinity }, failoverTime: 3000, read: 'ONE', write: 'ALL', latency: { p50: '8ms', p99: '40ms' } },
  s3: { nodes: 1, partitions: 1, replication: 1, placement: 'ring', leader: false, readFrom: 'any', concurrency: Infinity, queue: Infinity, partitionRate: { read: 5500, write: 3500 }, failoverTime: 0, read: 'ONE', write: 'ONE', latency: { p50: '15ms', p99: '80ms' } },
};

function acksOf(v: unknown, rf: number): number {
  const s = String(v ?? 'ONE').toUpperCase();
  if (/^\d+$/.test(s)) return Math.max(1, Math.min(rf, Number(s)));
  if (s === 'ALL') return rf;
  if (s === 'QUORUM' || s === 'LOCAL_QUORUM' || s === 'EACH_QUORUM' || s === 'MAJORITY') return Math.floor(rf / 2) + 1;
  if (s === 'TWO') return Math.min(rf, 2);
  if (s === 'THREE') return Math.min(rf, 3);
  return 1; // ONE, LOCAL_ONE, ANY, w:1
}

function parseStore(name: string, raw: any): StoreSpec {
  const engine = String(raw.engine ?? 'dynamodb').toLowerCase() as StoreEngine;
  const pre = STORE_PRESETS[engine];
  if (!pre) throw new Error(`engine: "${raw.engine}"을 모릅니다 (dynamodb | cassandra | mongodb | elasticsearch | s3)`);
  const replication = Math.max(1, num(raw.replication ?? raw.replicationFactor ?? (raw.replicas !== undefined ? 1 + Number(raw.replicas) : undefined), pre.replication));
  const placement: StoreSpec['placement'] = raw.placement ?? pre.placement;
  const partitions = Math.max(1, num(raw.partitions ?? raw.shards ?? raw.prefixes, pre.partitions));
  // Mongo: each shard is its own replica set; ring stores need at least RF nodes
  const nodes = placement === 'group' ? partitions * replication : Math.max(replication, num(raw.nodes, engine === 'dynamodb' || engine === 's3' ? partitions : pre.nodes));
  const cons = raw.consistency ?? {};
  const readDefault = typeof cons === 'string' ? cons : cons.read ?? raw.readConsistency ?? pre.read;
  const writeDefault = typeof cons === 'string' ? cons : cons.write ?? raw.writeConcern ?? raw.writeConsistency ?? pre.write;
  const pr = raw.partitionRate ?? {};
  const isWrite = (op: string) => /put|insert|update|delete|write|save|upsert|index|post|batchwrite|remove|set/i.test(op);
  const op = (opName: string, v: any): StoreOpSpec => {
    const o = v && typeof v === 'object' && !('p50' in v) && !('kind' in v) ? v : { latency: v };
    const write = o.write !== undefined ? !!o.write : isWrite(opName);
    return {
      latency: parseDist(o.latency ?? raw.latency ?? (engine === 's3' && write ? { p50: '30ms', p99: '150ms' } : pre.latency)),
      write,
      scatter: o.scatter !== undefined ? !!o.scatter : engine === 'elasticsearch' && !write && /search|query|_search|aggregat/i.test(opName),
      acks: acksOf(o.consistency ?? o.writeConcern ?? (write ? writeDefault : readDefault), replication),
      size: o.size !== undefined ? bytes(o.size) : engine === 's3' ? 100 * 1024 : 1024,
    };
  };
  const ops: Record<string, StoreOpSpec> = {};
  for (const [k, v] of Object.entries<any>(raw.ops ?? raw.queries ?? {})) ops[k] = at(`ops.${k}`, () => op(k, v));
  return {
    kind: 'nosql',
    name,
    engine,
    nodes,
    partitions,
    replication,
    placement,
    leader: raw.leader !== undefined ? !!raw.leader : pre.leader,
    readFrom: raw.readPreference === 'secondary' || raw.readPreference === 'nearest' || raw.readFrom === 'any' ? 'any' : raw.readPreference === 'primary' || raw.readFrom === 'leader' ? 'leader' : pre.readFrom,
    concurrency: cnt(raw.concurrency ?? raw.threads, pre.concurrency),
    queue: cnt(raw.queue ?? raw.queueSize, pre.queue),
    partitionRate: {
      read: pr.read !== undefined ? rate(pr.read) : pre.partitionRate.read,
      write: pr.write !== undefined ? rate(pr.write) : pre.partitionRate.write,
    },
    keySkew: raw.keySkew !== undefined ? Math.max(0, Number(raw.keySkew)) : 0,
    failoverTime: dur(raw.failoverTime ?? raw.electionTime, pre.failoverTime),
    bandwidth: raw.bandwidth !== undefined ? bandwidth(raw.bandwidth) : 80_000,
    ops,
    defaultOp: op('get', raw.defaultOp ?? {}),
  };
}

function parseLbAlgorithm(v: unknown): ServiceSpec['lb'] {
  const s = String(v ?? 'round-robin').toLowerCase();
  if (s === 'least-conn' || s === 'least-connections' || s === 'least_request' || s === 'least-request') return 'least-conn';
  if (s === 'random') return 'random';
  if (s === 'p2c' || s === 'power-of-two') return 'p2c';
  return 'round-robin';
}

function parseMesh(m: any): MeshSpec {
  const r = m.retries;
  const o = m.outlierDetection ?? m.outlier;
  return {
    sidecarLatency: parseDist(m.sidecarLatency ?? { p50: '0.3ms', p99: '2ms' }),
    sidecarCpu: m.sidecarCpu !== undefined ? time(m.sidecarCpu) : 0.2,
    retries:
      r === undefined || isOff(r)
        ? null
        : {
            attempts: Math.max(1, Math.round(num(r.attempts, 2))) + 1,
            perTryTimeout: dur(r.perTryTimeout, Infinity),
            on: r.on ? (Array.isArray(r.on) ? r.on : [r.on]) : (['conn', 'error', 'timeout'] as ErrorKind[]),
            backoff: dur(r.backoff, 25),
          },
    outlier:
      o === undefined || isOff(o)
        ? null
        : { consecutiveErrors: Math.max(1, num(o.consecutiveErrors ?? o.consecutive5xxErrors, 5)), ejectionTime: dur(o.baseEjectionTime ?? o.ejectionTime, 30_000), maxEjectionPercent: ratio(num(o.maxEjectionPercent, 10), true) },
    timeout: dur(m.timeout, Infinity),
    maxRequests: cnt(m.connectionPool?.maxRequests ?? m.maxRequests, Infinity),
    exclude: (m.exclude ?? []).map(String),
  };
}

function applyMesh(e: EdgeSpec, mesh: MeshSpec, nodes: Record<string, NodeSpec>, raw: any): void {
  const from = nodes[e.from];
  const to = nodes[e.to];
  const inMesh = (n: NodeSpec | undefined) => n?.kind === 'service' && n.role !== 'lb' && !mesh.exclude.includes(n.name);
  if (!inMesh(from) || !inMesh(to) || raw?.mesh === false) return;
  e.mesh = true;
  e.timeout = Math.min(e.timeout, mesh.timeout);
  e.connectTimeout = Math.min(e.connectTimeout, e.timeout);
  if (Number.isFinite(mesh.maxRequests) && !e.bulkhead) e.bulkhead = { maxConcurrent: mesh.maxRequests, maxWait: 0 };
}

export function splitEdgeKey(key: string): [string, string] {
  const i = key.indexOf('->');
  if (i < 0) throw new ModelError('연결선 키는 "from->to" 형식이어야 합니다', `edges.${key}`);
  return [key.slice(0, i).trim(), key.slice(i + 2).trim()];
}

// ---------------------------------------------------------------------------
// Nodes

function parseNode(name: string, raw: any, vars: Record<string, Dist>): NodeSpec {
  const kind = raw.kind ?? 'service';
  switch (kind) {
    case 'service':
      return parseService(name, raw, vars);
    case 'db':
      return parseDb(name, raw);
    case 'cache':
      return parseCache(name, raw);
    case 'external':
      return parseExternal(name, raw);
    case 'queue':
      return parseQueue(name, raw);
    case 'nosql':
      return parseStore(name, raw);
    case 'objectstore':
      return parseStore(name, { engine: 's3', ...raw });
    default:
      throw new Error(`알 수 없는 kind: "${kind}" (service | db | cache | external | queue | nosql | objectstore | gateway | loadbalancer | cdn | pooler)`);
  }
}

const GC_PAUSES: Record<GcKind, { young: [number, number]; old: [number, number] }> = {
  // [p50, p99] ms for a 1 GB heap; scaled by sqrt(heap GB)
  g1: { young: [8, 30], old: [60, 250] },
  parallel: { young: [15, 50], old: [400, 1200] },
  serial: { young: [25, 80], old: [700, 2000] },
  zgc: { young: [0.3, 1], old: [0.5, 2] },
};

function parseService(name: string, raw: any, vars: Record<string, Dist>): ServiceSpec {
  const rt = raw.runtime ?? {};
  const os = raw.os ?? {};
  const gc: GcKind = os.gc ?? 'g1';
  if (!GC_PAUSES[gc]) throw new Error(`알 수 없는 GC: "${gc}"`);
  const heapMb = os.heap !== undefined ? memoryMb(os.heap) : 1024;
  const scale = gc === 'zgc' ? 1 : Math.sqrt(Math.max(heapMb, 128) / 1024);
  const g = GC_PAUSES[gc];
  const youngGc = os.gcPause?.young
    ? parseDist(os.gcPause.young)
    : parseDist({ p50: g.young[0] * scale, p99: g.young[1] * scale });
  const oldGc = os.gcPause?.old ? parseDist(os.gcPause.old) : parseDist({ p50: g.old[0] * scale, p99: g.old[1] * scale });

  const endpoints: Record<string, EndpointSpec> = {};
  for (const [ep, e] of Object.entries<any>(raw.endpoints ?? {})) {
    endpoints[ep] = at(`endpoints.${ep}`, () => parseEndpoint(ep, e ?? {}, vars));
  }
  if (Object.keys(endpoints).length === 0) throw new Error('서비스에는 엔드포인트가 하나 이상 필요합니다');
  const model: RuntimeModel = rt.model ?? 'tomcat';
  if (!['tomcat', 'webflux', 'virtual'].includes(model)) throw new Error(`runtime.model: "${model}" (tomcat | webflux | virtual)`);
  const vcpu = Math.max(0.1, num(os.vcpu, 2));
  const hc = raw.healthCheck;
  return {
    kind: 'service',
    name,
    role: 'service',
    instances: Math.max(1, Math.round(num(raw.instances, 1))),
    lb: parseLbAlgorithm(raw.lb),
    model,
    eventLoops: Math.max(1, Math.round(num(rt.eventLoops, Math.max(1, Math.round(vcpu))))),
    pinning: rt.pinning !== undefined ? ratio(rt.pinning) : 0,
    healthCheck:
      hc === undefined || isOff(hc)
        ? null
        : { interval: dur(hc.interval, 10_000), threshold: Math.max(1, num(hc.threshold, 3)), riseThreshold: Math.max(1, num(hc.riseThreshold, 2)) },
    threads: Math.max(1, Math.round(num(rt.threads, 200))),
    maxConnections: cnt(rt.maxConnections, 8192),
    acceptCount: cnt(rt.acceptCount, 100),
    asyncThreads: Math.max(1, cnt(rt.asyncThreads, 8)),
    vcpu,
    heapMb,
    gc,
    somaxconn: cnt(os.somaxconn, 4096),
    csOverhead: os.contextSwitch !== undefined ? num(os.contextSwitch, 0.05) : 0.05,
    cpuLimit: os.cpuLimit !== undefined ? num(os.cpuLimit, Infinity) : Infinity,
    cfsPeriod: dur(os.cfsPeriod, 100),
    ulimit: cnt(os.ulimit, 1_048_576),
    ephemeralPorts: cnt(os.ephemeralPorts, 28_232),
    timeWait: dur(os.timeWait, 60_000),
    youngGc,
    oldGc,
    endpoints,
  };
}

function parseEndpoint(name: string, raw: any, vars: Record<string, Dist>): EndpointSpec {
  return {
    name,
    selfTime: parseDist(raw.selfTime ?? '2ms'),
    cpu: raw.cpu !== undefined ? parseDist(raw.cpu) : null,
    cpuRatio: raw.cpuRatio !== undefined ? ratio(raw.cpuRatio) : 0.3,
    alloc: raw.alloc !== undefined ? bytes(raw.alloc) / 1024 ** 2 : 0.25,
    requestSize: raw.requestSize !== undefined ? bytes(raw.requestSize) : 512,
    responseSize: raw.responseSize !== undefined ? bytes(raw.responseSize) : 2048,
    calls: (raw.calls ?? []).map((c: any, i: number) => at(`calls[${i}]`, () => parseCall(c, vars))),
    rateLimit: raw.rateLimit !== undefined ? rate(raw.rateLimit) : Infinity,
    handshake: !!raw.handshake,
    broadcast: raw.broadcast ? { fanout: Math.max(1, num(raw.broadcast.fanout, 10)), cpu: time(raw.broadcast.cpu ?? '0.02ms') } : null,
    observed: raw.observed !== false,
    source: String(raw.source ?? 'manual'),
  };
}

/**
 * "payment:POST /payments/approve"
 * "stock:GET /stocks/{id} x 3"        repeat 3 times
 * "stock:GET /stocks/{id} x 1..5"     repeat uniform 1..5 times
 * "stock:GET /stocks/{id} x items"    repeat per scenario.vars.items
 * "notify:POST /send @30%"            probability
 * { call: "...", prob: 30%, count: 3, optional: true, async: true, onMiss: [...] }
 */
export function parseCall(raw: any, vars: Record<string, Dist>): CallSpec {
  const obj = typeof raw === 'string' ? { call: raw } : raw;
  const step = (extra: Partial<CallSpec>): CallSpec => ({
    target: '',
    op: '',
    prob: obj.prob !== undefined ? ratio(obj.prob) : 1,
    count: obj.count !== undefined ? (typeof obj.count === 'object' ? parseDist(obj.count, Number) : parseCount(String(obj.count), vars)) : { kind: 'const', value: 1 },
    optional: !!obj.optional,
    async: false,
    onMiss: [],
    parallel: [],
    work: null,
    workCpu: 0.3,
    ...extra,
  });
  // { parallel: [ ...steps ] } — fork, then join on all of them
  if (obj && Array.isArray(obj.parallel)) {
    if (!obj.parallel.length) throw new Error('parallel 그룹이 비어 있습니다');
    return step({ parallel: obj.parallel.map((c: any, i: number) => at(`parallel[${i}]`, () => parseCall(c, vars))) });
  }
  // { work: 5ms, cpu: 50% } — processing in this service between two calls
  if (obj && obj.work !== undefined) return step({ work: parseDist(obj.work), workCpu: obj.cpu !== undefined ? ratio(obj.cpu) : 0.3 });
  if (!obj || typeof obj.call !== 'string') throw new Error('호출은 "노드:오퍼레이션" 문자열이거나 { call: ... }, { parallel: [...] }, { work: 5ms } 객체여야 합니다');
  let s: string = obj.call.trim();
  let prob = obj.prob !== undefined ? ratio(obj.prob) : 1;
  let count: Dist = { kind: 'const', value: 1 };
  const pm = /\s+@\s*([\d.]+%?)\s*$/.exec(s);
  if (pm) {
    prob = ratio(pm[1]);
    s = s.slice(0, pm.index);
  }
  const xm = /\s+x\s+(\S+)\s*$/.exec(s);
  if (xm) {
    count = parseCount(xm[1], vars);
    s = s.slice(0, xm.index);
  }
  if (obj.count !== undefined) count = typeof obj.count === 'object' ? parseDist(obj.count, Number) : parseCount(String(obj.count), vars);
  const i = s.indexOf(':');
  if (i <= 0) throw new Error(`호출 "${obj.call}"은 "노드:오퍼레이션" 형식이어야 합니다`);
  return {
    target: s.slice(0, i).trim(),
    op: s.slice(i + 1).trim(),
    prob,
    count,
    optional: !!obj.optional,
    async: !!obj.async,
    onMiss: (obj.onMiss ?? []).map((c: any) => parseCall(c, vars)),
    parallel: [],
    work: null,
    workCpu: 0.3,
  };
}

function parseCount(s: string, vars: Record<string, Dist>): Dist {
  if (/^\d+$/.test(s)) return { kind: 'const', value: Number(s) };
  const r = /^(\d+)\.\.(\d+)$/.exec(s);
  if (r) return { kind: 'uniform', min: Number(r[1]), max: Number(r[2]) + 0.999 };
  if (vars[s]) return vars[s];
  throw new Error(`반복 횟수 "${s}"를 해석할 수 없습니다 (숫자, a..b, 또는 scenario.vars 이름)`);
}

function parseDb(name: string, raw: any): DbSpec {
  const queries: DbSpec['queries'] = {};
  for (const [q, v] of Object.entries<any>(raw.queries ?? {})) {
    const o = v && typeof v === 'object' && 'latency' in v ? v : { latency: v };
    queries[q] = at(`queries.${q}`, () => ({
      latency: parseDist(o.latency ?? '2ms'),
      responseSize: o.responseSize !== undefined ? bytes(o.responseSize) : 512,
      read: o.read !== undefined ? !!o.read : isReadQuery(q),
      scatter: !!o.scatter,
    }));
  }
  const cl = raw.cluster ?? {};
  const c = raw.contention ?? {};
  return {
    kind: 'db',
    name,
    maxConnections: cnt(raw.maxConnections, 151),
    contention: {
      saturation: Math.max(2, num(c.saturation, 32)),
      latencyX: Math.max(1, num(c.latencyX, 3)),
      shape: Math.max(0.1, num(c.shape, 1.5)),
      retrograde: Math.max(0, num(c.retrograde, 0)),
    },
    queries,
    defaultQuery: { latency: parseDist(raw.latency ?? { p50: '2ms', p99: '10ms' }), responseSize: 512, read: false, scatter: false },
    cluster: {
      shards: Math.max(1, Math.round(num(cl.shards, 1))),
      keySkew: Math.max(0, num(cl.keySkew, 0)),
      replicas: Math.max(0, Math.round(num(cl.replicas, 0))),
      readSplit: cl.readSplit !== undefined ? !!cl.readSplit : num(cl.replicas, 0) > 0,
      failoverTime: dur(cl.failoverTime, 30_000),
    },
  };
}

/** SELECT / find… / get… style names are reads (routed to replicas when readSplit is on) */
export function isReadQuery(name: string): boolean {
  return /^(select|find|get|read|count|exists|search|load|query|list|fetch)/i.test(name.replace(/^[\w$]+\./, ''));
}

function parseCacheOp(v: any, base: CacheOpSpec): CacheOpSpec {
  return {
    hitRate: v.hitRate !== undefined ? ratio(v.hitRate) : base.hitRate,
    ttl: v.ttl !== undefined ? time(v.ttl) : base.ttl,
    keys: Math.max(1, Math.round(num(v.keys, base.keys))),
    ttlJitter: v.ttlJitter !== undefined ? Math.min(1, ratio(v.ttlJitter)) : base.ttlJitter,
    singleFlight: v.singleFlight !== undefined ? !!v.singleFlight : base.singleFlight,
    skew: v.skew !== undefined ? Math.max(0, num(v.skew, 0)) : base.skew,
  };
}

function parseCache(name: string, raw: any): CacheSpec {
  const defaults = parseCacheOp(raw, { hitRate: 0.9, ttl: NaN, keys: 1000, ttlJitter: 0, singleFlight: false, skew: 0 });
  const ops: CacheSpec['ops'] = {};
  for (const [o, v] of Object.entries<any>(raw.ops ?? {})) ops[o] = at(`ops.${o}`, () => parseCacheOp(v ?? {}, defaults));
  const cl = raw.cluster ?? {};
  return {
    kind: 'cache',
    name,
    cluster: {
      shards: Math.max(1, Math.round(num(cl.shards, 1))),
      replicas: Math.max(0, Math.round(num(cl.replicas, 0))),
      failoverTime: dur(cl.failoverTime, 15_000),
    },
    threads: Math.max(1, num(raw.threads, 1)),
    opTime: parseDist(raw.opTime ?? '0.1ms'),
    defaults,
    ops,
  };
}

function parseQueue(name: string, raw: any): QueueSpec {
  const c = raw.consumer;
  let consumer: QueueSpec['consumer'] = null;
  if (c) {
    const [service, ...rest] = String(c.endpoint ?? c.listener ?? '').split(':');
    const svc = c.service ?? service;
    const ep = c.service ? String(c.endpoint ?? c.listener) : rest.join(':').trim();
    if (!svc || !ep) throw new Error('consumer는 { service, endpoint } 또는 { endpoint: "서비스:리스너" }가 필요합니다');
    consumer = {
      service: String(svc).trim(),
      endpoint: ep,
      concurrency: Math.max(1, Math.round(num(c.concurrency, 1))),
      prefetch: Math.max(1, Math.round(num(c.prefetch, 250))),
      ack: c.ack === 'auto' ? 'auto' : 'manual',
      maxRetries: c.maxRetries === undefined || c.maxRetries === 'infinite' ? Infinity : Math.max(0, num(c.maxRetries, 3)),
      dlq: !!c.dlq,
      retryDelay: dur(c.retryDelay, 0),
      deliveryRtt: dur(c.deliveryRtt, 2),
    };
  }
  const broker = String(raw.broker ?? 'rabbitmq').toLowerCase();
  if (broker !== 'rabbitmq' && broker !== 'kafka') throw new Error(`broker: "${raw.broker}" (rabbitmq | kafka)`);
  const k = raw.kafka ?? {};
  const kc = raw.consumer ?? {};
  const kafka =
    broker === 'kafka'
      ? {
          partitions: Math.max(1, Math.round(num(k.partitions ?? raw.partitions, 6))),
          brokers: Math.max(1, Math.round(num(k.brokers, 3))),
          replicationFactor: Math.max(1, Math.round(num(k.replicationFactor, Math.min(3, num(k.brokers, 3))))),
          minInsyncReplicas: Math.max(1, Math.round(num(k.minInsyncReplicas, Math.min(2, num(k.brokers, 3))))),
          acks: String(k.acks ?? 'all') === '1' ? ('1' as const) : ('all' as const),
          replicationTime: parseDist(k.replicationTime ?? { p50: '1ms', p99: '5ms' }),
          electionTime: dur(k.electionTime, 5_000),
          deliveryTimeout: dur(k.deliveryTimeout, 30_000),
          keySkew: Math.max(0, num(k.keySkew ?? raw.keySkew, 0)),
          maxPollRecords: Math.max(1, Math.round(num(kc.maxPollRecords, 500))),
          onError: kc.onError === 'skip' ? ('skip' as const) : ('retry' as const),
          retryBackoff: dur(kc.retryBackoff, 0),
          rebalanceTime: dur(k.rebalanceTime ?? kc.rebalanceTime, 10_000),
        }
      : null;
  if (kafka && consumer) {
    // Spring Kafka DefaultErrorHandler: 9 retries (10 attempts) by default
    if (kc.maxRetries === undefined) consumer.maxRetries = 9;
    consumer.ack = 'manual';
    if (kc.deliveryRtt === undefined) consumer.deliveryRtt = 5;
  }
  return {
    kind: 'queue',
    name,
    broker,
    kafka,
    rabbit:
      broker === 'rabbitmq'
        ? {
            nodes: Math.max(1, Math.round(num(raw.cluster?.nodes, 1))),
            queueType: raw.cluster?.queueType === 'quorum' ? 'quorum' : 'classic',
            electionTime: dur(raw.cluster?.electionTime, 5_000),
          }
        : null,
    publishTime: parseDist(raw.publishTime ?? (broker === 'kafka' ? { p50: '2ms', p99: '10ms' } : { p50: '0.5ms', p99: '3ms' })),
    capacity: cnt(raw.capacity, 0),
    consumer,
  };
}

function parseExternal(name: string, raw: any): ExternalSpec {
  return {
    kind: 'external',
    name,
    concurrency: cnt(raw.concurrency, Infinity),
    latency: parseDist(raw.latency ?? { p50: '50ms', p99: '200ms' }),
    failureRate: raw.failureRate !== undefined ? ratio(raw.failureRate) : 0,
    rateLimit: raw.rateLimit !== undefined ? rate(raw.rateLimit) : Infinity,
  };
}

// ---------------------------------------------------------------------------
// Edges

/** model-wide network defaults (top-level `network:`): where the system runs, e.g. one host, one AZ, across regions */
let networkDefaults: any = {};

export function parseEdge(from: string, to: string, raw: any, target: NodeSpec, implicit: boolean): EdgeSpec {
  const n = raw.network ?? {};
  const fromClient = from === CLIENT;
  const g = networkDefaults;
  const network: NetworkSpec = {
    rtt: dur(n.rtt ?? (fromClient ? g.clientRtt : g.rtt), fromClient ? 2 : 0.5),
    jitter: dur(n.jitter ?? (fromClient ? g.clientJitter : g.jitter), fromClient ? 0.5 : 0.1),
    loss: n.loss !== undefined ? ratio(n.loss) : 0,
    rtoMin: dur(n.rtoMin, 200),
    bandwidth: n.bandwidth !== undefined ? bandwidth(n.bandwidth) : bandwidth('1gbps'),
    keepAlive: n.keepAlive !== false,
    handshakeRtts: num(n.handshakeRtts, n.tls ? 2 : 1),
  };
  const timeout = raw.timeout !== undefined ? time(raw.timeout) : Infinity;
  const pool =
    raw.pool !== undefined
      ? isOff(raw.pool)
        ? null
        : { size: Math.max(1, cnt(raw.pool.size, 10)), timeout: dur(raw.pool.timeout, 30_000) }
      : target.kind === 'db' && !fromClient
        ? { size: 10, timeout: 30_000 } // HikariCP defaults
        : null;
  return {
    key: `${from}->${to}`,
    from,
    to,
    implicit,
    blocking: raw.blocking !== undefined ? !!raw.blocking : target.kind === 'db',
    mesh: false,
    network,
    timeout,
    connectTimeout: raw.connectTimeout !== undefined ? time(raw.connectTimeout) : timeout,
    retry: raw.retry === undefined || isOff(raw.retry) ? null : parseRetry(raw.retry),
    circuitBreaker: raw.circuitBreaker === undefined || isOff(raw.circuitBreaker) ? null : parseCb(raw.circuitBreaker),
    bulkhead:
      raw.bulkhead === undefined || isOff(raw.bulkhead)
        ? null
        : { maxConcurrent: Math.max(1, num(raw.bulkhead.maxConcurrent, 25)), maxWait: dur(raw.bulkhead.maxWait, 0) },
    fallback:
      raw.fallback === undefined || isOff(raw.fallback) ? null : { latency: parseDist(raw.fallback.latency ?? '1ms') },
    rateLimiter:
      raw.rateLimiter === undefined || isOff(raw.rateLimiter)
        ? null
        : {
            limit: Math.max(1, num(raw.rateLimiter.limit, 50)),
            period: dur(raw.rateLimiter.period, 1000),
            timeout: dur(raw.rateLimiter.timeout, 0),
          },
    pool,
  };
}

function parseRetry(r: any): RetrySpec {
  const o = r === true ? {} : r;
  let jitter = 0;
  if (o.jitter === true) jitter = 0.5;
  else if (o.jitter !== undefined && o.jitter !== false) jitter = ratio(o.jitter);
  const on: ErrorKind[] = o.on ? (Array.isArray(o.on) ? o.on : [o.on]) : ERROR_KINDS;
  for (const k of on) if (!ERROR_KINDS.includes(k)) throw new Error(`retry.on: 알 수 없는 오류 종류 "${k}" (${ERROR_KINDS.join(', ')})`);
  return {
    maxAttempts: Math.max(1, Math.round(num(o.max ?? o.maxAttempts, 3))),
    backoff: o.backoff === 'exponential' ? 'exponential' : 'fixed',
    wait: dur(o.wait, 500),
    multiplier: num(o.multiplier, 2),
    maxWait: dur(o.maxWait, Infinity),
    jitter: Math.min(1, jitter),
    on,
  };
}

function parseCb(c: any): CircuitBreakerSpec {
  const o = c === true ? {} : c;
  // Defaults follow Resilience4j.
  return {
    failureRate: ratio(num(o.failureRate, 50), true),
    slowCall: dur(o.slowCall, 60_000),
    slowCallRate: ratio(num(o.slowCallRate, 100), true),
    windowType: o.windowType === 'time' ? 'time' : 'count',
    window: Math.max(1, Math.round(num(o.window, 100))),
    minCalls: Math.max(1, Math.round(num(o.minCalls, Math.min(100, num(o.window, 100))))),
    openFor: dur(o.openFor, 60_000),
    halfOpenCalls: Math.max(1, Math.round(num(o.halfOpenCalls, 10))),
  };
}

// ---------------------------------------------------------------------------
// Scenario

export function resolveEndpoint(ref: string, nodes: Record<string, NodeSpec>): EndpointRef {
  const i = ref.indexOf(':');
  if (i > 0 && nodes[ref.slice(0, i)]) {
    const node = ref.slice(0, i);
    const op = ref.slice(i + 1).trim();
    const n = nodes[node];
    if (n.kind !== 'service' || !n.endpoints[op]) throw new Error(`엔드포인트 "${ref}"가 없습니다`);
    return { node, op };
  }
  let found = Object.values(nodes).filter((n): n is ServiceSpec => n.kind === 'service' && !!n.endpoints[ref]);
  // traffic enters through the front-most hop exposing the API: drop every node that another candidate forwards this API to
  if (found.length > 1) {
    const forwardsTo = (m: ServiceSpec, n: ServiceSpec) => {
      let hit = false;
      forEachCall(m.endpoints[ref].calls, (c) => (hit ||= c.target === n.name));
      return hit;
    };
    const front = found.filter((n) => !found.some((m) => m !== n && forwardsTo(m, n)));
    if (front.length) found = front;
  }
  if (found.length === 0) throw new Error(`엔드포인트 "${ref}"를 가진 서비스가 없습니다`);
  if (found.length > 1)
    throw new Error(`엔드포인트 "${ref}"가 여러 서비스에 있습니다 (${found.map((f) => f.name).join(', ')}) — "서비스:${ref}"로 지정하세요`);
  return { node: found[0].name, op: ref };
}

function parseTraffic(t: any): TrafficPattern {
  const type = t.type ?? (t.peak !== undefined ? 'spike' : t.to !== undefined ? 'ramp' : t.steps ? 'steps' : 'constant');
  switch (type) {
    case 'constant':
    case 'soak':
      return { type: 'constant', rps: rate(t.rps ?? t.base ?? 100) };
    case 'ramp':
      return { type: 'ramp', from: rate(t.from ?? 0), to: rate(t.to), start: dur(t.start, 0), end: dur(t.end ?? t.over, 60_000) };
    case 'spike':
      return {
        type: 'spike',
        base: rate(t.base),
        peak: rate(t.peak),
        at: dur(t.at, 30_000),
        hold: dur(t.hold, Infinity),
        rampUp: dur(t.rampUp, 0),
      };
    case 'steps':
      return {
        type: 'steps',
        steps: (t.steps as any[]).map((s) => ({ at: time(s.at), rps: rate(s.rps) })).sort((a, b) => a.at - b.at),
      };
    default:
      throw new Error(`알 수 없는 트래픽 type: "${type}" (constant | ramp | spike | steps)`);
  }
}

export function rpsAt(p: TrafficPattern, t: number): number {
  switch (p.type) {
    case 'constant':
      return p.rps;
    case 'ramp':
      if (t <= p.start) return p.from;
      if (t >= p.end) return p.to;
      return p.from + ((p.to - p.from) * (t - p.start)) / (p.end - p.start);
    case 'spike': {
      if (t < p.at) return p.base;
      if (t >= p.at + p.rampUp + p.hold) return p.base;
      if (p.rampUp > 0 && t < p.at + p.rampUp) return p.base + ((p.peak - p.base) * (t - p.at)) / p.rampUp;
      return p.peak;
    }
    case 'steps': {
      let r = 0;
      for (const s of p.steps) if (s.at <= t) r = s.rps;
      return r;
    }
  }
}

export function peakRps(p: TrafficPattern): number {
  switch (p.type) {
    case 'constant':
      return p.rps;
    case 'ramp':
      return Math.max(p.from, p.to);
    case 'spike':
      return Math.max(p.base, p.peak);
    case 'steps':
      return Math.max(0, ...p.steps.map((s) => s.rps));
  }
}

function parseScenario(s: any, nodes: Record<string, NodeSpec>, vars: Record<string, Dist>): Scenario {
  const wsRaw = s.websocket;
  const traffic = s.traffic ?? (wsRaw ? { type: 'constant', rps: 0 } : { type: 'constant', rps: 100 });
  const mixRaw: Record<string, any> = traffic.mix ?? s.mix ?? {};
  let mix = Object.entries(mixRaw).map(([k, w]) => ({ ref: at(`traffic.mix.${k}`, () => resolveEndpoint(k, nodes)), weight: ratio(w, true) }));
  if (mix.length === 0 && wsRaw) {
    // WebSocket-only scenario: no request/response traffic
  } else if (mix.length === 0) {
    // default: every endpoint of the first service, equally weighted
    const first = Object.values(nodes).find((n): n is ServiceSpec => n.kind === 'service');
    if (!first) throw new Error('트래픽을 받을 서비스가 없습니다');
    mix = Object.keys(first.endpoints).map((op) => ({ ref: { node: first.name, op }, weight: 1 }));
  }
  const total = mix.reduce((a, m) => a + m.weight, 0);
  if (mix.length && total <= 0) throw new Error('traffic.mix 비율의 합이 0입니다');
  mix.forEach((m) => (m.weight /= total));

  const duration = dur(s.duration, 60_000);
  const sloRaw = s.slo ?? {};
  const slo = {
    p99: dur(sloRaw.p99, 300),
    errorRate: sloRaw.errorRate !== undefined ? ratio(sloRaw.errorRate) : 0.001,
    endpoints: {} as Record<string, { p99: number; errorRate: number }>,
  };
  for (const [k, v] of Object.entries<any>(sloRaw.endpoints ?? {})) {
    const ref = at(`slo.endpoints.${k}`, () => resolveEndpoint(k, nodes));
    slo.endpoints[`${ref.node}:${ref.op}`] = {
      p99: dur(v.p99, slo.p99),
      errorRate: v.errorRate !== undefined ? ratio(v.errorRate) : slo.errorRate,
    };
  }

  const faults: FaultSpec[] = (s.faults ?? []).filter((f: any) => f && f.enabled !== false).map((f: any, i: number) =>
    at(`faults[${i}]`, () => ({
      target: String(f.target ?? (f.zone !== undefined ? '*' : '')),
      zone: f.zone !== undefined ? String(f.zone) : null,
      instance: f.instance !== undefined ? Math.round(Number(f.instance)) : null,
      at: dur(f.at, 0),
      until: f.until !== undefined ? time(f.until) : f.for !== undefined ? dur(f.at, 0) + time(f.for) : Infinity,
      latencyX: num(f.latencyX, 1),
      errorRate: f.errorRate !== undefined ? ratio(f.errorRate) : 0,
      down: !!f.down,
      hang: !!f.hang,
      loss: f.loss !== undefined ? ratio(f.loss) : 0,
      flush: !!f.flush,
      pause: !!f.pause,
    })),
  );

  return {
    duration,
    warmup: dur(s.warmup, Math.min(10_000, duration * 0.1)),
    seed: Number(s.seed ?? 1),
    clientTimeout: dur(s.clientTimeout, 30_000),
    arrival: s.arrival === 'uniform' ? 'uniform' : 'poisson',
    traffic: at('traffic', () => parseTraffic(traffic)),
    mix,
    schedules: (s.schedules ?? []).map((j: any, i: number) =>
      at(`schedules[${i}]`, () => ({ ref: resolveEndpoint(String(j.endpoint), nodes), every: time(j.every), at: dur(j.at, 0) })),
    ),
    faults,
    slo,
    vars,
    websocket: wsRaw ? at('websocket', () => parseWebSocket(wsRaw, nodes)) : null,
  };
}
