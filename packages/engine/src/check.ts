// Static checks on the call graph, run before simulating:
// timeout inversion, worst-case retry amplification, missing timeouts, synchronized retries, breaker pitfalls.

import { quantile } from './dist';
import { CLIENT } from './parse';
import type { CallSpec, EdgeSpec, Model, RetrySpec, ServiceSpec, Warning } from './types';
import { forEachCall } from './types';
import { fmtMs } from './units';

/** Worst-case time a caller can spend in one logical call across `edge` before giving up (ms). */
export function callBudget(edge: EdgeSpec): number {
  const attempts = edge.retry?.maxAttempts ?? 1;
  let total = 0;
  for (let n = 1; n <= attempts; n++) {
    total += edge.timeout;
    if (n < attempts && edge.retry) total += backoff(edge.retry, n) * (1 + edge.retry.jitter);
  }
  return total;
}

function backoff(r: RetrySpec, n: number): number {
  return Math.min(r.maxWait, r.backoff === 'exponential' ? r.wait * Math.pow(r.multiplier, n - 1) : r.wait);
}

export interface AmplificationPath {
  path: string[];
  factor: number;
}

/** Worst-case number of requests reaching each edge per entry request, following retries × repetitions. */
export function retryAmplification(model: Model): { byEdge: Record<string, AmplificationPath>; max: AmplificationPath | null } {
  const byEdge: Record<string, AmplificationPath> = {};
  const visit = (caller: string, calls: CallSpec[], factor: number, path: string[], depth: number) => {
    if (depth > 20) return;
    for (const c of calls) {
      if (c.parallel.length) visit(caller, c.parallel, factor, path, depth + 1);
      if (!c.target) continue;
      const edge = model.edges[`${caller}->${c.target}`];
      if (!edge) continue;
      const reps = c.count.kind === 'const' ? c.count.value : c.count.kind === 'uniform' ? Math.floor(c.count.max) : quantile(c.count, 0.99);
      const meshAttempts = edge.mesh ? model.mesh?.retries?.attempts ?? 1 : 1;
      const f = factor * (edge.retry?.maxAttempts ?? 1) * meshAttempts * Math.max(1, Math.round(reps));
      const p = [...path, c.target];
      if (!byEdge[edge.key] || byEdge[edge.key].factor < f) byEdge[edge.key] = { path: p, factor: f };
      const t = model.nodes[c.target];
      if (t.kind === 'service') visit(c.target, t.endpoints[c.op].calls, f, p, depth + 1);
      if (c.onMiss.length) visit(caller, c.onMiss, factor, path, depth + 1);
    }
  };
  for (const m of model.scenario.mix) {
    const client = model.edges[`${CLIENT}->${m.ref.node}`];
    const f = client?.retry?.maxAttempts ?? 1;
    const svc = model.nodes[m.ref.node] as ServiceSpec;
    visit(m.ref.node, svc.endpoints[m.ref.op].calls, f, [CLIENT, m.ref.node], 0);
  }
  let max: AmplificationPath | null = null;
  for (const a of Object.values(byEdge)) if (!max || a.factor > max.factor) max = a;
  return { byEdge, max };
}

export function checkModel(model: Model): Warning[] {
  const out: Warning[] = [];
  const nodes = model.nodes;

  // calls per edge: which ops are invoked over it
  const opsByEdge = new Map<string, Set<string>>();
  for (const n of Object.values(nodes)) {
    if (n.kind !== 'service') continue;
    for (const ep of Object.values(n.endpoints)) {
      forEachCall(ep.calls, (c) => {
        const k = `${n.name}->${c.target}`;
        if (!opsByEdge.has(k)) opsByEdge.set(k, new Set());
        opsByEdge.get(k)!.add(c.op);
      });
    }
  }
  for (const m of model.scenario.mix) {
    const k = `${CLIENT}->${m.ref.node}`;
    if (!opsByEdge.has(k)) opsByEdge.set(k, new Set());
    opsByEdge.get(k)!.add(m.ref.op);
  }

  // cycles
  const visiting = new Set<string>();
  const done = new Set<string>();
  const dfs = (svc: string, op: string, stack: string[]): void => {
    const key = `${svc}:${op}`;
    if (done.has(key)) return;
    if (visiting.has(key)) {
      out.push({ level: 'error', code: 'cycle', message: `호출 순환: ${[...stack, key].join(' → ')}`, target: svc });
      return;
    }
    visiting.add(key);
    const n = nodes[svc];
    if (n.kind === 'service') {
      forEachCall(n.endpoints[op].calls, (c) => {
        if (nodes[c.target].kind === 'service') dfs(c.target, c.op, [...stack, key]);
      });
    }
    visiting.delete(key);
    done.add(key);
  };
  for (const n of Object.values(nodes)) if (n.kind === 'service') for (const op of Object.keys(n.endpoints)) dfs(n.name, op, []);

  for (const e of Object.values(model.edges)) {
    const target = nodes[e.to];
    const fromClient = e.from === CLIENT;

    // 1. missing timeouts on remote calls that hold a thread
    if (!fromClient && !Number.isFinite(e.timeout) && (target.kind === 'service' || target.kind === 'external')) {
      out.push({
        level: 'warn',
        code: 'no-timeout',
        message: `${e.key}: timeout이 없습니다. 하위가 멈추면 ${e.from}의 스레드가 무한정 붙잡힙니다.`,
        target: e.key,
      });
    }

    // 2. timeout inversion: our timeout is shorter than what the callee may legitimately spend downstream
    if (Number.isFinite(e.timeout) && target.kind === 'service') {
      for (const op of opsByEdge.get(e.key) ?? []) {
        const ep = target.endpoints[op];
        if (!ep) continue;
        for (const c of ep.calls) {
          const down = model.edges[`${e.to}->${c.target}`];
          if (!down) continue;
          if (Number.isFinite(down.timeout) && down.timeout >= e.timeout) {
            out.push({
              level: 'warn',
              code: 'timeout-inversion',
              message: `timeout 역전: ${e.key} timeout ${fmtMs(e.timeout)} ≤ ${down.key} timeout ${fmtMs(down.timeout)}. ${e.from}가 먼저 포기하고${e.retry ? ' 재시도해' : ''} ${e.to}의 작업이 버려집니다(좀비 작업).`,
              target: e.key,
            });
          } else if (down.retry && callBudget(down) >= e.timeout) {
            out.push({
              level: 'warn',
              code: 'timeout-inversion',
              message: `timeout 역전(재시도 포함): ${down.key}의 최악 소요 ${fmtMs(callBudget(down))}(${down.retry.maxAttempts}회 × ${fmtMs(down.timeout)} + 백오프) > ${e.key} timeout ${fmtMs(e.timeout)}.`,
              target: e.key,
            });
          }
          if (down.pool && down.pool.timeout >= e.timeout && nodes[c.target].kind === 'db') {
            out.push({
              level: 'info',
              code: 'pool-timeout-inversion',
              message: `${down.key} 커넥션풀 대기 timeout ${fmtMs(down.pool.timeout)} ≥ ${e.key} timeout ${fmtMs(e.timeout)}. 풀이 고갈되면 ${e.to}는 호출자가 이미 떠난 요청을 위해 커넥션을 기다립니다.`,
              target: down.key,
            });
          }
        }
      }
    }

    // 3. synchronized retries
    if (e.retry && e.retry.maxAttempts > 1 && e.retry.jitter === 0) {
      out.push({
        level: 'warn',
        code: 'retry-no-jitter',
        message: `${e.key}: 재시도에 jitter가 없습니다. 동시에 실패한 요청들이 같은 순간에 재시도해 트래픽 파도를 만듭니다.`,
        target: e.key,
      });
    }

    // 4. breaker without fallback / short open window
    if (e.circuitBreaker) {
      if (!e.fallback) {
        out.push({
          level: 'info',
          code: 'cb-no-fallback',
          message: `${e.key}: 서킷브레이커에 fallback이 없어 OPEN 동안 모든 호출이 즉시 실패합니다.`,
          target: e.key,
        });
      }
      if (e.circuitBreaker.openFor < 5000) {
        out.push({
          level: 'info',
          code: 'cb-short-open',
          message: `${e.key}: OPEN 유지 ${fmtMs(e.circuitBreaker.openFor)}는 짧습니다. 하위가 회복되기 전에 시험 호출이 반복되어 HALF_OPEN 진동이 생길 수 있습니다.`,
          target: e.key,
        });
      }
      if (Number.isFinite(e.timeout) && e.circuitBreaker.slowCall > e.timeout) {
        out.push({
          level: 'info',
          code: 'cb-slowcall-unreachable',
          message: `${e.key}: 느린 호출 기준 ${fmtMs(e.circuitBreaker.slowCall)}이 timeout ${fmtMs(e.timeout)}보다 길어 느린 호출로 집계되는 경우가 없습니다.`,
          target: e.key,
        });
      }
    }

    // 5. retrying non-idempotent calls
    if (e.retry && e.retry.maxAttempts > 1 && target.kind === 'service') {
      const posts = [...(opsByEdge.get(e.key) ?? [])].filter((op) => /^(POST|PATCH)\s/i.test(op));
      if (posts.length) {
        out.push({
          level: 'info',
          code: 'retry-non-idempotent',
          message: `${e.key}: ${posts.join(', ')}를 재시도합니다. 멱등성 키가 없다면 중복 처리될 수 있습니다.`,
          target: e.key,
        });
      }
    }
  }

  // 6. retry amplification
  const amp = retryAmplification(model);
  if (amp.max && amp.max.factor >= 8) {
    const p = amp.max.path;
    let retryLayers = 0;
    for (let i = 0; i < p.length - 1; i++) if ((model.edges[`${p[i]}->${p[i + 1]}`]?.retry?.maxAttempts ?? 1) > 1) retryLayers++;
    out.push({
      level: 'warn',
      code: 'retry-amplification',
      message: `재시도 증폭: ${amp.max.path.join(' → ')} 경로에서 진입 요청 1개가 최악의 경우 최하위에 ${amp.max.factor.toFixed(0)}개의 요청을 만듭니다${retryLayers > 1 ? ` (재시도 계층 ${retryLayers}개가 곱해짐)` : ''}. 재시도는 한 계층에만 두세요.`,
      target: `${amp.max.path[amp.max.path.length - 2]}->${amp.max.path[amp.max.path.length - 1]}`,
    });
  }

  // 7. connection pools vs DB max_connections
  for (const db of Object.values(nodes)) {
    if (db.kind !== 'db') continue;
    let total = 0;
    const parts: string[] = [];
    for (const e of Object.values(model.edges)) {
      if (e.to !== db.name || !e.pool) continue;
      const caller = nodes[e.from];
      const inst = caller?.kind === 'service' ? caller.instances : 1;
      total += e.pool.size * inst;
      parts.push(`${e.from} ${e.pool.size}×${inst}`);
    }
    if (total > db.maxConnections) {
      out.push({
        level: 'warn',
        code: 'pool-exceeds-db',
        message: `${db.name}: 커넥션풀 합계 ${total}(${parts.join(' + ')})가 max_connections ${db.maxConnections}를 넘습니다.`,
        target: db.name,
      });
    }
  }

  // 8. thread pool smaller than DB pool (pool can never be fully used)
  for (const e of Object.values(model.edges)) {
    const caller = nodes[e.from];
    if (caller?.kind === 'service' && e.pool && e.pool.size > caller.threads) {
      out.push({
        level: 'info',
        code: 'pool-larger-than-threads',
        message: `${e.key}: 풀 크기 ${e.pool.size}가 워커 스레드 ${caller.threads}보다 커서 다 쓰이지 않습니다.`,
        target: e.key,
      });
    }
  }

  // 9. phase-2 pitfalls
  for (const n of Object.values(nodes)) {
    if (n.kind === 'queue' && n.kafka && n.consumer) {
      const svc = nodes[n.consumer.service];
      const threads = n.consumer.concurrency * (svc?.kind === 'service' ? svc.instances : 1);
      if (threads > n.kafka.partitions) {
        out.push({
          level: 'warn',
          code: 'kafka-idle-consumers',
          message: `${n.name}: 컨슈머 스레드 ${threads}개(동시성 ${n.consumer.concurrency} × 인스턴스)가 파티션 ${n.kafka.partitions}개보다 많아 ${threads - n.kafka.partitions}개는 놀고 있습니다. 처리량을 늘리려면 파티션을 늘려야 합니다.`,
          target: n.name,
        });
      }
      if (n.kafka.onError === 'retry' && Number.isFinite(n.consumer.maxRetries) && n.kafka.retryBackoff * n.consumer.maxRetries >= 5000) {
        out.push({
          level: 'info',
          code: 'kafka-blocking-retry',
          message: `${n.name}: 실패한 레코드 하나가 파티션을 최대 ${fmtMs(n.kafka.retryBackoff * n.consumer.maxRetries)} 막습니다(백오프 ${fmtMs(n.kafka.retryBackoff)} × ${n.consumer.maxRetries}회, 제자리 재시도). 비블로킹 재시도 토픽(@RetryableTopic)이나 DLT를 고려하세요.`,
          target: n.name,
        });
      }
      if (n.kafka.keySkew >= 0.5) {
        out.push({
          level: 'info',
          code: 'kafka-hot-partition',
          message: `${n.name}: 키 분포가 치우쳐(keySkew ${n.kafka.keySkew}) 일부 파티션에 메시지가 몰립니다. 그 파티션의 컨슈머 하나가 전체 처리량을 제한합니다.`,
          target: n.name,
        });
      }
    }
    if (n.kind === 'queue' && !n.kafka && n.consumer && n.consumer.ack === 'manual' && !Number.isFinite(n.consumer.maxRetries)) {
      out.push({
        level: 'warn',
        code: 'queue-infinite-requeue',
        message: `${n.name}: 실패한 메시지를 무한히 재전달합니다(maxRetries 없음). 처리 불가능한 메시지 하나가 컨슈머를 계속 붙잡습니다. maxRetries와 DLQ를 두세요.`,
        target: n.name,
      });
    }
    if (n.kind === 'cache') {
      for (const [op, c] of Object.entries(n.ops)) {
        if (Number.isFinite(c.ttl) && c.ttlJitter === 0 && !c.singleFlight) {
          out.push({
            level: 'warn',
            code: 'cache-synchronized-ttl',
            message: `${n.name} ${op}: TTL에 jitter가 없고 단일 갱신도 없습니다. 함께 채워진 항목이 같은 순간 만료되어 DB로 스탬피드가 생깁니다.`,
            target: n.name,
          });
        }
      }
    }
    if (n.kind === 'service') {
      if (n.model === 'webflux') {
        const blocking = Object.values(model.edges).filter((e) => e.from === n.name && e.blocking);
        if (blocking.length) {
          out.push({
            level: 'warn',
            code: 'webflux-blocking',
            message: `${n.name}: WebFlux인데 블로킹 호출(${blocking.map((e) => e.to).join(', ')})이 있습니다. 호출 동안 이벤트 루프 ${n.eventLoops}개 중 하나가 멈춥니다. R2DBC 등 논블로킹 드라이버(blocking: false)나 별도 스케줄러를 쓰세요.`,
            target: n.name,
          });
        }
      }
      if (n.healthCheck && n.instances > 1 && n.healthCheck.interval * n.healthCheck.threshold >= 30_000) {
        out.push({
          level: 'info',
          code: 'health-check-gap',
          message: `${n.name}: 죽은 인스턴스를 로드밸런서에서 빼는 데 최대 ${fmtMs(n.healthCheck.interval * n.healthCheck.threshold)}가 걸립니다(간격 ${fmtMs(n.healthCheck.interval)} × ${n.healthCheck.threshold}회).`,
          target: n.name,
        });
      }
      if (Number.isFinite(n.cpuLimit) && n.cpuLimit < n.vcpu) {
        out.push({
          level: 'info',
          code: 'cpu-limit-below-vcpu',
          message: `${n.name}: 컨테이너 CPU limit(${n.cpuLimit})이 vCPU(${n.vcpu})보다 작습니다. 순간 사용량이 몰리면 CFS 쓰로틀링으로 ${fmtMs(n.cfsPeriod)} 주기의 정지가 생깁니다.`,
          target: n.name,
        });
      }
    }
  }
  for (const e of Object.values(model.edges)) {
    if (e.from !== CLIENT && !e.network.keepAlive && nodes[e.to].kind !== 'db') {
      out.push({
        level: 'warn',
        code: 'no-keep-alive',
        message: `${e.key}: keep-alive가 꺼져 있어 호출마다 새 연결(핸드셰이크)을 만들고, 닫힌 포트는 TIME_WAIT로 남아 임시 포트가 고갈될 수 있습니다.`,
        target: e.key,
      });
    }
  }

  // 10. API gateway / load balancer / service mesh
  const meshRetry = model.mesh?.retries;
  for (const e of Object.values(model.edges)) {
    if (e.mesh && meshRetry && meshRetry.attempts > 1 && e.retry && e.retry.maxAttempts > 1) {
      out.push({
        level: 'warn',
        code: 'mesh-double-retry',
        message: `${e.key}: 애플리케이션 재시도(${e.retry.maxAttempts}회)와 메시 재시도(${meshRetry.attempts}회)가 겹쳐 시도가 최대 ${e.retry.maxAttempts * meshRetry.attempts}배가 됩니다. 한 계층에서만 재시도하세요.`,
        target: e.key,
      });
    }
    if (e.mesh && meshRetry && Number.isFinite(meshRetry.perTryTimeout) && Number.isFinite(e.timeout) && meshRetry.perTryTimeout * meshRetry.attempts > e.timeout) {
      out.push({
        level: 'info',
        code: 'mesh-retry-budget',
        message: `${e.key}: 메시 재시도 ${meshRetry.attempts}회 × per-try ${fmtMs(meshRetry.perTryTimeout)}가 timeout ${fmtMs(e.timeout)}보다 길어 마지막 시도들은 쓰이지 못합니다.`,
        target: e.key,
      });
    }
  }
  for (const n of Object.values(nodes)) {
    if (n.kind !== 'service') continue;
    if (n.role === 'lb') {
      const target = Object.values(model.edges).find((e) => e.from === n.name)?.to;
      const t = target ? nodes[target] : undefined;
      if (t?.kind === 'service' && t.instances > 1 && !t.healthCheck && !model.mesh?.outlier)
        out.push({ level: 'warn', code: 'lb-no-health-check', message: `${n.name}: ${target} 앞의 로드밸런서에 헬스체크가 없어 죽은 인스턴스로도 계속 보냅니다.`, target: n.name });
    }
    if (n.role === 'gateway') {
      for (const e of Object.values(model.edges)) {
        if (e.from !== n.name || nodes[e.to].kind !== 'service') continue;
        if (!Number.isFinite(e.timeout)) out.push({ level: 'warn', code: 'gateway-no-timeout', message: `${n.name}→${e.to} 라우트에 timeout이 없습니다. 백엔드가 멈추면 게이트웨이 연결이 쌓입니다.`, target: e.key });
      }
    }
  }

  const order = { error: 0, warn: 1, info: 2 };
  const seen = new Set<string>();
  return out.filter((w) => !seen.has(w.code + w.message) && !!seen.add(w.code + w.message)).sort((a, b) => order[a.level] - order[b.level]);
}
