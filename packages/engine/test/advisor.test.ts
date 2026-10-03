// The recommender must find the fix for each demo on its own (the demos only describe the problem).
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { advise, parseYamlDoc } from '../src';

const demo = (f: string) => parseYamlDoc(readFileSync(join(__dirname, '../../../examples', f), 'utf8'));

const cases: { file: string; expect: string[]; minImprovement: number }[] = [
  { file: '01-cascading-failure.yaml', expect: ['cb:order->payment'], minImprovement: 0.9 },
  { file: '02-retry-storm.yaml', expect: ['retry-top-only'], minImprovement: 0.85 },
  { file: '03-event-capacity.yaml', expect: ['scale:order'], minImprovement: 0.95 },
  { file: '04-gc-pause.yaml', expect: ['gc:catalog'], minImprovement: 0.9 },
  { file: '05-backlog-overflow.yaml', expect: ['backlog:gateway'], minImprovement: 0.8 },
  { file: '06-packet-loss.yaml', expect: ['loss:api->inventory'], minImprovement: 0.8 },
  { file: '07-cache-stampede.yaml', expect: ['stampede:product-cache'], minImprovement: 0.95 },
  { file: '08-queue-recovery.yaml', expect: ['rabbit-scale:order-events'], minImprovement: 0.4 },
  { file: '09-health-check-gap.yaml', expect: ['health:payment'], minImprovement: 0.95 },
  { file: '10-kafka-partition-lag.yaml', expect: ['kafka-key:order-events', 'kafka-scale:order-events'], minImprovement: 0.9 },
  { file: '11-zone-outage.yaml', expect: ['zone-resilience', 'mesh-retry:order->payment'], minImprovement: 0.6 },
  { file: '12-gateway-lb-baseline.yaml', expect: ['scale:gateway'], minImprovement: 0.8 },
  { file: '13-websocket-chat.yaml', expect: ['ws-backoff'], minImprovement: 0.3 },
  { file: '14-dynamodb-hot-partition.yaml', expect: ['store-key:orders-table'], minImprovement: 0.9 },
  { file: '15-search-spike.yaml', expect: ['store-scale:product-search'], minImprovement: 0.9 },
];

describe('recommendation engine on the demo problems', () => {
  for (const c of cases) {
    it(c.file, { timeout: 120_000 }, () => {
      const a = advise(demo(c.file));
      const ids = a.recommendations.map((r) => r.id);
      for (const e of c.expect) expect(ids).toContain(e);
      const final = a.plan.length ? a.plan[a.plan.length - 1].after : a.baseline;
      expect(1 - final.badness / a.baseline.badness).toBeGreaterThanOrEqual(c.minImprovement);
      // the diagnosis names where it started
      expect(a.findings.length).toBeGreaterThan(0);
    });
  }
});
