// application.yml / application.properties → service runtime, HikariCP pools, Resilience4j policies, Feign timeouts.
import { parseAllDocuments } from 'yaml';
import { deepMerge, expandDotted, fmtDuration, prop, slug, springDuration, type ImportReport } from './util';
import { importGatewayRoutes } from './platform';

export interface SpringConfigOptions {
  /** service (node) name; defaults to spring.application.name */
  service?: string;
  instances?: number;
  /** Resilience4j / Feign instance name → target node. Default: the instance name itself. */
  targets?: Record<string, string>;
  /** active profiles; documents with spring.config.activate.on-profile outside this list are skipped */
  profiles?: string[];
}

function parseProperties(text: string): any {
  const out: any = {};
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#') || line.startsWith('!')) continue;
    const i = line.search(/[=:]/);
    if (i < 0) continue;
    const key = line.slice(0, i).trim();
    const value = line.slice(i + 1).trim();
    out[key] = /^-?\d+(\.\d+)?$/.test(value) ? Number(value) : value === 'true' ? true : value === 'false' ? false : value;
  }
  return expandDotted(out);
}

function load(text: string, profiles: string[]): any {
  if (!/^\s*[\w.-]+\s*:/m.test(text) || /^\s*[\w.-]+\s*=/m.test(text)) return parseProperties(text);
  let merged: any = {};
  for (const d of parseAllDocuments(text)) {
    const js = expandDotted(d.toJS() ?? {});
    const on = prop(js, 'spring.config.activate.on-profile') ?? prop(js, 'spring.profiles');
    if (on && !String(on).split(',').some((p) => profiles.includes(p.trim()))) continue;
    merged = deepMerge(merged, js);
  }
  return merged;
}

const toPct = (v: unknown) => (v === undefined ? undefined : Number(v));

export function importSpringConfig(text: string, opts: SpringConfigOptions = {}): ImportReport {
  const cfg = load(text, opts.profiles ?? []);
  const notes: string[] = [];
  const name = slug(opts.service ?? prop(cfg, 'spring.application.name') ?? 'service');
  const svc: any = { kind: 'service' };
  const runtime: any = {};
  const edges: Record<string, any> = {};
  const nodes: Record<string, any> = { [name]: svc };
  if (opts.instances) svc.instances = opts.instances;
  const target = (instance: string) => opts.targets?.[instance] ?? slug(instance);

  // --- web runtime
  const threads = prop(cfg, 'server.tomcat.threads.max') ?? prop(cfg, 'server.tomcat.max-threads');
  if (threads !== undefined) runtime.threads = Number(threads);
  const accept = prop(cfg, 'server.tomcat.accept-count');
  if (accept !== undefined) runtime.acceptCount = Number(accept);
  const maxConn = prop(cfg, 'server.tomcat.max-connections');
  if (maxConn !== undefined) runtime.maxConnections = Number(maxConn);
  if (prop(cfg, 'spring.threads.virtual.enabled') === true) {
    runtime.model = 'virtual';
    notes.push('가상 스레드(spring.threads.virtual.enabled)를 켠 서비스로 가져왔습니다.');
  }
  if (String(prop(cfg, 'spring.main.web-application-type') ?? '').toLowerCase() === 'reactive') runtime.model = 'webflux';
  const asyncMax = prop(cfg, 'spring.task.execution.pool.max-size');
  if (asyncMax !== undefined) runtime.asyncThreads = Number(asyncMax);
  if (Object.keys(runtime).length) svc.runtime = runtime;

  // --- datasource → db node + HikariCP pool
  const url = String(prop(cfg, 'spring.datasource.url') ?? prop(cfg, 'spring.datasource.hikari.jdbc-url') ?? '');
  if (url) {
    const m = /jdbc:(\w+):\/\/([^/:?]+)(?::\d+)?\/([^?;]+)/.exec(url);
    const dbName = slug(m ? `${m[3]}-db` : `${name}-db`);
    nodes[dbName] = { kind: 'db' };
    const pool: any = {};
    const size = prop(cfg, 'spring.datasource.hikari.maximum-pool-size');
    pool.size = size !== undefined ? Number(size) : 10;
    const ct = springDuration(prop(cfg, 'spring.datasource.hikari.connection-timeout'), 'ms');
    pool.timeout = fmtDuration(ct ?? 30_000);
    edges[`${name}->${dbName}`] = { pool };
    notes.push(`데이터소스 ${m?.[1] ?? 'jdbc'} → DB 노드 "${dbName}" (HikariCP ${pool.size}개, 대기 ${pool.timeout}). 쿼리 지연은 트레이스로 채우세요.`);
  }

  // --- redis
  const redisHost = prop(cfg, 'spring.data.redis.host') ?? prop(cfg, 'spring.redis.host');
  if (redisHost) {
    nodes.redis = { kind: 'cache' };
    notes.push('Redis 설정을 찾아 캐시 노드 "redis"를 만들었습니다. 적중률은 트레이스·지표로 채우세요.');
  }

  // --- resilience4j (configs.default + instances.X, with baseConfig)
  const r4 = (kind: string) => {
    const base = prop(cfg, `resilience4j.${kind}.configs`) ?? {};
    const inst = prop(cfg, `resilience4j.${kind}.instances`) ?? {};
    const out: Record<string, any> = {};
    for (const [k, v] of Object.entries<any>(inst)) {
      const baseName = prop(v, 'base-config') ?? 'default';
      out[k] = deepMerge(prop(base, baseName) ?? {}, v ?? {});
    }
    return out;
  };
  const edge = (instance: string) => (edges[`${name}->${target(instance)}`] ??= {});

  for (const [inst, c] of Object.entries(r4('circuitbreaker'))) {
    const cb: any = {};
    const set = (k: string, v: unknown) => v !== undefined && (cb[k] = v);
    set('failureRate', toPct(prop(c, 'failure-rate-threshold')));
    const sc = springDuration(prop(c, 'slow-call-duration-threshold'), 'ms');
    if (sc !== undefined) cb.slowCall = fmtDuration(sc);
    set('slowCallRate', toPct(prop(c, 'slow-call-rate-threshold')));
    set('window', prop(c, 'sliding-window-size'));
    if (String(prop(c, 'sliding-window-type') ?? '').toUpperCase().startsWith('TIME')) cb.windowType = 'time';
    set('minCalls', prop(c, 'minimum-number-of-calls'));
    const open = springDuration(prop(c, 'wait-duration-in-open-state'), 'ms');
    if (open !== undefined) cb.openFor = fmtDuration(open);
    set('halfOpenCalls', prop(c, 'permitted-number-of-calls-in-half-open-state'));
    edge(inst).circuitBreaker = cb;
  }
  for (const [inst, c] of Object.entries(r4('retry'))) {
    const r: any = {};
    const max = prop(c, 'max-attempts');
    r.max = max !== undefined ? Number(max) : 3;
    const wait = springDuration(prop(c, 'wait-duration'), 'ms');
    r.wait = fmtDuration(wait ?? 500);
    if (prop(c, 'enable-exponential-backoff') === true) {
      r.backoff = 'exponential';
      const mul = prop(c, 'exponential-backoff-multiplier');
      if (mul !== undefined) r.multiplier = Number(mul);
    }
    if (prop(c, 'enable-randomized-wait') === true) r.jitter = Number(prop(c, 'randomized-wait-factor') ?? 0.5);
    edge(inst).retry = r;
  }
  for (const [inst, c] of Object.entries(r4('timelimiter'))) {
    const t = springDuration(prop(c, 'timeout-duration'), 'ms');
    if (t !== undefined) edge(inst).timeout = fmtDuration(t);
  }
  for (const [inst, c] of Object.entries(r4('bulkhead'))) {
    const b: any = {};
    const mc = prop(c, 'max-concurrent-calls');
    if (mc !== undefined) b.maxConcurrent = Number(mc);
    const mw = springDuration(prop(c, 'max-wait-duration'), 'ms');
    if (mw !== undefined) b.maxWait = fmtDuration(mw);
    edge(inst).bulkhead = b;
  }
  for (const [inst, c] of Object.entries(r4('ratelimiter'))) {
    const r: any = {};
    const l = prop(c, 'limit-for-period');
    if (l !== undefined) r.limit = Number(l);
    const p = springDuration(prop(c, 'limit-refresh-period'), 'ms');
    if (p !== undefined) r.period = fmtDuration(p);
    const t = springDuration(prop(c, 'timeout-duration'), 'ms');
    if (t !== undefined) r.timeout = fmtDuration(t);
    edge(inst).rateLimiter = r;
  }

  // --- OpenFeign client timeouts
  const feign = prop(cfg, 'spring.cloud.openfeign.client.config') ?? prop(cfg, 'feign.client.config') ?? {};
  for (const [client, c] of Object.entries<any>(feign)) {
    if (client === 'default') continue;
    const read = springDuration(prop(c, 'read-timeout') ?? prop(c, 'readTimeout'), 'ms');
    const conn = springDuration(prop(c, 'connect-timeout') ?? prop(c, 'connectTimeout'), 'ms');
    if (read !== undefined && edge(client).timeout === undefined) edge(client).timeout = fmtDuration(read);
    if (conn !== undefined) edge(client).connectTimeout = fmtDuration(conn);
  }

  // --- RabbitMQ listener defaults (applied by the merge step to queues this service consumes)
  const rabbit = prop(cfg, 'spring.rabbitmq.listener.simple');
  if (rabbit) {
    const c: any = {};
    const conc = prop(rabbit, 'concurrency');
    if (conc !== undefined) c.concurrency = Number(conc);
    const pf = prop(rabbit, 'prefetch');
    if (pf !== undefined) c.prefetch = Number(pf);
    const ack = String(prop(rabbit, 'acknowledge-mode') ?? '').toLowerCase();
    if (ack) c.ack = ack === 'auto' || ack === 'none' ? 'auto' : 'manual';
    const retries = prop(rabbit, 'retry.max-attempts');
    if (prop(rabbit, 'retry.enabled') === true) c.maxRetries = Number(retries ?? 3) - 1;
    else if (prop(rabbit, 'default-requeue-rejected') !== false) c.maxRetries = 'infinite';
    svc['x-rabbitListener'] = c;
    notes.push('RabbitMQ 리스너 설정(concurrency, prefetch, ack, 재시도)을 찾았습니다. 이 서비스가 소비하는 큐에 적용됩니다.');
  }

  // --- Kafka listener defaults
  const kafkaListener = prop(cfg, 'spring.kafka.listener');
  const kafkaConsumer = prop(cfg, 'spring.kafka.consumer');
  if (kafkaListener || kafkaConsumer || prop(cfg, 'spring.kafka.bootstrap-servers')) {
    const c: any = {};
    const conc = prop(kafkaListener, 'concurrency');
    if (conc !== undefined) c.concurrency = Number(conc);
    const mpr = prop(kafkaConsumer, 'max-poll-records');
    if (mpr !== undefined) c.maxPollRecords = Number(mpr);
    const st = springDuration(prop(kafkaConsumer, 'properties.session.timeout.ms') ?? prop(cfg, 'spring.kafka.properties.session.timeout.ms'), 'ms');
    if (st !== undefined) c.rebalanceTime = fmtDuration(st);
    svc['x-kafkaListener'] = c;
    notes.push('Kafka 설정(listener concurrency, max-poll-records, session timeout)을 찾았습니다. 이 서비스가 소비하는 토픽에 적용됩니다. 파티션 수는 직접 넣으세요.');
  }

  // --- Spring Cloud Gateway: this application is an API gateway
  const gw = importGatewayRoutes(cfg, name);
  if (gw) {
    nodes[name] = { ...gw.node, ...(svc.instances ? { instances: svc.instances } : {}) };
    notes.push(...gw.notes);
  }

  const unmapped = Object.keys(edges).filter((k) => k.split('->')[1] !== slug(k.split('->')[1]));
  if (unmapped.length) notes.push(`대상 노드 이름을 추정한 연결선: ${unmapped.join(', ')}`);
  return { doc: { nodes, edges }, notes };
}
