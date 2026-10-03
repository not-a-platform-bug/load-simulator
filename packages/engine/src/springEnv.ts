// Scenario settings → Spring Boot environment variable overrides, so the real deployment runs with exactly the
// configuration that was simulated ("설정 변경: Spring 설정 오버라이드(환경 변수) 생성 후 재배포").
import type { Model } from './types';

const env = (prop: string) => prop.toUpperCase().replace(/[.-]/g, '_').replace(/\[(\d+)\]/g, '_$1_');
const sec = (ms: number) => (Number.isFinite(ms) ? `${Math.round(ms)}ms` : undefined);

/**
 * @param model parsed model
 * @param service node name of the Spring service
 * @param instanceName optional map target node → Resilience4j/Feign instance name (default: the node name)
 */
export function springEnv(model: Model, service: string, instanceName: Record<string, string> = {}): Record<string, string> {
  const n = model.nodes[service];
  if (!n || n.kind !== 'service') throw new Error(`서비스 "${service}"가 없습니다`);
  const out: Record<string, string> = {};
  const set = (prop: string, v: unknown) => {
    if (v !== undefined && v !== null && v !== '' && !(typeof v === 'number' && !Number.isFinite(v))) out[env(prop)] = String(v);
  };
  if (n.model === 'tomcat') {
    set('server.tomcat.threads.max', n.threads);
    set('server.tomcat.accept-count', n.acceptCount);
    set('server.tomcat.max-connections', n.maxConnections);
  }
  if (n.model === 'virtual') set('spring.threads.virtual.enabled', true);
  set('spring.task.execution.pool.max-size', n.asyncThreads);
  // JVM flags for heap / GC
  const gcFlag = { g1: '-XX:+UseG1GC', parallel: '-XX:+UseParallelGC', serial: '-XX:+UseSerialGC', zgc: '-XX:+UseZGC' }[n.gc];
  out.JAVA_TOOL_OPTIONS = `-Xms${Math.round(n.heapMb)}m -Xmx${Math.round(n.heapMb)}m ${gcFlag}`;

  for (const e of Object.values(model.edges)) {
    if (e.from !== service) continue;
    const target = model.nodes[e.to];
    const inst = instanceName[e.to] ?? e.to;
    if (target.kind === 'db' && e.pool) {
      set('spring.datasource.hikari.maximum-pool-size', e.pool.size);
      set('spring.datasource.hikari.connection-timeout', Math.round(e.pool.timeout));
      continue;
    }
    const r4 = (kind: string, prop: string, v: unknown) => set(`resilience4j.${kind}.instances.${inst}.${prop}`, v);
    if (Number.isFinite(e.timeout)) {
      r4('timelimiter', 'timeout-duration', sec(e.timeout));
      set(`spring.cloud.openfeign.client.config.${inst}.read-timeout`, Math.round(e.timeout));
      // plain RestClient/WebClient convention: app.<target>.read-timeout
      set(`app.${inst}.read-timeout`, sec(e.timeout));
    }
    if (Number.isFinite(e.connectTimeout)) {
      set(`spring.cloud.openfeign.client.config.${inst}.connect-timeout`, Math.round(e.connectTimeout));
      set(`app.${inst}.connect-timeout`, sec(e.connectTimeout));
    }
    if (!e.retry && (target.kind === 'service' || target.kind === 'external')) r4('retry', 'max-attempts', 1);
    if (e.retry) {
      r4('retry', 'max-attempts', e.retry.maxAttempts);
      r4('retry', 'wait-duration', sec(e.retry.wait));
      r4('retry', 'enable-exponential-backoff', e.retry.backoff === 'exponential');
      if (e.retry.backoff === 'exponential') r4('retry', 'exponential-backoff-multiplier', e.retry.multiplier);
      r4('retry', 'enable-randomized-wait', e.retry.jitter > 0);
      if (e.retry.jitter > 0) r4('retry', 'randomized-wait-factor', e.retry.jitter);
    }
    if (e.circuitBreaker) {
      const c = e.circuitBreaker;
      r4('circuitbreaker', 'sliding-window-type', c.windowType === 'time' ? 'TIME_BASED' : 'COUNT_BASED');
      r4('circuitbreaker', 'sliding-window-size', c.window);
      r4('circuitbreaker', 'minimum-number-of-calls', c.minCalls);
      r4('circuitbreaker', 'failure-rate-threshold', Math.round(c.failureRate * 100));
      r4('circuitbreaker', 'slow-call-duration-threshold', sec(c.slowCall));
      r4('circuitbreaker', 'slow-call-rate-threshold', Math.round(c.slowCallRate * 100));
      r4('circuitbreaker', 'wait-duration-in-open-state', sec(c.openFor));
      r4('circuitbreaker', 'permitted-number-of-calls-in-half-open-state', c.halfOpenCalls);
    }
    if (e.bulkhead) {
      r4('bulkhead', 'max-concurrent-calls', e.bulkhead.maxConcurrent);
      r4('bulkhead', 'max-wait-duration', sec(e.bulkhead.maxWait));
    }
    if (e.rateLimiter) {
      r4('ratelimiter', 'limit-for-period', e.rateLimiter.limit);
      r4('ratelimiter', 'limit-refresh-period', sec(e.rateLimiter.period));
      r4('ratelimiter', 'timeout-duration', sec(e.rateLimiter.timeout));
    }
  }
  for (const q of Object.values(model.nodes)) {
    if (q.kind !== 'queue' || q.consumer?.service !== service) continue;
    if (q.kafka) {
      set('spring.kafka.listener.concurrency', q.consumer.concurrency);
      set('spring.kafka.consumer.max-poll-records', q.kafka.maxPollRecords);
      set('spring.kafka.consumer.properties.session.timeout.ms', Math.round(q.kafka.rebalanceTime));
      continue;
    }
    set('spring.rabbitmq.listener.simple.concurrency', q.consumer.concurrency);
    set('spring.rabbitmq.listener.simple.prefetch', q.consumer.prefetch);
    set('spring.rabbitmq.listener.simple.acknowledge-mode', q.consumer.ack.toUpperCase());
    if (Number.isFinite(q.consumer.maxRetries)) {
      set('spring.rabbitmq.listener.simple.retry.enabled', true);
      set('spring.rabbitmq.listener.simple.retry.max-attempts', q.consumer.maxRetries + 1);
    } else set('spring.rabbitmq.listener.simple.default-requeue-rejected', true);
  }
  return out;
}
