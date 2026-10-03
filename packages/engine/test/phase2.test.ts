// Phase-2/3 mechanisms: each test pins down the behaviour a demo relies on.
import { describe, expect, it } from 'vitest';
import { loadModel, simulate } from '../src';

const sum = (a: number[]) => a.reduce((x, y) => x + y, 0);
const run = (yaml: string) => simulate(loadModel(yaml), undefined, undefined, { particles: false });

describe('cache keyspace', () => {
  const doc = (jitter: string, single: boolean) => `
nodes:
  app:
    endpoints:
      GET /p: { selfTime: 1ms, calls: [ { call: "cache:GET p", onMiss: [ "db:select" ] } ] }
  cache:
    kind: cache
    threads: 4
    ops:
      GET p: { ttl: 10s, keys: 200, ttlJitter: ${jitter}, singleFlight: ${single} }
  db:
    kind: db
    queries: { select: 20ms }
scenario:
  duration: 30s
  warmup: 0s
  traffic: { rps: 1000, mix: { "GET /p": 1 } }
`;
  it('synchronized TTL expiry sends a burst to the DB exactly at the TTL', () => {
    const r = run(doc('0', false));
    const db = r.nodes.find((n) => n.name === 'db')!.served;
    // before expiry the DB is idle, at 10s it gets hammered
    expect(sum(db.slice(0, 9))).toBe(0);
    expect(db[10]).toBeGreaterThan(200);
  });
  it('single flight loads each key once; jitter spreads the reloads out', () => {
    const plain = run(doc('0', false));
    const fixed = run(doc('30%', true));
    const peak = (r: typeof plain) => Math.max(...r.nodes.find((n) => n.name === 'db')!.served);
    expect(peak(fixed)).toBeLessThan(peak(plain) / 2);
    const c = fixed.nodes.find((n) => n.name === 'cache')!.cache!;
    expect(sum(c.waits)).toBeGreaterThan(0);
  });
  it('flush fault empties the cache', () => {
    const r = run(doc('30%', false).replace('traffic:', 'faults: [ { target: cache, at: 5s, flush: true } ]\n  traffic:'));
    const db = r.nodes.find((n) => n.name === 'db')!.served;
    expect(db[5]).toBeGreaterThan(100);
    expect(r.events.some((e) => e.type === 'cache-flush')).toBe(true);
  });
});

describe('message queue', () => {
  const doc = (extra = '', handler = '5ms', concurrency = 4) => `
nodes:
  producer:
    endpoints:
      POST /e: { selfTime: 1ms, calls: [ "q:publish" ] }
  q:
    kind: queue
    consumer: { service: worker, endpoint: handle, concurrency: ${concurrency}, prefetch: 10, ack: manual, maxRetries: infinite }
  worker:
    endpoints:
      handle: { selfTime: ${handler} }
scenario:
  duration: 40s
  warmup: 0s
  traffic: { rps: 200, mix: { "POST /e": 1 } }
  ${extra}
`;
  it('consumers keep up and a paused consumer builds a backlog that drains afterwards', () => {
    const steady = run(doc()).nodes.find((n) => n.name === 'q')!.queue!;
    expect(Math.max(...steady.depth)).toBeLessThan(20);
    const paused = run(doc('faults: [ { target: q, at: 10s, until: 20s, pause: true } ]')).nodes.find((n) => n.name === 'q')!.queue!;
    expect(paused.depth[18]).toBeGreaterThan(1500);
    expect(paused.depth[38]).toBeLessThan(20);
  });
  it('a failing handler with infinite requeue redelivers forever', () => {
    const r = run(doc('faults: [ { target: worker, at: 0s, errorRate: 100% } ]'));
    const q = r.nodes.find((n) => n.name === 'q')!.queue!;
    expect(sum(q.acked)).toBe(0);
    expect(sum(q.redelivered)).toBeGreaterThan(sum(q.published));
  });
});

describe('runtime models', () => {
  const doc = (model: string, threads = 20) => `
nodes:
  api:
    runtime: { model: ${model}, threads: ${threads}, eventLoops: 4 }
    os: { vcpu: 4, gc: zgc }
    endpoints:
      GET /x: { selfTime: 1ms, calls: [ "slow:GET /s" ] }
  slow:
    runtime: { threads: 2000 }
    os: { vcpu: 32, gc: zgc }
    endpoints:
      GET /s: { selfTime: 100ms, cpuRatio: 0 }
  db:
    kind: db
    maxConnections: 2000
    contention: { saturation: 1000 }
    queries: { q: 100ms }
scenario:
  duration: 20s
  warmup: 3s
  traffic: { rps: 500, mix: { "GET /x": 1 } }
`;
  it('a small Tomcat pool caps throughput on a slow downstream; webflux and virtual threads do not', () => {
    // 20 threads × (1 / 100ms) = 200 rps max for tomcat
    expect(run(doc('tomcat')).summary.p99).toBeGreaterThan(1000);
    expect(run(doc('webflux')).summary.p99).toBeLessThan(200);
    expect(run(doc('virtual')).summary.p99).toBeLessThan(200);
  });
  it('blocking JDBC calls stall webflux event loops', () => {
    const blocking = doc('webflux').replace('calls: [ "slow:GET /s" ]', 'calls: [ "db:q" ]');
    // 4 loops × (1 / 100ms) = 40 rps when every request blocks a loop for 100ms
    expect(run(blocking).summary.p99).toBeGreaterThan(1000);
    const reactive = blocking + '\nedges:\n  api->db: { blocking: false, pool: { size: 1000 } }\n';
    expect(run(reactive).summary.p99).toBeLessThan(300);
  });
});

describe('OS extras', () => {
  it('cgroup CPU limit throttles the instance in CFS periods', () => {
    const doc = (limit: string) => `
nodes:
  api:
    os: { vcpu: 4, ${limit} gc: zgc }
    endpoints:
      GET /x: { selfTime: 4ms, cpuRatio: 1, alloc: 0 }
scenario:
  duration: 20s
  warmup: 2s
  traffic: { rps: 400, mix: { "GET /x": 1 } }
`;
    const free = run(doc(''));
    const limited = run(doc('cpuLimit: 1.5,'));
    expect(sum(free.nodes[0].os!.throttledMs)).toBe(0);
    expect(sum(limited.nodes[0].os!.throttledMs)).toBeGreaterThan(1000);
    expect(limited.summary.p99).toBeGreaterThan(free.summary.p99 * 3);
  });
  it('ulimit -n refuses connections beyond the descriptor limit', () => {
    const r = run(`
nodes:
  api:
    os: { ulimit: 30, gc: zgc }
    endpoints:
      GET /x: { selfTime: 200ms, cpuRatio: 0 }
scenario:
  duration: 10s
  warmup: 1s
  traffic: { rps: 300, mix: { "GET /x": 1 } }
`);
    expect(r.summary.errorCauses.some((c) => c.cause.includes('EMFILE'))).toBe(true);
  });
  it('calls without keep-alive exhaust ephemeral ports through TIME_WAIT', () => {
    const r = run(`
nodes:
  api:
    os: { ephemeralPorts: 2000, timeWait: 60s, gc: zgc }
    endpoints:
      GET /x: { selfTime: 1ms, calls: [ "b:GET /b" ] }
  b:
    endpoints:
      GET /b: { selfTime: 1ms }
edges:
  api->b: { network: { keepAlive: false } }
scenario:
  duration: 20s
  warmup: 0s
  traffic: { rps: 300, mix: { "GET /x": 1 } }
`);
    // 2000 ports / 300 rps ≈ 6.7s until exhaustion
    expect(r.series.errors.slice(0, 5).every((e) => e === 0)).toBe(true);
    expect(r.series.errors[12]).toBeGreaterThan(100);
    expect(r.summary.errorCauses[0].cause).toContain('EADDRNOTAVAIL');
  });
});

describe('load balancer health checks', () => {
  const doc = (hc: string) => `
nodes:
  api:
    endpoints:
      GET /x: { selfTime: 1ms, calls: [ "b:GET /b" ] }
  b:
    instances: 3
    healthCheck: ${hc}
    endpoints:
      GET /b: { selfTime: 5ms }
edges:
  api->b: { timeout: 1s }
scenario:
  duration: 60s
  warmup: 0s
  traffic: { rps: 100, mix: { "GET /x": 1 } }
  faults:
    - { target: b, instance: 0, at: 10s, down: true, hang: true }
`;
  it('a hung instance keeps receiving 1/3 of traffic until health checks remove it', () => {
    const none = run(doc('false'));
    const fast = run(doc('{ interval: 2s, threshold: 2 }'));
    expect(none.series.errorRate[40]).toBeGreaterThan(0.25);
    expect(fast.series.errorRate[40]).toBe(0);
    const removed = fast.events.find((e) => e.type === 'health')!;
    expect(removed.t).toBeGreaterThan(10_000);
    expect(removed.t).toBeLessThan(15_000);
    expect(fast.nodes.find((n) => n.name === 'b')!.os!.healthy[30]).toBe(2);
  });
});

describe('circuit breaker time window', () => {
  it('opens on the failure rate of the last N seconds', () => {
    const r = run(`
nodes:
  a:
    endpoints:
      GET /a: { selfTime: 1ms, calls: [ "b:GET /b" ] }
  b:
    endpoints:
      GET /b: { selfTime: 1ms }
edges:
  a->b:
    timeout: 1s
    circuitBreaker: { windowType: time, window: 5, minCalls: 20, failureRate: 50, openFor: 5s }
    fallback: { latency: 1ms }
scenario:
  duration: 20s
  warmup: 0s
  traffic: { rps: 100, mix: { "GET /a": 1 } }
  faults: [ { target: b, at: 5s, until: 12s, errorRate: 100% } ]
`);
    const opened = r.events.find((e) => e.type === 'cb' && e.detail.includes('CLOSED → OPEN'))!;
    // the 5s window still holds pre-fault successes: failures pass 50% about 2.5s into the fault
    expect(opened.t).toBeGreaterThan(7000);
    expect(opened.t).toBeLessThan(8000);
  });
});

describe('DB retrograde contention', () => {
  it('past saturation, more concurrency lowers throughput when retrograde > 0', () => {
    const doc = (pool: number, retro: number) => `
nodes:
  a:
    runtime: { threads: 400 }
    endpoints:
      GET /a: { selfTime: 0.1ms, calls: [ "db:q" ] }
  db:
    kind: db
    maxConnections: 1000
    contention: { saturation: 10, latencyX: 2, retrograde: ${retro} }
    queries: { q: 5ms }
edges:
  a->db: { pool: { size: ${pool}, timeout: 30s } }
scenario:
  duration: 20s
  warmup: 5s
  traffic: { rps: 3000, mix: { "GET /a": 1 } }
`;
    const served = (pool: number, retro: number) => run(doc(pool, retro)).summary.throughput;
    expect(served(80, 1)).toBeLessThan(served(10, 1) * 0.6);
    expect(Math.abs(served(80, 0) - served(10, 0)) / served(10, 0)).toBeLessThan(0.15);
  });
});

describe('network loss model', () => {
  it('mid-stream losses cost one RTT (fast retransmit); only tail losses wait for the RTO', () => {
    const doc = (size: string) => `
nodes:
  a:
    endpoints:
      GET /a: { selfTime: 1ms, calls: [ "b:GET /b" ] }
  b:
    endpoints:
      GET /b: { selfTime: 1ms, responseSize: ${size} }
edges:
  a->b: { network: { rtt: 1ms, loss: 1% } }
scenario:
  duration: 30s
  warmup: 0s
  traffic: { rps: 500, mix: { "GET /a": 1 } }
`;
    // 48kb = 33 segments: ~28% see some loss, but only ~3% (tail) pay the 200ms RTO
    const big = run(doc('48kb'));
    expect(big.summary.p95).toBeLessThan(50);
    expect(big.summary.p99).toBeGreaterThan(200);
  });
});
