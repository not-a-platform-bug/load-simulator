// API gateway, load balancer and service mesh
import { describe, expect, it } from 'vitest';
import { checkModel, loadModel, simulate } from '../src';

const run = (yaml: string) => simulate(loadModel(yaml), undefined, undefined, { particles: false });
const sum = (a: number[]) => a.reduce((x, y) => x + y, 0);

describe('API gateway', () => {
  const doc = (extra = '') => `
nodes:
  gw:
    kind: gateway
    instances: 2
    routes:
      "/orders/**": { to: order, timeout: 1s }
      "GET /products/{id}": { to: "catalog:GET /items/{id}", rateLimit: 200rps }
  order:
    endpoints:
      GET /orders/{id}: { selfTime: 3ms }
      POST /orders: { selfTime: 5ms }
      GET /health: { selfTime: 1ms }
  catalog:
    endpoints:
      GET /items/{id}: { selfTime: 2ms }
scenario:
  duration: 20s
  warmup: 2s
  traffic: { rps: 600, mix: { "GET /orders/{id}": 30%, "POST /orders": 20%, "GET /products/{id}": 50% } }
  ${extra}
`;
  it('expands wildcard routes, takes the traffic first and adds its hop', () => {
    const m = loadModel(doc());
    expect(Object.keys((m.nodes.gw as any).endpoints).sort()).toEqual(['GET /orders/{id}', 'GET /products/{id}', 'POST /orders']);
    expect(m.scenario.mix.every((x) => x.ref.node === 'gw')).toBe(true);
    expect(m.edges['gw->order'].timeout).toBe(1000);
    const r = run(doc());
    expect(r.edges.find((e) => e.key === 'client->gw')!.calls).toBeGreaterThan(10_000);
  });
  it('route rate limits answer 429 instead of overloading the backend', () => {
    const r = run(doc());
    // 300 rps offered to a 200 rps route
    const products = r.endpoints.find((e) => e.id === 'gw:GET /products/{id}')!;
    expect(products.errorRate).toBeGreaterThan(0.25);
    expect(products.errorRate).toBeLessThan(0.4);
    expect(r.summary.errorCauses[0].cause).toContain('rate limit');
  });
});

describe('load balancer', () => {
  const doc = (algo: string, hc: string) => `
nodes:
  lb:
    kind: loadbalancer
    target: api
    algorithm: ${algo}
    ${hc}
  api:
    instances: 3
    runtime: { threads: 50 }
    endpoints:
      GET /x: { selfTime: { dist: exp, mean: 20ms }, cpuRatio: 0 }
scenario:
  duration: 40s
  warmup: 5s
  traffic: { rps: 2000, mix: { "GET /x": 1 } }
  faults:
    - { target: api, instance: 0, at: 10s, latencyX: 6 }
`;
  it('least-connections and power-of-two route around a slow instance; round robin does not', () => {
    const rr = run(doc('round-robin', ''));
    const lc = run(doc('least-conn', ''));
    const p2c = run(doc('p2c', ''));
    expect(lc.summary.p99).toBeLessThan(rr.summary.p99 / 3);
    expect(p2c.summary.p99).toBeLessThan(rr.summary.p99 / 2);
  });
  it('its health check is what removes a dead instance', () => {
    const y = (hc: string) => doc('round-robin', hc).replace('latencyX: 6', 'down: true, hang: true').replace('mean: 20ms', 'mean: 5ms') + '\nedges:\n  lb->api: { timeout: 1s }\n';
    const without = run(y(''));
    const withHc = run(y('healthCheck: { interval: 2s, threshold: 2 }'));
    expect(without.series.errorRate[30]).toBeGreaterThan(0.25);
    expect(withHc.series.errorRate[30]).toBe(0);
    expect(checkModel(loadModel(y(''))).map((w) => w.code)).toContain('lb-no-health-check');
  });
});

describe('service mesh', () => {
  const doc = (mesh: string, appRetry = '') => `
mesh: ${mesh}
nodes:
  a:
    instances: 2
    os: { vcpu: 4 }
    endpoints:
      GET /a: { selfTime: 2ms, calls: [ "b:GET /b" ] }
  b:
    instances: 3
    os: { vcpu: 4 }
    endpoints:
      GET /b: { selfTime: 2ms }
edges:
  a->b: { timeout: 2s ${appRetry} }
scenario:
  duration: 30s
  warmup: 2s
  traffic: { rps: 500, mix: { "GET /a": 1 } }
  faults:
    - { target: b, instance: 1, at: 10s, errorRate: 100% }
`;
  it('sidecars add latency on every service-to-service hop', () => {
    const plain = run(doc('false'));
    const meshed = run(doc('{ sidecarLatency: 1ms }'));
    expect(meshed.summary.p50 - plain.summary.p50).toBeGreaterThan(1.5);
  });
  it('mesh retries hide a broken instance; outlier detection ejects it', () => {
    const plain = run(doc('false'));
    const retries = run(doc('{ retries: { attempts: 2 } }'));
    const outlier = run(doc('{ outlierDetection: { consecutiveErrors: 5, baseEjectionTime: 30s, maxEjectionPercent: 50 } }'));
    expect(plain.summary.errorRate).toBeGreaterThan(0.2);
    expect(retries.summary.errorRate).toBeLessThan(0.01);
    expect(retries.edges.find((e) => e.key === 'a->b')!.meshRetries).toBeGreaterThan(1000);
    expect(outlier.events.some((e) => e.type === 'eject')).toBe(true);
    expect(outlier.series.errorRate[20]).toBe(0);
  });
  it('app retries on top of mesh retries multiply attempts and are flagged', () => {
    const m = loadModel(doc('{ retries: { attempts: 2 } }', ', retry: { max: 3, wait: 1ms }'));
    expect(checkModel(m).map((w) => w.code)).toContain('mesh-double-retry');
  });
});
