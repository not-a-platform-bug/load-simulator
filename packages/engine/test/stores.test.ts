// NoSQL / search / object storage, CDN and DB connection pooler
import { describe, expect, it } from 'vitest';
import { loadModel, simulate } from '../src';

const run = (yaml: string) => simulate(loadModel(yaml), undefined, undefined, { particles: false });
const ep = (r: ReturnType<typeof run>, op: string) => r.endpoints.find((e) => e.op === op && e.entry)!;
const edge = (r: ReturnType<typeof run>, k: string) => r.edges.find((e) => e.key === k)!;
const node = (r: ReturnType<typeof run>, n: string) => r.nodes.find((x) => x.name === n)!;
const sum = (a: number[]) => a.reduce((x, y) => x + y, 0);

const app = (store: string, calls: string, rps = 300, extra = '') => `
nodes:
  api:
    instances: 4
    runtime: { threads: 400 }
    os: { vcpu: 8 }
    endpoints:
      GET /x:
        selfTime: 1ms
        calls: [${calls}]
  store:
${store}
edges:
  api->store: { timeout: 2s }
scenario:
  duration: 30s
  warmup: 2s
  traffic: { rps: ${rps}, mix: { "GET /x": 100% } }
  ${extra}
`;

describe('DynamoDB', () => {
  const ddb = (skew: number) => `    kind: nosql
    engine: dynamodb
    partitions: 4
    keySkew: ${skew}
    ops: { PutItem: { write: true } }`;
  it("a hot key exceeds one partition's write capacity while the table as a whole has room", () => {
    const even = run(app(ddb(0), '"store:PutItem"', 3000));
    const hot = run(app(ddb(1), '"store:PutItem"', 3000));
    expect(even.summary.errorRate).toBeLessThan(0.005);
    expect(hot.summary.errorRate).toBeGreaterThan(0.2);
    expect(hot.summary.errorCauses[0].cause).toContain('ProvisionedThroughputExceeded');
    expect(node(hot, 'store').store!.hottestPartitionShare).toBeGreaterThan(0.5);
  });
});

describe('Cassandra', () => {
  const cas = (consistency: string, down = '') => app(
    `    kind: nosql
    engine: cassandra
    nodes: 3
    replication: 3
    consistency: ${consistency}`,
    '"store:select"',
    300,
    down ? `faults: [{ target: store, instance: 0, at: 0s, duration: 60s, down: true }]` : '',
  );
  it('QUORUM survives one node down, ALL does not', () => {
    expect(run(cas('QUORUM', 'x')).summary.errorRate).toBe(0);
    expect(run(cas('ALL', 'x')).summary.errorRate).toBeGreaterThan(0.9);
  });
  it('waiting for more replicas costs tail latency', () => {
    expect(ep(run(cas('ALL')), 'GET /x').p99).toBeGreaterThan(ep(run(cas('ONE')), 'GET /x').p99);
  });
});

describe('MongoDB', () => {
  it('writes fail until a new primary is elected, then recover', () => {
    const r = run(app(
      `    kind: nosql
    engine: mongodb
    ops: { insertOrder: {} }`,
      '"store:insertOrder"',
      200,
      'faults: [{ target: store, instance: 0, at: 10s, duration: 15s, down: true }]',
    ));
    expect(r.events.some((e) => e.type === 'failover')).toBe(true);
    const err = r.series.errors;
    expect(sum(err.slice(11, 21))).toBeGreaterThan(1000); // election window (12s)
    expect(sum(err.slice(24, 30))).toBe(0);
  });
});

describe('Elasticsearch', () => {
  const es = (rps: number) => app(
    `    kind: nosql
    engine: elasticsearch
    nodes: 3
    partitions: 5
    ops: { search: {}, get: { scatter: false } }`,
    '"store:search"',
    rps,
  );
  it('a search fans out to every shard and waits for the slowest', () => {
    const r = run(es(100));
    expect(ep(r, 'GET /x').p50).toBeGreaterThan(9);
  });
  it('a full search queue answers 429', () => {
    const r = run(es(4000));
    expect(r.summary.errorCauses.some((c) => c.cause.includes('429'))).toBe(true);
  });
});

describe('S3', () => {
  const s3 = (prefixes: number) => app(
    `    kind: objectstore
    prefixes: ${prefixes}
    ops: { GetObject: { size: 200kb } }`,
    '"store:GetObject"',
    8000,
  );
  it('one prefix is limited to ~5500 GET/s; spreading keys over prefixes removes SlowDown', () => {
    const one = run(s3(1));
    expect(one.summary.errorCauses[0].cause).toContain('SlowDown');
    expect(run(s3(4)).summary.errorRate).toBe(0);
  });
});

describe('CDN', () => {
  it('only misses and uncacheable requests reach the origin', () => {
    const r = run(`
nodes:
  cdn: { kind: cdn, origin: web, hitRate: 90% }
  web:
    endpoints:
      GET /page: { selfTime: 20ms }
      POST /form: { selfTime: 20ms }
scenario:
  duration: 20s
  warmup: 2s
  traffic: { rps: 500, mix: { "GET /page": 80%, "POST /form": 20% } }
`);
    const origin = edge(r, 'cdn->web').calls;
    const total = edge(r, 'client->cdn').calls;
    // 80% × 10% misses + 20% POST ≈ 28%
    expect(origin / total).toBeGreaterThan(0.24);
    expect(origin / total).toBeLessThan(0.32);
    expect(ep(r, 'GET /page').p50).toBeLessThan(ep(r, 'POST /form').p50);
  });
});

describe('connection pooler', () => {
  it('multiplexes many app connections onto a few DB connections', () => {
    const doc = (viaPooler: boolean) => `
nodes:
  api:
    instances: 8
    runtime: { threads: 200 }
    endpoints:
      GET /x: { selfTime: 1ms, calls: ["${viaPooler ? 'pgbouncer' : 'db'}:select"] }
  pgbouncer: { kind: pooler, target: db, poolSize: 24, maxClientConn: 400 }
  db:
    kind: db
    maxConnections: 500
    contention: { saturation: 24, latencyX: 3, shape: 1.5, retrograde: 0.5 }
    queries: { select: { p50: 5ms, p99: 20ms } }
edges:
  api->${viaPooler ? 'pgbouncer' : 'db'}: { pool: { size: 40, timeout: 3s }, timeout: 3s }
scenario:
  duration: 30s
  warmup: 3s
  traffic: { rps: 4000, mix: { "GET /x": 100% } }
`;
    const direct = run(doc(false));
    const pooled = run(doc(true));
    const peak = (r: ReturnType<typeof run>) => Math.max(...r.resources.filter((x) => x.node === 'db' && x.kind === 'db').flatMap((x) => x.util.map((u) => u * x.capacity)));
    expect(peak(pooled)).toBeLessThanOrEqual(24.5);
    expect(peak(direct)).toBeGreaterThan(40);
    expect(pooled.summary.throughput).toBeGreaterThan(direct.summary.throughput);
  });
});
