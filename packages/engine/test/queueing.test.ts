// Gate M0: the engine must agree with queueing theory where a closed form exists.
import { describe, expect, it } from 'vitest';
import { loadModel, simulate } from '../src';

/** Erlang C: probability of waiting in an M/M/c queue */
function erlangC(c: number, a: number): number {
  let sum = 0;
  let term = 1;
  for (let k = 0; k < c; k++) {
    if (k > 0) term *= a / k;
    sum += term;
  }
  const top = (term * a) / c / (1 - a / c);
  return top / (sum + top);
}

function mmc(lambda: number, meanMs: number, c: number) {
  const mu = 1000 / meanMs;
  const a = lambda / mu;
  const pw = erlangC(c, a);
  const wq = pw / (c * mu - lambda); // seconds
  return { wq: wq * 1000, w: wq * 1000 + meanMs, rho: a / c };
}

describe('M/M/c agreement', () => {
  for (const [c, rho] of [
    [1, 0.7],
    [4, 0.85],
    [8, 0.9],
  ] as const) {
    it(`c=${c}, rho=${rho}: mean response time within 5% of Erlang C`, () => {
      const meanMs = 10;
      const lambda = (rho * c * 1000) / meanMs;
      const model = loadModel(`
nodes:
  svc:
    runtime: { threads: ${c} }
    os: { vcpu: 64, heap: 64g, gc: zgc }
    endpoints:
      GET /x:
        selfTime: { dist: exp, mean: ${meanMs}ms }
        cpuRatio: 0
        alloc: 0
edges:
  client->svc:
    network: { rtt: 0, jitter: 0 }
scenario:
  duration: 600s
  warmup: 20s
  seed: 7
  traffic: { type: constant, rps: ${lambda}, mix: { "GET /x": 1 } }
`);
      const res = simulate(model, model.scenario, 7, { particles: false });
      const expected = mmc(lambda, meanMs, c);
      expect(Math.abs(res.summary.mean - expected.w) / expected.w).toBeLessThan(0.05);
      const threads = res.resources.find((r) => r.kind === 'threads')!;
      const util = threads.util.slice(20).reduce((a, b) => a + b, 0) / (threads.util.length - 20);
      expect(Math.abs(util - expected.rho)).toBeLessThan(0.02);
    });
  }
});
