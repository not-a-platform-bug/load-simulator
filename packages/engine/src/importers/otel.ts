// OpenTelemetry traces (OTLP JSON export, or a flat span array) → API-level call graph with measured distributions.
//
//   server span  → endpoint of its service      (self time = duration − time spent in direct client calls)
//   client span  → call to the server span below it; or to a DB / cache / external API by attributes
//   producer     → publish to a queue; consumer span → queue listener endpoint
//   root spans   → traffic mix and rate
import { distOf, fmtDuration, quantiles, slug, type ImportReport } from './util';

export interface Span {
  traceId: string;
  spanId: string;
  parentSpanId?: string;
  service: string;
  name: string;
  /** 1 internal, 2 server, 3 client, 4 producer, 5 consumer (OTLP SpanKind) */
  kind: number;
  start: number; // ms
  end: number; // ms
  attrs: Record<string, string | number | boolean>;
  error: boolean;
}

const KINDS: Record<string, number> = {
  SPAN_KIND_INTERNAL: 1,
  SPAN_KIND_SERVER: 2,
  SPAN_KIND_CLIENT: 3,
  SPAN_KIND_PRODUCER: 4,
  SPAN_KIND_CONSUMER: 5,
  internal: 1,
  server: 2,
  client: 3,
  producer: 4,
  consumer: 5,
};

function attrValue(v: any): string | number | boolean {
  if (v == null) return '';
  if ('stringValue' in v) return v.stringValue;
  if ('intValue' in v) return Number(v.intValue);
  if ('doubleValue' in v) return Number(v.doubleValue);
  if ('boolValue' in v) return !!v.boolValue;
  return String(Object.values(v)[0] ?? '');
}

function attrs(list: any): Record<string, string | number | boolean> {
  if (!list) return {};
  if (!Array.isArray(list)) return list;
  const out: Record<string, string | number | boolean> = {};
  for (const a of list) out[a.key] = attrValue(a.value);
  return out;
}

const nanoToMs = (v: unknown) => Number(BigInt(String(v ?? 0)) / 1000n) / 1000;

/** Accepts OTLP JSON ({ resourceSpans }), an array of such exports (one per line/file), or a flat array of spans. */
export function parseSpans(input: unknown): Span[] {
  const out: Span[] = [];
  const exports = Array.isArray(input) && input.length && (input[0] as any).resourceSpans ? input : [input];
  for (const ex of exports as any[]) {
    if (Array.isArray(ex)) {
      for (const s of ex) {
        out.push({
          traceId: String(s.traceId),
          spanId: String(s.spanId),
          parentSpanId: s.parentSpanId || undefined,
          service: String(s.service ?? s.serviceName),
          name: String(s.name),
          kind: typeof s.kind === 'number' ? s.kind : KINDS[s.kind] ?? 1,
          start: Number(s.start ?? s.startMs),
          end: Number(s.end ?? s.endMs),
          attrs: attrs(s.attributes ?? s.attrs),
          error: !!s.error,
        });
      }
      continue;
    }
    for (const rs of ex?.resourceSpans ?? []) {
      const service = String(attrs(rs.resource?.attributes)['service.name'] ?? 'unknown');
      for (const ss of rs.scopeSpans ?? rs.instrumentationLibrarySpans ?? []) {
        for (const s of ss.spans ?? []) {
          out.push({
            traceId: String(s.traceId),
            spanId: String(s.spanId),
            parentSpanId: s.parentSpanId || undefined,
            service,
            name: String(s.name),
            kind: typeof s.kind === 'number' ? s.kind : KINDS[s.kind] ?? 1,
            start: nanoToMs(s.startTimeUnixNano),
            end: nanoToMs(s.endTimeUnixNano),
            attrs: attrs(s.attributes),
            error: s.status?.code === 2 || s.status?.code === 'STATUS_CODE_ERROR',
          });
        }
      }
    }
  }
  return out;
}

function endpointName(s: Span): string {
  const method = s.attrs['http.request.method'] ?? s.attrs['http.method'];
  const route = s.attrs['http.route'];
  if (method && route) return `${method} ${route}`;
  if (s.kind === 5) {
    const dest = s.attrs['messaging.destination.name'] ?? s.attrs['messaging.destination'];
    return dest ? `listener ${dest}` : s.name;
  }
  return s.name;
}

interface Target {
  node: string;
  kind: 'service' | 'db' | 'cache' | 'external' | 'queue';
  op: string;
}

export interface TraceImportOptions {
  /** collapse ids in operation names (e.g. "SELECT ... WHERE id=42") */
  normalize?: boolean;
}

export function importTraces(input: unknown, _opts: TraceImportOptions = {}): ImportReport & { spans: number } {
  const spans = parseSpans(input);
  const notes: string[] = [];
  const byId = new Map(spans.map((s) => [`${s.traceId}/${s.spanId}`, s]));
  const children = new Map<string, Span[]>();
  for (const s of spans) {
    if (!s.parentSpanId) continue;
    const k = `${s.traceId}/${s.parentSpanId}`;
    if (!children.has(k)) children.set(k, []);
    children.get(k)!.push(s);
  }
  const kids = (s: Span) => children.get(`${s.traceId}/${s.spanId}`) ?? [];

  /** nearest server/consumer ancestor in the same service */
  const owner = (s: Span): Span | null => {
    let p = s.parentSpanId ? byId.get(`${s.traceId}/${s.parentSpanId}`) : undefined;
    while (p) {
      if ((p.kind === 2 || p.kind === 5) && p.service === s.service) return p;
      p = p.parentSpanId ? byId.get(`${p.traceId}/${p.parentSpanId}`) : undefined;
    }
    return null;
  };

  const brokers = new Map<string, string>();
  const targetOf = (c: Span): Target | null => {
    const a = c.attrs;
    if (c.kind === 4) {
      const dest = String(a['messaging.destination.name'] ?? a['messaging.destination'] ?? c.name);
      brokers.set(slug(dest), String(a['messaging.system'] ?? 'rabbitmq'));
      return { node: slug(dest), kind: 'queue', op: 'publish' };
    }
    const server = kids(c).find((k) => k.kind === 2);
    if (server) return { node: slug(server.service), kind: 'service', op: endpointName(server) };
    const system = String(a['db.system'] ?? '');
    if (system === 'redis' || system === 'memcached') {
      const op = String(a['db.operation'] ?? a['db.operation.name'] ?? c.name.split(' ')[0]).toUpperCase();
      return { node: slug(String(a['peer.service'] ?? a['server.address'] ?? system)), kind: 'cache', op: `${op} ${String(a['db.redis.key_prefix'] ?? 'key')}` };
    }
    if (system) {
      const dbName = String(a['db.name'] ?? a['db.namespace'] ?? a['peer.service'] ?? a['server.address'] ?? system);
      const op = String(a['db.operation'] ?? a['db.operation.name'] ?? '') + (a['db.sql.table'] || a['db.collection.name'] ? ` ${a['db.sql.table'] ?? a['db.collection.name']}` : '');
      return { node: slug(`${dbName}-db`), kind: 'db', op: (op.trim() || c.name).replace(/\s+/g, ' ') };
    }
    if (a['http.request.method'] || a['http.method'] || a['url.full'] || a['http.url']) {
      const host = String(a['peer.service'] ?? a['server.address'] ?? a['net.peer.name'] ?? (String(a['url.full'] ?? a['http.url'] ?? '').split('/')[2] ?? 'external'));
      const method = String(a['http.request.method'] ?? a['http.method'] ?? 'GET');
      const path = String(a['url.template'] ?? a['http.route'] ?? (String(a['url.full'] ?? a['http.url'] ?? '').split('/').slice(3).join('/').split('?')[0] || ''));
      return { node: slug(host.split(':')[0]), kind: 'external', op: `${method} /${path.replace(/^\//, '')}` };
    }
    return null;
  };

  // endpoints and their self times
  interface Ep {
    service: string;
    name: string;
    self: number[];
    count: number;
    errors: number;
    /** target key → per-execution counts */
    calls: Map<string, { target: Target; perExec: number[]; firstAt: number[] }>;
  }
  const eps = new Map<string, Ep>();
  const opLat = new Map<string, { target: Target; lat: number[] }>();
  const roots = new Map<string, number>();
  let tMin = Infinity;
  let tMax = -Infinity;

  for (const s of spans) {
    if (s.kind !== 2 && s.kind !== 5) continue;
    const service = slug(s.service);
    const name = endpointName(s);
    const key = `${service}:${name}`;
    let ep = eps.get(key);
    if (!ep) eps.set(key, (ep = { service, name, self: [], count: 0, errors: 0, calls: new Map() }));
    ep.count++;
    if (s.error) ep.errors++;
    // direct outgoing calls of this request: client/producer spans whose owner is this span
    const outgoing: Span[] = [];
    const walk = (x: Span) => {
      for (const k of kids(x)) {
        if (k.service !== s.service) continue;
        if (k.kind === 3 || k.kind === 4) outgoing.push(k);
        else if (k.kind === 1) walk(k);
      }
    };
    walk(s);
    let callTime = 0;
    const counts = new Map<string, { target: Target; n: number; first: number }>();
    for (const c of outgoing.sort((a, b) => a.start - b.start)) {
      const t = targetOf(c);
      if (!t) continue;
      callTime += c.end - c.start;
      const tk = `${t.node}:${t.op}`;
      const e = counts.get(tk) ?? { target: t, n: 0, first: c.start - s.start };
      e.n++;
      counts.set(tk, e);
      if (t.kind !== 'service') {
        const lk = `${t.node}|${t.op}`;
        if (!opLat.has(lk)) opLat.set(lk, { target: t, lat: [] });
        opLat.get(lk)!.lat.push(c.end - c.start);
      }
    }
    ep.self.push(Math.max(0.01, s.end - s.start - callTime));
    for (const [tk, e] of counts) {
      if (!ep.calls.has(tk)) ep.calls.set(tk, { target: e.target, perExec: [], firstAt: [] });
      const rec = ep.calls.get(tk)!;
      rec.perExec.push(e.n);
      rec.firstAt.push(e.first);
    }
    const parent = s.parentSpanId ? byId.get(`${s.traceId}/${s.parentSpanId}`) : undefined;
    if (!parent && s.kind === 2) {
      roots.set(key, (roots.get(key) ?? 0) + 1);
      tMin = Math.min(tMin, s.start);
      tMax = Math.max(tMax, s.start);
    }
  }

  // assemble the document
  const nodes: Record<string, any> = {};
  const ensure = (name: string, kind: string) => (nodes[name] ??= kind === 'service' ? { kind: 'service', endpoints: {} } : { kind });
  for (const ep of eps.values()) {
    const svc = ensure(ep.service, 'service');
    const calls: any[] = [];
    const ordered = [...ep.calls.values()].sort((a, b) => median(a.firstAt) - median(b.firstAt));
    for (const c of ordered) {
      const prob = c.perExec.length / ep.count;
      const avg = c.perExec.reduce((x, y) => x + y, 0) / c.perExec.length;
      let s = `${c.target.node}:${c.target.op}`;
      if (avg >= 1.5) {
        const lo = Math.min(...c.perExec);
        const hi = Math.max(...c.perExec);
        s += lo === hi ? ` x ${lo}` : ` x ${lo}..${hi}`;
      }
      if (prob < 0.98) s += ` @${(prob * 100).toFixed(prob < 0.1 ? 1 : 0)}%`;
      calls.push(s);
      ensure(c.target.node, c.target.kind);
    }
    svc.endpoints[ep.name] = { selfTime: distOf(ep.self), calls, source: 'trace' };
    if (ep.errors / ep.count > 0.001) notes.push(`${ep.service} ${ep.name}: 트레이스 오류율 ${((ep.errors / ep.count) * 100).toFixed(2)}%`);
  }
  for (const { target, lat } of opLat.values()) {
    const n = ensure(target.node, target.kind);
    const d = distOf(lat);
    if (target.kind === 'db') (n.queries ??= {})[target.op] = { latency: d };
    else if (target.kind === 'cache') n.opTime = d;
    else if (target.kind === 'external') n.latency = d;
  }
  // queue consumers: consumer spans whose destination matches a produced queue
  for (const ep of eps.values()) {
    if (!ep.name.startsWith('listener ')) continue;
    const q = slug(ep.name.slice('listener '.length));
    const node = ensure(q, 'queue');
    node.consumer ??= { service: ep.service, endpoint: ep.name };
  }
  for (const [q, system] of brokers) {
    if (system !== 'kafka' || !nodes[q]) continue;
    nodes[q].broker = 'kafka';
    nodes[q].kafka ??= { partitions: 6 };
    notes.push(`${q}: Kafka 토픽으로 가져왔습니다. 파티션 수(기본 6)는 직접 확인하세요.`);
  }

  const doc: any = { nodes };
  const total = [...roots.values()].reduce((a, b) => a + b, 0);
  if (total > 0) {
    const seconds = Math.max(1, (tMax - tMin) / 1000);
    const mix: Record<string, string> = {};
    for (const [k, n] of roots) mix[k] = `${((n / total) * 100).toFixed(1)}%`;
    doc.scenario = { traffic: { type: 'constant', rps: `${Math.max(1, Math.round(total / seconds))}rps`, mix } };
    notes.push(`진입 요청 ${total.toLocaleString()}건(${fmtDuration(tMax - tMin)} 구간)에서 트래픽 믹스를 계산했습니다. 샘플링된 트레이스라면 rps는 샘플링 비율로 나눠야 합니다.`);
  }
  notes.push(`스팬 ${spans.length.toLocaleString()}개에서 서비스 ${Object.values(nodes).filter((n: any) => n.kind === 'service').length}개, API ${eps.size}개를 찾았습니다.`);
  const thin = [...eps.values()].filter((e) => e.count < 100);
  if (thin.length) notes.push(`표본이 100건 미만인 API ${thin.length}개는 p99가 부정확합니다: ${thin.slice(0, 5).map((e) => `${e.service} ${e.name}`).join(', ')}`);
  return { doc, notes, spans: spans.length };
}

function median(v: number[]): number {
  return quantiles(v).p50;
}
