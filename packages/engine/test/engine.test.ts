import { describe, expect, it } from 'vitest';
import { checkModel, loadModel, simulate } from '../src';

const chain = (opts: { retry: string; fault?: string; jitter?: boolean }) => `
nodes:
  bff:
    endpoints:
      GET /home: { selfTime: 1ms, calls: [ "order:GET /orders" ] }
  order:
    endpoints:
      GET /orders: { selfTime: 1ms, calls: [ "payment:GET /pay" ] }
  payment:
    endpoints:
      GET /pay: { selfTime: 1ms, calls: [ "payment-db:select" ] }
  payment-db:
    kind: db
    queries: { select: 2ms }
edges:
  bff->order: { timeout: 5s, retry: ${opts.retry} }
  order->payment: { timeout: 5s, retry: ${opts.retry} }
  payment->payment-db: { timeout: 5s, retry: ${opts.retry}, pool: { size: 50 } }
scenario:
  duration: 20s
  warmup: 0s
  traffic: { type: constant, rps: 50, mix: { "GET /home": 1 } }
  faults:
    - { target: payment-db, at: 0s, errorRate: 100% }
`;

describe('determinism', () => {
  it('same input and seed → identical result', () => {
    const m = loadModel(chain({ retry: '{ max: 2, wait: 10ms }' }));
    const a = simulate(m);
    const b = simulate(m);
    expect({ ...a.summary, wallMs: 0 }).toEqual({ ...b.summary, wallMs: 0 });
    expect(a.series.p99).toEqual(b.series.p99);
  });
  it('different seed → different sample path', () => {
    const m = loadModel(chain({ retry: '{ max: 2, wait: 10ms }' }));
    expect(simulate(m, m.scenario, 1).summary.roots).not.toEqual(simulate(m, m.scenario, 2).summary.roots);
  });
});

describe('retry amplification', () => {
  it('3 layers × 3 attempts reach the bottom 27×', () => {
    const m = loadModel(chain({ retry: '{ max: 3, wait: 1ms }' }));
    const res = simulate(m);
    const db = res.edges.find((e) => e.key === 'payment->payment-db')!;
    expect(db.amplification).toBeGreaterThan(26);
    expect(db.amplification).toBeLessThan(28);
    const w = checkModel(m).find((x) => x.code === 'retry-amplification');
    expect(w?.message).toContain('27');
  });
  it('retrying only at the top keeps the bottom at 3×', () => {
    const m = loadModel(chain({ retry: '{ max: 1 }' }).replace('bff->order: { timeout: 5s, retry: { max: 1 } }', 'bff->order: { timeout: 5s, retry: { max: 3, wait: 1ms } }'));
    const res = simulate(m);
    const db = res.edges.find((e) => e.key === 'payment->payment-db')!;
    expect(db.amplification).toBeGreaterThan(2.9);
    expect(db.amplification).toBeLessThan(3.1);
  });
});

describe('zombie work', () => {
  it('callee keeps working after the caller times out', () => {
    const m = loadModel(`
nodes:
  api:
    endpoints:
      GET /a: { selfTime: 1ms, calls: [ "slow:GET /s" ] }
  slow:
    endpoints:
      GET /s: { selfTime: 500ms, cpuRatio: 0 }
edges:
  api->slow: { timeout: 100ms }
scenario:
  duration: 10s
  warmup: 0s
  traffic: { type: constant, rps: 20, mix: { "GET /a": 1 } }
`);
    const res = simulate(m);
    const slow = res.endpoints.find((e) => e.id === 'slow:GET /s')!;
    const api = res.endpoints.find((e) => e.id === 'api:GET /a')!;
    expect(api.errorRate).toBeGreaterThan(0.99);
    // the callee completed its work anyway, successfully, taking ~500ms each
    expect(slow.ok).toBeGreaterThan(150);
    expect(slow.p50).toBeGreaterThan(450);
  });
});

describe('static checks', () => {
  it('detects timeout inversion and missing timeouts', () => {
    const m = loadModel(`
nodes:
  a:
    endpoints:
      GET /a: { calls: [ "b:GET /b" ] }
  b:
    endpoints:
      GET /b: { calls: [ "c:GET /c" ] }
  c:
    endpoints:
      GET /c: {}
edges:
  a->b: { timeout: 1s }
  b->c: { timeout: 2s, retry: { max: 3 } }
scenario:
  traffic: { rps: 10, mix: { "GET /a": 1 } }
`);
    const codes = checkModel(m).map((w) => w.code);
    expect(codes).toContain('timeout-inversion');
    expect(codes).toContain('retry-no-jitter');
    const m2 = loadModel(`
nodes:
  a:
    endpoints:
      GET /a: { calls: [ "b:GET /b" ] }
  b:
    endpoints:
      GET /b: {}
scenario:
  traffic: { rps: 10, mix: { "GET /a": 1 } }
`);
    expect(checkModel(m2).map((w) => w.code)).toContain('no-timeout');
  });
});

describe('circuit breaker', () => {
  it('opens under failures, sheds load with fallback, and recovers after the fault', () => {
    const m = loadModel(`
nodes:
  order:
    endpoints:
      POST /orders: { selfTime: 2ms, calls: [ "payment:POST /pay" ] }
  payment:
    endpoints:
      POST /pay: { selfTime: 5ms }
edges:
  order->payment:
    timeout: 1s
    circuitBreaker: { failureRate: 50, window: 20, minCalls: 10, openFor: 2s, halfOpenCalls: 5 }
    fallback: { latency: 1ms }
scenario:
  duration: 30s
  warmup: 0s
  traffic: { rps: 100, mix: { "POST /orders": 1 } }
  faults:
    - { target: payment, at: 5s, until: 15s, errorRate: 100% }
`);
    const res = simulate(m);
    const e = res.edges.find((x) => x.key === 'order->payment')!;
    const opened = res.events.filter((x) => x.type === 'cb' && x.detail.includes('CLOSED → OPEN'));
    const closed = res.events.filter((x) => x.type === 'cb' && x.detail.includes('HALF_OPEN → CLOSED'));
    expect(opened.length).toBeGreaterThan(0);
    expect(opened[0].t).toBeGreaterThan(5000);
    expect(opened[0].t).toBeLessThan(6000);
    expect(closed.length).toBeGreaterThan(0);
    expect(closed[closed.length - 1].t).toBeGreaterThan(15000);
    expect(e.cbRejected).toBeGreaterThan(500);
    // fallback keeps the entry API successful
    expect(res.summary.errorRate).toBe(0);
    expect(res.summary.degraded).toBeGreaterThan(900);
  });
});

describe('OS layer', () => {
  it('GC pauses stall every request on the instance', () => {
    const doc = (alloc: string) => `
nodes:
  svc:
    os: { heap: 512m, gc: parallel }
    endpoints:
      GET /x: { selfTime: 5ms, alloc: ${alloc} }
scenario:
  duration: 30s
  warmup: 5s
  traffic: { rps: 200, mix: { "GET /x": 1 } }
`;
    const low = simulate(loadModel(doc('10kb')));
    const high = simulate(loadModel(doc('4mb')));
    expect(high.nodes[0].os!.gcCount.reduce((a, b) => a + b)).toBeGreaterThan(low.nodes[0].os!.gcCount.reduce((a, b) => a + b) * 10);
    expect(high.summary.p99).toBeGreaterThan(low.summary.p99 * 2);
  });

  it('CPU saturation makes latency climb steeply past ~70% utilisation', () => {
    const at = (rps: number) =>
      simulate(
        loadModel(`
nodes:
  svc:
    runtime: { threads: 200 }
    os: { vcpu: 2, gc: zgc }
    endpoints:
      GET /x: { selfTime: { dist: exp, mean: 10ms }, cpuRatio: 1, alloc: 0 }
scenario:
  duration: 60s
  warmup: 10s
  traffic: { rps: ${rps}, mix: { "GET /x": 1 } }
`),
        undefined,
        undefined,
        { particles: false },
      ).summary.p99;
    const p50util = at(100);
    const p90util = at(180);
    expect(p90util).toBeGreaterThan(p50util * 3);
  });

  it('full backlog drops SYNs and clients wait ≥1s for retransmission', () => {
    const res = simulate(
      loadModel(`
nodes:
  svc:
    runtime: { threads: 4, maxConnections: 4, acceptCount: 2 }
    os: { somaxconn: 2, gc: zgc }
    endpoints:
      GET /x: { selfTime: 50ms, alloc: 0 }
scenario:
  duration: 20s
  warmup: 2s
  traffic: { rps: 90, mix: { "GET /x": 1 } }
`),
    );
    expect(res.nodes[0].os!.synDrops.reduce((a, b) => a + b)).toBeGreaterThan(0);
    expect(res.summary.p99).toBeGreaterThan(1000);
  });
});

describe('network layer', () => {
  it('1% loss leaves the median alone but pushes p99 to RTO scale', () => {
    const doc = (loss: string) => `
nodes:
  a:
    endpoints:
      GET /a: { selfTime: 2ms, calls: [ "b:GET /b" ] }
  b:
    endpoints:
      GET /b: { selfTime: 2ms, responseSize: 20kb }
edges:
  a->b: { network: { rtt: 1ms, loss: ${loss} } }
scenario:
  duration: 30s
  warmup: 2s
  traffic: { rps: 200, mix: { "GET /a": 1 } }
`;
    const clean = simulate(loadModel(doc('0%')));
    const lossy = simulate(loadModel(doc('1%')));
    expect(Math.abs(lossy.summary.p50 - clean.summary.p50) / clean.summary.p50).toBeLessThan(0.2);
    expect(lossy.summary.p99).toBeGreaterThan(200);
    expect(clean.summary.p99).toBeLessThan(50);
  });
});
