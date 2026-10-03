// Recommendation engine: diagnose where a run went wrong, propose fixes for that specific problem,
// simulate every proposal on the same scenario and seed, and rank them by measured improvement.
//
//   diagnose()  → findings: what broke, where it started (first resource to saturate), how it spread
//   propose()   → candidate patches tied to findings (resilience, capacity, configuration, architecture)
//   advise()    → evaluate candidates, then build a step-by-step plan by applying the best and re-diagnosing
import { checkModel } from './check';
import { parseModel, CLIENT, type RawDoc } from './parse';
import { getPath, setPath, type RawPath } from './rawpath';
import { simulate } from './simulate';
import type { EdgeSpec, Model, ResourceKind, ResourceSeries, SimResult, StoreSpec, Warning } from './types';
import { fmtMs } from './units';

export interface PatchOp {
  path: RawPath;
  value: unknown;
}

export interface Finding {
  code: string;
  severity: 'critical' | 'major' | 'minor';
  title: string;
  detail: string;
  /** node name or edge key */
  target?: string;
  /** ms into the run when it became visible */
  at?: number;
}

export interface Candidate {
  id: string;
  title: string;
  /** why this addresses the diagnosed problem */
  why: string;
  category: 'resilience' | 'capacity' | 'config' | 'architecture';
  target?: string;
  patch: PatchOp[];
  /** what it costs: infrastructure, degraded responses, engineering work */
  tradeoff: string;
  /** penalty in badness units so cheap fixes win ties */
  cost: number;
  /** finding codes this candidate answers */
  answers: string[];
}

export interface Metrics {
  badness: number;
  sloPass: boolean;
  errorRate: number;
  p99: number;
  throughput: number;
  /** worst queue backlog in messages (0 without queues) */
  maxBacklog: number;
}

export interface Recommendation extends Candidate {
  before: Metrics;
  after: Metrics;
  /** (badness before − after − cost); higher is better */
  score: number;
  /** fraction of the badness removed */
  improvement: number;
}

export interface Advice {
  baseline: Metrics;
  findings: Finding[];
  recommendations: Recommendation[];
  /** cumulative plan: apply in order */
  plan: { step: Recommendation; after: Metrics }[];
  evaluated: number;
}

// ---------------------------------------------------------------------------
// Scoring

/** How far the run is from its SLOs (0 = all SLOs met and queues keep up). */
export function metricsOf(r: SimResult): Metrics {
  let badness = 0;
  const entries = r.endpoints.filter((e) => e.entry && e.slo && e.count > 0);
  const total = entries.reduce((a, e) => a + e.count, 0) || 1;
  for (const e of entries) {
    const w = Math.max(0.15, e.count / total);
    // a fallback answer is far better than an error but is not the real response: count it as a tenth of a failure
    const degraded = e.count ? e.degraded / e.count : 0; // weighted 0.1 below
    badness += w * (Math.max(0, Math.log(e.p99 / e.slo!.p99)) + 30 * Math.max(0, e.errorRate + 0.1 * degraded - e.slo!.errorRate));
  }
  let maxBacklog = 0;
  for (const n of r.nodes) {
    if (!n.queue) continue;
    const pubRate = n.queue.published.reduce((a, b) => a + b, 0) / Math.max(1, r.buckets);
    const peak = Math.max(...n.queue.depth);
    maxBacklog = Math.max(maxBacklog, peak);
    const lagSec = peak / Math.max(1, pubRate);
    const endSec = n.queue.depth[n.queue.depth.length - 1] / Math.max(1, pubRate);
    badness += 0.4 * Math.max(0, Math.log1p(lagSec) - Math.log1p(3)) + 0.4 * Math.max(0, Math.log1p(endSec) - Math.log1p(1));
  }
  // tie-breaker: lower overall tail latency is better even when SLOs pass
  badness += 0.01 * Math.log(Math.max(1, r.summary.p99));
  return { badness, sloPass: r.summary.sloPass, errorRate: r.summary.errorRate, p99: r.summary.p99, throughput: r.summary.throughput, maxBacklog };
}

// ---------------------------------------------------------------------------
// Diagnosis

const PRIORITY: Partial<Record<ResourceKind, number>> = { cpu: 0, loop: 0, db: 1, store: 1, pool: 2, cache: 3, external: 4, consumers: 4, bulkhead: 5, threads: 7, backlog: 8 };
const KIND_KO: Partial<Record<ResourceKind, string>> = {
  cpu: 'CPU',
  loop: '이벤트 루프',
  db: 'DB 동시 쿼리',
  store: 'NoSQL·검색 노드 동시 처리',
  pool: '커넥션풀',
  cache: '캐시 처리',
  external: '외부 API 동시 처리',
  consumers: '큐 컨슈머',
  bulkhead: 'Bulkhead',
  threads: '워커 스레드',
  backlog: '커널 backlog',
  async: '@Async 풀',
  fd: '파일 디스크립터',
  ports: '임시 포트',
};

export function resourceName(r: ResourceSeries): string {
  const k = KIND_KO[r.kind] ?? r.kind;
  if (r.edge) return `${r.edge.replace('->', '→')} ${k}`;
  return `${r.node}${r.member ? ` ${r.member}` : ''} ${k}`;
}

/** first bucket (after warmup) where the resource is saturated with waiters for two consecutive buckets */
function onset(r: ResourceSeries, from: number): number {
  const sat = (b: number) =>
    r.kind === 'backlog' ? r.util[b] > 0.05 : r.kind === 'db' ? r.util[b] >= 1 : r.util[b] >= 0.95 && (r.queue[b] >= 1 || r.kind === 'consumers');
  for (let b = from; b + 1 < r.util.length; b++) if (sat(b) && sat(b + 1)) return b;
  return -1;
}

export function diagnose(model: Model, r: SimResult, warnings: Warning[] = checkModel(model)): Finding[] {
  const out: Finding[] = [];
  const bms = r.bucketMs;
  const from = Math.floor(r.window[0] / bms);
  const faults = model.scenario.faults;

  // 1. SLO violations per entry API
  for (const e of r.endpoints) {
    if (!e.entry || !e.slo || e.slo.pass) continue;
    const parts = [];
    if (!e.slo.p99Ok) parts.push(`p99 ${fmtMs(e.p99)} (목표 ${fmtMs(e.slo.p99)})`);
    if (!e.slo.errorOk) parts.push(`에러율 ${(e.errorRate * 100).toFixed(2)}% (목표 ${(e.slo.errorRate * 100).toFixed(2)}%)`);
    out.push({ code: 'slo', severity: 'critical', title: `${e.op} SLO 위반`, detail: parts.join(', '), target: e.node });
  }

  // 2. saturation chain: which resource saturated first, and what followed
  const chain = r.resources
    .map((x) => ({ x, b: onset(x, from) }))
    .filter((c) => c.b >= 0 && c.x.kind !== 'fd' && c.x.kind !== 'ports')
    .sort((a, b) => a.b - b.b || (PRIORITY[a.x.kind] ?? 9) - (PRIORITY[b.x.kind] ?? 9));
  if (chain.length) {
    const root = chain[0];
    const fault = faults.filter((f) => f.at <= (root.b + 1) * bms).sort((a, b) => b.at - a.at)[0];
    const steps = chain.slice(0, 5).map((c) => `${resourceName(c.x)}(${(c.b * bms) / 1000 + 1}s)`);
    out.push({
      code: 'saturation-chain',
      severity: chain.length > 1 ? 'critical' : 'major',
      title: `${resourceName(root.x)}가 가장 먼저 포화`,
      detail:
        (fault ? `장애(${fault.target}${fault.latencyX !== 1 ? ` 지연 ×${fault.latencyX}` : ''}${fault.errorRate ? ` 오류 ${(fault.errorRate * 100).toFixed(0)}%` : ''}${fault.down ? ' 단절' : ''}, ${fault.at / 1000}s) 이후 ` : '') +
        `포화 전파: ${steps.join(' → ')}`,
      target: root.x.edge ?? root.x.node,
      at: root.b * bms,
    });

    // 3. synchronous cascade: a caller's threads saturate after something it calls saturated
    for (const c of chain) {
      if (c.x.kind !== 'threads') continue;
      const caller = c.x.node;
      for (const e of Object.values(model.edges)) {
        if (e.from !== caller || model.nodes[e.to].kind !== 'service') continue;
        const down = chain.find((d) => d.b <= c.b && d.x !== c.x && (d.x.node === e.to || d.x.edge?.startsWith(`${e.to}->`)));
        if (!down) continue;
        out.push({
          code: 'cascade',
          severity: 'critical',
          title: `${e.to}의 지연이 ${caller}까지 번짐`,
          detail: `${caller}의 워커 스레드가 ${e.to} 응답을 기다리느라 고갈되었습니다(${(c.b * bms) / 1000 + 1}s). timeout ${fmtMs(e.timeout)}, 서킷브레이커 ${e.circuitBreaker ? '있음' : '없음'}.`,
          target: e.key,
          at: c.b * bms,
        });
      }
    }
  }

  // 4. failure causes
  const causes = r.summary.errorCauses.slice(0, 3);
  if (causes.length) {
    out.push({
      code: 'error-causes',
      severity: 'major',
      title: '실패의 기원',
      detail: causes.map((c) => `${c.cause} ${c.count.toLocaleString()}건`).join(', '),
      target: causes[0].cause.split(' ')[0],
    });
  }

  // 5. signatures
  for (const e of r.edges) {
    if (e.from === CLIENT || e.calls === 0) continue;
    if (e.retries > 0.2 * e.calls || e.amplification > 1.5 * (e.calls / Math.max(1, r.summary.roots))) {
      out.push({ code: 'retry-storm', severity: 'major', title: `${e.key} 재시도 폭증`, detail: `호출 ${e.calls.toLocaleString()}회에 재시도 ${e.retries.toLocaleString()}회 (진입 요청당 ${e.amplification.toFixed(1)}회 시도)`, target: e.key });
    }
  }
  for (const n of r.nodes) {
    const spec = model.nodes[n.name];
    if (n.cache && spec.kind === 'cache') {
      const misses = n.cache.misses.slice(from);
      const sorted = [...misses].sort((a, b) => a - b);
      const median = sorted[Math.floor(sorted.length / 2)] || 0;
      const peak = Math.max(...misses);
      if (peak > Math.max(50, 8 * median)) {
        out.push({ code: 'stampede', severity: 'major', title: `${n.name} 캐시 스탬피드`, detail: `미스가 평소 ${median}/s에서 ${peak}/s로 한꺼번에 몰렸습니다(${misses.indexOf(peak) + from + 1}s). 동시에 만료된 항목이 원본으로 몰립니다.`, target: n.name, at: (misses.indexOf(peak) + from) * bms });
      }
    }
    if (n.os) {
      const gc = n.os.gcPauseMs.slice(from);
      const maxGc = Math.max(...gc);
      if (maxGc > 80) out.push({ code: 'gc', severity: 'major', title: `${n.name} GC 정지`, detail: `초당 GC 정지 최대 ${fmtMs(maxGc)} — 정지 동안 모든 요청이 멈춥니다.`, target: n.name });
      const syn = n.os.synDrops.reduce((a, b) => a + b, 0);
      if (syn > 0) out.push({ code: 'syn-drop', severity: 'major', title: `${n.name} SYN 드롭`, detail: `listen backlog가 가득 차 SYN ${syn.toLocaleString()}개가 버려졌고, 클라이언트는 1초 이상 재전송을 기다렸습니다.`, target: n.name });
      const thr = n.os.throttledMs.reduce((a, b) => a + b, 0);
      if (thr > 0) out.push({ code: 'throttle', severity: 'major', title: `${n.name} CPU 쓰로틀링`, detail: `cgroup CPU limit 때문에 총 ${fmtMs(thr)} 동안 정지했습니다.`, target: n.name });
    }
    if (n.queue && spec.kind === 'queue') {
      const q = n.queue;
      const peak = Math.max(...q.depth);
      const pub = q.published.reduce((a, b) => a + b, 0) / Math.max(1, r.buckets);
      if (peak > 3 * pub && peak > 100) {
        const end = q.depth[q.depth.length - 1];
        out.push({
          code: 'queue-backlog',
          severity: end > pub ? 'critical' : 'major',
          title: `${n.name} 적체`,
          detail: `최대 ${Math.round(peak).toLocaleString()}건 쌓였고 끝날 때 ${Math.round(end).toLocaleString()}건 남았습니다(발행 ${pub.toFixed(0)}/s). 가장 오래된 메시지 ${fmtMs(Math.max(...q.oldestAgeMs))}.`,
          target: n.name,
        });
      }
      if (spec.kafka) {
        if (q.idleConsumers && Math.max(...q.idleConsumers) > 0)
          out.push({ code: 'kafka-idle', severity: 'minor', title: `${n.name} 노는 컨슈머`, detail: `파티션 ${spec.kafka.partitions}개보다 컨슈머 스레드가 많아 ${Math.max(...q.idleConsumers)}개가 일을 받지 못합니다.`, target: n.name });
        if (q.maxPartitionLag && peak > 100 && Math.max(...q.maxPartitionLag) > 0.5 * peak)
          out.push({ code: 'kafka-hot', severity: 'major', title: `${n.name} 핫 파티션`, detail: `lag의 대부분이 파티션 하나에 몰려 있습니다. 그 파티션을 맡은 컨슈머 하나가 처리량 상한입니다.`, target: n.name });
        if (q.redelivered.reduce((a, b) => a + b, 0) > 0 && spec.kafka.onError === 'retry')
          out.push({ code: 'kafka-blocking', severity: 'major', title: `${n.name} 블로킹 재시도`, detail: `실패한 레코드를 제자리에서 재시도하는 동안 그 파티션 전체가 멈췄습니다.`, target: n.name });
        if ((q.rebalanceMs ?? []).some((x) => x > 0)) out.push({ code: 'kafka-rebalance', severity: 'minor', title: `${n.name} 리밸런스 정지`, detail: `컨슈머 그룹 리밸런스 동안 소비가 멈췄습니다.`, target: n.name });
      }
    }
  }
  for (const c of r.summary.errorCauses) {
    if (/EMFILE/.test(c.cause)) out.push({ code: 'fd', severity: 'major', title: '파일 디스크립터 고갈', detail: c.cause, target: c.cause.split('#')[0].split(' ')[0] });
    if (/EADDRNOTAVAIL/.test(c.cause)) out.push({ code: 'ports', severity: 'major', title: '임시 포트 고갈', detail: c.cause, target: c.cause.split('#')[0].split(' ')[0] });
    if (/ 429$/.test(c.cause)) out.push({ code: '429', severity: 'major', title: '외부 API rate limit', detail: c.cause, target: c.cause.split(' ')[0] });
  }
  // a dead / hung instance keeps receiving traffic
  for (const f of faults) {
    const n = model.nodes[f.target];
    if (!f.down || f.instance === null || n?.kind !== 'service') continue;
    const hc = n.healthCheck;
    out.push({
      code: 'instance-down',
      severity: 'major',
      title: `${f.target}#${f.instance + 1} 장애 동안 트래픽 유입`,
      detail: hc ? `헬스체크가 ${fmtMs(hc.interval * hc.threshold)} 뒤에야 제외합니다.` : '헬스체크가 없어 로드밸런서가 죽은 인스턴스로 계속 보냅니다.',
      target: f.target,
    });
  }
  // WebSocket: synchronized reconnects and lasting imbalance
  const ws = model.scenario.websocket;
  const wsNode = ws ? r.nodes.find((n) => n.name === ws.service)?.ws : undefined;
  if (ws && wsNode) {
    const drops = wsNode.drops.reduce((a, b) => a + b, 0);
    const peakConnects = Math.max(...wsNode.connects.slice(Math.floor(r.window[0] / bms)));
    if (drops > 0 && ws.reconnect.jitter < 0.3) {
      out.push({
        code: 'ws-reconnect-storm',
        severity: 'critical',
        title: '재연결 폭풍',
        detail: `끊긴 연결 ${drops.toLocaleString()}개가 jitter 없이 ${fmtMs(ws.reconnect.delay)} 뒤 한꺼번에 재연결했습니다(초당 최대 ${peakConnects.toLocaleString()}건 핸드셰이크). 실패한 클라이언트도 같은 박자로 다시 시도합니다.`,
        target: ws.service,
      });
    }
    const last = wsNode.maxPerInstance.length - 1;
    const max = wsNode.maxPerInstance[last];
    const min = wsNode.minPerInstance[last];
    if (max > 100 && max > 2 * min) {
      out.push({
        code: 'ws-imbalance',
        severity: 'minor',
        title: '연결 불균형',
        detail: `인스턴스별 연결 수가 ${min.toLocaleString()} ~ ${max.toLocaleString()}로 어긋나 있습니다. 기존 연결은 옮겨 가지 않으므로, 복구된 인스턴스는 놀고 나머지가 부하를 떠안습니다. 연결 최대 수명(서버가 주기적으로 정상 종료해 재분배)을 두는 방법이 있습니다.`,
        target: ws.service,
      });
    }
  }
  // a whole zone went down
  for (const f of faults) {
    if (!f.down || f.zone === null) continue;
    const hit = Object.entries(model.placement)
      .filter(([, z]) => z.length === 1 && z[0] === f.zone)
      .map(([n]) => n);
    out.push({
      code: 'zone-outage',
      severity: hit.length ? 'critical' : 'major',
      title: `존 ${f.zone} 장애`,
      detail: hit.length ? `${hit.join(', ')}가 존 ${f.zone}에만 있어 함께 멈췄습니다.` : `존 ${f.zone}의 멤버가 모두 멈췄습니다.`,
      target: hit[0],
    });
  }
  // DB shards: one hot shard
  for (const n of Object.values(model.nodes)) {
    if (n.kind !== 'db' || n.cluster.shards < 2) continue;
    const per = 1 + n.cluster.replicas;
    const prim = r.resources.filter((x) => x.node === n.name && x.kind === 'db' && x.member?.endsWith('primary'));
    const loads = prim.map((x) => x.util.reduce((a, b) => a + b, 0));
    if (loads.length === n.cluster.shards && Math.max(...loads) > 3 * Math.max(1e-9, Math.min(...loads)) && Math.max(...prim.map((x) => Math.max(...x.util))) > 0.8)
      out.push({ code: 'db-hot-shard', severity: 'major', title: `${n.name} 핫 샤드`, detail: `샤드 키가 치우쳐 한 샤드(${per > 1 ? 'primary' : ''})에 부하가 몰립니다.`, target: n.name });
  }
  // partitioned stores: throttling, rejections, unmet consistency
  for (const n of Object.values(model.nodes)) {
    if (n.kind !== 'nosql') continue;
    const st = r.nodes.find((x) => x.name === n.name)?.store;
    if (!st) continue;
    const tot = (a: number[]) => a.reduce((x, y) => x + y, 0);
    const throttled = tot(st.throttled);
    const rejected = tot(st.rejected);
    const unavailable = tot(st.unavailable);
    const hot = st.hottestPartitionShare;
    if (throttled > 0)
      out.push({
        code: 'store-throttle',
        severity: 'critical',
        title: n.engine === 's3' ? `${n.name} prefix 요청 한도 초과 (503 SlowDown)` : `${n.name} 파티션 처리량 한도 초과 (스로틀링)`,
        detail:
          n.partitions > 1 && hot > 1.5 / n.partitions
            ? `요청 ${throttled.toLocaleString()}건이 거절됐습니다. 가장 뜨거운 파티션이 전체 요청의 ${Math.round(hot * 100)}%를 받습니다 (고르게 나뉘면 ${Math.round(100 / n.partitions)}%). 전체 용량이 아니라 키가 문제입니다.`
            : `요청 ${throttled.toLocaleString()}건이 거절됐습니다. 파티션당 한도(읽기 ${n.partitionRate.read}/s, 쓰기 ${n.partitionRate.write}/s)를 넘었습니다.`,
        target: n.name,
      });
    if (rejected > 0)
      out.push({
        code: 'store-rejected',
        severity: 'critical',
        title: n.engine === 'elasticsearch' ? `${n.name} 검색 큐 포화 (429)` : `${n.name} 노드 과부하 거절`,
        detail: `노드의 처리 슬롯(${n.concurrency})과 대기열(${n.queue})이 가득 차 ${rejected.toLocaleString()}건을 거절했습니다.${n.engine === 'elasticsearch' ? ' 검색 하나가 샤드 수만큼 작업을 만듭니다.' : ''}`,
        target: n.name,
      });
    if (unavailable > 0)
      out.push({
        code: 'store-unavailable',
        severity: 'critical',
        title: `${n.name} 복제본 부족으로 요청 실패`,
        detail: `${unavailable.toLocaleString()}건이 primary 선출을 기다리거나 일관성 수준을 채울 복제본이 모자라 실패했습니다.`,
        target: n.name,
      });
  }
  // packet loss on a path that matters
  for (const e of Object.values(model.edges)) {
    const fl = faults.find((f) => f.target === e.key && f.loss > 0);
    if (e.network.loss > 0 || fl) out.push({ code: 'loss', severity: 'major', title: `${e.key} 패킷 손실`, detail: `손실 ${(((fl?.loss ?? 0) || e.network.loss) * 100).toFixed(1)}%: 꼬리 손실은 최소 RTO ${fmtMs(e.network.rtoMin)}를 기다립니다.`, target: e.key });
  }
  for (const w of warnings) if (w.level !== 'info') out.push({ code: `static:${w.code}`, severity: 'minor', title: '설정 경고', detail: w.message, target: w.target });

  const order = { critical: 0, major: 1, minor: 2 };
  return out.sort((a, b) => order[a.severity] - order[b.severity]);
}

// ---------------------------------------------------------------------------
// Candidates

function edgeKey(doc: RawDoc, key: string): string {
  for (const k of Object.keys(doc.edges ?? {})) if (k.replace(/\s+/g, '') === key) return k;
  return key;
}

function rawObj(doc: RawDoc, path: RawPath): Record<string, any> {
  const v = getPath(doc, path);
  return v && typeof v === 'object' ? { ...v } : {};
}

export function propose(doc: RawDoc, model: Model, r: SimResult, findings: Finding[]): Candidate[] {
  const out = new Map<string, Candidate>();
  const add = (c: Candidate) => {
    const prev = out.get(c.id);
    if (prev) prev.answers = [...new Set([...prev.answers, ...c.answers])];
    else out.set(c.id, c);
  };
  const ep = (k: string): RawPath => ['edges', edgeKey(doc, k)];
  const bottlenecks = r.resources.filter((x) => onset(x, Math.floor(r.window[0] / r.bucketMs)) >= 0);
  const svc = (name: string) => (model.nodes[name]?.kind === 'service' ? (model.nodes[name] as any) : null);

  const storeScale = (n: StoreSpec, code: string) => {
    if (n.placement === 'group') {
      add({
        id: `store-shards:${n.name}`,
        title: `${n.name} 샤드 ${n.partitions} → ${n.partitions * 2}개`,
        why: '샤드의 primary가 포화되었습니다. 샤드를 늘려 쓰기와 데이터를 나눕니다.',
        category: 'architecture',
        target: n.name,
        patch: [{ path: ['nodes', n.name, 'partitions'], value: n.partitions * 2 }],
        tradeoff: '샤드마다 복제 세트가 필요해 노드가 늘고, 청크 이동(balancer)이 일어납니다.',
        cost: 0.06,
        answers: [code],
      });
      return;
    }
    if (n.engine === 'dynamodb' || n.engine === 's3') return;
    add({
      id: `store-scale:${n.name}`,
      title: `${n.name} 노드 ${n.nodes} → ${n.nodes * 2}대`,
      why: n.engine === 'elasticsearch' ? '검색 스레드풀이 포화되었습니다. 데이터 노드를 늘려 샤드 작업을 나눕니다.' : '노드의 요청 처리 슬롯이 포화되었습니다. 노드를 늘려 토큰 범위를 나눕니다.',
      category: 'capacity',
      target: n.name,
      patch: [{ path: ['nodes', n.name, 'nodes'], value: n.nodes * 2 }],
      tradeoff: '노드 비용 증가, 데이터 재분배(스트리밍·샤드 재배치) 동안 부하',
      cost: 0.05,
      answers: [code],
    });
  };

  const breaker = (e: EdgeSpec, code: string) => {
    const cbOn = !!e.circuitBreaker;
    // a DB call has no meaningful substitute answer: fail fast instead of faking success
    const toDb = model.nodes[e.to]?.kind === 'db';
    const timeout = !Number.isFinite(e.timeout) ? 2000 : e.timeout > 1000 ? Math.max(500, Math.round(e.timeout / 3)) : e.timeout;
    const slow = Math.max(200, Math.min(1000, timeout / 2));
    const patch: PatchOp[] = [];
    if (!cbOn)
      patch.push({
        path: [...ep(e.key), 'circuitBreaker'],
        value: { ...rawObj(doc, [...ep(e.key), 'circuitBreaker']), enabled: true, failureRate: 50, slowCall: `${slow}ms`, slowCallRate: 50, window: 50, minCalls: 20, openFor: '10s', halfOpenCalls: 5 },
      });
    if (!e.fallback && !toDb) patch.push({ path: [...ep(e.key), 'fallback'], value: { latency: '2ms' } });
    if (timeout !== e.timeout) patch.push({ path: [...ep(e.key), 'timeout'], value: `${timeout}ms` });
    if (!patch.length) return;
    const parts = [!cbOn ? '서킷브레이커' : '', !e.fallback && !toDb ? 'fallback' : '', timeout !== e.timeout ? `timeout ${fmtMs(timeout)}` : ''].filter(Boolean);
    add({
      id: `cb:${e.key}`,
      title: `${e.from}→${e.to}에 ${parts.join(' + ')}`,
      why: `${e.to}가 느려지거나 실패하면 호출을 빨리 끊어 ${e.from}의 스레드를 지킵니다.`,
      category: 'resilience',
      target: e.key,
      patch,
      tradeoff: toDb ? 'OPEN 동안 해당 쿼리를 쓰는 요청은 즉시 실패합니다.' : 'OPEN 동안 fallback(대체 응답)으로 응답합니다. 기능이 일부 저하됩니다.',
      cost: 0.02,
      answers: [code],
    });
  };

  for (const f of findings) {
    switch (f.code) {
      case 'cascade': {
        const e = model.edges[f.target!];
        if (!e) break;
        breaker(e, f.code);
        const caller = svc(e.from);
        if (caller && !e.bulkhead)
          add({
            id: `bulkhead:${e.key}`,
            title: `${e.from}→${e.to}에 Bulkhead`,
            why: `${e.to} 호출이 ${e.from} 스레드의 일부만 쓰게 묶어 다른 API를 지킵니다.`,
            category: 'resilience',
            target: e.key,
            patch: [{ path: [...ep(e.key), 'bulkhead'], value: { maxConcurrent: Math.max(5, Math.round(caller.threads * 0.25)), maxWait: '0ms' } }],
            tradeoff: '한도를 넘는 호출은 즉시 거절됩니다.',
            cost: 0.02,
            answers: [f.code],
          });
        if (Number.isFinite(e.timeout) && e.timeout > 1000)
          add({
            id: `timeout:${e.key}`,
            title: `${e.from}→${e.to} timeout ${fmtMs(e.timeout)} → ${fmtMs(Math.max(300, e.timeout / 3))}`,
            why: '느린 하위를 기다리며 스레드를 붙잡는 시간을 줄입니다.',
            category: 'config',
            target: e.key,
            patch: [{ path: [...ep(e.key), 'timeout'], value: `${Math.round(Math.max(300, e.timeout / 3))}ms` }],
            tradeoff: '정상적으로 느린 요청도 실패할 수 있습니다.',
            cost: 0.01,
            answers: [f.code],
          });
        break;
      }
      case 'saturation-chain':
      case 'slo': {
        for (const b of bottlenecks) {
          const node = model.nodes[b.node];
          // event loops / carrier threads saturate when the CPU work on them does: same remedy
          if ((b.kind === 'cpu' || b.kind === 'loop') && node?.kind === 'service' && !out.has(`scale:${b.node}`)) {
            const cpuRes = r.resources.find((x) => x.node === b.node && x.kind === 'cpu');
            const peak = Math.max(...(cpuRes ?? b).util, ...b.util.map((u) => Math.min(u, 1.2)));
            let next = Math.min(40, Math.max(node.instances + 1, Math.ceil((node.instances * peak) / 0.6)));
            // with zone-aware routing, uneven instances per zone leave some instances idle and overload others
            const zones = model.placement[b.node]?.length ?? 0;
            if (model.topology?.zoneAware && zones > 1) next = Math.ceil(next / zones) * zones;
            add({
              id: `scale:${b.node}`,
              title: `${b.node} 인스턴스 ${node.instances} → ${next}대`,
              why: `CPU가 포화(최대 ${(peak * 100).toFixed(0)}%)되어 요청이 CPU를 기다립니다. 사용률 60% 목표로 늘립니다.`,
              category: 'capacity',
              target: b.node,
              patch: [{ path: ['nodes', b.node, 'instances'], value: next }],
              tradeoff: `인스턴스 ${next - node.instances}대 추가 비용`,
              cost: 0.015 * (next - node.instances),
              answers: [f.code],
            });
          }
          if (b.kind === 'pool' && b.edge) {
            const e = model.edges[b.edge];
            const dbNode = model.nodes[e.to];
            const dbSat = r.resources.filter((x) => x.node === e.to && x.kind === 'db').some((x) => Math.max(...x.util) >= 1);
            if (e.pool && !dbSat) {
              const size = Math.min(200, e.pool.size * 2);
              add({
                id: `pool:${e.key}`,
                title: `${e.from}→${e.to} 커넥션풀 ${e.pool.size} → ${size}`,
                why: `DB는 여유가 있는데 커넥션풀이 가득 차 요청이 풀 대기에서 막힙니다.`,
                category: 'config',
                target: e.key,
                patch: [{ path: [...ep(e.key), 'pool', 'size'], value: size }],
                tradeoff: 'DB 연결 수가 늘어납니다(max_connections 확인).',
                cost: 0.005,
                answers: [f.code],
              });
            }
            if (dbNode?.kind === 'db') {
              // a slow DB behind the pool: fail fast at the caller instead of queueing
              breaker(model.edges[`${e.from}->${e.to}`] ?? e, f.code);
            }
          }
          if (b.kind === 'db' && node?.kind === 'db') {
            const writes = Object.values(node.queries).filter((q) => !q.read).length;
            if (writes > 0)
              add({
                id: `shard:${b.node}`,
                title: `${b.node} 샤딩 ${node.cluster.shards} → ${node.cluster.shards * 2}개`,
                why: '쓰기가 primary 하나에 몰려 포화되었습니다. 레플리카는 쓰기를 나눠 받지 못하므로 키로 데이터를 나눕니다.',
                category: 'architecture',
                target: b.node,
                patch: [{ path: ['nodes', b.node, 'cluster'], value: { ...rawObj(doc, ['nodes', b.node, 'cluster']), shards: node.cluster.shards * 2 } }],
                tradeoff: 'DB 추가 비용, 샤드 키 설계와 샤드를 넘는 쿼리(scatter-gather)의 지연, 재배치 작업이 필요합니다.',
                cost: 0.07,
                answers: [f.code],
              });
            const reads = Object.values(node.queries).filter((q) => q.read).length;
            if (reads > 0 && node.cluster.replicas === 0)
              add({
                id: `replicas:${b.node}`,
                title: `${b.node}에 읽기 레플리카 2대 + 읽기 분산`,
                why: 'DB 동시 쿼리가 포화되었고 읽기 쿼리가 있습니다. 읽기를 레플리카로 보냅니다.',
                category: 'architecture',
                target: b.node,
                patch: [{ path: ['nodes', b.node, 'cluster'], value: { ...rawObj(doc, ['nodes', b.node, 'cluster']), replicas: 2, readSplit: true } }],
                tradeoff: 'DB 2대 추가, 복제 지연으로 읽기가 약간 오래된 값을 볼 수 있습니다.',
                cost: 0.06,
                answers: [f.code],
              });
            add({
              id: `dbup:${b.node}`,
              title: `${b.node} 사양 상향 (동시 처리 2배)`,
              why: 'DB 동시 쿼리가 포화점을 넘었습니다.',
              category: 'capacity',
              target: b.node,
              patch: [{ path: ['nodes', b.node, 'contention', 'saturation'], value: node.contention.saturation * 2 }],
              tradeoff: 'DB 인스턴스 비용 증가',
              cost: 0.05,
              answers: [f.code],
            });
          }
          if (b.kind === 'store' && node?.kind === 'nosql') storeScale(node, f.code);
          // pure load problem (no injected fault): offload cacheable reads to the edge
          if ((b.kind === 'cpu' || b.kind === 'loop' || b.kind === 'db') && !model.scenario.faults.length && !Object.values(model.nodes).some((n) => n.kind === 'service' && n.role === 'cdn')) {
            const mix = model.scenario.mix;
            const total = mix.reduce((a, m) => a + m.weight, 0) || 1;
            const gets = mix.filter((m) => /^(GET|HEAD)\s/i.test(m.ref.op));
            const share = gets.reduce((a, m) => a + m.weight, 0) / total;
            const origin = mix[0]?.ref.node;
            if (share >= 0.6 && origin && !out.has('cdn'))
              add({
                id: 'cdn',
                title: `${origin} 앞에 CDN (GET 응답 캐시, 적중률 80% 가정)`,
                why: `요청의 ${Math.round(share * 100)}%가 GET입니다. 캐시할 수 있는 응답을 엣지에서 돌려주면 오리진과 그 뒤 전체의 부하가 줄어듭니다.`,
                category: 'architecture',
                target: origin,
                patch: [{ path: ['nodes', 'cdn'], value: { kind: 'cdn', origin, hitRate: '80%' } }],
                tradeoff: '개인화·실시간 응답은 캐시할 수 없고, 캐시 무효화(purge)와 TTL 설계가 필요합니다. 적중률은 실제 트래픽으로 확인하세요.',
                // the hit rate is an assumption, not a measurement: rank it after equally effective, verified changes
                cost: 0.15,
                answers: [f.code],
              });
          }
          if (b.kind === 'threads' && node?.kind === 'service') {
            const cpu = r.resources.find((x) => x.node === b.node && x.kind === 'cpu');
            if (cpu && Math.max(...cpu.util) < 0.7)
              add({
                id: `threads:${b.node}`,
                title: `${b.node} 워커 스레드 ${node.threads} → ${Math.min(1000, node.threads * 2)}`,
                why: 'CPU는 남는데 스레드가 하위 응답을 기다리며 모두 묶였습니다.',
                category: 'config',
                target: b.node,
                patch: [{ path: ['nodes', b.node, 'runtime', 'threads'], value: Math.min(1000, node.threads * 2) }],
                tradeoff: '메모리 사용과 하위 시스템으로 가는 동시 요청이 늘어납니다.',
                cost: 0.005,
                answers: [f.code],
              });
          }
          if (b.kind === 'cache' && node?.kind === 'cache')
            add({
              id: `shards:${b.node}`,
              title: `${b.node} Redis Cluster 샤드 ${node.cluster.shards} → ${node.cluster.shards * 3}`,
              why: '단일 명령 스레드가 포화되었습니다. 키를 샤드로 나눕니다.',
              category: 'architecture',
              target: b.node,
              patch: [{ path: ['nodes', b.node, 'cluster'], value: { ...rawObj(doc, ['nodes', b.node, 'cluster']), shards: node.cluster.shards * 3, replicas: Math.max(1, node.cluster.replicas) } }],
              tradeoff: '노드 추가, 멀티키 명령 제약',
              cost: 0.04,
              answers: [f.code],
            });
          if (b.kind === 'backlog' && node?.kind === 'service')
            add({
              id: `backlog:${b.node}`,
              title: `${b.node} accept 대기열 확대`,
              why: '커널 backlog가 차서 연결이 드롭됩니다.',
              category: 'config',
              target: b.node,
              patch: [
                { path: ['nodes', b.node, 'runtime', 'maxConnections'], value: 8192 },
                { path: ['nodes', b.node, 'runtime', 'acceptCount'], value: 1024 },
                { path: ['nodes', b.node, 'os', 'somaxconn'], value: 4096 },
              ],
              tradeoff: '과부하 시 실패 대신 대기가 늘어납니다.',
              cost: 0.005,
              answers: [f.code],
            });
        }
        break;
      }
      case 'retry-storm':
      case 'static:retry-amplification':
      case 'static:retry-no-jitter': {
        // keep retries only at the outermost layer, with exponential backoff + jitter
        const withRetry = Object.values(model.edges).filter((e) => e.retry && e.retry.maxAttempts > 1);
        if (!withRetry.length) break;
        const depth = (n: string): number => (Object.values(model.edges).some((e) => e.from === CLIENT && e.to === n) ? 0 : 1 + Math.min(9, ...Object.values(model.edges).filter((e) => e.to === n && e.from !== CLIENT).map((e) => depth(e.from))));
        const sorted = [...withRetry].sort((a, b) => depth(a.from) - depth(b.from));
        const top = sorted[0];
        const patch: PatchOp[] = sorted.slice(1).map((e) => ({ path: [...ep(e.key), 'retry', 'enabled'], value: false }));
        patch.push({ path: [...ep(top.key), 'retry', 'backoff'], value: 'exponential' }, { path: [...ep(top.key), 'retry', 'jitter'], value: true });
        add({
          id: 'retry-top-only',
          title: `재시도는 최상위(${top.key.replace('->', '→')}) 한 곳에만, 지수 백오프 + jitter`,
          why: '계층마다 재시도가 곱해져 장애 중 하위로 가는 요청이 불어나고, 동시에 재시도하는 파도가 생깁니다.',
          category: 'resilience',
          target: top.key,
          patch,
          tradeoff: '하위 계층의 일시적 실패는 최상위 재시도에 맡깁니다.',
          cost: 0.005,
          answers: [f.code],
        });
        break;
      }
      case 'stampede': {
        const c = model.nodes[f.target!];
        if (c?.kind !== 'cache') break;
        const patch: PatchOp[] = [];
        for (const [op, s] of Object.entries(c.ops)) {
          if (!Number.isFinite(s.ttl)) continue;
          patch.push({ path: ['nodes', c.name, 'ops', op, 'ttlJitter'], value: '30%' }, { path: ['nodes', c.name, 'ops', op, 'singleFlight'], value: true });
        }
        if (patch.length)
          add({
            id: `stampede:${c.name}`,
            title: `${c.name} TTL jitter 30% + 단일 갱신(lock)`,
            why: '같은 순간 만료되던 항목을 흩뜨리고, 같은 키는 한 요청만 원본을 다시 읽게 합니다.',
            category: 'config',
            target: c.name,
            patch,
            tradeoff: '갱신을 기다리는 요청은 잠깐 대기합니다.',
            cost: 0.005,
            answers: [f.code],
          });
        break;
      }
      case 'gc': {
        const s = svc(f.target!);
        if (!s) break;
        const heap = Math.min(8192, s.heapMb * 4);
        add({
          id: `gc:${s.name}`,
          title: `${s.name} 힙 ${Math.round(s.heapMb)}MB → ${heap >= 1024 ? `${heap / 1024}GB` : `${heap}MB`}${s.gc === 'g1' || s.gc === 'zgc' ? '' : ' + G1 GC'}`,
          why: '할당 속도에 비해 힙이 작아 GC가 잦고, 정지 동안 모든 요청이 멈춥니다.',
          category: 'config',
          target: s.name,
          patch: [
            { path: ['nodes', s.name, 'os', 'heap'], value: heap % 1024 === 0 ? `${heap / 1024}g` : `${heap}m` },
            ...(s.gc === 'g1' || s.gc === 'zgc' ? [] : [{ path: ['nodes', s.name, 'os', 'gc'], value: 'g1' }]),
          ],
          tradeoff: '컨테이너 메모리가 늘어납니다.',
          cost: 0.01,
          answers: [f.code],
        });
        add({
          id: `zgc:${s.name}`,
          title: `${s.name} ZGC로 전환`,
          why: 'ZGC는 정지 시간이 ms 이하입니다.',
          category: 'config',
          target: s.name,
          patch: [{ path: ['nodes', s.name, 'os', 'gc'], value: 'zgc' }],
          tradeoff: '처리량이 약간 줄고 메모리를 더 씁니다.',
          cost: 0.012,
          answers: [f.code],
        });
        break;
      }
      case 'syn-drop': {
        const s = svc(f.target!);
        if (!s) break;
        add({
          id: `backlog:${s.name}`,
          title: `${s.name} max-connections·accept-count·somaxconn 확대`,
          why: '버스트를 커널에서 버리지 않고 대기열로 흡수합니다(재전송 1초 대기 제거).',
          category: 'config',
          target: s.name,
          patch: [
            { path: ['nodes', s.name, 'runtime', 'maxConnections'], value: 8192 },
            { path: ['nodes', s.name, 'runtime', 'acceptCount'], value: 1024 },
            { path: ['nodes', s.name, 'os', 'somaxconn'], value: 4096 },
          ],
          tradeoff: '지속적 과부하에서는 실패 대신 대기가 길어집니다.',
          cost: 0.005,
          answers: [f.code],
        });
        break;
      }
      case 'throttle': {
        const s = svc(f.target!);
        if (!s) break;
        add({
          id: `cpulimit:${s.name}`,
          title: `${s.name} CPU limit ${s.cpuLimit} → ${s.vcpu} (vCPU와 같게)`,
          why: 'CFS 쿼터를 다 쓰면 다음 주기까지 프로세스 전체가 멈춥니다.',
          category: 'config',
          target: s.name,
          patch: [{ path: ['nodes', s.name, 'os', 'cpuLimit'], value: s.vcpu }],
          tradeoff: '노드 CPU를 더 할당합니다.',
          cost: 0.01,
          answers: [f.code],
        });
        break;
      }
      case 'loss': {
        const e = model.edges[f.target!];
        if (!e || e.from === CLIENT) break;
        const t = model.nodes[e.to];
        const base = t.kind === 'service' ? Object.values(t.endpoints)[0] : null;
        const p99 = base ? Math.exp((base.selfTime as any).mu ?? Math.log(10)) * 4 : 20;
        const timeout = Math.round(Math.min(e.network.rtoMin * 0.5, Math.max(30, p99 * 3)));
        add({
          id: `loss:${e.key}`,
          title: `${e.from}→${e.to} timeout ${timeout}ms + jitter 재시도`,
          why: `RTO(${fmtMs(e.network.rtoMin)})를 기다리는 대신 짧은 timeout 후 새로 요청합니다.`,
          category: 'resilience',
          target: e.key,
          patch: [
            { path: [...ep(e.key), 'timeout'], value: `${timeout}ms` },
            { path: [...ep(e.key), 'retry'], value: { max: 3, wait: '5ms', jitter: true, on: ['timeout'] } },
          ],
          tradeoff: '재시도만큼 하위 요청이 늘어납니다(멱등 요청에만).',
          cost: 0.01,
          answers: [f.code],
        });
        break;
      }
      case 'instance-down': {
        const s = svc(f.target!);
        if (!s) break;
        const patch: PatchOp[] = [{ path: ['nodes', s.name, 'healthCheck'], value: { interval: '2s', threshold: 2 } }];
        for (const e of Object.values(model.edges)) {
          if (e.to !== s.name || e.from === CLIENT) continue;
          patch.push({ path: [...ep(e.key), 'retry'], value: { max: 2, wait: '10ms', jitter: true, on: ['timeout', 'conn'] } });
          // bound how long a hung instance can hold a caller, without cutting off legitimately slow requests
          if (!Number.isFinite(e.timeout)) patch.push({ path: [...ep(e.key), 'timeout'], value: '2s' });
          else if (e.timeout > 3000) patch.push({ path: [...ep(e.key), 'timeout'], value: `${Math.round(e.timeout / 3)}ms` });
        }
        if (model.mesh && !model.mesh.outlier)
          add({
            id: 'mesh-outlier',
            title: '메시 outlier detection 켜기 (연속 오류 5회 → 30초 제외)',
            why: '헬스체크를 기다리지 않고, 오류를 내는 인스턴스를 호출 측 사이드카가 바로 뺍니다.',
            category: 'resilience',
            target: s.name,
            patch: [{ path: ['mesh', 'outlierDetection'], value: { consecutiveErrors: 5, baseEjectionTime: '30s', maxEjectionPercent: 50 } }],
            tradeoff: '일시적 오류에도 인스턴스가 빠질 수 있습니다.',
            cost: 0.005,
            answers: [f.code],
          });
        add({
          id: `health:${s.name}`,
          title: `${s.name} 헬스체크 2초×2회 + 호출 측 짧은 timeout·다른 인스턴스 재시도`,
          why: '죽은 인스턴스를 빨리 빼고, 그 사이 실패한 요청은 다른 인스턴스로 다시 보냅니다.',
          category: 'resilience',
          target: s.name,
          patch,
          tradeoff: '헬스체크 트래픽이 늘고 재시도만큼 요청이 늘어납니다.',
          cost: 0.01,
          answers: [f.code],
        });
        break;
      }
      case 'queue-backlog':
      case 'kafka-idle':
      case 'kafka-hot':
      case 'kafka-blocking': {
        const q = model.nodes[f.target!];
        if (q?.kind !== 'queue' || !q.consumer) break;
        const cons = model.nodes[q.consumer.service];
        const inst = cons?.kind === 'service' ? cons.instances : 1;
        if (q.kafka) {
          const threads = q.consumer.concurrency * inst;
          if (f.code === 'kafka-hot')
            add({
              id: `kafka-key:${q.name}`,
              title: `${q.name} 파티션 키 재설계 (핫 키 분산)`,
              why: '한 키에 몰린 메시지는 파티션을 늘려도 한 컨슈머가 처리합니다. 키에 접미사를 붙이거나 순서가 필요한 단위로 키를 다시 정합니다.',
              category: 'architecture',
              target: q.name,
              patch: [{ path: ['nodes', q.name, 'kafka', 'keySkew'], value: 0 }],
              tradeoff: '키 단위 순서 보장 범위가 바뀝니다. 애플리케이션 변경이 필요합니다.',
              cost: 0.05,
              answers: [f.code],
            });
          if (f.code === 'kafka-blocking')
            add({
              id: `kafka-dlt:${q.name}`,
              title: `${q.name} 실패 레코드는 2회만 재시도하고 DLT로`,
              why: '제자리 재시도가 파티션 전체를 막습니다. 빨리 DLT로 넘기고(또는 @RetryableTopic) 뒤의 레코드를 처리합니다.',
              category: 'resilience',
              target: q.name,
              patch: [
                { path: ['nodes', q.name, 'consumer', 'maxRetries'], value: 2 },
                { path: ['nodes', q.name, 'consumer', 'dlq'], value: true },
              ],
              tradeoff: '일시적 실패도 DLT로 갈 수 있어 재처리 절차가 필요합니다.',
              cost: 0.01,
              answers: [f.code],
            });
          const parts = Math.max(q.kafka.partitions * 2, threads);
          add({
            id: `kafka-scale:${q.name}`,
            title: `${q.name} 파티션 ${q.kafka.partitions} → ${parts}${threads < parts ? `, 컨슈머 동시성 → ${Math.ceil(parts / inst)}` : ''}`,
            why: 'Kafka 컨슈머 병렬도는 파티션 수가 상한입니다.',
            category: 'capacity',
            target: q.name,
            patch: [
              { path: ['nodes', q.name, 'kafka', 'partitions'], value: parts },
              ...(threads < parts ? [{ path: ['nodes', q.name, 'consumer', 'concurrency'], value: Math.ceil(parts / inst) }] : []),
            ],
            tradeoff: '파티션 증가는 되돌릴 수 없고, 키→파티션 매핑이 바뀌어 순서가 일시적으로 섞입니다.',
            cost: 0.01,
            answers: [f.code],
          });
        } else {
          add({
            id: `rabbit-scale:${q.name}`,
            title: `${q.name} 컨슈머 동시성 ${q.consumer.concurrency} → ${q.consumer.concurrency * 3}, prefetch ${q.consumer.prefetch} → ${Math.max(50, q.consumer.prefetch)}`,
            why: '리스너 스레드가 발행 속도를 겨우 따라가 장애 뒤 적체가 빠지지 않습니다. prefetch로 브로커 왕복도 줄입니다.',
            category: 'capacity',
            target: q.name,
            patch: [
              { path: ['nodes', q.name, 'consumer', 'concurrency'], value: q.consumer.concurrency * 3 },
              { path: ['nodes', q.name, 'consumer', 'prefetch'], value: Math.max(50, q.consumer.prefetch) },
            ],
            tradeoff: '컨슈머가 쓰는 DB·하위 시스템 부하가 늘어납니다.',
            cost: 0.01,
            answers: [f.code],
          });
        }
        if (cons?.kind === 'service')
          add({
            id: `scale:${cons.name}`,
            title: `${cons.name} 인스턴스 ${cons.instances} → ${cons.instances * 2}대`,
            why: '컨슈머 인스턴스를 늘려 처리 스레드를 늘립니다.',
            category: 'capacity',
            target: cons.name,
            patch: [{ path: ['nodes', cons.name, 'instances'], value: cons.instances * 2 }],
            tradeoff: `인스턴스 ${cons.instances}대 추가 비용`,
            cost: 0.015 * cons.instances,
            answers: [f.code],
          });
        break;
      }
      case 'db-hot-shard': {
        const n = model.nodes[f.target!];
        if (n?.kind !== 'db') break;
        add({
          id: `shard-key:${n.name}`,
          title: `${n.name} 샤드 키 재설계 (부하 분산)`,
          why: '샤드를 늘려도 같은 키는 같은 샤드로 갑니다. 카디널리티가 높은 키나 해시 접두를 써서 고르게 나눕니다.',
          category: 'architecture',
          target: n.name,
          patch: [{ path: ['nodes', n.name, 'cluster', 'keySkew'], value: 0 }],
          tradeoff: '데이터 재배치와 쿼리 변경이 필요합니다.',
          cost: 0.06,
          answers: [f.code],
        });
        break;
      }
      case 'zone-outage': {
        const zones = model.topology?.zones ?? [];
        if (zones.length < 2) break;
        // survive a zone: nothing may live in one zone only, and load balancers must notice dead members
        const patch: PatchOp[] = [];
        const spread: string[] = [];
        for (const [name, z] of Object.entries(model.placement)) {
          const node = model.nodes[name];
          if (z.length === 1) {
            spread.push(name);
            patch.push({ path: ['nodes', name, 'zones'], value: zones });
            if (node.kind === 'service' && node.instances < zones.length) patch.push({ path: ['nodes', name, 'instances'], value: zones.length });
            if (node.kind === 'db' && node.cluster.replicas === 0)
              patch.push({ path: ['nodes', name, 'cluster'], value: { ...rawObj(doc, ['nodes', name, 'cluster']), replicas: zones.length - 1, failoverTime: '15s' } });
          }
          if (node.kind === 'service' && node.instances > 1 && !node.healthCheck) patch.push({ path: ['nodes', name, 'healthCheck'], value: { interval: '2s', threshold: 2 } });
        }
        if (patch.length)
          add({
            id: 'zone-resilience',
            title: `존 장애 대비: ${spread.length ? `${spread.join(', ')}를 ${zones.join('·')}에 분산 + ` : ''}헬스체크`,
            why: '한 존에만 있는 노드는 그 존과 함께 멈추고, 헬스체크가 없으면 로드밸런서가 죽은 존의 인스턴스로 계속 보냅니다.',
            category: 'architecture',
            target: spread[0],
            patch,
            tradeoff: '존마다 인스턴스·레플리카가 필요해 비용이 늘고, 존 사이 호출 지연이 생깁니다.',
            cost: 0.03 + 0.02 * spread.length,
            answers: [f.code],
          });
        if (model.topology && !model.topology.zoneAware)
          add({
            id: 'zone-aware',
            title: '존 인지 라우팅 켜기',
            why: '같은 존의 정상 인스턴스를 우선해 존을 넘는 지연과 장애 존으로 가는 요청을 줄입니다.',
            category: 'config',
            patch: [{ path: ['topology', 'zoneAware'], value: true }],
            tradeoff: '존마다 인스턴스 수가 다르면 부하가 고르지 않을 수 있습니다.',
            cost: 0.005,
            answers: [f.code],
          });
        break;
      }
      case 'static:mesh-double-retry': {
        const e = model.edges[f.target!];
        if (e)
          add({
            id: `mesh-retry:${e.key}`,
            title: `${e.from}→${e.to} 앱 재시도 끄기 (메시 재시도만 사용)`,
            why: '앱과 메시가 각자 재시도해 시도가 곱해집니다.',
            category: 'config',
            target: e.key,
            patch: [{ path: [...ep(e.key), 'retry', 'enabled'], value: false }],
            tradeoff: '재시도 정책을 메시 설정에서 관리합니다.',
            cost: 0.003,
            answers: [f.code],
          });
        break;
      }
      case 'ws-reconnect-storm': {
        add({
          id: 'ws-backoff',
          title: '재연결에 지수 백오프 + full jitter (1s → 최대 30s)',
          why: '끊긴 클라이언트가 같은 순간 몰려오지 않게 흩뜨리고, 실패할수록 간격을 늘려 회복 중인 서버를 짓누르지 않게 합니다.',
          category: 'resilience',
          target: f.target,
          patch: [{ path: ['scenario', 'websocket', 'reconnect'], value: { delay: '1s', multiplier: 2, maxDelay: '30s', jitter: true } }],
          tradeoff: '일부 클라이언트는 다시 붙는 데 더 오래 걸립니다(클라이언트 앱 배포 필요).',
          cost: 0.01,
          answers: [f.code],
        });
        break;
      }
      case 'fd': {
        const s = svc(f.target!);
        if (s) add({ id: `ulimit:${s.name}`, title: `${s.name} ulimit -n 65535`, why: '열린 소켓 수가 한도에 닿아 연결을 받지 못합니다.', category: 'config', target: s.name, patch: [{ path: ['nodes', s.name, 'os', 'ulimit'], value: 65535 }], tradeoff: '없음', cost: 0.001, answers: [f.code] });
        break;
      }
      case 'ports':
      case 'static:no-keep-alive': {
        for (const e of Object.values(model.edges))
          if (!e.network.keepAlive && e.from !== CLIENT)
            add({ id: `keepalive:${e.key}`, title: `${e.from}→${e.to} keep-alive 켜기`, why: '호출마다 새 연결을 만들어 임시 포트가 TIME_WAIT로 고갈됩니다.', category: 'config', target: e.key, patch: [{ path: [...ep(e.key), 'network', 'keepAlive'], value: true }], tradeoff: '없음', cost: 0.001, answers: [f.code] });
        break;
      }
      case '429': {
        const target = f.target!;
        for (const e of Object.values(model.edges)) {
          if (e.to !== target) continue;
          const ext = model.nodes[target];
          if (ext?.kind !== 'external' || !Number.isFinite(ext.rateLimit)) continue;
          const callers = e.from === CLIENT ? 1 : svc(e.from)?.instances ?? 1;
          add({ id: `rl:${e.key}`, title: `${e.from}→${target} 클라이언트 측 rate limiter (${Math.floor((ext.rateLimit * 0.9) / callers)}/s/인스턴스)`, why: '상대의 rate limit을 넘겨 429를 받기 전에 우리 쪽에서 속도를 맞춥니다.', category: 'resilience', target: e.key, patch: [{ path: [...ep(e.key), 'rateLimiter'], value: { limit: Math.floor((ext.rateLimit * 0.9) / callers), period: '1s', timeout: '500ms' } }], tradeoff: '한도를 넘는 요청은 대기하거나 거절됩니다.', cost: 0.01, answers: [f.code] });
        }
        break;
      }
      case 'static:no-timeout': {
        const e = model.edges[f.target!];
        if (e) add({ id: `timeout-add:${e.key}`, title: `${e.from}→${e.to} timeout 2s`, why: '하위가 멈추면 스레드가 무한정 붙잡힙니다.', category: 'config', target: e.key, patch: [{ path: [...ep(e.key), 'timeout'], value: '2s' }], tradeoff: '2초를 넘는 정상 요청은 실패합니다.', cost: 0.002, answers: [f.code] });
        break;
      }
      case 'store-throttle': {
        const n = model.nodes[f.target!];
        if (n?.kind !== 'nosql') break;
        if (n.keySkew > 0.15)
          add({
            id: `store-key:${n.name}`,
            title: n.engine === 's3' ? `${n.name} 객체 키 앞부분을 해시로 분산` : `${n.name} 파티션 키 분산 (뜨거운 키에 suffix 샤딩)`,
            why: '요청이 한 파티션에 몰려 그 파티션의 한도만 넘었습니다. 키에 무작위 suffix를 붙이거나(write sharding) 키 설계를 바꿔 고르게 퍼뜨립니다.',
            category: 'architecture',
            target: n.name,
            patch: [{ path: ['nodes', n.name, 'keySkew'], value: 0.1 }],
            tradeoff: '같은 논리 키를 읽을 때 suffix 수만큼 나눠 읽고 합쳐야 합니다.',
            cost: 0.03,
            answers: [f.code],
          });
        add({
          id: `store-partitions:${n.name}`,
          title: n.engine === 's3' ? `${n.name} prefix ${n.partitions} → ${n.partitions * 4}개로 분산` : `${n.name} 파티션 ${n.partitions} → ${n.partitions * 4}개 (용량 증설·사전 분할)`,
          why: '파티션마다 처리량 한도가 있습니다. 파티션이 늘면 전체 한도가 늘어납니다.',
          category: 'capacity',
          target: n.name,
          patch: [{ path: ['nodes', n.name, n.engine === 's3' ? 'prefixes' : 'partitions'], value: n.partitions * 4 }],
          tradeoff: n.engine === 's3' ? '키 설계 변경이 필요합니다.' : '비용이 늘고, 뜨거운 키 하나는 여전히 한 파티션에 남습니다.',
          cost: 0.04,
          answers: [f.code],
        });
        break;
      }
      case 'store-rejected': {
        const n = model.nodes[f.target!];
        if (n?.kind === 'nosql') storeScale(n, f.code);
        break;
      }
      case 'store-unavailable': {
        const n = model.nodes[f.target!];
        if (n?.kind !== 'nosql') break;
        const ops = Object.values(n.ops).concat(n.defaultOp);
        const quorum = Math.floor(n.replication / 2) + 1;
        if (!n.leader && ops.some((o) => o.acks > quorum)) {
          const patchOps: PatchOp[] = [{ path: ['nodes', n.name, 'consistency'], value: { read: 'QUORUM', write: 'QUORUM' } }];
          for (const [k, o] of Object.entries(n.ops)) if (o.acks > quorum && getPath(doc, ['nodes', n.name, 'ops', k, 'consistency']) !== undefined) patchOps.push({ path: ['nodes', n.name, 'ops', k, 'consistency'], value: 'QUORUM' });
          add({
            id: `store-consistency:${n.name}`,
            title: `${n.name} 일관성 ALL → QUORUM`,
            why: 'ALL은 복제본 하나만 죽어도 실패합니다. QUORUM은 과반만 있으면 되고, 읽기·쓰기 모두 QUORUM이면 최신 값을 읽습니다.',
            category: 'config',
            target: n.name,
            patch: patchOps,
            tradeoff: '쓰기 직후 다른 복제본은 잠깐 뒤처질 수 있습니다(읽기도 QUORUM이면 안전).',
            cost: 0.005,
            answers: [f.code],
          });
        }
        // writes stall during a primary election: callers should retry instead of failing the request
        for (const e of Object.values(model.edges)) {
          if (e.to !== n.name || e.from === CLIENT || e.retry) continue;
          add({
            id: `store-retry:${e.key}`,
            title: `${e.from}→${n.name} 재시도 (retryWrites, 지수 백오프 최대 ${fmtMs(Math.max(2000, n.failoverTime))})`,
            why: 'primary 선출 동안의 쓰기 실패는 잠깐이면 풀립니다. 드라이버의 재시도로 사용자에게 실패를 넘기지 않습니다.',
            category: 'resilience',
            target: e.key,
            patch: [
              { path: [...ep(e.key), 'retry'], value: { max: 6, wait: '500ms', backoff: 'exponential', multiplier: 2, jitter: true, on: ['conn'] } },
            ],
            tradeoff: '선출 동안 해당 요청은 느려지고, 호출 측 스레드를 오래 붙잡습니다.',
            cost: 0.01,
            answers: [f.code],
          });
        }
        break;
      }
      case 'static:webflux-blocking': {
        for (const e of Object.values(model.edges))
          if (e.from === f.target && e.blocking)
            add({ id: `nonblocking:${e.key}`, title: `${e.from}→${e.to} 논블로킹 드라이버(R2DBC 등)로 전환`, why: '블로킹 호출이 이벤트 루프를 멈춥니다.', category: 'architecture', target: e.key, patch: [{ path: [...ep(e.key), 'blocking'], value: false }], tradeoff: '드라이버·코드 변경이 필요합니다.', cost: 0.04, answers: [f.code] });
        break;
      }
    }
  }
  return [...out.values()];
}

// ---------------------------------------------------------------------------
// Evaluation

export function applyPatch(doc: RawDoc, ops: PatchOp[]): RawDoc {
  return ops.reduce((d, op) => setPath(d, op.path, op.value), doc);
}

function run(doc: RawDoc): { model: Model; result: SimResult } {
  const model = parseModel(doc);
  return { model, result: simulate(model, model.scenario, model.scenario.seed, { particles: false }) };
}

export interface AdviseOptions {
  /** max candidates simulated per step (default 10) */
  maxCandidates?: number;
  /** plan length (default 3) */
  steps?: number;
  onProgress?: (done: number, total: number, label: string) => void;
}

export function advise(doc: RawDoc, opts: AdviseOptions = {}): Advice {
  const maxCandidates = opts.maxCandidates ?? 10;
  const steps = opts.steps ?? 3;
  let evaluated = 0;
  const base = run(doc);
  const baseline = metricsOf(base.result);
  const findings = diagnose(base.model, base.result);

  const evaluate = (d: RawDoc, m: Model, r: SimResult, f: Finding[], before: Metrics, stepLabel: string): Recommendation[] => {
    const cands = propose(d, m, r, f).slice(0, maxCandidates);
    const recs: Recommendation[] = [];
    cands.forEach((c, i) => {
      opts.onProgress?.(i, cands.length, `${stepLabel}${c.title}`);
      try {
        const after = metricsOf(run(applyPatch(d, c.patch)).result);
        evaluated++;
        const gain = before.badness - after.badness;
        recs.push({ ...c, before, after, score: gain - c.cost, improvement: before.badness > 0 ? gain / before.badness : 0 });
      } catch {
        // a candidate that produces an invalid model is simply dropped
      }
    });
    return recs.sort((a, b) => b.score - a.score);
  };

  const recommendations = evaluate(doc, base.model, base.result, findings, baseline, '');
  const plan: Advice['plan'] = [];
  let cur = doc;
  let curMetrics = baseline;
  let options = recommendations;
  const used = new Set<string>();
  for (let s = 0; s < steps; s++) {
    const best = options.find((r) => !used.has(r.id) && r.score > 0.01 && r.improvement > 0.05);
    if (!best) break;
    used.add(best.id);
    cur = applyPatch(cur, best.patch);
    const next = run(cur);
    curMetrics = metricsOf(next.result);
    plan.push({ step: { ...best, after: curMetrics }, after: curMetrics });
    if (curMetrics.badness < 0.05 || s === steps - 1) break;
    options = evaluate(cur, next.model, next.result, diagnose(next.model, next.result), curMetrics, `${s + 2}단계: `);
  }
  return { baseline, findings, recommendations, plan, evaluated };
}
