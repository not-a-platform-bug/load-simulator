// Commands that connect the simulator to real systems: import, calibrate, compare, spring-env, toxiproxy.
import { readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { stringify } from 'yaml';
import {
  analyzeSpringSource,
  calibrate,
  compareWithMeasurement,
  comparisonMarkdown,
  faultPlan,
  findCapacity,
  importIstio,
  importK6,
  importKubernetes,
  importOpenApi,
  importPrometheus,
  importSpringConfig,
  importTraces,
  loadModel,
  mergeImports,
  parseYamlDoc,
  simulate,
  springEnv,
  units,
  type ImportReport,
  type Measured,
  type Measurement,
} from '@load-simulator/engine';

type Flags = Record<string, string>;

function walk(dir: string): { path: string; content: string }[] {
  return readdirSync(dir).flatMap((f) => {
    if (f === 'node_modules' || f === 'build' || f === 'target' || f.startsWith('.')) return [];
    const p = join(dir, f);
    if (statSync(p).isDirectory()) return walk(p);
    return /\.(java|kt)$/.test(f) ? [{ path: p, content: readFileSync(p, 'utf8') }] : [];
  });
}

const list = (v?: string) => (v ? v.split(',').map((s) => s.trim()).filter(Boolean) : []);

export function cmdImport(flags: Flags): number {
  const service = flags.service;
  const reports: ImportReport[] = [];
  // application.yml first: its datasource names the DB node that repository calls should point to
  const config = list(flags.application).map((f) =>
    importSpringConfig(readFileSync(f, 'utf8'), { service, profiles: list(flags.profiles), instances: flags.instances ? Number(flags.instances) : undefined }),
  );
  const db = config.flatMap((r) => Object.entries<any>(r.doc.nodes ?? {}).filter(([, n]) => n.kind === 'db').map(([k]) => k))[0];
  for (const dir of list(flags['spring-src'])) {
    if (!service) throw new Error('--spring-src에는 --service 이름이 필요합니다');
    reports.push(analyzeSpringSource(walk(dir), { service, db }));
  }
  for (const f of list(flags.openapi)) reports.push(importOpenApi(readFileSync(f, 'utf8'), { service }));
  reports.push(...config);
  if (flags.prometheus) {
    const [before, after] = list(flags.prometheus);
    if (!after || !service || !flags.seconds) throw new Error('--prometheus before.txt,after.txt --seconds N --service 이름이 필요합니다');
    reports.push(importPrometheus(readFileSync(before, 'utf8'), readFileSync(after, 'utf8'), { service, seconds: Number(flags.seconds), instances: flags.instances ? Number(flags.instances) : 1 }));
  }
  if (flags.traces) {
    const inputs = list(flags.traces).flatMap((f) =>
      readFileSync(f, 'utf8')
        .split(/\r?\n/)
        .filter((l) => l.trim())
        .flatMap((l, i, all) => (all.length > 1 && l.trim().startsWith('{') ? [JSON.parse(l)] : i === 0 ? [JSON.parse(all.join('\n'))] : [])),
    );
    reports.push(importTraces(inputs.length === 1 ? inputs[0] : inputs));
  }
  for (const f of list(flags.k6)) reports.push(importK6(readFileSync(f, 'utf8'), { service }));
  for (const f of list(flags.k8s)) reports.push(importKubernetes(readFileSync(f, 'utf8'), { zones: flags.zones ? list(flags.zones) : undefined }));
  for (const f of list(flags.istio)) reports.push(importIstio(readFileSync(f, 'utf8')));
  if (!reports.length) throw new Error('가져올 입력이 없습니다 (--spring-src, --openapi, --application, --prometheus, --traces, --k6, --k8s, --istio)');
  const base = flags.base ? parseYamlDoc(readFileSync(flags.base, 'utf8')) : {};
  const { doc, notes, error } = mergeImports(reports, base);
  for (const n of notes) console.error(`  · ${n}`);
  const yaml = `# load-sim import (${new Date().toISOString().slice(0, 10)})\n# 미관측(observed: false) API는 처리 시간이 추정값입니다.\n${stringify(doc, { lineWidth: 0 })}`;
  if (flags.out) writeFileSync(flags.out, yaml);
  else console.log(yaml);
  if (error) {
    console.error(`✖ 가져온 모델이 아직 유효하지 않습니다: ${error}`);
    return 1;
  }
  if (flags.out) console.error(`✔ ${flags.out}`);
  return 0;
}

export function cmdCalibrate(file: string, flags: Flags): number {
  if (!flags.measured) throw new Error('--measured points.json 이 필요합니다 ([{ "rps": 500, "p99": 120, "throughput": 498 }, ...])');
  const doc = parseYamlDoc(readFileSync(file, 'utf8'));
  const points: Measurement[] = JSON.parse(readFileSync(flags.measured, 'utf8'));
  const res = calibrate(doc, points, {
    duration: flags.duration ? units.time(flags.duration) : undefined,
    onProgress: (m) => console.error(`  ${m}`),
  });
  console.log(`손실 ${res.loss.before.toFixed(4)} → ${res.loss.after.toFixed(4)}`);
  for (const p of res.params) console.log(`  ${p.path}: ${p.before ?? '(기본값)'} → ${p.after}`);
  console.log('\n| rps | 실측 p99 | 시뮬 p99 | 실측 처리량 | 시뮬 처리량 |\n|---:|---:|---:|---:|---:|');
  for (const p of res.points)
    console.log(`| ${p.rps} | ${p.measured.p99 ?? '—'} | ${p.simulated.p99.toFixed(1)} | ${p.measured.throughput ?? '—'} | ${p.simulated.throughput.toFixed(1)} |`);
  const out = flags.out ?? file.replace(/\.ya?ml$/, '.calibrated.yaml');
  writeFileSync(out, stringify(res.doc, { lineWidth: 0 }));
  console.error(`✔ ${out}`);
  return 0;
}

export function cmdCompare(file: string, flags: Flags): number {
  if (!flags.measured) throw new Error('--measured measured.json 이 필요합니다');
  const model = loadModel(readFileSync(file, 'utf8'));
  const measured: Measured = JSON.parse(readFileSync(flags.measured, 'utf8'));
  if (flags.rps) model.scenario.traffic = { type: 'constant', rps: Number(flags.rps) };
  if (flags.duration) model.scenario.duration = units.time(flags.duration);
  if (flags['no-faults']) model.scenario.faults = [];
  const sim = simulate(model, model.scenario, model.scenario.seed, { particles: false });
  const cap = measured.capacityRps !== undefined ? findCapacity(model).maxRps : undefined;
  const rows = compareWithMeasurement(sim, measured, cap);
  const md = comparisonMarkdown(flags.title ?? basename(file), rows);
  console.log(md);
  if (flags.out) writeFileSync(flags.out, md);
  if (flags.json) writeFileSync(flags.json, JSON.stringify(rows));
  return rows.every((r) => r.pass !== false) ? 0 : flags['fail-on-error'] ? 1 : 0;
}

export function cmdSpringEnv(file: string, flags: Flags): number {
  const model = loadModel(readFileSync(file, 'utf8'));
  const services = flags.service ? [flags.service] : Object.values(model.nodes).filter((n) => n.kind === 'service').map((n) => n.name);
  for (const s of services) {
    const vars = springEnv(model, s);
    if (flags.format === 'compose') {
      console.log(`  ${s}:\n    environment:`);
      for (const [k, v] of Object.entries(vars)) console.log(`      ${k}: "${v}"`);
    } else {
      console.log(`# ${s}`);
      for (const [k, v] of Object.entries(vars)) console.log(`${k}=${JSON.stringify(v)}`);
    }
  }
  return 0;
}

/**
 * Applies the scenario's fault plan to a running Toxiproxy in real time (start it together with k6).
 * --proxies maps scenario targets to Toxiproxy proxy names, e.g. payment-db=mysql-payment,order->payment=payment
 */
export async function cmdToxiproxy(file: string, flags: Flags): Promise<number> {
  const model = loadModel(readFileSync(file, 'utf8'));
  const api = (flags.api ?? 'http://localhost:8474').replace(/\/$/, '');
  const map = Object.fromEntries(list(flags.proxies).map((kv) => kv.split('=') as [string, string]));
  const plan = faultPlan(model);
  if (!plan.length) {
    console.log('시나리오에 장애가 없습니다.');
    return 0;
  }
  const dry = flags['dry-run'] === 'true';
  const t0 = Date.now();
  const at = (ms: number) => new Promise((r) => setTimeout(r, Math.max(0, t0 + ms - Date.now())));
  const call = async (method: string, path: string, body?: unknown) => {
    if (dry) {
      console.log(`  [dry-run] ${method} ${api}${path} ${body ? JSON.stringify(body) : ''}`);
      return;
    }
    const res = await fetch(`${api}${path}`, { method, headers: { 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
    if (!res.ok && res.status !== 404) throw new Error(`Toxiproxy ${method} ${path}: ${res.status} ${await res.text()}`);
  };
  const steps = plan.flatMap((p, i) => {
    const proxy = map[p.target] ?? p.target;
    const names = p.toxics.map((t, k) => `ls-${i}-${k}-${t.type}`);
    const start = { t: p.at, run: () => Promise.all(p.toxics.map((t, k) => call('POST', `/proxies/${proxy}/toxics`, { name: names[k], type: t.type, stream: 'downstream', toxicity: 1, attributes: t.attributes }))) };
    const stop = Number.isFinite(p.until) ? [{ t: p.until, run: () => Promise.all(names.map((n) => call('DELETE', `/proxies/${proxy}/toxics/${n}`))) }] : [];
    if (p.note) console.log(`  ${units.fmtMs(p.at)} ${p.target} → proxy "${proxy}": ${p.note}${p.netem ? ` (네트워크 손실은 tc로: ${p.netem})` : ''}`);
    return p.toxics.length ? [start, ...stop] : [];
  });
  steps.sort((a, b) => a.t - b.t);
  for (const s of steps) {
    await at(s.t);
    await s.run();
    console.log(`  ${((Date.now() - t0) / 1000).toFixed(1)}s 적용`);
  }
  return 0;
}
