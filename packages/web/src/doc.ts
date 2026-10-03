// Helpers for editing the raw YAML document (the single source of truth shared by canvas, panel and YAML editor).
import { parse, stringify } from 'yaml';
import type { RawDoc } from '@load-simulator/engine';

export type Path = (string | number)[];

export function clone<T>(v: T): T {
  return structuredClone(v);
}

export function getPath(doc: any, path: Path): any {
  let o = doc;
  for (const k of path) {
    if (o == null) return undefined;
    o = o[k];
  }
  return o;
}

/** Immutable set; creates intermediate objects. value === undefined deletes the key. */
export function setPath(doc: RawDoc, path: Path, value: unknown): RawDoc {
  const root = clone(doc);
  let o: any = root;
  for (let i = 0; i < path.length - 1; i++) {
    const k = path[i];
    if (o[k] == null || typeof o[k] !== 'object') o[k] = {};
    o = o[k];
  }
  const last = path[path.length - 1];
  if (value === undefined) delete o[last];
  else o[last] = value;
  return root;
}

export interface PatchOp {
  path: Path;
  value: unknown;
}

export function applyPatch(doc: RawDoc, ops: PatchOp[]): RawDoc {
  return ops.reduce((d, op) => setPath(d, op.path, op.value), doc);
}

export function toYaml(doc: RawDoc): string {
  return stringify(doc, { lineWidth: 0, flowCollectionPadding: true, collectionStyle: 'any' } as any);
}

export function fromYaml(text: string): RawDoc {
  const d = parse(text);
  if (!d || typeof d !== 'object') throw new Error('YAML 최상위는 객체여야 합니다');
  return d as RawDoc;
}

export type NodeKind = 'service' | 'db' | 'cache' | 'external' | 'queue' | 'gateway' | 'loadbalancer' | 'cdn' | 'pooler' | 'nosql' | 'objectstore';

export function nodeKind(raw: any): NodeKind {
  const k = raw?.kind ?? 'service';
  return k === 'lb' ? 'loadbalancer' : k;
}

/** gateways, load balancers and CDNs forward requests; they have no hand-written APIs */
export const isFront = (raw: any) => ['gateway', 'loadbalancer', 'cdn'].includes(nodeKind(raw));

/** partitioned stores (NoSQL, search, object storage) */
export const isStore = (raw: any) => ['nosql', 'objectstore'].includes(nodeKind(raw));

/** Remove a node and everything that references it. */
export function removeNode(doc: RawDoc, name: string): RawDoc {
  const d = clone(doc);
  delete d.nodes?.[name];
  for (const k of Object.keys(d.edges ?? {})) {
    const [a, b] = k.split('->').map((s) => s.trim());
    if (a === name || b === name) delete d.edges[k];
  }
  for (const n of Object.values<any>(d.nodes ?? {})) {
    for (const ep of Object.values<any>(n.endpoints ?? {})) {
      if (Array.isArray(ep?.calls)) ep.calls = pruneCalls(ep.calls, name);
    }
  }
  const mix = d.scenario?.traffic?.mix;
  if (mix) for (const k of Object.keys(mix)) if (k.startsWith(`${name}:`) || !refExists(d, k)) delete mix[k];
  if (Array.isArray(d.scenario?.faults)) d.scenario.faults = d.scenario.faults.filter((f: any) => f.target !== name && !String(f.target).split('->').includes(name));
  for (const n of Object.values<any>(d.nodes ?? {})) {
    if (nodeKind(n) === 'gateway')
      for (const [k, r] of Object.entries<any>(n.routes ?? {})) if (String(typeof r === 'string' ? r : r?.to).split(':')[0] === name) delete n.routes[k];
    if (nodeKind(n) === 'loadbalancer' && n.target === name) n.target = '';
    if (nodeKind(n) === 'cdn' && n.origin === name) n.origin = '';
    if (nodeKind(n) === 'pooler' && n.target === name) n.target = '';
  }
  // queues consumed by the removed service lose their consumer
  for (const q of Object.values<any>(d.nodes ?? {})) if (q?.kind === 'queue' && q.consumer?.service === name) delete q.consumer;
  delete d.layout?.[name];
  return d;
}

export function removeEdge(doc: RawDoc, key: string): RawDoc {
  const d = clone(doc);
  const [a, b] = key.split('->').map((s) => s.trim());
  delete d.edges?.[key];
  const n = d.nodes?.[a];
  for (const ep of Object.values<any>(n?.endpoints ?? {})) {
    if (Array.isArray(ep?.calls)) ep.calls = pruneCalls(ep.calls, b);
  }
  return d;
}

/** Drop every call to `target`, also inside cache-miss paths and parallel groups (emptied groups go too). */
export function pruneCalls(calls: any[], target: string): any[] {
  const out: any[] = [];
  for (const c of calls) {
    if (targetOf(c) === target) continue;
    if (c && typeof c === 'object' && Array.isArray(c.parallel)) {
      const p = pruneCalls(c.parallel, target);
      if (!p.length) continue;
      out.push({ ...c, parallel: p });
      continue;
    }
    if (c && typeof c === 'object' && Array.isArray(c.onMiss)) out.push({ ...c, onMiss: pruneCalls(c.onMiss, target) });
    else out.push(c);
  }
  return out;
}

export function targetOf(call: any): string {
  const s = typeof call === 'string' ? call : String(call?.call ?? '');
  return s.slice(0, s.indexOf(':')).trim();
}

function refExists(d: RawDoc, ref: string): boolean {
  for (const n of Object.values<any>(d.nodes ?? {})) if (n?.endpoints?.[ref]) return true;
  return false;
}

/** Operations a node offers to callers (endpoints, queries, cache commands…). Pass the doc to resolve poolers. */
export function operationsOf(raw: any, doc?: RawDoc): string[] {
  switch (nodeKind(raw)) {
    case 'pooler': {
      const db = doc?.nodes?.[raw.target];
      return db ? operationsOf(db) : ['query'];
    }
    case 'service':
      return Object.keys(raw.endpoints ?? {});
    case 'db':
      return Object.keys(raw.queries ?? {}).length ? Object.keys(raw.queries) : ['query'];
    case 'cache':
      return Object.keys(raw.ops ?? {}).length ? Object.keys(raw.ops) : ['GET key'];
    case 'queue':
      return ['publish'];
    case 'gateway':
      return Object.keys(raw.routes ?? {});
    case 'nosql':
      return Object.keys(raw.ops ?? {}).length ? Object.keys(raw.ops) : ['GetItem', 'PutItem'];
    case 'objectstore':
      return Object.keys(raw.ops ?? {}).length ? Object.keys(raw.ops) : ['GetObject', 'PutObject'];
    default:
      return ['POST /api'];
  }
}

export interface ConnectSpec {
  from: string;
  to: string;
  /** endpoint of `from` that makes the call */
  fromEndpoint: string;
  /** operation on `to` */
  op: string;
  prob?: number;
  count?: number;
}

/** Add a call from a chosen endpoint of `from` to an operation on `to`, plus an edge entry with safe defaults. */
export function connect(doc: RawDoc, c: ConnectSpec): RawDoc {
  const d = clone(doc);
  const src = d.nodes?.[c.from];
  const dst = d.nodes?.[c.to];
  if (!src || !dst || c.from === c.to) return doc;
  // a gateway gets a route, a load balancer gets a target
  if (nodeKind(src) === 'gateway') {
    src.routes = { ...(src.routes ?? {}), [c.op]: { to: `${c.to}:${c.op}`, timeout: '2s' } };
    return d;
  }
  if (nodeKind(src) === 'loadbalancer') {
    src.target = c.to;
    return d;
  }
  if (nodeKind(src) === 'cdn') {
    src.origin = c.to;
    return d;
  }
  if (nodeKind(src) === 'pooler') {
    if (nodeKind(dst) === 'db') src.target = c.to;
    return d;
  }
  if (nodeKind(src) !== 'service') return doc;
  const ep = src.endpoints?.[c.fromEndpoint];
  if (!ep) return doc;
  let call = `${c.to}:${c.op}`;
  if (c.count && c.count > 1) call += ` x ${c.count}`;
  if (c.prob !== undefined && c.prob < 1) call += ` @${+(c.prob * 100).toFixed(1)}%`;
  ep.calls = [...(ep.calls ?? []), call];
  ensureCallTarget(d, c.from, c.to, c.op);
  return d;
}

/** Make a call `from → to:op` runnable: the target lists the operation and the edge has safe defaults. Mutates `d`. */
export function ensureCallTarget(d: RawDoc, from: string, to: string, op: string): void {
  const dst = d.nodes?.[to];
  if (!dst || !to || !op) return;
  // a new DB query / service API appears in the target's catalogue
  if (nodeKind(dst) === 'db' && !dst.queries?.[op]) (dst.queries ??= {})[op] = { p50: '3ms', p99: '15ms' };
  if (nodeKind(dst) === 'service' && !dst.endpoints?.[op]) (dst.endpoints ??= {})[op] = { selfTime: { p50: '5ms', p99: '20ms' } };
  if (isStore(dst) && !dst.ops?.[op]) (dst.ops ??= {})[op] = {};
  // a pooler exposes its DB's queries: a new query lands on the DB behind it
  if (nodeKind(dst) === 'pooler') {
    const db = d.nodes?.[dst.target];
    if (db && nodeKind(db) === 'db' && !db.queries?.[op] && op !== 'query') (db.queries ??= {})[op] = { p50: '3ms', p99: '15ms' };
  }
  d.edges ??= {};
  const kind = nodeKind(dst);
  if (!Object.keys(d.edges).some((k) => k.replace(/\s/g, '') === `${from}->${to}`))
    d.edges[`${from}->${to}`] =
      kind === 'db' || kind === 'pooler' ? { pool: { size: 10, timeout: '3s' } } : kind === 'queue' || kind === 'cache' ? {} : isStore(dst) ? { timeout: '1s' } : { timeout: '2s' };
}

// ---------------------------------------------------------------------------
// API flow editing: an endpoint's `calls` is an ordered list of steps

/** One step of an API's flow in editable form. */
export type Step =
  | { type: 'call'; target: string; op: string; count: number; prob: number; optional: boolean; async: boolean; onMiss: Step[] }
  | { type: 'work'; work: string; cpu: number; prob: number }
  | { type: 'parallel'; steps: Step[]; optional: boolean };

/** "stock:GET /s/{id} x 3 @20%" → parts (count may be a range or variable; kept as text then) */
export function splitCall(s: string): { target: string; op: string; count: number | string; prob: number } {
  let rest = s.trim();
  let prob = 1;
  let count: number | string = 1;
  const pm = /\s+@\s*([\d.]+)(%?)\s*$/.exec(rest);
  if (pm) {
    prob = Number(pm[1]) / (pm[2] ? 100 : 1);
    rest = rest.slice(0, pm.index);
  }
  const xm = /\s+x\s+(\S+)\s*$/.exec(rest);
  if (xm) {
    count = /^\d+$/.test(xm[1]) ? Number(xm[1]) : xm[1];
    rest = rest.slice(0, xm.index);
  }
  const i = rest.indexOf(':');
  return { target: i > 0 ? rest.slice(0, i).trim() : '', op: i > 0 ? rest.slice(i + 1).trim() : rest, count, prob };
}

const probOf = (v: unknown, def = 1): number => {
  if (v === undefined) return def;
  const s = String(v).trim();
  return s.endsWith('%') ? Number(s.slice(0, -1)) / 100 : Number(s);
};

export function toStep(raw: any): Step {
  if (raw && typeof raw === 'object' && Array.isArray(raw.parallel)) return { type: 'parallel', steps: raw.parallel.map(toStep), optional: !!raw.optional };
  if (raw && typeof raw === 'object' && raw.work !== undefined) return { type: 'work', work: String(raw.work), cpu: probOf(raw.cpu, 0.3), prob: probOf(raw.prob) };
  const obj = typeof raw === 'string' ? { call: raw } : raw ?? { call: '' };
  const p = splitCall(String(obj.call ?? ''));
  const count = obj.count !== undefined ? Number(obj.count) || 1 : typeof p.count === 'number' ? p.count : 1;
  return {
    type: 'call',
    target: p.target,
    op: p.op,
    count,
    prob: obj.prob !== undefined ? probOf(obj.prob) : p.prob,
    optional: !!obj.optional,
    async: !!obj.async,
    onMiss: (obj.onMiss ?? []).map(toStep),
  };
}

const pctText = (p: number) => `${+(p * 100).toFixed(2)}%`;

/** Back to the compact YAML form: a plain string when nothing else is set. */
export function fromStep(s: Step): any {
  if (s.type === 'parallel') return { parallel: s.steps.map(fromStep), ...(s.optional ? { optional: true } : {}) };
  if (s.type === 'work') return { work: s.work, ...(Math.abs(s.cpu - 0.3) > 1e-9 ? { cpu: pctText(s.cpu) } : {}), ...(s.prob < 1 ? { prob: pctText(s.prob) } : {}) };
  let call = `${s.target}:${s.op}`;
  if (s.count > 1) call += ` x ${s.count}`;
  if (s.prob < 1) call += ` @${+(s.prob * 100).toFixed(2)}%`;
  if (!s.optional && !s.async && !s.onMiss.length) return call;
  return { call, ...(s.optional ? { optional: true } : {}), ...(s.async ? { async: true } : {}), ...(s.onMiss.length ? { onMiss: s.onMiss.map(fromStep) } : {}) };
}

/** Write an endpoint's flow and make every call target runnable. */
export function setFlow(doc: RawDoc, svc: string, ep: string, steps: Step[]): RawDoc {
  const d = clone(doc);
  const e = d.nodes?.[svc]?.endpoints?.[ep];
  if (!e) return doc;
  e.calls = steps.map(fromStep);
  if (!e.calls.length) delete e.calls;
  const visit = (s: Step) => {
    if (s.type === 'call') {
      ensureCallTarget(d, svc, s.target, s.op);
      s.onMiss.forEach(visit);
    } else if (s.type === 'parallel') s.steps.forEach(visit);
  };
  steps.forEach(visit);
  return d;
}

/** Rewrite (or drop, when `to` is null) every reference to `svc:from`: callers, traffic mix, gateway routes, queue consumers. */
function retargetEndpoint(d: RawDoc, svc: string, from: string, to: string | null): void {
  const fix = (calls: any[]): any[] => {
    const out: any[] = [];
    for (const c of calls) {
      const st = toStep(c);
      if (st.type === 'call' && st.target === svc && st.op === from) {
        if (to !== null) out.push(fromStep({ ...st, op: to }));
        continue;
      }
      if (c && typeof c === 'object' && Array.isArray(c.parallel)) {
        const p = fix(c.parallel);
        if (p.length) out.push({ ...c, parallel: p });
      } else if (c && typeof c === 'object' && Array.isArray(c.onMiss)) out.push({ ...c, onMiss: fix(c.onMiss) });
      else out.push(c);
    }
    return out;
  };
  for (const n of Object.values<any>(d.nodes ?? {})) {
    for (const e of Object.values<any>(n?.endpoints ?? {})) if (Array.isArray(e?.calls)) e.calls = fix(e.calls);
    if (nodeKind(n) === 'gateway')
      for (const [k, r] of Object.entries<any>(n.routes ?? {})) {
        const dest = typeof r === 'string' ? r : r?.to;
        if (dest !== `${svc}:${from}`) continue;
        if (to === null) delete n.routes[k];
        else n.routes[k] = typeof r === 'string' ? `${svc}:${to}` : { ...r, to: `${svc}:${to}` };
      }
    if (n?.kind === 'queue' && n.consumer?.service === svc && n.consumer.endpoint === from) {
      if (to === null) delete n.consumer;
      else n.consumer.endpoint = to;
    }
  }
  const mix = d.scenario?.traffic?.mix;
  if (mix)
    for (const k of Object.keys(mix)) {
      if (k !== `${svc}:${from}` && k !== from) continue;
      const v = mix[k];
      delete mix[k];
      if (to !== null) mix[k === from ? to : `${svc}:${to}`] = v;
    }
}

/** Does anything send requests to `svc:ep` — traffic mix, a caller, a gateway route, a queue consumer? */
export function isReached(doc: RawDoc, svc: string, ep: string): boolean {
  const mix = doc.scenario?.traffic?.mix ?? {};
  if (mix[`${svc}:${ep}`] !== undefined || mix[ep] !== undefined) return true;
  let hit = false;
  const visit = (c: any) => {
    const st = toStep(c);
    if (st.type === 'call') {
      if (st.target === svc && st.op === ep) hit = true;
      (c?.onMiss ?? []).forEach(visit);
    } else if (st.type === 'parallel') (c.parallel ?? []).forEach(visit);
  };
  for (const n of Object.values<any>(doc.nodes ?? {})) {
    for (const e of Object.values<any>(n?.endpoints ?? {})) (e?.calls ?? []).forEach(visit);
    if (nodeKind(n) === 'gateway') for (const r of Object.values<any>(n.routes ?? {})) if ((typeof r === 'string' ? r : r?.to) === `${svc}:${ep}`) hit = true;
    if (nodeKind(n) === 'loadbalancer' && n.target === svc && mix[ep] !== undefined) hit = true;
    if (n?.kind === 'queue' && n.consumer?.service === svc && n.consumer.endpoint === ep) hit = true;
  }
  return hit;
}

export function addEndpoint(doc: RawDoc, svc: string, ep: string): RawDoc {
  const d = clone(doc);
  const n = d.nodes?.[svc];
  if (!n || !ep.trim() || n.endpoints?.[ep]) return doc;
  (n.endpoints ??= {})[ep.trim()] = { selfTime: { p50: '5ms', p99: '20ms' } };
  return d;
}

export function renameEndpoint(doc: RawDoc, svc: string, from: string, to: string): RawDoc {
  to = to.trim();
  const n = doc.nodes?.[svc];
  if (!n?.endpoints?.[from] || !to || from === to || n.endpoints[to]) return doc;
  const d = clone(doc);
  // keep the key order so the API list does not jump around
  d.nodes[svc].endpoints = Object.fromEntries(Object.entries<any>(d.nodes[svc].endpoints).map(([k, v]) => [k === from ? to : k, v]));
  retargetEndpoint(d, svc, from, to);
  return d;
}

export function removeEndpoint(doc: RawDoc, svc: string, ep: string): RawDoc {
  const d = clone(doc);
  if (!d.nodes?.[svc]?.endpoints?.[ep]) return doc;
  delete d.nodes[svc].endpoints[ep];
  retargetEndpoint(d, svc, ep, null);
  return d;
}

export function addNode(doc: RawDoc, kind: NodeKind, pos: [number, number]): { doc: RawDoc; name: string } {
  const d = clone(doc);
  d.nodes ??= {};
  const base = { service: 'service', db: 'db', cache: 'cache', external: 'external-api', queue: 'events', gateway: 'gateway', loadbalancer: 'lb', cdn: 'cdn', pooler: 'pgbouncer', nosql: 'table', objectstore: 'bucket' }[kind];
  const firstDb = Object.entries<any>(d.nodes).find(([, n]) => nodeKind(n) === 'db')?.[0];
  // a CDN goes in front of the outermost entry: an existing load balancer or gateway, else the first service
  const front = Object.entries<any>(d.nodes).find(([, n]) => nodeKind(n) === 'loadbalancer')?.[0] ?? Object.entries<any>(d.nodes).find(([, n]) => nodeKind(n) === 'gateway')?.[0];
  const firstSvc = Object.entries<any>(d.nodes).find(([, n]) => nodeKind(n) === 'service' && Object.keys(n.endpoints ?? {}).length);
  let name = base;
  for (let i = 2; d.nodes[name]; i++) name = `${base}-${i}`;
  const defaults: Record<string, any> = {
    service: { kind: 'service', instances: 1, runtime: { threads: 200 }, os: { vcpu: 2, heap: '1g' }, endpoints: { 'GET /': { selfTime: { p50: '5ms', p99: '25ms' } } } },
    db: { kind: 'db', maxConnections: 151, queries: { query: { latency: { p50: '3ms', p99: '15ms' } } } },
    cache: { kind: 'cache', hitRate: '90%', opTime: '0.2ms' },
    external: { kind: 'external', latency: { p50: '80ms', p99: '300ms' }, concurrency: 100 },
    queue: { kind: 'queue', broker: 'rabbitmq' },
    gateway: { kind: 'gateway', instances: 2, os: { vcpu: 2 }, routes: firstSvc ? { '/**': { to: firstSvc[0], timeout: '2s' } } : {} },
    loadbalancer: { kind: 'loadbalancer', target: firstSvc?.[0] ?? '', algorithm: 'round-robin', layer: 7 },
    cdn: { kind: 'cdn', origin: front ?? firstSvc?.[0] ?? '', hitRate: '90%' },
    pooler: { kind: 'pooler', engine: 'pgbouncer', target: firstDb ?? '', poolSize: 20, maxClientConn: 100 },
    nosql: { kind: 'nosql', engine: 'dynamodb', partitions: 4, ops: { GetItem: {}, PutItem: {} } },
    objectstore: { kind: 'objectstore', prefixes: 1, ops: { GetObject: { size: '200kb' }, PutObject: { size: '200kb' } } },
  };
  d.nodes[name] = defaults[kind];
  d.layout ??= {};
  d.layout[name] = pos;
  return { doc: d, name };
}
