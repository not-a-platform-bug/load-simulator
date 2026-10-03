import { describe, expect, it } from 'vitest';
import { loadModel, simulate } from '../src';

const run = (yaml: string) => simulate(loadModel(yaml), undefined, undefined, { particles: false });
const q = (r: ReturnType<typeof run>) => r.nodes.find((n) => n.name === 'events')!.queue!;
const max = (a: number[]) => Math.max(...a);
const sum = (a: number[]) => a.reduce((x, y) => x + y, 0);

const doc = (o: { partitions?: number; concurrency?: number; skew?: number; onError?: string; extra?: string; instances?: number } = {}) => `
nodes:
  producer:
    endpoints:
      POST /e: { selfTime: 1ms, calls: [ "events:publish" ] }
  events:
    kind: queue
    broker: kafka
    kafka: { partitions: ${o.partitions ?? 12}, keySkew: ${o.skew ?? 0}, rebalanceTime: 8s }
    consumer: { service: worker, endpoint: handle, concurrency: ${o.concurrency ?? 3}, onError: ${o.onError ?? 'retry'}, retryBackoff: 500ms, dlq: true }
  worker:
    instances: ${o.instances ?? 4}
    endpoints:
      handle: { selfTime: 10ms, cpuRatio: 0 }
scenario:
  duration: 40s
  warmup: 0s
  traffic: { rps: 500, mix: { "POST /e": 1 } }
  ${o.extra ?? ''}
`;

describe('kafka consumer group', () => {
  it('keeps up when partitions ≥ consumer threads', () => {
    const r = q(run(doc()));
    expect(max(r.depth)).toBeLessThan(50);
    expect(max(r.idleConsumers!)).toBe(0);
  });
  it('parallelism is capped by partitions: extra consumers sit idle and lag grows', () => {
    // 3 partitions × (1 / 10ms) = 300 msg/s < 500 msg/s published, even with 12 threads
    const r = q(run(doc({ partitions: 3 })));
    expect(r.idleConsumers![5]).toBe(9);
    expect(r.depth[35]).toBeGreaterThan(5000);
  });
  it('a hot key overloads one partition while the others are idle', () => {
    const r = q(run(doc({ skew: 1.5 })));
    expect(r.maxPartitionLag![35]).toBeGreaterThan(1000);
    expect(r.maxPartitionLag![35] / r.depth[35]).toBeGreaterThan(0.8);
  });
  it('blocking retries of failing records stall partitions; skip does not', () => {
    const fault = 'faults: [ { target: worker, at: 10s, until: 12s, errorRate: 30% } ]';
    const retry = q(run(doc({ extra: fault })));
    const skip = q(run(doc({ onError: 'skip', extra: fault })));
    expect(max(retry.depth)).toBeGreaterThan(max(skip.depth) * 5);
    expect(sum(retry.redelivered)).toBeGreaterThan(0);
    expect(sum(skip.redelivered)).toBe(0);
  });
  it('a consumer instance leaving the group stops everyone for the rebalance', () => {
    const r = run(doc({ extra: 'faults: [ { target: worker, instance: 0, at: 10s, until: 25s, down: true } ]' }));
    const qq = q(r);
    expect(r.events.filter((e) => e.type === 'rebalance').length).toBe(2);
    // leaving (10s) and rejoining (25s) each stop consumption for 8s at 500 msg/s
    expect(max(qq.depth)).toBeGreaterThan(3000);
    expect(sum(qq.rebalanceMs!)).toBeGreaterThan(15_000);
    // after the second rebalance the full group drains the lag
    expect(qq.depth[39]).toBeLessThan(max(qq.depth) / 2);
  });
});
