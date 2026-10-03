// "Bring your real environment": configuration, source, API specs, traces, metrics and k6 scripts → one scenario.
import { useState } from 'react';
import {
  analyzeSpringSource,
  importIstio,
  importK6,
  importKubernetes,
  importOpenApi,
  importPrometheus,
  importSpringConfig,
  importTraces,
  mergeImports,
  type ImportReport,
  type RawDoc,
} from '@load-simulator/engine';
import { fromYaml } from './doc';

interface ServiceInput {
  name: string;
  instances: string;
  config: File[];
  openapi: File | null;
  source: File[];
  promBefore: File | null;
  promAfter: File | null;
  promSeconds: string;
}

const emptyService = (): ServiceInput => ({ name: '', instances: '', config: [], openapi: null, source: [], promBefore: null, promAfter: null, promSeconds: '60' });

function FilePick({ label, hint, multiple, dir, accept, files, onFiles }: {
  label: string;
  hint?: string;
  multiple?: boolean;
  dir?: boolean;
  accept?: string;
  files: File[];
  onFiles: (f: File[]) => void;
}) {
  return (
    <label className="filepick">
      <span>
        {label}
        {hint && <small>{hint}</small>}
      </span>
      <input
        type="file"
        multiple={multiple || dir}
        accept={accept}
        {...(dir ? ({ webkitdirectory: '', directory: '' } as any) : {})}
        onChange={(e) => onFiles(Array.from(e.target.files ?? []))}
      />
      <em>{files.length === 0 ? '선택 안 함' : dir ? `${files.filter((f) => /\.(java|kt)$/.test(f.name)).length}개 소스 파일` : files.map((f) => f.name).join(', ')}</em>
    </label>
  );
}

export function ImportWizard({ onClose, onCreate }: { onClose: () => void; onCreate: (doc: RawDoc, name: string, origin: string) => void }) {
  const [mode, setMode] = useState<'env' | 'yaml'>('env');
  const [services, setServices] = useState<ServiceInput[]>([emptyService()]);
  const [traces, setTraces] = useState<File[]>([]);
  const [k6, setK6] = useState<File[]>([]);
  const [k8s, setK8s] = useState<File[]>([]);
  const [istio, setIstio] = useState<File[]>([]);
  const [name, setName] = useState('내 환경');
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{ doc: RawDoc; notes: string[]; error?: string; stats: string } | null>(null);
  const [yamlFile, setYamlFile] = useState<File[]>([]);
  const [failure, setFailure] = useState<string | null>(null);

  const update = (i: number, patch: Partial<ServiceInput>) => setServices((s) => s.map((x, k) => (k === i ? { ...x, ...patch } : x)));

  const run = async () => {
    setBusy(true);
    setFailure(null);
    try {
      const reports: ImportReport[] = [];
      for (const s of services) {
        const service = s.name.trim() || undefined;
        const instances = s.instances ? Number(s.instances) : undefined;
        const configs: ImportReport[] = [];
        for (const f of s.config) configs.push(importSpringConfig(await f.text(), { service, instances }));
        const svcName = service ?? Object.keys(configs[0]?.doc.nodes ?? {}).find((k) => configs[0].doc.nodes![k].kind === 'service');
        const db = configs.flatMap((r) => Object.entries<any>(r.doc.nodes ?? {}).filter(([, n]) => n.kind === 'db').map(([k]) => k))[0];
        const src = s.source.filter((f) => /\.(java|kt)$/.test(f.name));
        if (src.length) {
          if (!svcName) throw new Error('소스 분석에는 서비스 이름이 필요합니다 (이름 칸 또는 application.yml의 spring.application.name)');
          const files = await Promise.all(src.map(async (f) => ({ path: (f as any).webkitRelativePath || f.name, content: await f.text() })));
          reports.push(analyzeSpringSource(files, { service: svcName, db }));
        }
        if (s.openapi) reports.push(importOpenApi(await s.openapi.text(), { service: svcName }));
        reports.push(...configs);
        if (s.promBefore && s.promAfter) {
          if (!svcName) throw new Error('Prometheus 지표에는 서비스 이름이 필요합니다');
          reports.push(importPrometheus(await s.promBefore.text(), await s.promAfter.text(), { service: svcName, seconds: Number(s.promSeconds) || 60, instances }));
        }
      }
      if (traces.length) {
        const inputs: unknown[] = [];
        for (const f of traces) {
          const text = await f.text();
          try {
            inputs.push(JSON.parse(text));
          } catch {
            // OTLP file exporter writes one JSON document per line
            for (const line of text.split(/\r?\n/)) if (line.trim()) inputs.push(JSON.parse(line));
          }
        }
        reports.push(importTraces(inputs.length === 1 ? inputs[0] : inputs));
      }
      for (const f of k6) reports.push(importK6(await f.text(), { service: services.length === 1 ? services[0].name.trim() || undefined : undefined }));
      for (const f of k8s) reports.push(importKubernetes(await f.text()));
      for (const f of istio) reports.push(importIstio(await f.text()));
      if (!reports.length) throw new Error('가져올 파일을 하나 이상 고르세요.');
      const merged = mergeImports(reports);
      const nodes = Object.values<any>(merged.doc.nodes ?? {});
      const eps = nodes.flatMap((n) => Object.values<any>(n.endpoints ?? {}));
      const stats = `노드 ${nodes.length}개 · API ${eps.length}개 (실측 ${eps.filter((e) => e.observed !== false).length}, 추정 ${eps.filter((e) => e.observed === false).length})`;
      setResult({ ...merged, stats });
    } catch (e) {
      setFailure((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const openYaml = async () => {
    try {
      const f = yamlFile[0];
      if (!f) throw new Error('YAML 파일을 고르세요.');
      onCreate(fromYaml(await f.text()), f.name.replace(/\.ya?ml$/, ''), 'file');
    } catch (e) {
      setFailure((e as Error).message);
    }
  };

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" role="dialog" aria-modal="true" aria-label="내 환경 가져오기" onClick={(e) => e.stopPropagation()}>
        <header>
          <h2>내 환경 가져오기</h2>
          <button className="ghost" onClick={onClose} aria-label="닫기">
            ✕
          </button>
        </header>
        <div className="seg">
          <button className={mode === 'env' ? 'active' : ''} onClick={() => setMode('env')}>
            설정·소스·트레이스에서
          </button>
          <button className={mode === 'yaml' ? 'active' : ''} onClick={() => setMode('yaml')}>
            시나리오 YAML 열기
          </button>
        </div>

        {mode === 'yaml' ? (
          <div className="modal-body">
            <FilePick label="시나리오 파일" accept=".yaml,.yml" files={yamlFile} onFiles={setYamlFile} />
            {failure && <p className="error-text">{failure}</p>}
            <footer>
              <button className="primary" onClick={openYaml}>
                열기
              </button>
            </footer>
          </div>
        ) : (
          <div className="modal-body">
            <p className="muted small">
              실제 서비스의 설정과 측정값을 그대로 옮겨옵니다. 모두 브라우저 안에서 처리되며 어디로도 전송되지 않습니다. 트레이스가 있으면 처리 시간·호출 관계가 실측값으로 채워지고, 없는 API는
              “추정”으로 표시됩니다.
            </p>
            {services.map((s, i) => (
              <fieldset key={i} className="svc-import">
                <legend>
                  서비스 {i + 1}
                  {services.length > 1 && (
                    <button className="link" onClick={() => setServices((x) => x.filter((_, k) => k !== i))}>
                      빼기
                    </button>
                  )}
                </legend>
                <div className="row2">
                  <label>
                    이름 <input value={s.name} placeholder="spring.application.name" onChange={(e) => update(i, { name: e.target.value })} />
                  </label>
                  <label>
                    인스턴스 수 <input value={s.instances} placeholder="1" onChange={(e) => update(i, { instances: e.target.value })} />
                  </label>
                </div>
                <FilePick label="application.yml / .properties" hint="Tomcat·HikariCP·Resilience4j·Feign·RabbitMQ·Kafka·Spring Cloud Gateway" multiple accept=".yml,.yaml,.properties" files={s.config} onFiles={(f) => update(i, { config: f })} />
                <FilePick label="소스 폴더" hint="@RestController·@KafkaListener·@Scheduled·Feign·Repository 정적 분석" dir files={s.source} onFiles={(f) => update(i, { source: f })} />
                <FilePick label="OpenAPI (springdoc)" accept=".json,.yaml,.yml" files={s.openapi ? [s.openapi] : []} onFiles={(f) => update(i, { openapi: f[0] ?? null })} />
                <div className="row2">
                  <FilePick label="Prometheus 스크랩 (이전)" hint="/actuator/prometheus" accept=".txt,.prom" files={s.promBefore ? [s.promBefore] : []} onFiles={(f) => update(i, { promBefore: f[0] ?? null })} />
                  <FilePick label="Prometheus 스크랩 (이후)" accept=".txt,.prom" files={s.promAfter ? [s.promAfter] : []} onFiles={(f) => update(i, { promAfter: f[0] ?? null })} />
                </div>
                {s.promBefore && (
                  <label className="inline">
                    두 스크랩 사이 간격(초) <input value={s.promSeconds} onChange={(e) => update(i, { promSeconds: e.target.value })} />
                  </label>
                )}
              </fieldset>
            ))}
            <button className="ghost" onClick={() => setServices((s) => [...s, emptyService()])}>
              + 서비스 추가
            </button>
            <fieldset>
              <legend>시스템 전체</legend>
              <FilePick label="OpenTelemetry 트레이스 (OTLP JSON)" hint="처리 시간 분포·호출 그래프·호출 횟수·트래픽 믹스" multiple accept=".json,.jsonl" files={traces} onFiles={setTraces} />
              <FilePick label="k6 스크립트" hint="트래픽 패턴·API 믹스·SLO" accept=".js,.ts" files={k6} onFiles={setK6} />
            </fieldset>
            <fieldset>
              <legend>인프라</legend>
              <FilePick label="Kubernetes 매니페스트" hint="replicas·CPU limit·힙·readinessProbe·존 분산" multiple accept=".yaml,.yml" files={k8s} onFiles={setK8s} />
              <FilePick label="Istio (VirtualService·DestinationRule)" hint="메시 재시도·timeout·outlier detection·connection pool" multiple accept=".yaml,.yml" files={istio} onFiles={setIstio} />
            </fieldset>
            {failure && <p className="error-text">{failure}</p>}
            {result && (
              <div className="import-result">
                <strong>{result.stats}</strong>
                {result.error && <p className="error-text">아직 실행할 수 없는 부분이 있습니다: {result.error} — 시나리오를 연 뒤 설정 패널이나 YAML에서 고치세요.</p>}
                <ul>
                  {result.notes.map((n, i) => (
                    <li key={i}>{n}</li>
                  ))}
                </ul>
              </div>
            )}
            <footer>
              {result ? (
                <>
                  <label className="inline">
                    이름 <input value={name} onChange={(e) => setName(e.target.value)} />
                  </label>
                  <button className="ghost" onClick={() => setResult(null)}>
                    다시 고르기
                  </button>
                  <button className="primary" onClick={() => onCreate(result.doc, name, 'import')}>
                    시나리오로 열기
                  </button>
                </>
              ) : (
                <button className="primary" disabled={busy} onClick={run}>
                  {busy ? '분석 중…' : '가져오기'}
                </button>
              )}
            </footer>
          </div>
        )}
      </div>
    </div>
  );
}
