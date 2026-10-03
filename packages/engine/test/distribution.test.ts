// DB sharding and availability zones
import { describe, expect, it } from 'vitest';
import { loadModel, simulate } from '../src';

const run = (yaml: string) => simulate(loadModel(yaml), undefined, undefined, { particles: false });
const sum = (a: number[]) => a.reduce((x, y) => x + y, 0);

describe('DB sharding', () => {
  const doc = (shards: number, extra = '') => `
nodes:
  api:
    runtime: { threads: 400 }
    os: { vcpu: 8 }
    endpoints:
      POST /w: { selfTime: 1ms, calls: [ "db:insertOrder" ] }
      GET /report: { selfTime: 1ms, calls: [ "db:sumAll" ] }
  db:
    kind: db
    cluster: { shards: ${shards} ${extra} }
    contention: { saturation: 16, latencyX: 2 }
    queries:
      insertOrder: 5ms
      sumAll: { latency: { p50: 5ms, p99: 30ms }, scatter: true }
edges:
  api->db: { pool: { size: 200, timeout: 5s } }
scenario:
  duration: 30s
  warmup: 5s
  traffic: { rps: 3000, mix: { "POST /w": 95%, "GET /report": 5% } }
`;
  it('writes scale out over shards (replicas would not help)', () => {
    // one primary: 16 / (5ms × 2) = 1600 writes/s < 2850 offered
    expect(run(doc(1)).summary.p99).toBeGreaterThan(1000);
    const four = run(doc(4));
    expect(four.endpoints.find((e) => e.op === 'POST /w')!.p50).toBeLessThan(20);
    expect(four.endpoints.find((e) => e.op === 'POST /w')!.p99).toBeLessThan(300);
  });
  it('a skewed shard key makes one shard hot', () => {
    const r = run(doc(4, ', keySkew: 1.5'));
    const u = r.resources.filter((x) => x.kind === 'db').map((x) => sum(x.util));
    expect(Math.max(...u)).toBeGreaterThan(Math.min(...u) * 4);
  });
  it('scatter-gather queries wait for the slowest shard', () => {
    const r = run(doc(8));
    const report = r.endpoints.find((e) => e.op === 'GET /report')!;
    const write = r.endpoints.find((e) => e.op === 'POST /w')!;
    expect(report.p50).toBeGreaterThan(write.p50 * 1.5);
  });
});

describe('availability zones', () => {
  const doc = (opts: { zoneAware?: boolean; zones?: string; fault?: string } = {}) => `
topology: { zones: [a, b, c], crossZoneRtt: 2ms, zoneAware: ${opts.zoneAware ?? false} }
nodes:
  web:
    instances: 3
    healthCheck: { interval: 1s, threshold: 2 }
    endpoints:
      GET /x: { selfTime: 1ms, calls: [ "api:GET /y" ] }
  api:
    instances: 3
    ${opts.zones ?? ''}
    healthCheck: { interval: 1s, threshold: 2 }
    endpoints:
      GET /y: { selfTime: 2ms, calls: [ "db:select" ] }
  db:
    kind: db
    cluster: { replicas: 2, failoverTime: 10s }
    queries: { select: 1ms, insertX: 1ms }
edges:
  web->api: { timeout: 1s, retry: { max: 2, wait: 5ms, on: [conn, timeout] } }
scenario:
  duration: 60s
  warmup: 3s
  traffic: { rps: 300, mix: { "GET /x": 1 } }
  ${opts.fault ? `faults: [ ${opts.fault} ]` : ''}
`;
  it('cross-zone calls cost latency; zone-aware routing keeps calls local', () => {
    const spread = run(doc());
    const local = run(doc({ zoneAware: true }));
    expect(spread.summary.p50 - local.summary.p50).toBeGreaterThan(0.8);
  });
  it('a zone outage takes down every member in that zone, and spreading over zones survives it', () => {
    const fault = '{ target: "*", zone: a, at: 20s, until: 40s, down: true }';
    // api only in zone a: the outage kills it
    const single = run(doc({ zones: 'zones: [a]', fault }));
    expect(single.series.errorRate[30]).toBeGreaterThan(0.9);
    // api spread over three zones (with health checks + retries): survives; db primary is in zone a → reads keep going on replicas
    const spread = run(doc({ fault }));
    expect(spread.series.errorRate[30]).toBeLessThan(0.01);
    expect(spread.summary.errorRate).toBeLessThan(single.summary.errorRate / 5);
    expect(spread.events.some((e) => e.type === 'fault-start' && e.target === '존 a')).toBe(true);
  });
});
