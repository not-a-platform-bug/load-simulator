// load-sim: the same engine as the browser, for terminals and CI.

import { readFileSync, writeFileSync } from 'node:fs';
import {
  checkModel,
  compileK6,
  faultPlan,
  findCapacity,
  loadModel,
  markdownReport,
  simulate,
  units,
  type Model,
  type Warning,
} from '@load-simulator/engine';
import { cmdCalibrate, cmdCompare, cmdImport, cmdSpringEnv, cmdToxiproxy } from './commands';

const HELP = `load-sim — 백엔드 물리엔진 CLI

사용법:
  load-sim run <scenario.yaml> [--seed N] [--json out.json] [--report out.md]
  load-sim check <scenario.yaml>                       정적 검사(timeout 역전, 재시도 증폭 등)
  load-sim capacity <scenario.yaml> [--p99 300ms] [--error-rate 0.1%] [--min-rps N]
                                                       SLO를 지키는 최대 RPS와 첫 병목. --min-rps 미달 시 exit 1 (CI 회귀 검사)
  load-sim k6 <scenario.yaml> [--out script.js] [--max-rps N] [--allow host1,host2] [--rps N --duration 40s --no-faults]
                                                       같은 시나리오를 k6 스크립트로 컴파일 + 장애 주입 계획 출력

가져오기·보정·검증:
  load-sim import --service order [--spring-src dir] [--openapi api.json] [--application application.yml]
                  [--profiles prod] [--traces otlp.json] [--prometheus before.txt,after.txt --seconds 60]
                  [--k6 script.js] [--k8s deploy.yaml --zones a,b,c] [--istio istio.yaml]
                  [--base existing.yaml] [--out scenario.yaml]
  load-sim calibrate <scenario.yaml> --measured points.json [--out calibrated.yaml]
                                                       여러 부하 수준의 실측(p99·처리량)에 맞춰 DB 경합 곡선 등을 보정
  load-sim compare <scenario.yaml> --measured measured.json [--out table.md]
                                                       실측 대비 오차표 (docs/accuracy.md 형식)
  load-sim spring-env <scenario.yaml> [--service order] [--format env|compose]
                                                       시나리오 설정 → Spring 환경 변수 오버라이드
  load-sim toxiproxy <scenario.yaml> [--api http://localhost:8474] [--proxies payment-db=mysql] [--dry-run]
                                                       시나리오의 장애를 실시간으로 Toxiproxy에 적용 (k6와 함께 실행)
`;

function args(argv: string[]) {
  const pos: string[] = [];
  const flags: Record<string, string> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const k = a.slice(2);
      const v = argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[++i] : 'true';
      flags[k] = v;
    } else pos.push(a);
  }
  return { pos, flags };
}

function load(path: string | undefined): Model {
  if (!path) {
    console.error(HELP);
    process.exit(2);
  }
  return loadModel(readFileSync(path, 'utf8'));
}

function printWarnings(ws: Warning[]) {
  const icon = { error: '✖', warn: '⚠', info: 'ℹ' };
  for (const w of ws) console.log(`${icon[w.level]} [${w.code}] ${w.message}`);
  if (!ws.length) console.log('✔ 정적 검사 경고 없음');
}

const fmt = units.fmtMs;

function main() {
  const [cmd, ...rest] = process.argv.slice(2);
  const { pos, flags } = args(rest);
  switch (cmd) {
    case 'run': {
      const model = load(pos[0]);
      const seed = flags.seed ? Number(flags.seed) : model.scenario.seed;
      const res = simulate(model, model.scenario, seed, { particles: false });
      const s = res.summary;
      console.log(`시뮬레이션 ${fmt(res.duration)} · 진입 요청 ${s.roots.toLocaleString()} · 사건 ${s.eventsProcessed.toLocaleString()} · ${s.wallMs}ms`);
      console.log(`처리량 ${s.throughput.toFixed(1)} rps · p50 ${fmt(s.p50)} · p95 ${fmt(s.p95)} · p99 ${fmt(s.p99)} · 에러율 ${(s.errorRate * 100).toFixed(2)}% · fallback ${s.degraded}`);
      console.log(s.sloPass ? '✔ SLO 충족' : `✖ SLO 위반: ${s.sloViolations.join('; ')}`);
      for (const e of res.endpoints.filter((x) => x.entry)) {
        console.log(`  ${e.op.padEnd(28)} ${e.throughput.toFixed(1).padStart(8)} rps  p99 ${fmt(e.p99).padStart(7)}  err ${(e.errorRate * 100).toFixed(2).padStart(6)}%  ${e.slo?.pass ? '✔' : '✖'}`);
      }
      if (s.errorCauses.length) console.log(`실패 원인: ${s.errorCauses.slice(0, 3).map((c) => `${c.cause} (${c.count})`).join(', ')}`);
      if (flags.json) writeFileSync(flags.json, JSON.stringify(res));
      if (flags.report) writeFileSync(flags.report, markdownReport(res, { warnings: checkModel(model) }));
      process.exit(s.sloPass ? 0 : flags['fail-on-slo'] ? 1 : 0);
    }
    case 'check': {
      const ws = checkModel(load(pos[0]));
      printWarnings(ws);
      process.exit(ws.some((w) => w.level === 'error') ? 1 : 0);
    }
    case 'capacity': {
      const model = load(pos[0]);
      const slo: Record<string, number> = {};
      if (flags.p99) slo.p99 = units.time(flags.p99);
      if (flags['error-rate']) slo.errorRate = units.ratio(flags['error-rate']);
      const t = Date.now();
      const cap = findCapacity(model, {
        slo,
        duration: flags.duration ? units.time(flags.duration) : undefined,
        onProbe: (p) =>
          console.log(
            `  ${String(p.rps).padStart(7)} rps  ${p.pass ? '✔' : '✖'}  가장 나쁜 API ${p.worst.endpoint}: p99 ${fmt(p.worst.p99)}, 에러 ${(p.worst.errorRate * 100).toFixed(2)}%`,
          ),
      });
      console.log(cap.summary);
      console.log(`(${cap.probes.length}회 실행, ${Date.now() - t}ms)`);
      if (flags.report) writeFileSync(flags.report, markdownReport(simulate(model), { capacity: cap, warnings: checkModel(model) }));
      const min = flags['min-rps'] ? Number(flags['min-rps']) : 0;
      if (min && cap.maxRps < min) {
        console.error(`✖ 산출 용량 ${cap.maxRps} RPS < 기준 ${min} RPS`);
        process.exit(1);
      }
      process.exit(0);
    }
    case 'k6': {
      const model = load(pos[0]);
      if (flags.rps) model.scenario.traffic = { type: 'constant', rps: Number(flags.rps) };
      if (flags.duration) model.scenario.duration = units.time(flags.duration);
      if (flags['no-faults']) model.scenario.faults = [];
      const script = compileK6(model, {
        maxRps: flags['max-rps'] ? Number(flags['max-rps']) : undefined,
        allowHosts: flags.allow ? flags.allow.split(',') : undefined,
      });
      if (flags.out) {
        writeFileSync(flags.out, script);
        console.log(`k6 스크립트: ${flags.out}`);
      } else console.log(script);
      const plan = faultPlan(model);
      if (plan.length) {
        console.error('\n장애 주입 계획 (Toxiproxy / tc netem):');
        for (const p of plan) console.error(`  ${fmt(p.at)}–${fmt(p.until)} ${p.target}: ${p.note} ${JSON.stringify(p.toxics)}${p.netem ? ` | ${p.netem}` : ''}`);
      }
      process.exit(0);
    }
    case 'import':
      process.exit(cmdImport(flags));
    case 'calibrate':
      process.exit(cmdCalibrate(pos[0], flags));
    case 'compare':
      process.exit(cmdCompare(pos[0], flags));
    case 'spring-env':
      process.exit(cmdSpringEnv(pos[0], flags));
    case 'toxiproxy':
      cmdToxiproxy(pos[0], flags).then(
        (c) => process.exit(c),
        (e) => {
          console.error(`✖ ${(e as Error).message}`);
          process.exit(2);
        },
      );
      return;
    default:
      console.log(HELP);
      process.exit(cmd ? 2 : 0);
  }
}

try {
  main();
} catch (e) {
  console.error(`✖ ${(e as Error).message}`);
  process.exit(2);
}
