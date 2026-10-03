// Platform configuration → scenario: Kubernetes manifests, Istio traffic policy, Spring Cloud Gateway routes.
import { parseAllDocuments } from 'yaml';
import { fmtDuration, prop, slug, springDuration, type ImportReport } from './util';

const docs = (text: string): any[] =>
  parseAllDocuments(text)
    .map((d) => d.toJS())
    .flatMap((d) => (d?.kind === 'List' ? d.items ?? [] : [d]))
    .filter(Boolean);

/** "500m" → 0.5, "2" → 2 */
function cpu(v: unknown): number | undefined {
  if (v === undefined || v === null) return undefined;
  const s = String(v);
  return s.endsWith('m') ? Number(s.slice(0, -1)) / 1000 : Number(s);
}

/** "1Gi" / "768Mi" / "512M" → MB */
function mem(v: unknown): number | undefined {
  if (v === undefined || v === null) return undefined;
  const m = /^(\d+(?:\.\d+)?)(Ki|Mi|Gi|K|M|G)?$/.exec(String(v));
  if (!m) return undefined;
  const k: Record<string, number> = { Ki: 1 / 1024, Mi: 1, Gi: 1024, K: 1 / 1000, M: 1, G: 1000 };
  return Number(m[1]) * (k[m[2] ?? 'Mi'] ?? 1 / 1024 / 1024);
}

/**
 * Deployments / StatefulSets → service instances and OS limits:
 * replicas → instances, limits.cpu → cgroup cpuLimit (and vCPU), -Xmx or 75% of the memory limit → heap,
 * readinessProbe → load balancer health check, topology spread over zones → zones.
 */
export function importKubernetes(text: string, opts: { zones?: string[] } = {}): ImportReport {
  const notes: string[] = [];
  const nodes: Record<string, any> = {};
  let zonal = false;
  for (const d of docs(text)) {
    if (!['Deployment', 'StatefulSet'].includes(d.kind)) continue;
    const spec = d.spec ?? {};
    const pod = spec.template?.spec ?? {};
    const name = slug(d.metadata?.labels?.app ?? spec.selector?.matchLabels?.app ?? d.metadata?.name ?? 'service');
    const c = (pod.containers ?? [])[0] ?? {};
    const n: any = { kind: 'service', instances: Number(spec.replicas ?? 1), os: {} };
    const limit = cpu(c.resources?.limits?.cpu);
    const request = cpu(c.resources?.requests?.cpu);
    if (limit) {
      n.os.cpuLimit = limit;
      n.os.vcpu = Math.max(1, Math.ceil(limit));
    } else if (request) n.os.vcpu = Math.max(1, Math.ceil(request));
    const env = Object.fromEntries((c.env ?? []).map((e: any) => [e.name, e.value]));
    const javaOpts = String(env.JAVA_TOOL_OPTIONS ?? env.JAVA_OPTS ?? env.JDK_JAVA_OPTIONS ?? '');
    const xmx = /-Xmx(\d+)([mMgG])/.exec(javaOpts);
    const memLimit = mem(c.resources?.limits?.memory);
    if (xmx) n.os.heap = `${xmx[1]}${xmx[2].toLowerCase()}`;
    else if (memLimit) n.os.heap = `${Math.round(memLimit * 0.75)}m`;
    if (/UseZGC/.test(javaOpts)) n.os.gc = 'zgc';
    else if (/UseParallelGC/.test(javaOpts)) n.os.gc = 'parallel';
    const rp = c.readinessProbe;
    if (rp) n.healthCheck = { interval: `${rp.periodSeconds ?? 10}s`, threshold: rp.failureThreshold ?? 3, riseThreshold: rp.successThreshold ?? 1 };
    const spreads = (pod.topologySpreadConstraints ?? []).some((t: any) => t.topologyKey === 'topology.kubernetes.io/zone');
    const pinned = pod.nodeSelector?.['topology.kubernetes.io/zone'];
    if (pinned) {
      n.zones = [String(pinned)];
      zonal = true;
    } else if (spreads) zonal = true;
    nodes[name] = n;
    notes.push(`${d.kind} ${d.metadata?.name}: 인스턴스 ${n.instances}${limit ? `, CPU limit ${limit}` : ''}${n.os.heap ? `, 힙 ${n.os.heap}` : ''}${rp ? `, readiness ${rp.periodSeconds ?? 10}s×${rp.failureThreshold ?? 3}` : ', readinessProbe 없음'}${pinned ? `, 존 ${pinned} 고정` : ''}`);
  }
  const doc: any = { nodes };
  if (zonal) {
    doc.topology = { zones: opts.zones ?? ['a', 'b', 'c'] };
    notes.push(`존 분산 설정을 찾았습니다. 존 이름(${doc.topology.zones.join(', ')})을 실제 클러스터에 맞게 고치세요.`);
  }
  if (!Object.keys(nodes).length) notes.push('Deployment/StatefulSet을 찾지 못했습니다.');
  return { doc, notes };
}

/** Istio VirtualService / DestinationRule → mesh retries, timeout, outlier detection and connection pool limits. */
export function importIstio(text: string): ImportReport {
  const notes: string[] = [];
  const mesh: any = {};
  for (const d of docs(text)) {
    if (d.kind === 'VirtualService') {
      for (const h of d.spec?.http ?? []) {
        if (h.retries && !mesh.retries) {
          const on = String(h.retries.retryOn ?? '5xx,connect-failure').split(',');
          mesh.retries = {
            attempts: Number(h.retries.attempts ?? 2),
            ...(h.retries.perTryTimeout ? { perTryTimeout: fmtDuration(springDuration(h.retries.perTryTimeout)!) } : {}),
            on: [...new Set(on.flatMap((x) => (/5xx|gateway-error|retriable/.test(x) ? ['error'] : /connect|reset|refused/.test(x) ? ['conn'] : /timeout/.test(x) ? ['timeout'] : [])))],
          };
        }
        if (h.timeout && !mesh.timeout) mesh.timeout = fmtDuration(springDuration(h.timeout)!);
      }
      notes.push(`VirtualService ${d.metadata?.name}: 재시도·timeout을 메시 전체 설정으로 가져왔습니다.`);
    }
    if (d.kind === 'DestinationRule') {
      const tp = d.spec?.trafficPolicy ?? {};
      const od = tp.outlierDetection;
      if (od)
        mesh.outlierDetection = {
          consecutiveErrors: od.consecutive5xxErrors ?? od.consecutiveGatewayErrors ?? od.consecutiveErrors ?? 5,
          baseEjectionTime: fmtDuration(springDuration(od.baseEjectionTime ?? '30s')!),
          maxEjectionPercent: od.maxEjectionPercent ?? 10,
        };
      const http = tp.connectionPool?.http;
      if (http?.http2MaxRequests || http?.http1MaxPendingRequests) mesh.connectionPool = { maxRequests: http.http2MaxRequests ?? http.http1MaxPendingRequests };
      notes.push(`DestinationRule ${d.metadata?.name}: outlier detection·connection pool을 가져왔습니다.`);
    }
  }
  if (!Object.keys(mesh).length) notes.push('VirtualService/DestinationRule을 찾지 못했습니다.');
  else notes.push('Istio 설정은 서비스마다 다를 수 있지만 메시 전체 기본값으로 가져왔습니다. 특정 연결선만 다르면 edges.<a->b>.mesh로 조정하세요.');
  return { doc: Object.keys(mesh).length ? { mesh } : {}, notes };
}

/** Spring Cloud Gateway routes (inside an application.yml) → gateway node. Returns null if there are no routes. */
export function importGatewayRoutes(cfg: any, name: string): { node: any; notes: string[] } | null {
  const routes = prop(cfg, 'spring.cloud.gateway.server.webflux.routes') ?? prop(cfg, 'spring.cloud.gateway.routes');
  if (!Array.isArray(routes) || !routes.length) return null;
  const notes: string[] = [];
  const out: Record<string, any> = {};
  for (const r of routes) {
    const uri = String(r.uri ?? '');
    const target = slug(uri.replace(/^lb:\/\//, '').replace(/^https?:\/\//, '').split(/[:/]/)[0] || r.id);
    const preds = (r.predicates ?? []).map((p: any) => (typeof p === 'string' ? p : `${p.name}=${Object.values(p.args ?? {}).join(',')}`));
    const path = preds.find((p: string) => p.startsWith('Path='))?.slice(5).split(',')[0] ?? '/**';
    const method = preds.find((p: string) => p.startsWith('Method='))?.slice(7).split(',')[0];
    const route: any = { to: target };
    for (const f of r.filters ?? []) {
      const fname = typeof f === 'string' ? f.split('=')[0] : f.name;
      const args = typeof f === 'string' ? f.split('=')[1] : f.args;
      if (fname === 'Retry') route.retry = { max: Number(typeof args === 'string' ? args : args?.retries ?? 3) + 1, wait: '50ms', jitter: true };
      if (fname === 'CircuitBreaker') route.circuitBreaker = { failureRate: 50, window: 100, openFor: '60s' };
      if (fname === 'RequestRateLimiter') {
        const rate = args?.['redis-rate-limiter.replenishRate'] ?? args?.['redis-rate-limiter']?.replenishRate ?? args?.redisRateLimiter?.replenishRate;
        if (rate) route.rateLimit = `${rate}rps`;
      }
    }
    out[method ? `${method} ${path}` : path] = route;
  }
  notes.push(`Spring Cloud Gateway 라우트 ${routes.length}개를 가져왔습니다. 대상 서비스의 API가 가져와지면 경로 패턴에 맞는 API로 펼쳐집니다.`);
  return { node: { kind: 'gateway', routes: out }, notes };
}
