// Combine import results into one scenario document. Later sources win, with one rule on top:
// an API seen in traces is "observed"; one only found in source code / OpenAPI keeps a default profile marked unobserved.
import { parseModel, type RawDoc } from '../parse';
import { deepMerge, type ImportReport } from './util';

const PRIORITY: Record<string, number> = { manual: 0, 'spring-source': 1, openapi: 1, prometheus: 2, trace: 3 };

export function mergeImports(reports: ImportReport[], base: RawDoc = {}): { doc: RawDoc; notes: string[]; error?: string } {
  const notes = reports.flatMap((r) => r.notes);
  let doc: RawDoc = structuredClone(base);
  for (const r of reports) {
    const patch = structuredClone(r.doc) as RawDoc;
    // endpoints: merge per endpoint with source priority
    for (const [name, node] of Object.entries<any>(patch.nodes ?? {})) {
      const existing = doc.nodes?.[name];
      if (!existing?.endpoints || !node?.endpoints) continue;
      for (const [ep, spec] of Object.entries<any>(node.endpoints)) {
        const cur = existing.endpoints[ep];
        if (!cur) continue;
        const pNew = PRIORITY[spec.source ?? 'manual'] ?? 0;
        const pOld = PRIORITY[cur.source ?? 'manual'] ?? 0;
        if (pNew < pOld) {
          // keep the better-sourced profile; only fill fields it lacks
          node.endpoints[ep] = deepMerge(spec, cur);
        } else if (spec.calls === undefined && cur.calls) spec.calls = cur.calls;
      }
    }
    doc = deepMerge(doc, patch);
  }

  // Kubernetes says "service", a gateway config says "gateway": the more specific kind wins
  for (const r of reports) for (const [name, n] of Object.entries<any>(r.doc.nodes ?? {})) if (n?.kind === 'gateway' && doc.nodes?.[name]) doc.nodes[name].kind = 'gateway';
  for (const [name, node] of Object.entries<any>(doc.nodes ?? {})) {
    if (node.kind === 'gateway') {
      delete node.endpoints;
      continue;
    }
    if (node.kind && node.kind !== 'service') continue;
    for (const [epName, ep] of Object.entries<any>(node.endpoints ?? {})) {
      // traced APIs are observed even if source analysis saw them first
      if (ep.source === 'trace') ep.observed = true;
      // Prometheus latency is end-to-end; usable as self time only for leaf APIs
      const lat = ep['x-observedLatency'];
      if (lat) {
        if ((!ep.calls || !ep.calls.length) && ep.source !== 'trace') {
          ep.selfTime = lat.p50 ? { p50: lat.p50, p99: lat.p99 } : lat.mean;
          ep.observed = true;
          ep.source = 'prometheus';
        }
        delete ep['x-observedLatency'];
      }
      if (!ep.selfTime) {
        ep.selfTime = { p50: '5ms', p99: '25ms' };
        ep.observed = false;
        notes.push(`${name} ${epName}: 처리 시간 정보가 없어 기본값(추정)을 썼습니다.`);
      }
    }
    // HikariCP pool sizes seen in metrics → this service's DB connection(s)
    const pools = node['x-hikariPools'];
    if (pools) {
      doc.edges ??= {};
      const dbEdges = Object.keys(doc.edges).filter((k) => k.startsWith(`${name}->`) && doc.nodes[k.split('->')[1]]?.kind === 'db');
      const dbTargets = Object.entries<any>(doc.nodes).filter(([, n]) => n.kind === 'db').map(([k]) => k);
      for (const [pool, size] of Object.entries<any>(pools)) {
        const byName = dbTargets.find((d) => d === pool || d.startsWith(pool.toLowerCase()));
        const key = byName ? `${name}->${byName}` : dbEdges.length === 1 ? dbEdges[0] : null;
        if (key) {
          doc.edges[key] = { ...(doc.edges[key] ?? {}), pool: { ...(doc.edges[key]?.pool ?? {}), size } };
          notes.push(`HikariCP 풀 "${pool}"(${size}개)을 ${key}에 적용했습니다.`);
        } else notes.push(`HikariCP 풀 "${pool}"(${size}개)이 어느 DB인지 알 수 없어 적용하지 않았습니다. edges.${name}->DB이름.pool.size로 직접 넣으세요.`);
      }
      delete node['x-hikariPools'];
    }
    // RabbitMQ listener settings → the queues this service consumes
    const rl = node['x-rabbitListener'];
    if (rl) {
      for (const q of Object.values<any>(doc.nodes))
        if (q.kind === 'queue' && q.broker !== 'kafka' && q.consumer?.service === name) q.consumer = { ...q.consumer, ...rl };
      delete node['x-rabbitListener'];
    }
    const kl = node['x-kafkaListener'];
    if (kl) {
      for (const q of Object.values<any>(doc.nodes)) {
        if (q.kind !== 'queue' || q.broker !== 'kafka' || q.consumer?.service !== name) continue;
        const { rebalanceTime, ...rest } = kl;
        q.consumer = { ...q.consumer, ...rest };
        if (rebalanceTime) q.kafka = { ...(q.kafka ?? {}), rebalanceTime };
      }
      delete node['x-kafkaListener'];
    }
  }

  // a service with no known API yet (only configuration was imported) gets a placeholder so the model runs
  for (const [name, node] of Object.entries<any>(doc.nodes ?? {})) {
    if ((node.kind ?? 'service') !== 'service' || Object.keys(node.endpoints ?? {}).length) continue;
    if (node.kind === 'gateway') continue;
    node.endpoints = { 'GET /': { selfTime: { p50: '5ms', p99: '25ms' }, observed: false, source: 'placeholder' } };
    notes.push(`${name}: API를 찾지 못해 자리표시 API "GET /"를 넣었습니다. 소스 폴더·OpenAPI·트레이스를 함께 가져오면 실제 API로 바뀝니다.`);
  }
  // edges from configuration (Resilience4j / Feign instance names) may point at services not imported yet
  for (const key of Object.keys(doc.edges ?? {})) {
    const to = key.split('->')[1]?.trim();
    if (to && !doc.nodes?.[to]) {
      doc.nodes[to] = { kind: 'external' };
      notes.push(`설정에 나온 호출 대상 "${to}"를 외부 API로 추가했습니다. 같은 시스템의 서비스라면 그 서비스도 가져오세요.`);
    }
  }
  // every call target must exist as a node
  for (const node of Object.values<any>(doc.nodes ?? {})) {
    for (const ep of Object.values<any>(node.endpoints ?? {})) {
      const visit = (c: any) => {
        const s = typeof c === 'string' ? c : String(c?.call ?? '');
        const target = s.slice(0, s.indexOf(':')).trim();
        if (target && !doc.nodes[target]) {
          doc.nodes[target] = { kind: 'external' };
          notes.push(`호출 대상 "${target}"의 정의가 없어 외부 API로 추가했습니다.`);
        }
        (c?.onMiss ?? []).forEach(visit);
        (c?.parallel ?? []).forEach(visit);
      };
      (ep.calls ?? []).forEach(visit);
    }
  }
  // drop mix entries that point to unknown APIs
  const mix = doc.scenario?.traffic?.mix;
  if (mix) {
    for (const k of Object.keys(mix)) {
      const [svc, ...rest] = k.split(':');
      const api = rest.join(':');
      const ok = api ? doc.nodes?.[svc]?.endpoints?.[api] : Object.values<any>(doc.nodes ?? {}).some((n) => n.endpoints?.[k]);
      if (!ok) {
        delete mix[k];
        notes.push(`트래픽 믹스의 "${k}"에 해당하는 API가 없어 뺐습니다.`);
      }
    }
  }
  try {
    parseModel(doc);
    return { doc, notes };
  } catch (e) {
    return { doc, notes, error: (e as Error).message };
  }
}
