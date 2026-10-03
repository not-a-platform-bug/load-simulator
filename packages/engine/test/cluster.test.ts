import { describe, expect, it } from 'vitest';
import { loadModel, simulate } from '../src';

const run = (yaml: string) => simulate(loadModel(yaml), undefined, undefined, { particles: false });
const sum = (a: number[]) => a.reduce((x, y) => x + y, 0);

describe('DB cluster', () => {
  const doc = (cluster: string, faults = '') => `
nodes:
  api:
    runtime: { threads: 400 }
    endpoints:
      GET /read: { selfTime: 1ms, calls: [ "db:selectItem" ] }
      POST /write: { selfTime: 1ms, calls: [ "db:insertItem" ] }
  db:
    kind: db
    cluster: ${cluster}
    contention: { saturation: 32, latencyX: 2 }
    queries: { selectItem: 10ms, insertItem: 5ms }
edges:
  api->db: { pool: { size: 200, timeout: 2s }, timeout: 2s }
scenario:
  duration: 60s
  warmup: 5s
  traffic: { rps: 2500, mix: { "GET /read": 90%, "POST /write": 10% } }
  ${faults}
`;
  it('read replicas take read load off the primary', () => {
    const single = run(doc('{ replicas: 0 }'));
    const replicated = run(doc('{ replicas: 2 }'));
    expect(replicated.summary.p99).toBeLessThan(single.summary.p99 / 2);
    const prim = replicated.resources.find((r) => r.member === 'primary')!;
    const rep1 = replicated.resources.find((r) => r.member === 'replica-1')!;
    expect(sum(rep1.util)).toBeGreaterThan(sum(prim.util) * 2);
  });
  it('primary failure: writes fail until a replica is promoted, reads keep working', () => {
    const r = run(doc('{ replicas: 2, failoverTime: 10s }', 'faults: [ { target: db, instance: 0, at: 20s, down: true } ]'));
    expect(r.series.errors[25]).toBeGreaterThan(50);
    expect(r.series.errors[35]).toBe(0);
    const ev = r.events.find((e) => e.type === 'failover')!;
    expect(ev.t).toBeGreaterThanOrEqual(30_000);
    expect(r.endpoints.find((e) => e.op === 'GET /read')!.errorRate).toBeLessThan(0.001);
  });
});

describe('Redis cluster', () => {
  const doc = (shards: number, skew: number, faults = '') => `
nodes:
  api:
    os: { vcpu: 16 }
    endpoints:
      GET /x: { selfTime: 1ms, calls: [ "redis:GET k" ] }
  redis:
    kind: cache
    cluster: { shards: ${shards}, replicas: 1, failoverTime: 5s }
    opTime: 0.2ms
    ops: { GET k: { hitRate: 1, skew: ${skew} } }
scenario:
  duration: 30s
  warmup: 2s
  traffic: { rps: 6000, mix: { "GET /x": 1 } }
  ${faults}
`;
  it('sharding spreads a single-threaded server over several; a hot key still hits one shard', () => {
    // 6000 ops/s × 0.2ms = 1.2 cores: too much for one Redis thread
    expect(run(doc(1, 0)).summary.p99).toBeGreaterThan(1000);
    expect(run(doc(3, 0)).summary.p99).toBeLessThan(100);
    const hot = run(doc(3, 2));
    const shards = hot.resources.filter((r) => r.kind === 'cache').map((r) => sum(r.util));
    expect(Math.max(...shards)).toBeGreaterThan(Math.min(...shards) * 1.5);
  });
  it('a dead shard fails its keys until the replica takes over', () => {
    const r = run(doc(3, 0, 'faults: [ { target: redis, instance: 1, at: 10s, down: true } ]'));
    expect(r.series.errorRate[12]).toBeGreaterThan(0.2);
    expect(r.series.errorRate[12]).toBeLessThan(0.45);
    expect(r.series.errorRate[17]).toBe(0);
  });
});

describe('broker clusters', () => {
  const kafka = (acks: string, faults: string) => `
nodes:
  p:
    runtime: { threads: 2000 }
    endpoints:
      POST /e: { selfTime: 1ms, calls: [ "t:publish" ] }
  t:
    kind: queue
    broker: kafka
    kafka: { partitions: 6, brokers: 3, replicationFactor: 3, minInsyncReplicas: 2, acks: "${acks}", electionTime: 5s, deliveryTimeout: 5s }
    consumer: { service: c, endpoint: h, concurrency: 6 }
  c:
    endpoints:
      h: { selfTime: 2ms }
edges:
  p->t: { timeout: 30s }
scenario:
  duration: 40s
  warmup: 0s
  traffic: { rps: 300, mix: { "POST /e": 1 } }
  faults: [ ${faults} ]
`;
  it('kafka: losing a broker stalls its partitions for the leader election, then continues', () => {
    const r = run(kafka('all', '{ target: t, instance: 0, at: 10s, down: true }'));
    // producers to the affected partitions block ~5s (recorded when they complete, around 15s) → latency, not errors
    expect(r.summary.errorRate).toBe(0);
    expect(Math.max(...r.series.p99.slice(10, 17).filter(Number.isFinite))).toBeGreaterThan(3000);
    expect(r.series.p99[25]).toBeLessThan(50);
  });
  it('kafka acks=all: fewer live replicas than min.insync.replicas rejects writes', () => {
    const r = run(kafka('all', '{ target: t, instance: 0, at: 10s, down: true }, { target: t, instance: 1, at: 10s, down: true }'));
    // NotEnoughReplicas is retried until delivery.timeout (5s), then fails
    expect(r.series.errorRate[25]).toBeGreaterThan(0.9);
    const acks1 = run(kafka('1', '{ target: t, instance: 0, at: 10s, down: true }, { target: t, instance: 1, at: 10s, down: true }'));
    expect(acks1.series.errorRate[30]).toBe(0);
  });
  const rabbit = (type: string) => `
nodes:
  p:
    endpoints:
      POST /e: { selfTime: 1ms, calls: [ "q:publish" ] }
  q:
    kind: queue
    cluster: { nodes: 3, queueType: ${type}, electionTime: 5s }
    consumer: { service: c, endpoint: h, concurrency: 4 }
  c:
    endpoints:
      h: { selfTime: 2ms }
scenario:
  duration: 40s
  warmup: 0s
  traffic: { rps: 200, mix: { "POST /e": 1 } }
  faults: [ { target: q, instance: 0, at: 10s, until: 30s, down: true } ]
`;
  it('rabbitmq: a classic queue is gone while its node is down; a quorum queue re-elects', () => {
    const classic = run(rabbit('classic'));
    const quorum = run(rabbit('quorum'));
    expect(classic.series.errorRate[20]).toBeGreaterThan(0.9);
    expect(quorum.series.errorRate[20]).toBe(0);
    expect(quorum.summary.p50).toBeGreaterThan(classic.summary.p50);
  });
});
