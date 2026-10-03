// An API's flow: ordered calls, parallel groups (fork/join), processing between calls, cache-miss paths
import { describe, expect, it } from 'vitest';
import { checkModel, loadModel, simulate } from '../src';

const run = (yaml: string) => simulate(loadModel(yaml), undefined, undefined, { particles: false });

const doc = (calls: string) => `
nodes:
  api:
    endpoints:
      GET /x:
        selfTime: 1ms
        calls:
${calls}
  slow-a:
    endpoints:
      GET /a: { selfTime: 40ms, cpuRatio: 0 }
  slow-b:
    endpoints:
      GET /b: { selfTime: 40ms, cpuRatio: 0 }
  db: { kind: db, queries: { SELECT x: 2ms } }
  cache: { kind: cache, hitRate: 50% }
  events: { kind: queue }
network: { rtt: 0.1ms }
scenario:
  duration: 10s
  warmup: 1s
  traffic: { rps: 50, mix: { "GET /x": 100% } }
`;

const ep = (r: ReturnType<typeof run>) => r.endpoints.find((e) => e.node === 'api' && e.op === 'GET /x' && e.entry)!;
const edge = (r: ReturnType<typeof run>, k: string) => r.edges.find((e) => e.key === k)!;

describe('API flow', () => {
  it('sequential calls add up, a parallel group waits only for the slowest branch', () => {
    const seq = run(doc(`          - "slow-a:GET /a"\n          - "slow-b:GET /b"`));
    const par = run(doc(`          - parallel: ["slow-a:GET /a", "slow-b:GET /b"]`));
    expect(ep(seq).p50).toBeGreaterThan(80);
    expect(ep(par).p50).toBeGreaterThan(40);
    expect(ep(par).p50).toBeLessThan(60);
    expect(edge(par, 'api->slow-b').calls).toBeGreaterThan(400);
  });

  it('processing between calls holds the request for its duration', () => {
    const base = run(doc(`          - "db:SELECT x"`));
    const work = run(doc(`          - "db:SELECT x"\n          - { work: 30ms, cpu: 10% }\n          - "events:publish"`));
    expect(ep(work).p50 - ep(base).p50).toBeGreaterThan(25);
    expect(edge(work, 'api->events').calls).toBeGreaterThan(400);
  });

  it('cache-aside miss path, DB and queue in any order', () => {
    const r = run(doc(`          - { call: "cache:GET k", onMiss: ["db:SELECT x"] }\n          - "events:publish"\n          - "db:SELECT x @50%"`));
    const db = edge(r, 'api->db').calls;
    const total = edge(r, 'api->cache').calls;
    // ~50% misses + ~50% of requests make the second query
    expect(db / total).toBeGreaterThan(0.8);
    expect(db / total).toBeLessThan(1.2);
    expect(r.summary.errorRate).toBe(0);
  });

  it('a failed required branch fails the group; an optional group does not', () => {
    const fault = `\n  faults: [{ target: slow-b, at: 0s, duration: 20s, errorRate: 100% }]`;
    const req = run(doc(`          - parallel: ["slow-a:GET /a", "slow-b:GET /b"]`) + fault);
    const opt = run(doc(`          - { parallel: ["slow-a:GET /a", "slow-b:GET /b"], optional: true }`) + fault);
    expect(req.summary.errorRate).toBeGreaterThan(0.9);
    expect(opt.summary.errorRate).toBe(0);
  });

  it('static checks see calls inside parallel groups', () => {
    const m = loadModel(doc(`          - parallel: ["slow-a:GET /a", "slow-b:GET /b"]`));
    expect(m.edges['api->slow-b']).toBeTruthy();
    expect(checkModel(m).some((w) => w.code === 'no-timeout' && w.target === 'api->slow-b')).toBe(true);
  });
});
