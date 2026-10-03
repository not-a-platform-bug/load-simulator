#!/usr/bin/env node
// Validation harness runner: the same scenario file drives the simulator and a real load test, and the
// two are compared metric by metric (docs/accuracy.md).
//
//   node harness/run.mjs [--scenario harness/scenarios/cascading.yaml] [--calibrate 60,90,120] [--validate 200,300]
//                        [--fault] [--keep] [--skip-up] [--reuse]
//
//   --reuse   keep measurements already in harness/out (calibration points, validation runs) and only run what is missing
//
// Steps
//   1. scenario → Spring environment overrides (load-sim spring-env) → docker compose up (CPU/memory limited)
//   2. low-load measurement at --calibrate levels (k6, constant arrival rate)  → load-sim calibrate
//   3. high-load prediction vs measurement at --validate levels (levels NOT used for calibration)
//   4. optional fault run: k6 + Toxiproxy fault plan in real time; breaker OPEN time from Prometheus
//   5. error table → harness/out/accuracy-<date>.md
import { execFileSync, spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..');
const out = join(here, 'out');
const cli = join(root, 'packages/cli/dist/load-sim.cjs');

const args = Object.fromEntries(
  process.argv.slice(2).map((a, i, all) => (a.startsWith('--') ? [a.slice(2), all[i + 1] && !all[i + 1].startsWith('--') ? all[i + 1] : 'true'] : [])).filter((x) => x.length),
);
const scenario = resolve(args.scenario ?? join(here, 'scenarios/cascading.yaml'));
const calibrateLevels = String(args.calibrate ?? '60,90,120').split(',').map(Number);
const validateLevels = String(args.validate ?? '200,300').split(',').map(Number);
const BASE = args.base ?? 'http://localhost:8080';
const PROM = args.prometheus ?? 'http://localhost:9090';
const TOXI = args.toxiproxy ?? 'http://localhost:8474';
const PROXIES = args.proxies ?? 'payments-db=mysql-payments,orders-db=mysql-orders,order->payment=payment,order->stock=stock';
const SERVICES = ['order', 'payment', 'stock'];

const log = (m) => console.log(`\x1b[36m▸\x1b[0m ${m}`);
const sh = (cmd, argv, opts = {}) => execFileSync(cmd, argv, { stdio: opts.capture ? ['ignore', 'pipe', 'inherit'] : 'inherit', cwd: opts.cwd ?? root, env: { ...process.env, ...opts.env }, encoding: 'utf8' });
const sim = (...a) => sh('node', [cli, ...a], { capture: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitFor(url, label, timeoutMs = 300_000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    try {
      const r = await fetch(url);
      if (r.ok) return;
    } catch {
      // not up yet
    }
    await sleep(2000);
  }
  throw new Error(`${label}가 ${timeoutMs / 1000}초 안에 뜨지 않았습니다 (${url})`);
}

/** run k6 at a constant rate and return client-side measurements in simulator units */
function k6At(rps, seconds, label, { faults = false } = {}) {
  const script = join(out, `k6-${label}.js`);
  const summary = join(out, `k6-${label}.json`);
  const flags = ['k6', scenario, '--out', script, '--allow', 'localhost,127.0.0.1', '--max-rps', String(Math.max(rps, 10_000))];
  if (rps) flags.push('--rps', String(rps), '--duration', `${seconds}s`);
  if (!faults) flags.push('--no-faults');
  sim(...flags);
  try {
    sh('k6', ['run', '--quiet', '--summary-export', summary, script], { env: { BASE_URL: BASE } });
  } catch (e) {
    // exit 99 = SLO thresholds crossed: expected under faults and overload, the summary is still written
    if (e.status !== 99 || !existsSync(summary)) throw e;
    log(`${label}: SLO 임계값을 넘었습니다 (측정은 정상 — 그대로 비교합니다)`);
  }
  const s = JSON.parse(readFileSync(summary, 'utf8')).metrics;
  const failed = s.http_req_failed?.value ?? s.http_req_failed?.rate ?? 0;
  const dur = s.http_req_duration;
  return {
    rps,
    throughput: +(s.http_reqs.rate * (1 - failed)).toFixed(2),
    p50: +(dur.med ?? dur['p(50)']).toFixed(2),
    p99: +dur['p(99)'].toFixed(2),
    errorRate: +failed.toFixed(5),
  };
}

async function promQuery(query, start, end) {
  const u = new URL(`${PROM}/api/v1/query_range`);
  u.searchParams.set('query', query);
  u.searchParams.set('start', String(start / 1000));
  u.searchParams.set('end', String(end / 1000));
  u.searchParams.set('step', '1');
  const r = await fetch(u);
  if (!r.ok) return [];
  const j = await r.json();
  return j.data?.result ?? [];
}

async function main() {
  mkdirSync(join(out, 'env'), { recursive: true });
  if (!existsSync(cli)) {
    log('CLI 빌드');
    sh('npm', ['run', 'build', '-w', '@load-simulator/cli']);
  }
  for (const tool of ['docker', 'k6']) {
    try {
      execFileSync(tool, ['--version'], { stdio: 'ignore' });
    } catch {
      throw new Error(`${tool}가 필요합니다`);
    }
  }

  // 1. same settings in the real deployment as in the scenario
  log('시나리오 설정 → Spring 환경 변수');
  for (const s of SERVICES) {
    const env = sim('spring-env', scenario, '--service', s);
    writeFileSync(join(out, 'env', `${s}.env`), env.split('\n').filter((l) => l && !l.startsWith('#')).join('\n') + '\n');
  }
  if (!args['skip-up']) {
    log('docker compose up (처음에는 이미지 빌드로 몇 분 걸립니다)');
    sh('docker', ['compose', 'up', '-d', '--build'], { cwd: here });
  }
  await waitFor(`${BASE}/actuator/health`, 'order');
  await waitFor(`${TOXI}/version`, 'toxiproxy');
  await waitFor(`${PROM}/-/ready`, 'prometheus');

  if (!args.reuse) {
    // the JIT needs tens of thousands of requests before latencies settle; a short, light warm-up leaves the
    // low-load calibration runs measuring a cold JVM (p50 falling as load rises)
    const warm = Math.max(...calibrateLevels);
    log(`워밍업 (JIT, 커넥션풀, 캐시) ${warm} rps × 60초`);
    k6At(warm, 60, 'warmup');
  }

  // 2. calibration on low load only
  const pointsFile = join(out, 'calibration-points.json');
  let points = [];
  if (args.reuse && existsSync(pointsFile)) {
    points = JSON.parse(readFileSync(pointsFile, 'utf8'));
    log(`보정용 측정 재사용 (${points.map((p) => p.rps).join(', ')} rps)`);
  } else {
    for (const rps of calibrateLevels) {
      log(`보정용 측정 ${rps} rps × 40초`);
      points.push(k6At(rps, 40, `cal-${rps}`));
    }
    writeFileSync(pointsFile, JSON.stringify(points, null, 2));
  }
  log('보정 (load-sim calibrate)');
  const calibrated = join(out, 'calibrated.yaml');
  const calOut = sim('calibrate', scenario, '--measured', join(out, 'calibration-points.json'), '--out', calibrated, '--duration', '20s');

  // 3. extrapolation: higher load levels the model has not seen
  const sections = [];
  for (const rps of validateLevels) {
    const file = join(out, `measured-${rps}.json`);
    if (!(args.reuse && existsSync(file))) {
      log(`검증 측정 ${rps} rps × 60초 (보정에 쓰지 않은 부하)`);
      writeFileSync(file, JSON.stringify(k6At(rps, 60, `val-${rps}`)));
    } else log(`검증 측정 ${rps} rps 재사용`);
    const table = sim('compare', calibrated, '--measured', join(out, `measured-${rps}.json`), '--rps', String(rps), '--duration', '60s', '--no-faults', '--title', `${rps} rps (외삽)`);
    sections.push(table);
  }

  // 4. fault run: the scenario's own traffic and faults, faults applied through Toxiproxy in real time
  if (args.fault) {
    log('장애 실행: k6 + Toxiproxy');
    const t0 = Date.now();
    const toxi = spawn('node', [cli, 'toxiproxy', scenario, '--api', TOXI, '--proxies', PROXIES], { stdio: 'inherit' });
    const m = k6At(0, 0, 'fault', { faults: true });
    toxi.kill();
    await sleep(3000);
    const open = await promQuery('max(resilience4j_circuitbreaker_state{state="open"})', t0, Date.now());
    const series = open[0]?.values ?? [];
    const first = series.find(([, v]) => Number(v) > 0);
    const measured = { throughput: m.throughput, p50: m.p50, p99: m.p99, errorRate: m.errorRate, ...(first ? { cbOpenAt: +(first[0] - t0 / 1000).toFixed(1) } : {}) };
    writeFileSync(join(out, 'measured-fault.json'), JSON.stringify(measured));
    sections.push(sim('compare', calibrated, '--measured', join(out, 'measured-fault.json'), '--title', '장애 시나리오 (Toxiproxy)'));
  }

  const date = new Date().toISOString().slice(0, 10);
  const report = [
    `# 검증 결과 ${date}`,
    '',
    `- 시나리오: \`${scenario.replace(root + '/', '')}\``,
    `- 보정 부하: ${calibrateLevels.join(', ')} rps / 검증 부하: ${validateLevels.join(', ')} rps`,
    `- 환경: docker compose (CPU·메모리 limit은 harness/docker-compose.yml)`,
    '',
    '## 보정',
    '',
    '```',
    calOut.trim(),
    '```',
    '',
    '## 오차',
    '',
    ...sections,
  ].join('\n');
  const file = join(out, `accuracy-${date}.md`);
  writeFileSync(file, report);
  log(`결과: ${file}`);
  console.log('\n' + sections.join('\n'));

  if (!args.keep) {
    log('docker compose down');
    sh('docker', ['compose', 'down'], { cwd: here });
  }
}

main().catch((e) => {
  console.error(`✖ ${e.message}`);
  process.exit(1);
});
