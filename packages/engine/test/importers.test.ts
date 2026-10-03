import { readFileSync, readdirSync, statSync } from 'node:fs';
import { parse as parseYaml } from 'yaml';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  analyzeSpringSource,
  calibrate,
  compareWithMeasurement,
  importIstio,
  importK6,
  importKubernetes,
  importOpenApi,
  importPrometheus,
  importSpringConfig,
  importTraces,
  loadModel,
  mergeImports,
  parseModel,
  simulate,
} from '../src';

const fx = (f: string) => readFileSync(join(__dirname, 'fixtures', f), 'utf8');

function walk(dir: string): { path: string; content: string }[] {
  return readdirSync(dir).flatMap((f) => {
    const p = join(dir, f);
    return statSync(p).isDirectory() ? walk(p) : [{ path: p, content: readFileSync(p, 'utf8') }];
  });
}

describe('application.yml', () => {
  it('maps Tomcat, HikariCP, Resilience4j, Feign and RabbitMQ settings', () => {
    const { doc } = importSpringConfig(fx('application.yml'));
    const order = doc.nodes!.order;
    expect(order.runtime).toMatchObject({ threads: 150, acceptCount: 200 });
    expect(doc.nodes!['orders-db']).toEqual({ kind: 'db' });
    expect(doc.edges!['order->orders-db']).toEqual({ pool: { size: 20, timeout: '3s' } });
    const pay = doc.edges!['order->payment'];
    expect(pay.timeout).toBe('2s');
    expect(pay.connectTimeout).toBe('500ms');
    expect(pay.retry).toMatchObject({ max: 3, wait: '200ms', backoff: 'exponential', multiplier: 2, jitter: 0.5 });
    expect(pay.circuitBreaker).toMatchObject({ window: 50, failureRate: 50, openFor: '10s', slowCall: '1s', slowCallRate: 60, minCalls: 20 });
    expect(order['x-rabbitListener']).toMatchObject({ concurrency: 4, prefetch: 10, ack: 'manual', maxRetries: 'infinite' });
  });
  it('applies profile documents only when the profile is active', () => {
    expect(importSpringConfig(fx('application.yml')).doc.nodes!.order.runtime.threads).toBe(150);
    expect(importSpringConfig(fx('application.yml'), { profiles: ['prod'] }).doc.nodes!.order.runtime.threads).toBe(400);
  });
});

describe('Spring source analysis', () => {
  const r = analyzeSpringSource(walk(join(__dirname, 'fixtures/spring')), { service: 'order' });
  const eps = r.doc.nodes!.order.endpoints;
  it('finds every API, listener and scheduled job — including ones without traffic', () => {
    expect(Object.keys(eps).sort()).toEqual(
      ['GET /orders/admin/report', 'GET /orders/{id}', 'POST /orders', '@RabbitListener onOrder', '@Scheduled OrderService.expireCarts'].sort(),
    );
    expect(Object.values<any>(eps).every((e) => e.observed === false)).toBe(true);
    expect(r.doc.scenario!.schedules).toEqual([{ endpoint: 'order:@Scheduled OrderService.expireCarts', every: '30000ms' }]);
    expect(r.doc.nodes!['order-events']).toMatchObject({ kind: 'queue', consumer: { service: 'order', endpoint: '@RabbitListener onOrder' } });
  });
  it('follows injected beans to Feign, repository and messaging calls in order', () => {
    expect(eps['POST /orders'].calls).toEqual(['order-db:Order.findStock', 'order-db:Order.save', 'payment:POST /payments/approve', 'order-events:publish']);
    expect(eps['GET /orders/{id}'].calls).toEqual(['order-db:Order.findById']);
    expect(eps['GET /orders/admin/report'].calls).toEqual(['order-db:Product.findAll']);
  });
});

describe('OpenAPI', () => {
  it('lists APIs as unobserved with size estimates', () => {
    const { doc } = importOpenApi(fx('openapi.json'));
    const eps = doc.nodes!.order.endpoints;
    expect(Object.keys(eps)).toEqual(['POST /orders', 'GET /orders/{id}', 'GET /orders/search']);
    expect(eps['GET /orders/search'].responseSize).toBe('4kb');
    expect(eps['POST /orders'].observed).toBe(false);
  });
});

describe('k6', () => {
  it('turns arrival-rate stages into steps and requests into a mix', () => {
    const { doc } = importK6(fx('load.js'), { service: 'order' });
    const t = doc.scenario!.traffic;
    expect(t.type).toBe('steps');
    expect(t.steps[0]).toEqual({ at: '0s', rps: '50rps' });
    expect(t.steps.some((s: any) => s.rps === '200rps')).toBe(true);
    expect(t.mix).toEqual({ 'order:GET /orders/{id}': '66.7%', 'order:POST /orders': '33.3%' });
    expect(doc.scenario!.duration).toBe('100s');
    expect(doc.scenario!.slo).toEqual({ p99: '400ms', errorRate: 0.01 });
  });
});

describe('Prometheus', () => {
  it('derives rate, mix, leaf latency, CPU and allocation per request from two scrapes', () => {
    const { doc, notes } = importPrometheus(fx('scrape-before.txt'), fx('scrape-after.txt'), { service: 'order', seconds: 60 });
    // (6000 + 1515) requests in 60s; actuator excluded
    expect(doc.scenario!.traffic.rps).toBe('125rps');
    expect(doc.scenario!.traffic.mix['order:GET /orders/{id}']).toBe('79.8%');
    const eps = doc.nodes!.order.endpoints;
    expect(eps['GET /orders/{id}']['x-observedLatency']).toEqual({ mean: '8ms' });
    // 15 CPU seconds / 7515 requests ≈ 2ms
    expect(eps['GET /orders/{id}'].cpu).toBe('2ms');
    expect(doc.nodes!.order.runtime.threads).toBe(200);
    expect(notes.some((n) => n.includes('5xx'))).toBe(true);
  });
});

/** Synthetic traces from a known system: gateway → order → (mysql, payment → mysql) */
function syntheticTraces(n: number) {
  const spans: any[] = [];
  let t = 0;
  let id = 0;
  const sid = () => String(++id);
  for (let i = 0; i < n; i++) {
    const tr = `t${i}`;
    t += 10;
    const root = sid();
    const create = i % 4 !== 0; // 75% POST /orders, 25% GET
    const selfOrder = 4 + (i % 7);
    if (!create) {
      spans.push({ traceId: tr, spanId: root, service: 'order', name: 'GET', kind: 2, start: t, end: t + 6, attributes: { 'http.request.method': 'GET', 'http.route': '/orders/{id}' } });
      const db = sid();
      spans.push({ traceId: tr, spanId: db, parentSpanId: root, service: 'order', name: 'SELECT orders', kind: 3, start: t + 1, end: t + 4, attributes: { 'db.system': 'mysql', 'db.name': 'orders', 'db.operation': 'SELECT', 'db.sql.table': 'orders' } });
      continue;
    }
    const items = 1 + (i % 3);
    let cur = t + selfOrder;
    const children: any[] = [];
    for (let k = 0; k < items; k++) {
      children.push({ traceId: tr, spanId: sid(), parentSpanId: root, service: 'order', name: 'SELECT stock', kind: 3, start: cur, end: cur + 2, attributes: { 'db.system': 'mysql', 'db.name': 'orders', 'db.operation': 'SELECT', 'db.sql.table': 'stock' } });
      cur += 2;
    }
    const client = sid();
    children.push({ traceId: tr, spanId: client, parentSpanId: root, service: 'order', name: 'POST', kind: 3, start: cur, end: cur + 20, attributes: { 'http.request.method': 'POST', 'server.address': 'payment' } });
    const pay = sid();
    children.push({ traceId: tr, spanId: pay, parentSpanId: client, service: 'payment', name: 'POST', kind: 2, start: cur + 1, end: cur + 19, attributes: { 'http.request.method': 'POST', 'http.route': '/payments/approve' } });
    children.push({ traceId: tr, spanId: sid(), parentSpanId: pay, service: 'payment', name: 'INSERT payments', kind: 3, start: cur + 5, end: cur + 15, attributes: { 'db.system': 'mysql', 'db.name': 'payments', 'db.operation': 'INSERT', 'db.sql.table': 'payments' } });
    if (i % 10 === 0) children.push({ traceId: tr, spanId: sid(), parentSpanId: root, service: 'order', name: 'order-events publish', kind: 4, start: cur + 21, end: cur + 22, attributes: { 'messaging.destination.name': 'order-events' } });
    cur += 23;
    spans.push({ traceId: tr, spanId: root, service: 'order', name: 'POST', kind: 2, start: t, end: cur, attributes: { 'http.request.method': 'POST', 'http.route': '/orders' } }, ...children);
  }
  return spans;
}

describe('OpenTelemetry traces', () => {
  const { doc } = importTraces(syntheticTraces(2000));
  it('builds the API-level call graph with probabilities and repetitions', () => {
    const post = doc.nodes!.order.endpoints['POST /orders'];
    expect(post.source).toBe('trace');
    expect(post.calls).toEqual(['orders-db:SELECT stock x 1..3', 'payment:POST /payments/approve', 'order-events:publish @6.7%']);
    expect(doc.nodes!.payment.endpoints['POST /payments/approve'].calls).toEqual(['payments-db:INSERT payments']);
    expect(doc.nodes!['orders-db'].kind).toBe('db');
    expect(doc.nodes!['order-events'].kind).toBe('queue');
  });
  it('measures self time excluding downstream calls, and the traffic mix', () => {
    const self = doc.nodes!.order.endpoints['POST /orders'].selfTime;
    // order's own work: selfOrder (4..10ms) + the 3ms after the payment call not covered by a child span
    expect(parseFloat(self.p50)).toBeGreaterThanOrEqual(6);
    expect(parseFloat(self.p99)).toBeLessThanOrEqual(13);
    expect(doc.scenario!.traffic.mix).toEqual({ 'order:POST /orders': '75.0%', 'order:GET /orders/{id}': '25.0%' });
    expect(doc.nodes!['payments-db'].queries['INSERT payments'].latency).toBe('10ms');
  });
  it('merges with source analysis: traced APIs become observed, the rest stay estimated', () => {
    const merged = mergeImports([
      analyzeSpringSource(walk(join(__dirname, 'fixtures/spring')), { service: 'order' }),
      importSpringConfig(fx('application.yml')),
      importTraces(syntheticTraces(500)),
    ]);
    expect(merged.error).toBeUndefined();
    const eps = merged.doc.nodes.order.endpoints;
    expect(eps['POST /orders'].observed).toBe(true);
    expect(eps['GET /orders/admin/report'].observed).toBe(false);
    // RabbitMQ listener defaults land on the queue this service consumes
    expect(merged.doc.nodes['order-events'].consumer).toMatchObject({ service: 'order', concurrency: 4, prefetch: 10 });
    const model = parseModel(merged.doc);
    const r = simulate(model, model.scenario, 1, { particles: false });
    expect(r.endpoints.find((e) => e.op === 'GET /orders/admin/report')!.observed).toBe(false);
    expect(r.summary.roots).toBeGreaterThan(0);
  });
});

describe('calibration and comparison', () => {
  const doc = (sat: number) => `
nodes:
  api:
    runtime: { threads: 400 }
    endpoints:
      GET /x: { selfTime: 1ms, calls: [ "db:q" ] }
  db:
    kind: db
    contention: { saturation: ${sat}, latencyX: 3 }
    queries: { q: { p50: 4ms, p99: 12ms } }
edges:
  api->db: { pool: { size: 100, timeout: 5s } }
scenario:
  seed: 3
  traffic: { rps: 100, mix: { "GET /x": 1 } }
`;
  it('recovers a DB contention curve from measurements at several load levels', () => {
    // "reality": saturation 12
    const truth = loadModel(doc(12));
    const points = [500, 1500, 2500].map((rps) => {
      const r = simulate(truth, { ...truth.scenario, duration: 20_000, warmup: 5000, traffic: { type: 'constant', rps } }, 3, { particles: false });
      return { rps, p99: r.summary.p99, throughput: r.summary.throughput };
    });
    const raw = (y: string) => parseYaml(y);
    const res = calibrate(raw(doc(64)), points, { params: [{ path: ['nodes', 'db', 'contention', 'saturation'], min: 4, max: 128, log: true, integer: true }], duration: 20_000 });
    expect(res.loss.after).toBeLessThan(res.loss.before / 5);
    const fitted = res.params[0].after;
    expect(fitted).toBeGreaterThanOrEqual(9);
    expect(fitted).toBeLessThanOrEqual(16);
  });
  it('reports per-metric error against the accuracy targets', () => {
    const r = simulate(loadModel(doc(12)));
    const rows = compareWithMeasurement(r, { throughput: r.summary.throughput * 1.05, p99: r.summary.p99 * 1.3, firstBottleneck: 'db:db' });
    expect(rows.find((x) => x.metric.startsWith('처리량'))!.pass).toBe(true);
    expect(rows.find((x) => x.metric.startsWith('p99'))!.pass).toBe(false);
  });
});

describe('platform configuration', () => {
  it('Kubernetes: replicas, CPU limits, heap, readiness, zones', () => {
    const { doc } = importKubernetes(fx('k8s.yaml'));
    expect(doc.nodes!.order).toEqual({
      kind: 'service',
      instances: 4,
      os: { cpuLimit: 1.5, vcpu: 2, heap: '1536m', gc: 'zgc' },
      healthCheck: { interval: '5s', threshold: 2, riseThreshold: 1 },
    });
    expect(doc.nodes!.payment).toMatchObject({ instances: 2, os: { cpuLimit: 2, heap: '768m' }, zones: ['a'] });
    expect(doc.topology).toEqual({ zones: ['a', 'b', 'c'] });
  });
  it('Istio: mesh retries, timeout, outlier detection, connection pool', () => {
    const { doc } = importIstio(fx('istio.yaml'));
    expect(doc.mesh).toEqual({
      retries: { attempts: 2, perTryTimeout: '1s', on: ['error', 'conn'] },
      timeout: '3s',
      outlierDetection: { consecutiveErrors: 3, baseEjectionTime: '20s', maxEjectionPercent: 50 },
      connectionPool: { maxRequests: 200 },
    });
  });
  it('Spring Cloud Gateway: routes become a gateway node that expands against the imported services', () => {
    const gw = importSpringConfig(fx('gateway.yml'));
    expect(gw.doc.nodes!.edge).toEqual({
      kind: 'gateway',
      routes: { '/orders/**': { to: 'order', retry: { max: 3, wait: '50ms', jitter: true } }, '/products/**': { to: 'catalog', rateLimit: '500rps' } },
    });
    const merged = mergeImports([
      gw,
      { doc: { nodes: { order: { kind: 'service', endpoints: { 'POST /orders': { selfTime: '5ms' }, 'GET /orders/{id}': { selfTime: '2ms' } } }, catalog: { kind: 'service', endpoints: { 'GET /products/{id}': { selfTime: '2ms' } } } } }, notes: [] },
      { doc: { scenario: { traffic: { rps: 100, mix: { 'POST /orders': 50, 'GET /products/{id}': 50 } } } }, notes: [] },
    ]);
    expect(merged.error).toBeUndefined();
    const m = parseModel(merged.doc);
    expect(Object.keys((m.nodes.edge as any).endpoints).sort()).toEqual(['GET /orders/{id}', 'GET /products/{id}', 'POST /orders']);
    expect(m.scenario.mix.every((x) => x.ref.node === 'edge')).toBe(true);
  });
});
