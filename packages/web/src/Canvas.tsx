import { memo, useEffect, useMemo, useRef, useState } from 'react';
import {
  Background,
  BaseEdge,
  Controls,
  EdgeLabelRenderer,
  Handle,
  Panel,
  Position,
  ReactFlow,
  getBezierPath,
  useReactFlow,
  useStore,
  type Connection,
  type Edge,
  type EdgeProps,
  type Node,
  type NodeChange,
  type NodeProps,
} from '@xyflow/react';
import type { RawDoc, SimResult, Warning } from '@load-simulator/engine';
import { clock } from './clock';
import { ms, num, pct, toMs, toRatio } from './format';
import { nodeKind } from './doc';
import { apiColors } from './apiColors';

export type Layer = 'app' | 'os' | 'net';
export type Selection = { type: 'node' | 'edge'; id: string } | null;
export type Layout = Record<string, [number, number]>;

const KIND_LABEL: Record<string, string> = {
  service: '서비스',
  db: 'DB',
  cache: '캐시',
  external: '외부 API',
  queue: '메시지 큐',
  gateway: 'API 게이트웨이',
  loadbalancer: '로드밸런서',
  cdn: 'CDN',
  pooler: '커넥션 풀러',
  nosql: 'NoSQL',
  objectstore: '오브젝트 스토리지',
  client: '클라이언트',
};

const ENGINE: Record<string, string> = { dynamodb: 'DynamoDB', cassandra: 'Cassandra', mongodb: 'MongoDB', elasticsearch: 'Elasticsearch' };

export function satColor(s: number): string {
  if (!Number.isFinite(s) || s <= 0.01) return 'var(--sat-0)';
  if (s < 0.5) return 'var(--sat-1)';
  if (s < 0.75) return 'var(--sat-2)';
  if (s < 0.95) return 'var(--sat-3)';
  if (s <= 1.05) return 'var(--sat-4)';
  return 'var(--sat-5)';
}

// ---------------------------------------------------------------------------
// Nodes

interface Gauge {
  label: string;
  value: number; // 0..1+
  text: string;
}

interface BlockData extends Record<string, unknown> {
  name: string;
  kind: string;
  instances: number;
  /** cluster shape, e.g. "primary + 2 replicas", "Kafka · 12 partitions" */
  cluster: string;
  /** requests / messages waiting right now (shown as a badge instead of piled particles) */
  waiting: number;
  sat: number;
  gauges: Gauge[];
  note: string;
  warn: boolean;
  bottleneck: boolean;
  focus: boolean;
}

/** 14px line icons, one per block kind */
const ICON_PATHS: Record<string, string> = {
  service: 'M3 4.5h10v7H3z M3 7h10',
  gateway: 'M2.5 13V6l5.5-3.5L13.5 6v7 M6 13V9h4v4',
  loadbalancer: 'M8 2.5v4 M8 6.5L3.5 11 M8 6.5v4.5 M8 6.5l4.5 4.5 M2.5 11.5h2 M7 11.5h2 M11.5 11.5h2',
  cdn: 'M4.5 12h7a3 3 0 0 0 .3-6 4 4 0 0 0-7.6 1A2.5 2.5 0 0 0 4.5 12z',
  pooler: 'M2.5 3.5h11L9.5 8v4.5l-3 1V8z',
  db: 'M3 4c0-1.1 2.2-1.5 5-1.5s5 .4 5 1.5v8c0 1.1-2.2 1.5-5 1.5S3 13.1 3 12z M3 4c0 1.1 2.2 1.5 5 1.5S13 5.1 13 4 M3 8c0 1.1 2.2 1.5 5 1.5S13 9.1 13 8',
  cache: 'M9 2L4 9h4l-1 5 5-7H8z',
  nosql: 'M2.5 3.5h11v9h-11z M2.5 6.5h11 M2.5 9.5h11 M6.5 3.5v9',
  objectstore: 'M3 4.5h10l-1.2 8.5H4.2z M3 4.5c0-1 2.2-1.5 5-1.5s5 .5 5 1.5',
  queue: 'M2.5 4.5h11 M2.5 8h11 M2.5 11.5h11 M11 2.5l2.5 2-2.5 2',
  external: 'M8 2.5a5.5 5.5 0 1 0 0 11a5.5 5.5 0 1 0 0-11z M2.5 8h11 M8 2.5c-2 2.5-2 8.5 0 11 M8 2.5c2 2.5 2 8.5 0 11',
  client: 'M2.5 3.5h11v7h-11z M6 13.5h4 M8 10.5v3',
};

function KindIcon({ kind }: { kind: string }) {
  const d = ICON_PATHS[kind];
  if (!d) return null;
  return (
    <svg className="block-icon" viewBox="0 0 16 16" width="14" height="14" aria-hidden>
      <path d={d} fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

const Block = memo(function Block({ data, selected }: NodeProps<Node<BlockData>>) {
  const d = data;
  return (
    <div
      className={`block kind-${d.kind}${selected ? ' selected' : ''}${d.bottleneck ? ' bottleneck' : ''}${d.sat > 1.05 ? ' overloaded' : ''}`}
      style={{ ['--sat' as any]: satColor(d.sat) }}
    >
      <Handle type="target" position={Position.Left} />
      <div className="block-head">
        <KindIcon kind={d.kind} />
        <span className="block-kind">{KIND_LABEL[d.kind]}</span>
        {(d.kind === 'service' || d.kind === 'gateway' || d.kind === 'loadbalancer' || d.kind === 'pooler') && d.instances > 1 && <span className="block-inst">×{d.instances}</span>}
        {d.cluster && <span className="block-cluster">{d.cluster}</span>}
        {d.warn && <span className="block-warn" title="정적 검사 경고">!</span>}
      </div>
      <div className="block-name">{d.name}</div>
      {d.waiting >= 1 && (
        <span className="block-waiting" title="지금 기다리는 요청·메시지">
          대기 {d.waiting >= 10_000 ? `${(d.waiting / 1000).toFixed(0)}k` : d.waiting >= 1000 ? `${(d.waiting / 1000).toFixed(1)}k` : Math.round(d.waiting)}
        </span>
      )}
      {d.gauges.map((g) => (
        <div className="gauge" key={g.label}>
          <span className="gauge-label">{g.label}</span>
          <span className="gauge-bar">
            <span style={{ width: `${Math.min(100, g.value * 100)}%`, background: satColor(g.value) }} />
          </span>
          <span className="gauge-text">{g.text}</span>
        </div>
      ))}
      {d.note && <div className="block-note">{d.note}</div>}
      {d.bottleneck && <div className="block-flag">첫 병목</div>}
      <Handle type="source" position={Position.Right} />
    </div>
  );
});

const ClientBlock = memo(function ClientBlock({ data }: NodeProps<Node<BlockData>>) {
  return (
    <div className="block kind-client">
      <div className="block-head">
        <KindIcon kind="client" />
        <span className="block-kind">트래픽</span>
      </div>
      <div className="block-name">{data.name}</div>
      {data.note && <div className="block-note">{data.note}</div>}
      <Handle type="source" position={Position.Right} />
    </div>
  );
});

// ---------------------------------------------------------------------------
// Edges

interface LinkData extends Record<string, unknown> {
  dashed?: boolean;
  label: string;
  badges: { text: string; tone: 'ok' | 'warn' | 'bad' | 'info' }[];
  width: number;
  tone: 'idle' | 'ok' | 'warn' | 'bad';
  warn: boolean;
}

function Link({ id, sourceX, sourceY, targetX, targetY, sourcePosition, targetPosition, data, selected, markerEnd }: EdgeProps<Edge<LinkData>>) {
  const [path, lx, ly] = getBezierPath({ sourceX, sourceY, targetX, targetY, sourcePosition, targetPosition });
  const d = data!;
  return (
    <>
      <BaseEdge
        id={id}
        path={path}
        markerEnd={markerEnd}
        className={`link tone-${d.tone}${selected ? ' selected' : ''}${d.dashed ? ' dashed' : ''}`}
        style={{ strokeWidth: d.width }}
        interactionWidth={18}
      />
      {(d.label || d.badges.length > 0) && (
        <EdgeLabelRenderer>
          <div className={`link-label${selected ? ' selected' : ''}`} style={{ transform: `translate(-50%, -50%) translate(${lx}px, ${ly}px)` }}>
            {d.label && <span className="link-text">{d.label}</span>}
            {d.badges.map((b) => (
              <span key={b.text} className={`badge tone-${b.tone}`}>
                {b.text}
              </span>
            ))}
            {d.warn && <span className="badge tone-warn">!</span>}
          </div>
        </EdgeLabelRenderer>
      )}
    </>
  );
}

const nodeTypes = { block: Block, client: ClientBlock };

/** short description of a node's cluster shape */
export function clusterLabel(raw: any): string {
  const kind = nodeKind(raw);
  const c = raw?.cluster ?? {};
  const zones = Array.isArray(raw?.zones) && raw.zones.length ? ` · 존 ${raw.zones.join('/')}` : '';
  if (kind === 'db' && Number(c.shards) > 1) return `${c.shards} 샤드${Number(c.replicas) > 0 ? ` × (1+${c.replicas})` : ''}${zones}`;
  if (kind === 'db' && Number(c.replicas) > 0) return `primary + ${c.replicas} replica${zones}`;
  if (kind === 'gateway') return `라우트 ${Object.keys(raw.routes ?? {}).length}개${zones}`;
  if (kind === 'loadbalancer') return `L${raw.layer ?? 7} · ${raw.algorithm ?? 'round-robin'} → ${raw.target ?? '?'}`;
  if (kind === 'cache' && Number(c.shards) > 1) return `${c.shards} shards`;
  if (kind === 'cdn') return `적중 ${raw.hitRate ?? '90%'} → ${raw.origin || '?'}`;
  if (kind === 'pooler') return `${raw.engine === 'proxysql' ? 'ProxySQL' : raw.engine === 'rds-proxy' ? 'RDS Proxy' : 'PgBouncer'} · DB 연결 ${raw.poolSize ?? 20} → ${raw.target || '?'}`;
  if (kind === 'objectstore') return `S3 · prefix ${raw.prefixes ?? 1}`;
  if (kind === 'nosql') {
    const e = raw.engine ?? 'dynamodb';
    const parts = [ENGINE[e] ?? e];
    if (e === 'dynamodb') parts.push(`파티션 ${raw.partitions ?? 4}`);
    else if (e === 'mongodb') parts.push(`${Number(raw.partitions ?? 1) > 1 ? `샤드 ${raw.partitions} × ` : ''}RS ${raw.replication ?? 3}`);
    else if (e === 'elasticsearch') parts.push(`노드 ${raw.nodes ?? 3} · 샤드 ${raw.partitions ?? 5}×${raw.replication ?? 2}`);
    else parts.push(`노드 ${raw.nodes ?? 3} · RF ${raw.replication ?? 3}`);
    return parts.join(' · ') + zones;
  }
  if (kind === 'queue') {
    if (raw.broker === 'kafka') return `Kafka · ${raw.kafka?.partitions ?? 6} 파티션${raw.kafka?.brokers ? ` · ${raw.kafka.brokers} 브로커` : ''}`;
    return `RabbitMQ${Number(c.nodes) > 1 ? ` · ${c.queueType === 'quorum' ? 'quorum' : 'classic'} ×${c.nodes}` : ''}`;
  }
  return zones.slice(3);
}
const edgeTypes = { link: Link };

// ---------------------------------------------------------------------------
// Layout

export function autoLayout(doc: RawDoc, layout: Layout): Layout {
  const out: Layout = { ...layout };
  const nodes = Object.keys(doc.nodes ?? {});
  const missing = nodes.filter((n) => !out[n]);
  if (!missing.length) return out;
  // depth = longest call distance from an entry service
  const depth: Record<string, number> = {};
  const entries = new Set(Object.keys(doc.scenario?.traffic?.mix ?? {}).map((k) => k.split(':')[0]));
  for (const n of nodes) if (entries.has(n) || [...entries].some((e) => doc.nodes[n]?.endpoints?.[e])) depth[n] = 0;
  for (let i = 0; i < nodes.length; i++) {
    for (const n of nodes) {
      if (depth[n] === undefined) continue;
      for (const ep of Object.values<any>(doc.nodes[n]?.endpoints ?? {})) {
        const visit = (c: any) => {
          const s = typeof c === 'string' ? c : String(c?.call ?? '');
          const t = s.slice(0, s.indexOf(':')).trim();
          if (t && doc.nodes[t] && (depth[t] ?? -1) < depth[n] + 1) depth[t] = depth[n] + 1;
          (c?.onMiss ?? []).forEach(visit);
          (c?.parallel ?? []).forEach(visit);
        };
        (ep?.calls ?? []).forEach(visit);
      }
    }
  }
  const cols: Record<number, number> = {};
  for (const n of missing) {
    const dpt = Math.min(depth[n] ?? 0, 8);
    const row = (cols[dpt] = (cols[dpt] ?? 0) + 1) - 1;
    out[n] = [80 + dpt * 300, 60 + row * 190];
  }
  return out;
}

// ---------------------------------------------------------------------------
// Particles: sampled request traces, drawn on a canvas above the flow.
//
// Each request travels along the drawn edge curves in its API's colour: a filled dot with a short tail on the way
// in, a ring on the way back. Every API gets its own lane on an edge so concurrent flows stay apart; the response
// that reaches the client shows the outcome (red diamond + burst = failure, amber halo = fallback).

type Pt = { x: number; y: number };
interface Box {
  /** right-middle (outgoing handle) and left-middle (incoming handle) in screen px */
  out: Pt;
  in: Pt;
}

/** React Flow's default bezier between a right-side source handle and a left-side target handle. */
function bezier(a: Pt, b: Pt): (f: number) => Pt {
  const off = (d: number) => (d >= 0 ? 0.5 * d : 0.25 * 25 * Math.sqrt(-d));
  const c1 = { x: a.x + off(b.x - a.x), y: a.y };
  const c2 = { x: b.x - off(b.x - a.x), y: b.y };
  return (f) => {
    const u = 1 - f;
    return {
      x: u * u * u * a.x + 3 * u * u * f * c1.x + 3 * u * f * f * c2.x + f * f * f * b.x,
      y: u * u * u * a.y + 3 * u * u * f * c1.y + 3 * u * f * f * c2.y + f * f * f * b.y,
    };
  };
}

function Particles({ result, names, focusApi }: { result: SimResult | null; names: string[]; focusApi: string | null }) {
  const ref = useRef<HTMLCanvasElement>(null);
  const transform = useStore((s) => s.transform);
  const lookup = useStore((s) => s.nodeLookup);
  const state = useRef({ transform, lookup, focusApi });
  state.current = { transform, lookup, focusApi };

  const traces = useMemo(() => {
    if (!result) return [];
    return [...result.particles.traces].sort((a, b) => a.t0 - b.t0);
  }, [result]);
  const colors = useMemo(() => apiColors(result), [result]);

  useEffect(() => {
    const canvas = ref.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d')!;
    const read = () => {
      const cs = getComputedStyle(canvas);
      return {
        error: cs.getPropertyValue('--particle-err').trim() || '#ef4444',
        degraded: cs.getPropertyValue('--particle-deg').trim() || '#f59e0b',
        open: cs.getPropertyValue('--particle-open').trim() || '#94a3b8',
        bg: cs.getPropertyValue('--surface').trim() || '#ffffff',
      };
    };
    let palette = read();
    const mq = matchMedia('(prefers-color-scheme: dark)');
    const onScheme = () => (palette = read());
    mq.addEventListener('change', onScheme);

    const draw = (t: number) => {
      const { transform: [tx, ty, zoom], lookup, focusApi } = state.current;
      const dpr = devicePixelRatio || 1;
      const w = canvas.clientWidth;
      const h = canvas.clientHeight;
      if (canvas.width !== w * dpr || canvas.height !== h * dpr) {
        canvas.width = w * dpr;
        canvas.height = h * dpr;
      }
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, w, h);
      if (!traces.length) return;
      const boxes = new Map<number, Box | null>();
      const box = (idx: number): Box | null => {
        if (boxes.has(idx)) return boxes.get(idx)!;
        const n = lookup.get(idx < 0 ? '__client' : names[idx]);
        let bx: Box | null = null;
        if (n) {
          const pw = n.measured?.width ?? 160;
          const ph = n.measured?.height ?? 80;
          const p = n.internals.positionAbsolute;
          const y = (p.y + ph / 2) * zoom + ty;
          bx = { out: { x: (p.x + pw) * zoom + tx, y }, in: { x: p.x * zoom + tx, y } };
        }
        boxes.set(idx, bx);
        return bx;
      };
      const curves = new Map<string, (f: number) => Pt>();
      const curve = (from: number, to: number) => {
        const k = `${from}>${to}`;
        let c = curves.get(k);
        if (!c) {
          const a = box(from);
          const b = box(to);
          if (!a || !b) return null;
          c = bezier(a.out, b.in);
          curves.set(k, c);
        }
        return c;
      };

      const travel = 420 * clock.speed; // sim ms a hop takes on screen
      const burst = 520 * clock.speed;
      const maxSpan = 60_000;
      const r = Math.max(2, 3 * Math.sqrt(zoom));
      const laneGap = 3.2 * Math.sqrt(zoom);
      let lo = 0;
      let hi = traces.length;
      while (lo < hi) {
        const mid = (lo + hi) >> 1;
        if (traces[mid].t0 < t - maxSpan) lo = mid + 1;
        else hi = mid;
      }
      const stack: number[] = [];
      for (let i = lo; i < traces.length; i++) {
        const tr = traces[i];
        if (tr.t0 > t) break;
        const p = tr.path;
        const hops = p.length / 2 - 1;
        let local = t - tr.t0;
        const total = tr.t1 - tr.t0 + hops * travel;
        const api = colors.get(tr.api);
        const color = api?.color ?? '#64748b';
        const dim = focusApi !== null && tr.api !== focusApi;
        // failure burst at the client after the response arrived
        if (local > total) {
          if (tr.status === 'error' && local - total < burst && !dim) {
            const c = box(-1);
            if (c) {
              const f = (local - total) / burst;
              ctx.globalAlpha = 0.3 * (1 - f);
              ctx.strokeStyle = palette.error;
              ctx.lineWidth = 1.2;
              ctx.beginPath();
              ctx.arc(c.out.x, c.out.y, r + f * 11 * Math.sqrt(zoom), 0, Math.PI * 2);
              ctx.stroke();
            }
          }
          continue;
        }
        // walk the hops: a hop back to the node we came from is a response
        stack.length = 0;
        stack.push(p[1]);
        let pos: ((f: number) => Pt) | null = null;
        let f = 0;
        let response = false;
        let last = false;
        for (let k = 0; k < hops; k++) {
          const from = p[2 * k + 1];
          const to = p[2 * k + 3];
          const back = stack.length >= 2 && stack[stack.length - 2] === to;
          if (back) stack.pop();
          else stack.push(to);
          const dwell = p[2 * (k + 1)] - p[2 * k];
          // time spent inside a block is not drawn: waiting is shown as the block's "대기" badge
          if (local < dwell) break;
          local -= dwell;
          if (local < travel) {
            const c = back ? curve(to, from) : curve(from, to);
            if (!c) break;
            const g = local / travel;
            const e = g * g * (3 - 2 * g);
            f = back ? 1 - e : e;
            pos = c;
            response = back;
            last = k === hops - 1;
            break;
          }
          local -= travel;
        }
        if (!pos) continue;
        // lane: per-API offset across the edge, requests and responses on opposite sides
        const here = pos(f);
        const ahead = pos(Math.min(1, f + 0.01));
        const behind = pos(Math.max(0, f - 0.01));
        let nx = -(ahead.y - behind.y);
        let ny = ahead.x - behind.x;
        const len = Math.hypot(nx, ny) || 1;
        nx /= len;
        ny /= len;
        const shift = ((api?.lane ?? 0) * laneGap + (response ? 2.5 : -2.5) * Math.sqrt(zoom));
        const at = (q: Pt) => ({ x: q.x + nx * shift, y: q.y + ny * shift });
        const alpha = dim ? 0.08 : 1;
        // tail: a few fading samples behind the head, in travel direction
        const dir = response ? 1 : -1;
        for (let j = 4; j >= 1; j--) {
          const q = at(pos(Math.min(1, Math.max(0, f + dir * j * 0.035))));
          ctx.globalAlpha = alpha * 0.16 * (5 - j) / 4;
          ctx.fillStyle = color;
          ctx.beginPath();
          ctx.arc(q.x, q.y, r * (1 - j * 0.14), 0, Math.PI * 2);
          ctx.fill();
        }
        const c = at(here);
        ctx.globalAlpha = alpha;
        const outcome = last ? tr.status : 'ok';
        if (outcome === 'error') {
          // failure travelling back to the client: red diamond
          ctx.fillStyle = palette.error;
          ctx.beginPath();
          const d = r * 1.35;
          ctx.moveTo(c.x, c.y - d);
          ctx.lineTo(c.x + d, c.y);
          ctx.lineTo(c.x, c.y + d);
          ctx.lineTo(c.x - d, c.y);
          ctx.closePath();
          ctx.fill();
          continue;
        }
        if (response) {
          ctx.fillStyle = palette.bg;
          ctx.strokeStyle = outcome === 'open' ? palette.open : color;
          ctx.lineWidth = Math.max(1.4, 1.8 * Math.sqrt(zoom));
          ctx.beginPath();
          ctx.arc(c.x, c.y, r, 0, Math.PI * 2);
          ctx.fill();
          ctx.stroke();
        } else {
          ctx.fillStyle = color;
          ctx.beginPath();
          ctx.arc(c.x, c.y, r, 0, Math.PI * 2);
          ctx.fill();
        }
        if (outcome === 'degraded') {
          ctx.strokeStyle = palette.degraded;
          ctx.lineWidth = 1.5;
          ctx.beginPath();
          ctx.arc(c.x, c.y, r + 2.5, 0, Math.PI * 2);
          ctx.stroke();
        }
      }
      ctx.globalAlpha = 1;
    };
    const off = clock.subscribe(draw);
    draw(clock.t);
    return () => {
      off();
      mq.removeEventListener('change', onScheme);
    };
  }, [traces, names, colors]);

  // redraw when panning/zooming or changing the focused API while paused
  useEffect(() => {
    clock.seek(clock.t);
  }, [transform, lookup, focusApi]);

  return <canvas ref={ref} className="particles" />;
}

/** Which colour is which API; clicking one focuses its requests and dims the others. */
function ApiLegend({ result, focusApi, onFocus }: { result: SimResult | null; focusApi: string | null; onFocus: (id: string | null) => void }) {
  const colors = apiColors(result);
  if (colors.size === 0) return null;
  const share = new Map((result?.endpoints ?? []).filter((e) => e.entry).map((e) => [e.id, e.count]));
  const total = [...share.values()].reduce((a, b) => a + b, 0) || 1;
  const multiNode = new Set([...colors.values()].map((c) => c.node)).size > 1;
  return (
    <Panel position="top-left" className="api-legend">
      {[...colors.values()].map((c) => (
        <button
          key={c.id}
          className={`api-chip${focusApi === c.id ? ' on' : ''}${focusApi && focusApi !== c.id ? ' off' : ''}`}
          style={{ ['--api' as any]: c.color }}
          onClick={() => onFocus(focusApi === c.id ? null : c.id)}
          title={`${c.node}:${c.op} — 클릭하면 이 API의 요청만 강조합니다`}
        >
          <i />
          <span className="mono">{multiNode ? `${c.node} ${c.op}` : c.op}</span>
          <small>{Math.round(((share.get(c.id) ?? 0) / total) * 100)}%</small>
        </button>
      ))}
    </Panel>
  );
}

/** Re-fit the view when the canvas area changes size (banner rows, window resize, panel layout). */
function AutoFit() {
  const { fitView } = useReactFlow();
  const width = useStore((s) => s.width);
  const height = useStore((s) => s.height);
  const first = useRef(true);
  useEffect(() => {
    if (first.current) {
      first.current = false;
      return;
    }
    const t = setTimeout(() => fitView({ padding: 0.12, maxZoom: 1.1, duration: 200 }), 60);
    return () => clearTimeout(t);
  }, [width, height, fitView]);
  return null;
}

// ---------------------------------------------------------------------------

interface CanvasProps {
  doc: RawDoc;
  layout: Layout;
  result: SimResult | null;
  warnings: Warning[];
  sec: number;
  layer: Layer;
  selection: Selection;
  bottleneck: string | null;
  focus?: string;
  onSelect: (s: Selection) => void;
  onMove: (name: string, pos: [number, number]) => void;
  onConnect: (from: string, to: string) => void;
  onDelete: (s: Selection) => void;
}

export function ArchitectureCanvas(p: CanvasProps) {
  const { doc, layout, result, sec, layer } = p;
  const b = Math.max(0, Math.min((result?.buckets ?? 1) - 1, sec));
  const warnTargets = useMemo(() => new Set(p.warnings.filter((w) => w.level !== 'info').map((w) => w.target)), [p.warnings]);

  const nodes = useMemo<Node[]>(() => {
    const out: Node[] = [];
    const names = Object.keys(doc.nodes ?? {});
    const entries = Object.keys(doc.scenario?.traffic?.mix ?? {});
    // client block left of the leftmost entry service
    const xs = names.map((n) => layout[n]?.[0] ?? 0);
    const ys = names.map((n) => layout[n]?.[1] ?? 0);
    const rps = result ? result.series.arrivals[b] : 0;
    out.push({
      id: '__client',
      type: 'client',
      position: { x: Math.min(...xs, 80) - 230, y: ys.length ? (Math.min(...ys) + Math.max(...ys)) / 2 : 120 },
      data: { name: 'client', kind: 'client', instances: 1, cluster: '', waiting: 0, sat: 0, gauges: [], note: result ? `${num(rps)} rps · ${entries.length}개 API` : '', warn: false, bottleneck: false, focus: false },
      draggable: false,
      selectable: false,
      connectable: false,
      deletable: false,
    } as Node<BlockData>);

    for (const name of names) {
      const raw = doc.nodes[name] ?? {};
      const kind = nodeKind(raw);
      const nr = result?.nodes.find((n) => n.name === name);
      const res = result?.resources.filter((r) => r.node === name && !r.edge) ?? [];
      const pools = result?.resources.filter((r) => r.node === name && r.edge) ?? [];
      const g = (kindKey: string) => res.find((r) => r.kind === kindKey);
      // several members (replicas, shards): show the busiest
      const busiest = (kindKey: string) => res.filter((r) => r.kind === kindKey).sort((x, y) => y.util[b] - x.util[b])[0];
      const gauges: Gauge[] = [];
      let note = '';
      let waiting = 0;
      for (const r of res) if (r.kind !== 'fd' && r.kind !== 'ports' && r.kind !== 'backlog') waiting += r.queue[b] ?? 0;
      for (const r of pools) waiting += r.queue[b] ?? 0;
      if (nr?.queue) waiting = nr.queue.depth[b] ?? 0;
      if (result && nr) {
        if (layer === 'app') {
          if (nr.queue) {
            const q = nr.queue;
            const cons = g('consumers');
            if (cons) gauges.push({ label: '컨슈머', value: cons.util[b], text: pct(cons.util[b], 0) });
            if (q.maxPartitionLag) gauges.push({ label: '최대 파티션', value: Math.min(1, (q.maxPartitionLag[b] ?? 0) / Math.max(1, q.depth[b] ?? 1)), text: `lag ${num(q.maxPartitionLag[b] ?? 0)}` });
            note = `발행 ${num(q.published[b] ?? 0)}/s · 처리 ${num(q.acked[b] ?? 0)}/s${q.idleConsumers?.[b] ? ` · 노는 컨슈머 ${q.idleConsumers[b]}` : ''}`;
          }
          const main = g('threads') ?? g('loop') ?? busiest('db') ?? busiest('store') ?? busiest('cache') ?? g('external');
          if (nr.store) {
            const st = nr.store;
            const refused = (st.throttled[b] ?? 0) + (st.rejected[b] ?? 0) + (st.unavailable[b] ?? 0);
            if (refused > 0) note = `거절 ${num(refused)}/s${st.throttled[b] ? ' · 스로틀링' : st.rejected[b] ? ' · 큐 가득' : ' · 복제본 부족'}`;
          }
          if (main) {
            gauges.push({
              label: main.kind === 'threads' ? '스레드' : main.kind === 'loop' ? '이벤트 루프' : main.kind === 'db' ? '동시 쿼리' : main.kind === 'store' ? '노드 처리' : main.kind === 'cache' ? '처리' : '동시 처리',
              value: main.util[b],
              text: pct(main.util[b], 0),
            });
          }
          for (const pool of pools.filter((x) => x.kind === 'pool' || x.kind === 'bulkhead')) {
            const to = pool.edge!.split('->')[1];
            const q = pool.queue[b];
            gauges.push({ label: `${pool.kind === 'pool' ? '풀' : 'BH'}→${to}`, value: pool.util[b], text: `${pct(pool.util[b], 0)}${q >= 1 ? ` · 대기 ${num(q)}` : ''}` });
          }
          if (!nr.queue && !note) note = `${num(nr.served[b])} 요청/s${nr.os && nr.os.healthy[b] < nr.instances ? ` · 정상 ${nr.os.healthy[b]}/${nr.instances}대` : ''}`;
        } else if (layer === 'os') {
          if (nr.os) {
            gauges.push({ label: 'CPU', value: nr.os.cpu[b], text: pct(nr.os.cpu[b], 0) });
            const gcFrac = nr.os.gcPauseMs[b] / (result.bucketMs || 1000);
            gauges.push({ label: 'GC 정지', value: Math.min(1, gcFrac * 10), text: `${ms(nr.os.gcPauseMs[b])}/s` });
            const bl = g('backlog');
            gauges.push({ label: 'backlog', value: bl ? bl.util[b] : 0, text: `${num(nr.os.backlog[b])}${nr.os.synDrops[b] ? ` · SYN 드롭 ${nr.os.synDrops[b]}` : ''}` });
          } else {
            const main = g('db') ?? g('cache') ?? g('external');
            if (main) gauges.push({ label: '사용률', value: main.util[b], text: pct(main.util[b], 0) });
            note = 'OS 계층은 서비스 노드만 모델링';
          }
        } else {
          note = kind === 'service' ? `${raw.instances ?? 1}대 · ${num(nr.served[b])} 요청/s` : `${num(nr.served[b])} 요청/s`;
        }
      }
      out.push({
        id: name,
        type: 'block',
        position: { x: layout[name]?.[0] ?? 0, y: layout[name]?.[1] ?? 0 },
        selected: p.selection?.type === 'node' && p.selection.id === name,
        data: {
          name,
          kind,
          instances: Number(raw.instances ?? 1),
          cluster: clusterLabel(raw),
          waiting,
          sat: nr ? nr.saturation[b] : 0,
          gauges,
          note,
          warn: warnTargets.has(name),
          bottleneck: p.bottleneck === name,
          focus: p.focus === name,
        },
      } as Node<BlockData>);
    }
    return out;
  }, [doc, layout, result, b, layer, p.selection, p.bottleneck, p.focus, warnTargets]);

  const edges = useMemo<Edge[]>(() => {
    const out: Edge[] = [];
    const keys = new Set<string>(Object.keys(doc.edges ?? {}).map((k) => k.split('->').map((s) => s.trim()).join('->')));
    for (const e of result?.edges ?? []) keys.add(e.key);
    for (const k of Object.keys(doc.scenario?.traffic?.mix ?? {})) {
      const svc = k.includes(':') ? k.split(':')[0] : Object.keys(doc.nodes ?? {}).find((n) => doc.nodes[n]?.endpoints?.[k]);
      if (svc) keys.add(`client->${svc}`);
    }
    for (const [qname, q] of Object.entries<any>(doc.nodes ?? {})) {
      if (q?.kind !== 'queue' || !q.consumer) continue;
      const svc = q.consumer.service ?? String(q.consumer.endpoint ?? '').split(':')[0];
      if (!doc.nodes[svc]) continue;
      const nr = result?.nodes.find((n) => n.name === qname);
      out.push({
        id: `__consume:${qname}`,
        source: qname,
        target: svc,
        type: 'link',
        selectable: false,
        data: { label: nr?.queue ? `소비 ${num(nr.queue.acked[b] ?? 0)}/s` : '소비', badges: [], width: 1.5, tone: 'idle', warn: false, dashed: true },
      } as Edge<LinkData>);
    }
    for (const key of keys) {
      const [from, to] = key.split('->');
      if (!doc.nodes?.[to] || (from !== 'client' && !doc.nodes?.[from])) continue;
      const raw = doc.edges?.[key] ?? {};
      const er = result?.edges.find((e) => e.key === key);
      const badges: LinkData['badges'] = [];
      let label = '';
      let tone: LinkData['tone'] = 'idle';
      let width = 1.5;
      const on = (o: any) => o !== undefined && o !== null && o !== false && o?.enabled !== false;
      if (er) {
        const att = er.series.attempts[b];
        const fail = er.series.failures[b];
        width = 1.2 + Math.min(6, Math.log10(1 + att) * 1.8);
        tone = att === 0 ? 'idle' : fail / Math.max(1, att) > 0.2 ? 'bad' : fail > 0 ? 'warn' : 'ok';
        if (layer === 'net') {
          const n = raw.network ?? {};
          const rtt = toMs(n.rtt, from === 'client' ? 2 : 0.5);
          const loss = toRatio(n.loss, 0);
          const parts = [`RTT ${ms(rtt)}`];
          if (loss > 0) parts.push(`손실 ${pct(loss)}`);
          if (n.keepAlive === false) parts.push('keep-alive 끔');
          if (raw.timeout) parts.push(`timeout ${raw.timeout}`);
          label = parts.join(' · ');
        } else if (from !== 'client') {
          label = `${num(att)}/s`;
          if (er.series.retries[b] > 0) badges.push({ text: `재시도 ${num(er.series.retries[b])}`, tone: 'warn' });
        }
        if (er.series.cbOpen[b] > 0.01) badges.push({ text: er.series.cbOpen[b] >= 0.99 ? 'OPEN' : `OPEN ${pct(er.series.cbOpen[b], 0)}`, tone: 'bad' });
        else if (er.series.cbHalfOpen[b] > 0.01) badges.push({ text: 'HALF_OPEN', tone: 'warn' });
      }
      if (layer === 'app' && from !== 'client') {
        if (on(raw.circuitBreaker) && !badges.some((x) => x.text.startsWith('OPEN') || x.text === 'HALF_OPEN')) badges.push({ text: 'CB', tone: 'ok' });
        if (on(raw.retry) && (raw.retry.max ?? raw.retry.maxAttempts ?? 3) > 1 && !badges.some((x) => x.text.startsWith('재시도')))
          badges.push({ text: `↻${raw.retry.max ?? raw.retry.maxAttempts ?? 3}`, tone: 'info' });
      }
      out.push({
        id: key,
        source: from === 'client' ? '__client' : from,
        target: to,
        type: 'link',
        selected: p.selection?.type === 'edge' && p.selection.id === key,
        selectable: from !== 'client',
        data: { label, badges, width, tone, warn: warnTargets.has(key) },
      } as Edge<LinkData>);
    }
    return out;
  }, [doc, result, b, layer, p.selection, warnTargets]);

  // Controlled nodes are rebuilt every render, so React Flow's measured sizes must be carried over;
  // a node without `measured` is treated as unmeasured and hidden (and its edges are not drawn).
  const [focusApi, setFocusApi] = useState<string | null>(null);
  const [sizes, setSizes] = useState<Record<string, { width: number; height: number }>>({});
  const measuredNodes = useMemo(() => nodes.map((n) => (sizes[n.id] ? { ...n, measured: sizes[n.id] } : n)), [nodes, sizes]);

  const onNodesChange = (changes: NodeChange[]) => {
    const dims: { id: string; width: number; height: number }[] = [];
    for (const c of changes) {
      if (c.type === 'position' && c.position && c.id !== '__client') p.onMove(c.id, [Math.round(c.position.x), Math.round(c.position.y)]);
      if (c.type === 'dimensions' && c.dimensions) dims.push({ id: c.id, ...c.dimensions });
    }
    if (dims.length) {
      setSizes((prev) => {
        let next: typeof prev | null = null;
        for (const d of dims) {
          const o = prev[d.id];
          if (o && o.width === d.width && o.height === d.height) continue;
          next ??= { ...prev };
          next[d.id] = { width: d.width, height: d.height };
        }
        return next ?? prev;
      });
    }
  };

  return (
    <ReactFlow
      nodes={measuredNodes}
      edges={edges}
      nodeTypes={nodeTypes}
      edgeTypes={edgeTypes}
      onNodesChange={onNodesChange}
      onNodeClick={(_, n) => n.id !== '__client' && p.onSelect({ type: 'node', id: n.id })}
      onEdgeClick={(_, e) => !e.id.startsWith('client->') && p.onSelect({ type: 'edge', id: e.id })}
      onPaneClick={() => p.onSelect(null)}
      onConnect={(c: Connection) => c.source && c.target && p.onConnect(c.source, c.target)}
      onNodesDelete={(ns) => ns.forEach((n) => p.onDelete({ type: 'node', id: n.id }))}
      onEdgesDelete={(es) => es.forEach((e) => p.onDelete({ type: 'edge', id: e.id }))}
      fitView
      fitViewOptions={{ padding: 0.12, maxZoom: 1.1 }}
      minZoom={0.2}
      maxZoom={2}
      proOptions={{ hideAttribution: true }}
      deleteKeyCode={['Delete', 'Backspace']}
    >
      <Background gap={24} size={1} />
      <Controls showInteractive={false} position="bottom-left" />
      <Particles result={result} names={result?.particles.nodes ?? []} focusApi={focusApi} />
      <ApiLegend result={result} focusApi={focusApi} onFocus={setFocusApi} />
      <AutoFit />
    </ReactFlow>
  );
}
