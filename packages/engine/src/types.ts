import type { Dist } from './dist';

// ---------------------------------------------------------------------------
// Normalized model (output of parseModel). All times in ms, sizes in bytes,
// memory in MB, ratios in 0..1.
// ---------------------------------------------------------------------------

export interface CallSpec {
  target: string;
  op: string;
  prob: number;
  /** Number of sequential repetitions (N+1 loops). Sampled per execution and rounded. */
  count: Dist;
  /** A failed optional call does not fail the calling endpoint. */
  optional: boolean;
  /** Fire-and-forget on the instance's @Async pool; does not hold the request thread. */
  async: boolean;
  /** Cache-aside: calls executed by the caller when the cache lookup misses. */
  onMiss: CallSpec[];
  /** Step kinds without a target (target === ''):
   *  parallel group — run these steps concurrently and wait for all of them (CompletableFuture.allOf / Mono.zip);
   *  work — local processing between calls (holds the request thread, `workCpu` of it on a core). */
  parallel: CallSpec[];
  work: Dist | null;
  workCpu: number;
}

/** Every remote call in a step list, including cache-miss paths and parallel groups. */
export function forEachCall(calls: CallSpec[], fn: (c: CallSpec) => void): void {
  for (const c of calls) {
    if (c.target) fn(c);
    forEachCall(c.onMiss, fn);
    forEachCall(c.parallel, fn);
  }
}

export interface EndpointSpec {
  name: string;
  selfTime: Dist;
  /** CPU time per request; null means cpuRatio × selfTime */
  cpu: Dist | null;
  cpuRatio: number;
  /** MB allocated on the heap per request */
  alloc: number;
  requestSize: number;
  responseSize: number;
  calls: CallSpec[];
  /** requests per second this API accepts before answering 429 (gateway / Bucket4j style, shared by all instances) */
  rateLimit: number;
  /** WebSocket upgrade: the instance serving it keeps the client's connection */
  handshake: boolean;
  /** after handling a message, deliver it to `fanout` subscribers spread over all instances holding connections */
  broadcast: { fanout: number; cpu: number } | null;
  /** false when the API was found (source code, OpenAPI) but never seen in traces: its profile is a default estimate */
  observed: boolean;
  /** where the profile came from, e.g. "trace", "openapi", "spring-source", "manual" */
  source: string;
}

export type GcKind = 'g1' | 'parallel' | 'zgc' | 'serial';

export type RuntimeModel = 'tomcat' | 'webflux' | 'virtual';

export interface HealthCheckSpec {
  interval: number;
  /** consecutive failed probes before the instance is taken out of rotation */
  threshold: number;
  /** consecutive successful probes before it is put back */
  riseThreshold: number;
}

export interface ServiceSpec {
  kind: 'service';
  name: string;
  instances: number;
  /** service: application; gateway: API gateway routing to backends; lb: load balancer in front of one service */
  role: 'service' | 'gateway' | 'lb' | 'cdn' | 'pooler';
  /** how callers spread requests over this service's instances */
  lb: 'round-robin' | 'least-conn' | 'random' | 'p2c';
  /** tomcat: thread per request; webflux: event loops, blocking calls stall a loop; virtual: virtual threads on carriers */
  model: RuntimeModel;
  /** webflux event loops (default = vcpu) */
  eventLoops: number;
  /** virtual threads: probability that a blocking call pins its carrier (synchronized + I/O) */
  pinning: number;
  healthCheck: HealthCheckSpec | null;
  threads: number;
  maxConnections: number;
  acceptCount: number;
  asyncThreads: number;
  vcpu: number;
  heapMb: number;
  gc: GcKind;
  somaxconn: number;
  /** context switching: CPU time × (1 + csOverhead · ln(runnable / cores)) when oversubscribed */
  csOverhead: number;
  /** container CPU limit in cores (cgroup CFS quota); Infinity = none */
  cpuLimit: number;
  cfsPeriod: number;
  /** ulimit -n: open sockets (inbound connections + outbound calls) */
  ulimit: number;
  /** ephemeral port range size for outbound connections without keep-alive */
  ephemeralPorts: number;
  timeWait: number;
  youngGc: Dist;
  oldGc: Dist;
  endpoints: Record<string, EndpointSpec>;
}

export interface DbSpec {
  kind: 'db';
  name: string;
  maxConnections: number;
  /** latency multiplier = 1 + (latencyX - 1) * ((c - 1) / (saturation - 1)) ^ shape, linear in c past saturation */
  contention: { saturation: number; latencyX: number; shape: number; retrograde: number };
  queries: Record<string, { latency: Dist; responseSize: number; read: boolean; scatter: boolean }>;
  defaultQuery: { latency: Dist; responseSize: number; read: boolean; scatter: boolean };
  /**
   * Sharded and replicated: `shards` independent primaries, each with `replicas` read replicas.
   * Member index = shard × (1 + replicas) + k (k = 0 is the shard's initial primary).
   */
  cluster: {
    shards: number;
    /** shard-key skew: 0 = even, ~1 = a hot shard */
    keySkew: number;
    replicas: number;
    /** send read queries to replicas (round robin) instead of the primary */
    readSplit: boolean;
    /** time to promote a replica after the primary dies */
    failoverTime: number;
  };
}

export interface CacheOpSpec {
  /** fixed hit ratio, used when no ttl is given */
  hitRate: number;
  /** keyspace model: entries expire after ttl and are refilled by the caller's onMiss path */
  ttl: number;
  keys: number;
  /** ±ratio randomisation of each entry's ttl (0 = synchronized expiry) */
  ttlJitter: number;
  /** only one caller reloads a missing key; others wait for it (lock / single flight) */
  singleFlight: boolean;
  /** skew of key popularity: 0 = uniform, ~1 = Zipf-like hot keys */
  skew: number;
}

export interface CacheSpec {
  kind: 'cache';
  name: string;
  /** Redis Cluster: keys are split over shards (instance i = shard i); each shard has its own command thread(s) */
  cluster: { shards: number; replicas: number; failoverTime: number };
  threads: number;
  opTime: Dist;
  defaults: CacheOpSpec;
  ops: Record<string, CacheOpSpec>;
}

export interface ExternalSpec {
  kind: 'external';
  name: string;
  concurrency: number;
  latency: Dist;
  failureRate: number;
  /** requests per second accepted before answering 429 */
  rateLimit: number;
}

export type Broker = 'rabbitmq' | 'kafka';

export interface KafkaSpec {
  partitions: number;
  /** cluster: partition leaders are spread over brokers (instance i = broker i) */
  brokers: number;
  replicationFactor: number;
  minInsyncReplicas: number;
  acks: 'all' | '1';
  /** extra publish latency for replicating to followers when acks=all */
  replicationTime: Dist;
  /** time to elect new leaders when a broker dies */
  electionTime: number;
  /** a producer blocks this long waiting for a leader before failing */
  deliveryTimeout: number;
  /** key skew: 0 = keys spread evenly, ~1 = a few hot partitions get most messages */
  keySkew: number;
  /** records fetched per poll; the fetch round trip is amortised over the batch */
  maxPollRecords: number;
  /** what the listener does with a failing record */
  onError: 'retry' | 'skip';
  /** blocking retries in place (partition stalls meanwhile), then the record goes to the DLT (if any) or is skipped */
  retryBackoff: number;
  /** consumption pauses this long whenever group membership changes (instance dies or comes back) */
  rebalanceTime: number;
}

export interface QueueSpec {
  kind: 'queue';
  name: string;
  /** rabbitmq: one FIFO, any free listener takes the next message; kafka: partitioned log, in-order per partition */
  broker: Broker;
  kafka: KafkaSpec | null;
  /** RabbitMQ cluster: the queue lives on node 0. classic: lost while that node is down; quorum: replicated, re-elects a leader */
  rabbit: { nodes: number; queueType: 'classic' | 'quorum'; electionTime: number } | null;
  /** broker publish latency */
  publishTime: Dist;
  /** max messages held; publishes beyond this fail (0 = unbounded) */
  capacity: number;
  consumer: {
    service: string;
    endpoint: string;
    /** listener threads per consumer instance */
    concurrency: number;
    /** unacked messages a consumer may hold (buffered + processing) */
    prefetch: number;
    ack: 'auto' | 'manual';
    /** redeliveries before a message goes to the DLQ; Infinity = requeue forever */
    maxRetries: number;
    dlq: boolean;
    retryDelay: number;
    /** broker round trip per delivery; prefetch amortises it */
    deliveryRtt: number;
  } | null;
}

/** Partitioned, replicated data stores: NoSQL databases, search engines and object storage. */
export type StoreEngine = 'dynamodb' | 'cassandra' | 'mongodb' | 'elasticsearch' | 's3';

export interface StoreOpSpec {
  /** service time on one replica */
  latency: Dist;
  write: boolean;
  /** touches every partition (search, scan, scatter-gather query) and waits for the slowest */
  scatter: boolean;
  /** replicas that must answer: consistency level (ONE/QUORUM/ALL) or write concern */
  acks: number;
  /** bytes moved per request (object storage); adds size / bandwidth */
  size: number;
}

export interface StoreSpec {
  kind: 'nosql';
  name: string;
  engine: StoreEngine;
  /** members (instance i = node i): Cassandra nodes, Mongo replica-set members, ES data nodes */
  nodes: number;
  /** key ranges: DynamoDB partitions, Mongo shards, ES primary shards, S3 prefixes, Cassandra token ranges */
  partitions: number;
  /** copies of every partition (replication factor / replica set size / 1 + ES replicas) */
  replication: number;
  /** ring: partition p lives on nodes p, p+1, … (Cassandra, ES); group: each shard owns its own replica set (Mongo) */
  placement: 'ring' | 'group';
  /** writes go through the partition's primary and then replicate (Mongo, ES, DynamoDB) vs leaderless (Cassandra) */
  leader: boolean;
  /** reads from the primary only (Mongo readPreference primary, strongly consistent reads) or any replica */
  readFrom: 'leader' | 'any';
  /** concurrent requests one node works on (native transport threads, WiredTiger tickets, search thread pool) */
  concurrency: number;
  /** requests one node may queue before rejecting (ES search queue → 429); Infinity = unbounded */
  queue: number;
  /** per-partition operations per second (DynamoDB 3000 RCU / 1000 WCU, S3 5500 GET / 3500 PUT per prefix) */
  partitionRate: { read: number; write: number };
  /** 0 = keys spread evenly, ~1 = a few hot keys dominate */
  keySkew: number;
  /** time to elect a new primary after it dies (leader engines) */
  failoverTime: number;
  /** bytes per ms one request can transfer */
  bandwidth: number;
  ops: Record<string, StoreOpSpec>;
  defaultOp: StoreOpSpec;
}

export type NodeSpec = ServiceSpec | DbSpec | CacheSpec | ExternalSpec | QueueSpec | StoreSpec;
export type NodeKind = NodeSpec['kind'];

export interface NetworkSpec {
  rtt: number;
  jitter: number;
  loss: number;
  rtoMin: number;
  /** bytes per ms */
  bandwidth: number;
  keepAlive: boolean;
  handshakeRtts: number;
}

export interface RetrySpec {
  maxAttempts: number;
  backoff: 'fixed' | 'exponential';
  wait: number;
  multiplier: number;
  maxWait: number;
  /** 0 = no jitter; 0.5 = ±50% randomization */
  jitter: number;
  on: ErrorKind[];
}

export interface CircuitBreakerSpec {
  failureRate: number;
  slowCall: number;
  slowCallRate: number;
  /** count: last N calls; time: calls in the last N seconds */
  windowType: 'count' | 'time';
  window: number;
  minCalls: number;
  openFor: number;
  halfOpenCalls: number;
}

export interface EdgeSpec {
  key: string;
  from: string;
  to: string;
  /** true if not declared in YAML (defaults apply) */
  implicit: boolean;
  network: NetworkSpec;
  timeout: number;
  connectTimeout: number;
  retry: RetrySpec | null;
  circuitBreaker: CircuitBreakerSpec | null;
  bulkhead: { maxConcurrent: number; maxWait: number } | null;
  fallback: { latency: Dist } | null;
  rateLimiter: { limit: number; period: number; timeout: number } | null;
  /** HikariCP pool (db targets) or HTTP client connection pool (others), per caller instance */
  pool: { size: number; timeout: number } | null;
  /** does the call block the calling thread? (webflux / virtual threads). Default: true for db (JDBC), false otherwise */
  blocking: boolean;
  /** both ends are in the service mesh: sidecars, mesh retries and outlier detection apply */
  mesh: boolean;
}

export type TrafficPattern =
  | { type: 'constant'; rps: number }
  | { type: 'ramp'; from: number; to: number; start: number; end: number }
  | { type: 'spike'; base: number; peak: number; at: number; hold: number; rampUp: number }
  | { type: 'steps'; steps: { at: number; rps: number }[] };

export interface EndpointRef {
  node: string;
  op: string;
}

export interface FaultSpec {
  /** node / edge, or "*" with `zone` for a whole-zone outage */
  target: string;
  /** limit the fault to the members placed in this availability zone */
  zone: string | null;
  /** limit the fault to one instance of a service (0-based) */
  instance: number | null;
  at: number;
  until: number;
  latencyX: number;
  errorRate: number;
  down: boolean;
  /** a down instance accepts connections but never answers (vs. refusing them) */
  hang: boolean;
  loss: number;
  /** cache: drop every entry at `at` (restart / flush) */
  flush: boolean;
  /** queue: consumers stop pulling messages */
  pause: boolean;
}

export interface SloSpec {
  p99: number;
  errorRate: number;
  endpoints: Record<string, { p99: number; errorRate: number }>;
}

export interface WebSocketSpec {
  /** handshake API as the client calls it (may be a gateway / load balancer in front) */
  connect: EndpointRef;
  /** service whose instances hold the connections */
  service: string;
  /** handler that runs on the instance holding the connection, per client message */
  message: EndpointRef;
  clients: number;
  /** initial connections are opened evenly over this time */
  connectOver: number;
  /** messages per client per second */
  messageRate: number;
  reconnect: { delay: number; multiplier: number; maxDelay: number; jitter: number };
  /** heap held per open connection (MB) */
  connMemory: number;
  /** a hung server is noticed after this long without heartbeat */
  heartbeatTimeout: number;
}

export interface Scenario {
  duration: number;
  warmup: number;
  seed: number;
  clientTimeout: number;
  arrival: 'poisson' | 'uniform';
  traffic: TrafficPattern;
  mix: { ref: EndpointRef; weight: number }[];
  schedules: { ref: EndpointRef; every: number; at: number }[];
  websocket: WebSocketSpec | null;
  faults: FaultSpec[];
  slo: SloSpec;
  vars: Record<string, Dist>;
}

export interface MeshSpec {
  /** extra latency per sidecar hop (each call crosses two sidecars) */
  sidecarLatency: Dist;
  /** CPU per request spent in the sidecar(s) of a pod, charged to that pod */
  sidecarCpu: number;
  /** Envoy-level retries, applied inside each application-level attempt */
  retries: { attempts: number; perTryTimeout: number; on: ErrorKind[]; backoff: number } | null;
  /** passive health checking: eject an instance after consecutive errors */
  outlier: { consecutiveErrors: number; ejectionTime: number; maxEjectionPercent: number } | null;
  /** route timeout (VirtualService); the effective timeout is the smaller of this and the app's */
  timeout: number;
  /** max concurrent requests per caller pod → upstream; overflow answers 503 immediately */
  maxRequests: number;
  /** nodes outside the mesh */
  exclude: string[];
}

export interface TopologySpec {
  zones: string[];
  /** extra round trip when caller and callee members are in different zones */
  crossZoneRtt: number;
  /** load balancers prefer instances in the caller's zone (topology-aware routing) */
  zoneAware: boolean;
}

export interface Model {
  nodes: Record<string, NodeSpec>;
  edges: Record<string, EdgeSpec>;
  scenario: Scenario;
  mesh: MeshSpec | null;
  topology: TopologySpec | null;
  /** node → zones its members are spread over (member i lives in zones[i % zones.length]) */
  placement: Record<string, string[]>;
}

// ---------------------------------------------------------------------------
// Results
// ---------------------------------------------------------------------------

export type ErrorKind =
  | 'timeout'
  | 'error'
  | 'conn'
  | 'rejected'
  | 'cb_open'
  | 'pool_timeout'
  | 'rate_limited'
  | 'too_many_requests';

export const ERROR_KINDS: ErrorKind[] = [
  'timeout',
  'error',
  'conn',
  'rejected',
  'cb_open',
  'pool_timeout',
  'rate_limited',
  'too_many_requests',
];

export interface LatencyStats {
  count: number;
  ok: number;
  errors: number;
  errorRate: number;
  degraded: number;
  mean: number;
  p50: number;
  p95: number;
  p99: number;
  max: number;
}

export interface EndpointResult extends LatencyStats {
  id: string;
  node: string;
  op: string;
  entry: boolean;
  observed: boolean;
  source: string;
  /** successful responses per second over the measurement window */
  throughput: number;
  slo?: { p99: number; errorRate: number; pass: boolean; p99Ok: boolean; errorOk: boolean };
  series?: { throughput: number[]; errors: number[]; p50: number[]; p99: number[] };
}

export type ResourceKind =
  | 'threads'
  | 'cpu'
  | 'backlog'
  | 'pool'
  | 'bulkhead'
  | 'db'
  | 'cache'
  | 'external'
  | 'async'
  | 'loop'
  | 'fd'
  | 'ports'
  | 'consumers'
  | 'store';

export interface ResourceSeries {
  id: string;
  kind: ResourceKind;
  /** node the resource lives on (for pools: the caller service) */
  node: string;
  edge?: string;
  /** cluster member (e.g. "replica 1", "shard 2") when a node has several */
  member?: string;
  label: string;
  capacity: number;
  /** time-averaged busy / capacity per bucket */
  util: number[];
  /** time-averaged number of waiters per bucket */
  queue: number[];
  /** max waiters in bucket */
  queueMax: number[];
}

export interface EdgeResult {
  key: string;
  from: string;
  to: string;
  implicit: boolean;
  attempts: number;
  calls: number;
  retries: number;
  timeouts: number;
  failures: number;
  fallbacks: number;
  cbRejected: number;
  /** retries done by the mesh sidecar (inside app attempts) */
  meshRetries: number;
  /** attempts per root request */
  amplification: number;
  series: {
    attempts: number[];
    retries: number[];
    failures: number[];
    /** fraction of caller instances whose breaker is OPEN (avg over bucket) */
    cbOpen: number[];
    cbHalfOpen: number[];
  };
}

export interface NodeResult {
  name: string;
  kind: NodeKind;
  instances: number;
  /** headline saturation 0..1+ per bucket (max of its resources), used for block colour */
  saturation: number[];
  /** OS layer gauges (services only) */
  os?: {
    cpu: number[];
    gcPauseMs: number[];
    backlog: number[];
    synDrops: number[];
    gcCount: number[];
    throttledMs: number[];
    fdUsed: number[];
    portsInUse: number[];
    /** instances currently in the load balancer rotation */
    healthy: number[];
  };
  queue?: {
    depth: number[];
    published: number[];
    acked: number[];
    redelivered: number[];
    dlq: number[];
    oldestAgeMs: number[];
    /** kafka: largest single-partition lag (hot partition / head-of-line blocking) */
    maxPartitionLag?: number[];
    /** kafka: consumer threads with no partition assigned */
    idleConsumers?: number[];
    /** kafka: ms of the bucket spent rebalancing */
    rebalanceMs?: number[];
  };
  cache?: { hits: number[]; misses: number[]; loads: number[]; waits: number[] };
  /** partitioned stores: requests refused per second, by reason */
  store?: { throttled: number[]; rejected: number[]; unavailable: number[]; hottestPartitionShare: number };
  /** WebSocket connections held by this service */
  ws?: { connections: number[]; maxPerInstance: number[]; minPerInstance: number[]; connects: number[]; drops: number[] };
  /** requests served per second */
  served: number[];
}

export interface SimEvent {
  t: number;
  type: 'cb' | 'gc-old' | 'fault-start' | 'fault-end' | 'health' | 'cache-flush' | 'rebalance' | 'failover' | 'eject';
  target: string;
  detail: string;
}

export interface ParticleTrace {
  t0: number;
  t1: number;
  status: 'ok' | 'error' | 'degraded' | 'open';
  /** flattened [t, nodeIndex, t, nodeIndex, ...]; nodeIndex -1 = client */
  path: number[];
  /** entry API the request was sent to (EndpointResult.id) */
  api: string;
}

export interface SimResult {
  duration: number;
  bucketMs: number;
  buckets: number;
  window: [number, number];
  time: number[];
  series: {
    arrivals: number[];
    throughput: number[];
    errors: number[];
    degraded: number[];
    errorRate: number[];
    p50: number[];
    p95: number[];
    p99: number[];
    byKind: Record<ErrorKind, number[]>;
  };
  summary: LatencyStats & {
    roots: number;
    throughput: number;
    inFlightAtEnd: number;
    sloPass: boolean;
    sloViolations: string[];
    /** root failures grouped by where they originated, e.g. "order->payment timeout" */
    errorCauses: { cause: string; count: number }[];
    eventsProcessed: number;
    wallMs: number;
  };
  endpoints: EndpointResult[];
  resources: ResourceSeries[];
  edges: EdgeResult[];
  nodes: NodeResult[];
  events: SimEvent[];
  particles: { sampleEvery: number; nodes: string[]; traces: ParticleTrace[] };
}

export interface Warning {
  level: 'error' | 'warn' | 'info';
  code: string;
  message: string;
  /** node or edge key the warning points at */
  target?: string;
}
