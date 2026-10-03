import { createContext, useContext, useEffect, useState, type ReactNode } from 'react';
import type { RawDoc } from '@load-simulator/engine';
import { getPath, nodeKind, setPath, type Path } from './doc';
import { fmtDur, toMb, toMs, toRatio } from './format';
import type { Selection } from './Canvas';
import { AddEndpoint, EndpointHeader, FlowEditor } from './FlowEditor';

/** Paths changed by the demo's fix, highlighted so the "one slider" is easy to find. */
const Changed = createContext<string[]>([]);
const key = (p: Path) => p.join('/');

type Kind = 'int' | 'float' | 'dur' | 'ratio' | 'pctnum' | 'mem' | 'kb' | 'rate' | 'bool' | 'select';

interface FieldDef {
  label: string;
  path: Path;
  kind: Kind;
  def: number | boolean | string;
  min?: number;
  max?: number;
  step?: number;
  log?: boolean;
  options?: string[];
  hint?: string;
}

function read(doc: RawDoc, f: FieldDef): number | boolean | string {
  const v = getPath(doc, f.path);
  switch (f.kind) {
    case 'bool':
      return v === undefined ? f.def : v !== false;
    case 'select':
      return v ?? f.def;
    case 'dur':
      return toMs(v, f.def as number);
    case 'ratio':
      return toRatio(v, f.def as number);
    case 'pctnum':
      return v === undefined ? (f.def as number) : Number(v);
    case 'mem':
      return toMb(v, f.def as number);
    case 'rate':
      return v === undefined ? (f.def as number) : parseFloat(String(v));
    case 'kb': {
      if (v === undefined) return f.def as number;
      const m = /^\s*([\d.]+)\s*([kmg]?)b?\s*$/i.exec(String(v));
      if (!m) return f.def as number;
      const unit = m[2].toLowerCase();
      return Number(m[1]) * (unit === 'k' ? 1 : unit === 'm' ? 1024 : unit === 'g' ? 1024 * 1024 : 1 / 1024);
    }
    default:
      return v === undefined ? (f.def as number) : Number(v);
  }
}

function encode(f: FieldDef, n: number | boolean | string): unknown {
  switch (f.kind) {
    case 'bool':
    case 'select':
      return n;
    case 'dur':
      return fmtDur(n as number);
    case 'ratio':
      return `${+((n as number) * 100).toFixed(3)}%`;
    case 'mem': {
      const mb = Math.round(n as number);
      return mb % 1024 === 0 ? `${mb / 1024}g` : `${mb}m`;
    }
    case 'rate':
      return `${+(n as number).toFixed(1)}rps`;
    case 'kb': {
      const kb = n as number;
      return kb >= 1024 ? `${+(kb / 1024).toFixed(1)}mb` : `${Math.max(1, Math.round(kb))}kb`;
    }
    case 'int':
      return Math.round(n as number);
    default:
      return n;
  }
}

function Slider({ f, value, onChange }: { f: FieldDef; value: number; onChange: (v: number) => void }) {
  const min = f.min ?? 0;
  const max = f.max ?? 100;
  const toPos = (v: number) => (f.log ? (Math.log(Math.max(v, min)) - Math.log(min)) / (Math.log(max) - Math.log(min)) : (v - min) / (max - min));
  const fromPos = (p: number) => {
    const v = f.log ? Math.exp(Math.log(min) + p * (Math.log(max) - Math.log(min))) : min + p * (max - min);
    const step = f.step ?? (f.kind === 'int' ? 1 : 0);
    if (f.log) {
      const mag = Math.pow(10, Math.floor(Math.log10(v)) - 1);
      return Math.round(v / mag) * mag;
    }
    return step ? Math.round(v / step) * step : v;
  };
  const display = f.kind === 'ratio' ? +(value * 100).toFixed(3) : f.kind === 'dur' ? +value.toFixed(2) : +(+value).toFixed(3);
  const [text, setText] = useState(String(display));
  useEffect(() => setText(String(display)), [display]);
  const unit = f.kind === 'dur' ? 'ms' : f.kind === 'ratio' || f.kind === 'pctnum' ? '%' : f.kind === 'mem' ? 'MB' : f.kind === 'kb' ? 'KB' : f.kind === 'rate' ? 'rps' : '';
  return (
    <div className="slider">
      <input
        type="range"
        min={0}
        max={1000}
        value={Math.round(Math.max(0, Math.min(1, toPos(value))) * 1000)}
        onChange={(e) => onChange(fromPos(Number(e.target.value) / 1000))}
        aria-label={f.label}
      />
      <span className="num">
        <input
          value={text}
          onChange={(e) => setText(e.target.value)}
          onBlur={() => {
            const n = Number(text);
            if (Number.isFinite(n)) onChange(f.kind === 'ratio' ? n / 100 : n);
            else setText(String(display));
          }}
          onKeyDown={(e) => e.key === 'Enter' && (e.target as HTMLInputElement).blur()}
          aria-label={`${f.label} 값`}
        />
        {unit && <i>{unit}</i>}
      </span>
    </div>
  );
}

function Field({ doc, f, onDoc }: { doc: RawDoc; f: FieldDef; onDoc: (d: RawDoc) => void }) {
  const v = read(doc, f);
  const set = (n: number | boolean | string) => onDoc(setPath(doc, f.path, encode(f, n)));
  const changed = useContext(Changed).includes(key(f.path));
  return (
    <label className={`field kind-${f.kind}${changed ? ' changed' : ''}`}>
      <span className="field-label">
        {f.label}
        {f.hint && <small>{f.hint}</small>}
      </span>
      {f.kind === 'bool' ? (
        <input type="checkbox" className="switch" checked={v as boolean} onChange={(e) => set(e.target.checked)} />
      ) : f.kind === 'select' ? (
        <select value={v as string} onChange={(e) => set(e.target.value)}>
          {f.options!.map((o) => (
            <option key={o}>{o}</option>
          ))}
        </select>
      ) : (
        <Slider f={f} value={v as number} onChange={set} />
      )}
    </label>
  );
}

/** A resilience policy section with an on/off switch. Off keeps the parameters (enabled: false). */
function Policy({ doc, base, name, title, defaults, fields, onDoc, children }: {
  doc: RawDoc;
  base: Path;
  name: string;
  title: string;
  defaults: Record<string, unknown>;
  fields: FieldDef[];
  onDoc: (d: RawDoc) => void;
  children?: ReactNode;
}) {
  const raw = getPath(doc, [...base, name]);
  const on = raw !== undefined && raw !== null && raw !== false && raw?.enabled !== false;
  const prefix = key([...base, name]);
  const changed = useContext(Changed).some((c) => c === prefix || c.startsWith(prefix + '/'));
  const toggle = (next: boolean) => {
    if (next) {
      const obj = raw && typeof raw === 'object' ? { ...raw, enabled: true } : { ...defaults };
      onDoc(setPath(doc, [...base, name], obj));
    } else if (raw && typeof raw === 'object') onDoc(setPath(doc, [...base, name, 'enabled'], false));
    else onDoc(setPath(doc, [...base, name], undefined));
  };
  return (
    <section className={`policy${on ? ' on' : ''}${changed ? ' changed' : ''}`}>
      <header>
        <h4>
          {title}
          {changed && <span className="changed-tag">막는 장면에서 바뀜</span>}
        </h4>
        <input type="checkbox" className="switch" checked={on} onChange={(e) => toggle(e.target.checked)} aria-label={`${title} 켜기`} />
      </header>
      {on && (
        <div className="fields">
          {fields.map((f) => (
            <Field key={f.path.join('.')} doc={doc} f={{ ...f, path: [...base, name, ...f.path] }} onDoc={onDoc} />
          ))}
          {children}
        </div>
      )}
    </section>
  );
}

function Fields({ doc, defs, onDoc }: { doc: RawDoc; defs: FieldDef[]; onDoc: (d: RawDoc) => void }) {
  return (
    <div className="fields">
      {defs.map((f) => (
        <Field key={f.path.join('.')} doc={doc} f={f} onDoc={onDoc} />
      ))}
    </div>
  );
}

// ---------------------------------------------------------------------------

function DistFields({ doc, path, onDoc, label }: { doc: RawDoc; path: Path; onDoc: (d: RawDoc) => void; label: string }) {
  const raw = getPath(doc, path);
  if (raw && typeof raw === 'object' && raw.p50 !== undefined) {
    return (
      <>
        <Field doc={doc} f={{ label: `${label} p50`, path: [...path, 'p50'], kind: 'dur', def: 5, min: 0.1, max: 5000, log: true }} onDoc={onDoc} />
        <Field doc={doc} f={{ label: `${label} p99`, path: [...path, 'p99'], kind: 'dur', def: 25, min: 0.1, max: 30000, log: true }} onDoc={onDoc} />
      </>
    );
  }
  if (raw === undefined || typeof raw === 'string' || typeof raw === 'number') {
    return <Field doc={doc} f={{ label, path, kind: 'dur', def: 2, min: 0.05, max: 5000, log: true }} onDoc={onDoc} />;
  }
  return (
    <div className="field">
      <span className="field-label">{label}</span>
      <code className="mono">{JSON.stringify(raw)}</code>
    </div>
  );
}

function ServicePanel({ doc, name, onDoc }: { doc: RawDoc; name: string; onDoc: (d: RawDoc) => void }) {
  const b = ['nodes', name];
  const eps = Object.keys(getPath(doc, [...b, 'endpoints']) ?? {});
  const model = getPath(doc, [...b, 'runtime', 'model']) ?? 'tomcat';
  return (
    <>
      <h3>애플리케이션</h3>
      <Fields
        doc={doc}
        onDoc={onDoc}
        defs={[
          { label: '인스턴스 수', path: [...b, 'instances'], kind: 'int', def: 1, min: 1, max: 40 },
          { label: '런타임', hint: 'tomcat = 요청당 스레드', path: [...b, 'runtime', 'model'], kind: 'select', def: 'tomcat', options: ['tomcat', 'webflux', 'virtual'] },
          ...(model === 'webflux' ? [{ label: '이벤트 루프', path: [...b, 'runtime', 'eventLoops'], kind: 'int' as const, def: 2, min: 1, max: 64 }] : []),
          ...(model === 'virtual' ? [{ label: 'pinning 비율', hint: 'synchronized 안의 블로킹 호출', path: [...b, 'runtime', 'pinning'], kind: 'ratio' as const, def: 0, min: 0, max: 1, step: 0.01 }] : []),
          { label: '워커 스레드', hint: 'server.tomcat.threads.max', path: [...b, 'runtime', 'threads'], kind: 'int', def: 200, min: 1, max: 800, log: true },
          { label: 'accept-count', hint: 'listen backlog (somaxconn과 작은 값)', path: [...b, 'runtime', 'acceptCount'], kind: 'int', def: 100, min: 1, max: 4096, log: true },
          { label: 'max-connections', path: [...b, 'runtime', 'maxConnections'], kind: 'int', def: 8192, min: 10, max: 20000, log: true },
        ]}
      />
      <h3>OS</h3>
      <Fields
        doc={doc}
        onDoc={onDoc}
        defs={[
          { label: 'vCPU', path: [...b, 'os', 'vcpu'], kind: 'float', def: 2, min: 0.5, max: 32, step: 0.5 },
          { label: '힙', path: [...b, 'os', 'heap'], kind: 'mem', def: 1024, min: 128, max: 32768, log: true },
          { label: 'GC', path: [...b, 'os', 'gc'], kind: 'select', def: 'g1', options: ['g1', 'parallel', 'serial', 'zgc'] },
          { label: 'somaxconn', path: [...b, 'os', 'somaxconn'], kind: 'int', def: 4096, min: 1, max: 65535, log: true },
          { label: '컨테이너 CPU limit', hint: 'cgroup 쿼터 (vCPU 이상이면 제한 없음)', path: [...b, 'os', 'cpuLimit'], kind: 'float', def: 64, min: 0.25, max: 64, step: 0.25 },
          { label: 'ulimit -n', path: [...b, 'os', 'ulimit'], kind: 'int', def: 1048576, min: 64, max: 1048576, log: true },
        ]}
      />
      <ZonesField doc={doc} name={name} onDoc={onDoc} />
      <Policy
        doc={doc}
        base={b}
        name="healthCheck"
        title="로드밸런서 헬스체크"
        defaults={{ interval: '5s', threshold: 3 }}
        onDoc={onDoc}
        fields={[
          { label: '간격', path: ['interval'], kind: 'dur', def: 10000, min: 500, max: 60000, log: true },
          { label: '제외 기준 (연속 실패)', path: ['threshold'], kind: 'int', def: 3, min: 1, max: 10 },
          { label: '복귀 기준 (연속 성공)', path: ['riseThreshold'], kind: 'int', def: 2, min: 1, max: 10 },
        ]}
      />
      <h3>API</h3>
      <p className="muted small">API마다 DB·캐시·큐·다른 서비스를 어떤 순서로 호출하는지 지정합니다. 병렬 그룹, 호출 사이 처리 시간, 캐시 미스 경로도 넣을 수 있습니다.</p>
      {eps.map((ep) => (
        <details key={ep} className="endpoint" open={eps.length <= 2}>
          <summary>
            <EndpointHeader doc={doc} svc={name} ep={ep} onDoc={onDoc} />
          </summary>
          <div className="fields">
            <DistFields doc={doc} path={[...b, 'endpoints', ep, 'selfTime']} onDoc={onDoc} label="자체 처리" />
            <Field doc={doc} f={{ label: 'CPU 시간', path: [...b, 'endpoints', ep, 'cpu'], kind: 'dur', def: 0, min: 0.01, max: 500, log: true, hint: '미지정 시 자체 처리의 30%' }} onDoc={onDoc} />
          </div>
          <FlowEditor doc={doc} svc={name} ep={ep} onDoc={onDoc} />
        </details>
      ))}
      <AddEndpoint doc={doc} svc={name} onDoc={onDoc} />
    </>
  );
}

function DbPanel({ doc, name, onDoc }: { doc: RawDoc; name: string; onDoc: (d: RawDoc) => void }) {
  const b = ['nodes', name];
  const qs = Object.keys(getPath(doc, [...b, 'queries']) ?? {});
  return (
    <>
      <h3>DB 서버</h3>
      <Fields
        doc={doc}
        onDoc={onDoc}
        defs={[
          { label: 'max_connections', path: [...b, 'maxConnections'], kind: 'int', def: 151, min: 10, max: 5000, log: true },
          { label: '포화 동시성', hint: '이 동시성에서 지연이 아래 배수가 됨', path: [...b, 'contention', 'saturation'], kind: 'int', def: 32, min: 2, max: 512, log: true },
          { label: '포화 시 지연 배수', path: [...b, 'contention', 'latencyX'], kind: 'float', def: 3, min: 1, max: 20, step: 0.1 },
          { label: '곡선 형태', path: [...b, 'contention', 'shape'], kind: 'float', def: 1.5, min: 0.5, max: 4, step: 0.1 },
          { label: '역행 계수', hint: '포화 뒤 처리량이 떨어지는 정도', path: [...b, 'contention', 'retrograde'], kind: 'float', def: 0, min: 0, max: 3, step: 0.05 },
        ]}
      />
      <h3>클러스터</h3>
      <Fields
        doc={doc}
        onDoc={onDoc}
        defs={[
          { label: '샤드', hint: '키로 나눈 primary 수', path: [...b, 'cluster', 'shards'], kind: 'int', def: 1, min: 1, max: 64, log: true },
          { label: '샤드 키 쏠림', hint: '0 = 고르게', path: [...b, 'cluster', 'keySkew'], kind: 'float', def: 0, min: 0, max: 3, step: 0.1 },
          { label: '샤드당 읽기 레플리카', path: [...b, 'cluster', 'replicas'], kind: 'int', def: 0, min: 0, max: 8 },
          { label: '읽기를 레플리카로', hint: 'select/find/get… 쿼리', path: [...b, 'cluster', 'readSplit'], kind: 'bool', def: false },
          { label: 'failover 시간', hint: 'primary 장애 → 승격까지', path: [...b, 'cluster', 'failoverTime'], kind: 'dur', def: 30000, min: 1000, max: 120000, log: true },
        ]}
      />
      <ZonesField doc={doc} name={name} onDoc={onDoc} />
      <h3>쿼리</h3>
      {qs.map((q) => {
        const raw = getPath(doc, [...b, 'queries', q]);
        const path = raw && typeof raw === 'object' && 'latency' in raw ? [...b, 'queries', q, 'latency'] : [...b, 'queries', q];
        return (
          <details key={q} className="endpoint" open={qs.length <= 3}>
            <summary>
              <code>{q}</code>
            </summary>
            <div className="fields">
              <DistFields doc={doc} path={path} onDoc={onDoc} label="지연" />
              {path[path.length - 1] === 'latency' && (
                <Field doc={doc} f={{ label: '모든 샤드 조회 (scatter)', path: [...b, 'queries', q, 'scatter'], kind: 'bool', def: false }} onDoc={onDoc} />
              )}
            </div>
          </details>
        );
      })}
    </>
  );
}

function CachePanel({ doc, name, onDoc }: { doc: RawDoc; name: string; onDoc: (d: RawDoc) => void }) {
  const b = ['nodes', name];
  return (
    <>
      <h3>캐시</h3>
      <Fields
        doc={doc}
        onDoc={onDoc}
        defs={[
          { label: '적중률', hint: 'TTL 모델을 쓰지 않는 명령', path: [...b, 'hitRate'], kind: 'ratio', def: 0.9, min: 0, max: 1, step: 0.001 },
          { label: '명령 처리 스레드', path: [...b, 'threads'], kind: 'int', def: 1, min: 1, max: 16 },
        ]}
      />
      <DistFields doc={doc} path={[...b, 'opTime']} onDoc={onDoc} label="명령 지연" />
      <h3>Redis Cluster</h3>
      <Fields
        doc={doc}
        onDoc={onDoc}
        defs={[
          { label: '샤드', path: [...b, 'cluster', 'shards'], kind: 'int', def: 1, min: 1, max: 32 },
          { label: '샤드당 레플리카', path: [...b, 'cluster', 'replicas'], kind: 'int', def: 0, min: 0, max: 4 },
          { label: 'failover 시간', path: [...b, 'cluster', 'failoverTime'], kind: 'dur', def: 15000, min: 1000, max: 60000, log: true },
        ]}
      />
      <h3>명령별 키 모델</h3>
      {Object.keys(getPath(doc, [...b, 'ops']) ?? {}).map((op) => (
        <details key={op} className="endpoint" open>
          <summary>
            <code>{op}</code>
          </summary>
          <Fields
            doc={doc}
            onDoc={onDoc}
            defs={[
              { label: 'TTL', hint: '없으면 고정 적중률', path: [...b, 'ops', op, 'ttl'], kind: 'dur', def: 0, min: 1000, max: 3600000, log: true },
              { label: '키 수', path: [...b, 'ops', op, 'keys'], kind: 'int', def: 1000, min: 1, max: 1000000, log: true },
              { label: 'TTL jitter', path: [...b, 'ops', op, 'ttlJitter'], kind: 'ratio', def: 0, min: 0, max: 1, step: 0.01 },
              { label: '단일 갱신(lock)', path: [...b, 'ops', op, 'singleFlight'], kind: 'bool', def: false },
              { label: '키 쏠림', hint: '0 = 고르게', path: [...b, 'ops', op, 'skew'], kind: 'float', def: 0, min: 0, max: 3, step: 0.1 },
            ]}
          />
        </details>
      ))}
    </>
  );
}

/** which availability zones a node's members are spread over (only with scenario topology) */
function ZonesField({ doc, name, onDoc }: { doc: RawDoc; name: string; onDoc: (d: RawDoc) => void }) {
  const zones: string[] = doc.topology?.zones ?? [];
  if (!zones.length) return null;
  const cur: string[] = doc.nodes?.[name]?.zones ?? zones;
  return (
    <div className="field">
      <span className="field-label">
        배치 존<small>멤버 i는 존[i mod n]</small>
      </span>
      <div className="zone-picks">
        {zones.map((z) => (
          <label key={z} className="chip">
            <input
              type="checkbox"
              checked={cur.includes(z)}
              onChange={(e) => {
                const next = e.target.checked ? zones.filter((x) => cur.includes(x) || x === z) : cur.filter((x) => x !== z);
                if (next.length) onDoc(setPath(doc, ['nodes', name, 'zones'], next.length === zones.length ? undefined : next));
              }}
            />
            {z}
          </label>
        ))}
      </div>
    </div>
  );
}

function GatewayPanel({ doc, name, onDoc }: { doc: RawDoc; name: string; onDoc: (d: RawDoc) => void }) {
  const b = ['nodes', name];
  const routes: Record<string, any> = getPath(doc, [...b, 'routes']) ?? {};
  const services = Object.entries<any>(doc.nodes ?? {}).filter(([n, x]) => nodeKind(x) === 'service' && n !== name);
  const [pattern, setPattern] = useState('/api/**');
  const [to, setTo] = useState(services[0]?.[0] ?? '');
  return (
    <>
      <h3>게이트웨이</h3>
      <Fields
        doc={doc}
        onDoc={onDoc}
        defs={[
          { label: '인스턴스 수', path: [...b, 'instances'], kind: 'int', def: 1, min: 1, max: 40 },
          { label: 'vCPU', path: [...b, 'os', 'vcpu'], kind: 'float', def: 2, min: 0.5, max: 32, step: 0.5 },
          { label: '요청당 CPU', path: [...b, 'cpu'], kind: 'dur', def: 0.3, min: 0.01, max: 20, log: true },
          { label: 'max-connections', path: [...b, 'maxConnections'], kind: 'int', def: 8192, min: 10, max: 100000, log: true },
        ]}
      />
      <ZonesField doc={doc} name={name} onDoc={onDoc} />
      <Policy
        doc={doc}
        base={b}
        name="healthCheck"
        title="헬스체크 (앞단 LB)"
        defaults={{ interval: '5s', threshold: 3 }}
        onDoc={onDoc}
        fields={[
          { label: '간격', path: ['interval'], kind: 'dur', def: 10000, min: 500, max: 60000, log: true },
          { label: '제외 기준', path: ['threshold'], kind: 'int', def: 3, min: 1, max: 10 },
        ]}
      />
      <h3>라우트</h3>
      {Object.entries(routes).map(([p, r]) => {
        const rp = [...b, 'routes', p];
        return (
          <details key={p} className="endpoint" open>
            <summary>
              <code>{p}</code> → <code>{typeof r === 'string' ? r : r?.to}</code>
              <button className="ghost small" aria-label="라우트 삭제" onClick={() => onDoc(setPath(doc, rp, undefined))}>
                ✕
              </button>
            </summary>
            <Fields
              doc={doc}
              onDoc={onDoc}
              defs={[
                { label: 'timeout', path: [...rp, 'timeout'], kind: 'dur', def: 0, min: 50, max: 60000, log: true },
                { label: 'rate limit', hint: '넘으면 429', path: [...rp, 'rateLimit'], kind: 'rate', def: 100000, min: 1, max: 100000, log: true },
              ]}
            />
          </details>
        );
      })}
      <div className="fault-adder">
        <input value={pattern} onChange={(e) => setPattern(e.target.value)} aria-label="경로 패턴" placeholder="/orders/**" />
        <select value={to} onChange={(e) => setTo(e.target.value)} aria-label="대상 서비스">
          {services.map(([n]) => (
            <option key={n}>{n}</option>
          ))}
        </select>
        <button className="primary small" disabled={!pattern || !to} onClick={() => onDoc(setPath(doc, [...b, 'routes', pattern], { to, timeout: '2s' }))}>
          라우트 추가
        </button>
      </div>
      <p className="muted small">경로 패턴(`/orders/**`)은 대상 서비스의 API 중 맞는 것으로 펼쳐집니다. 재시도·서킷브레이커는 게이트웨이→서비스 연결선에서 설정합니다.</p>
    </>
  );
}

function LoadBalancerPanel({ doc, name, onDoc }: { doc: RawDoc; name: string; onDoc: (d: RawDoc) => void }) {
  const b = ['nodes', name];
  const services = Object.entries<any>(doc.nodes ?? {}).filter(([, x]) => nodeKind(x) === 'service');
  return (
    <>
      <h3>로드밸런서</h3>
      <label className="field kind-select">
        <span className="field-label">대상 서비스</span>
        <select value={getPath(doc, [...b, 'target']) ?? ''} onChange={(e) => onDoc(setPath(doc, [...b, 'target'], e.target.value))}>
          {services.map(([n]) => (
            <option key={n}>{n}</option>
          ))}
        </select>
      </label>
      <Fields
        doc={doc}
        onDoc={onDoc}
        defs={[
          { label: '알고리즘', path: [...b, 'algorithm'], kind: 'select', def: 'round-robin', options: ['round-robin', 'least-conn', 'random', 'p2c'] },
          { label: '계층', hint: 'L4 = TCP, L7 = HTTP', path: [...b, 'layer'], kind: 'select', def: '7', options: ['4', '7'] },
          { label: '인스턴스 수', path: [...b, 'instances'], kind: 'int', def: 1, min: 1, max: 20 },
          { label: 'vCPU', path: [...b, 'os', 'vcpu'], kind: 'float', def: 4, min: 0.5, max: 64, step: 0.5 },
          { label: 'max-connections', path: [...b, 'maxConnections'], kind: 'int', def: 8192, min: 10, max: 200000, log: true },
          { label: '요청 timeout', hint: 'idle / request timeout → 504', path: [...b, 'timeout'], kind: 'dur', def: 60000, min: 100, max: 600000, log: true },
        ]}
      />
      <ZonesField doc={doc} name={name} onDoc={onDoc} />
      <Policy
        doc={doc}
        base={b}
        name="healthCheck"
        title="대상 헬스체크"
        defaults={{ interval: '5s', threshold: 2 }}
        onDoc={onDoc}
        fields={[
          { label: '간격', path: ['interval'], kind: 'dur', def: 10000, min: 500, max: 60000, log: true },
          { label: '제외 기준 (연속 실패)', path: ['threshold'], kind: 'int', def: 3, min: 1, max: 10 },
          { label: '복귀 기준 (연속 성공)', path: ['riseThreshold'], kind: 'int', def: 2, min: 1, max: 10 },
        ]}
      />
    </>
  );
}

const ENGINE_LABEL: Record<string, string> = { dynamodb: 'DynamoDB', cassandra: 'Cassandra', mongodb: 'MongoDB', elasticsearch: 'Elasticsearch / OpenSearch' };

function StoreOps({ doc, name, onDoc, s3, es }: { doc: RawDoc; name: string; onDoc: (d: RawDoc) => void; s3: boolean; es: boolean }) {
  const b = ['nodes', name];
  const ops = Object.keys(getPath(doc, [...b, 'ops']) ?? {});
  const [draft, setDraft] = useState('');
  const add = () => {
    const op = draft.trim();
    if (!op || ops.includes(op)) return;
    onDoc(setPath(doc, [...b, 'ops', op], {}));
    setDraft('');
  };
  return (
    <>
      <h3>오퍼레이션</h3>
      {ops.map((op) => (
        <details key={op} className="endpoint" open={ops.length <= 2}>
          <summary>
            <span className="ep-head">
              <code>{op}</code>
              <span className="ep-actions">
                <button
                  className="ghost small"
                  aria-label="오퍼레이션 삭제"
                  onClick={(e) => {
                    e.preventDefault();
                    const next = { ...(getPath(doc, [...b, 'ops']) ?? {}) };
                    delete next[op];
                    onDoc(setPath(doc, [...b, 'ops'], next));
                  }}
                >
                  ✕
                </button>
              </span>
            </span>
          </summary>
          <div className="fields">
            <DistFields doc={doc} path={[...b, 'ops', op, 'latency']} onDoc={onDoc} label="복제본 처리" />
            <Fields
              doc={doc}
              onDoc={onDoc}
              defs={[
                { label: '쓰기', hint: '이름으로 추정 (Put·Insert·Update…)', path: [...b, 'ops', op, 'write'], kind: 'bool', def: /put|insert|update|delete|write|save|upsert|index|post|remove|set/i.test(op) },
                ...(es || !s3 ? [{ label: '모든 파티션 조회', hint: es ? '검색은 기본으로 모든 샤드' : 'scan · scatter-gather', path: [...b, 'ops', op, 'scatter'], kind: 'bool' as const, def: es && /search|query|aggregat/i.test(op) }] : []),
                ...(s3 ? [{ label: '객체 크기', path: [...b, 'ops', op, 'size'], kind: 'kb' as const, def: 100, min: 1, max: 1024 * 1024, log: true }] : []),
              ]}
            />
          </div>
        </details>
      ))}
      <div className="add-endpoint">
        <input className="mono" value={draft} placeholder={s3 ? 'GetObject' : es ? 'search' : 'GetItem'} aria-label="오퍼레이션 이름" onChange={(e) => setDraft(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && add()} />
        <button className="primary small" disabled={!draft.trim() || ops.includes(draft.trim())} onClick={add}>
          오퍼레이션 추가
        </button>
      </div>
    </>
  );
}

function StorePanel({ doc, name, onDoc }: { doc: RawDoc; name: string; onDoc: (d: RawDoc) => void }) {
  const b = ['nodes', name];
  const s3 = nodeKind(doc.nodes?.[name]) === 'objectstore';
  const engine = s3 ? 's3' : getPath(doc, [...b, 'engine']) ?? 'dynamodb';
  const cons = (label: string, key: 'read' | 'write', def: string, options: string[]) => ({ label, path: [...b, 'consistency', key], kind: 'select' as const, def, options });
  const byEngine: Record<string, FieldDef[]> = {
    dynamodb: [
      { label: '파티션', hint: '테이블 용량·데이터가 늘면 나뉨', path: [...b, 'partitions'], kind: 'int', def: 4, min: 1, max: 256, log: true },
      { label: '파티션 읽기 한도', hint: '3000 RCU', path: [...b, 'partitionRate', 'read'], kind: 'rate', def: 3000, min: 100, max: 30000, log: true },
      { label: '파티션 쓰기 한도', hint: '1000 WCU', path: [...b, 'partitionRate', 'write'], kind: 'rate', def: 1000, min: 100, max: 10000, log: true },
      cons('읽기', 'read', 'ONE', ['ONE', 'QUORUM']),
    ],
    cassandra: [
      { label: '노드', path: [...b, 'nodes'], kind: 'int', def: 3, min: 1, max: 48 },
      { label: '복제 계수 (RF)', path: [...b, 'replication'], kind: 'int', def: 3, min: 1, max: 5 },
      cons('읽기 일관성', 'read', 'QUORUM', ['ONE', 'QUORUM', 'ALL']),
      cons('쓰기 일관성', 'write', 'QUORUM', ['ONE', 'QUORUM', 'ALL']),
      { label: '노드당 동시 처리', hint: 'native_transport_max_threads', path: [...b, 'concurrency'], kind: 'int', def: 128, min: 8, max: 1024, log: true },
    ],
    mongodb: [
      { label: '샤드', hint: '1 = 단일 복제 세트', path: [...b, 'partitions'], kind: 'int', def: 1, min: 1, max: 32 },
      { label: '복제 세트 크기', path: [...b, 'replication'], kind: 'int', def: 3, min: 1, max: 7 },
      cons('write concern', 'write', 'majority', ['1', 'majority']),
      { label: 'readPreference', path: [...b, 'readPreference'], kind: 'select', def: 'primary', options: ['primary', 'secondary'] },
      { label: 'primary 선출 시간', path: [...b, 'failoverTime'], kind: 'dur', def: 12000, min: 1000, max: 60000, log: true },
      { label: '노드당 동시 처리', hint: 'WiredTiger 티켓', path: [...b, 'concurrency'], kind: 'int', def: 128, min: 8, max: 1024, log: true },
    ],
    elasticsearch: [
      { label: '데이터 노드', path: [...b, 'nodes'], kind: 'int', def: 3, min: 1, max: 48 },
      { label: '프라이머리 샤드', path: [...b, 'partitions'], kind: 'int', def: 5, min: 1, max: 64 },
      { label: '복사본 수', hint: '1 + replicas', path: [...b, 'replication'], kind: 'int', def: 2, min: 1, max: 4 },
      { label: 'search 스레드풀', hint: 'vCPU×1.5+1', path: [...b, 'concurrency'], kind: 'int', def: 7, min: 1, max: 128, log: true },
      { label: 'search 큐', hint: '넘치면 429', path: [...b, 'queue'], kind: 'int', def: 1000, min: 10, max: 10000, log: true },
    ],
    s3: [
      { label: 'prefix 수', hint: '키 앞부분으로 나뉘는 범위', path: [...b, 'prefixes'], kind: 'int', def: 1, min: 1, max: 1024, log: true },
      { label: 'prefix당 GET 한도', path: [...b, 'partitionRate', 'read'], kind: 'rate', def: 5500, min: 100, max: 50000, log: true },
      { label: 'prefix당 PUT 한도', path: [...b, 'partitionRate', 'write'], kind: 'rate', def: 3500, min: 100, max: 50000, log: true },
    ],
  };
  return (
    <>
      <h3>{s3 ? '오브젝트 스토리지 (S3)' : '엔진'}</h3>
      {!s3 && (
        <Fields doc={doc} onDoc={onDoc} defs={[{ label: '종류', path: [...b, 'engine'], kind: 'select', def: 'dynamodb', options: Object.keys(ENGINE_LABEL) }]} />
      )}
      <Fields
        doc={doc}
        onDoc={onDoc}
        defs={[...(byEngine[engine] ?? []), { label: '키 쏠림', hint: '0 = 고르게, 1 = 소수의 핫 키', path: [...b, 'keySkew'], kind: 'float', def: 0, min: 0, max: 2, step: 0.05 }]}
      />
      <ZonesField doc={doc} name={name} onDoc={onDoc} />
      <StoreOps doc={doc} name={name} onDoc={onDoc} s3={s3} es={engine === 'elasticsearch'} />
    </>
  );
}

function CdnPanel({ doc, name, onDoc }: { doc: RawDoc; name: string; onDoc: (d: RawDoc) => void }) {
  const b = ['nodes', name];
  const origins = Object.keys(doc.nodes ?? {}).filter((n) => n !== name && ['service', 'gateway', 'loadbalancer'].includes(nodeKind(doc.nodes[n])));
  const rules: Record<string, any> = getPath(doc, [...b, 'rules']) ?? {};
  const [draft, setDraft] = useState('');
  return (
    <>
      <h3>CDN</h3>
      <Fields
        doc={doc}
        onDoc={onDoc}
        defs={[
          { label: '오리진', path: [...b, 'origin'], kind: 'select', def: origins[0] ?? '', options: origins },
          { label: '적중률', hint: 'GET·HEAD 기본값 (다른 메서드는 항상 오리진으로)', path: [...b, 'hitRate'], kind: 'ratio', def: 0.9, min: 0, max: 1, step: 0.01 },
          { label: '오리진 RTT', path: [...b, 'originRtt'], kind: 'dur', def: 30, min: 1, max: 300, log: true },
          { label: '오리진 timeout', path: [...b, 'originTimeout'], kind: 'dur', def: 30000, min: 500, max: 120000, log: true },
        ]}
      />
      <h3>경로별 적중률</h3>
      <p className="muted small">캐시하면 안 되는 개인화 응답은 0%로 둡니다.</p>
      <div className="fields">
        {Object.keys(rules).map((r) => (
          <div key={r} className="rule-row">
            <Field doc={doc} f={{ label: r, path: [...b, 'rules', r], kind: 'ratio', def: 0, min: 0, max: 1, step: 0.01 }} onDoc={onDoc} />
            <button
              className="ghost small"
              aria-label="규칙 삭제"
              onClick={() => {
                const next = { ...rules };
                delete next[r];
                onDoc(setPath(doc, [...b, 'rules'], next));
              }}
            >
              ✕
            </button>
          </div>
        ))}
      </div>
      <div className="add-endpoint">
        <input className="mono" value={draft} placeholder="GET /search" aria-label="경로 패턴" onChange={(e) => setDraft(e.target.value)} />
        <button
          className="primary small"
          disabled={!draft.trim() || draft.trim() in rules}
          onClick={() => {
            onDoc(setPath(doc, [...b, 'rules', draft.trim()], '0%'));
            setDraft('');
          }}
        >
          규칙 추가
        </button>
      </div>
    </>
  );
}

function PoolerPanel({ doc, name, onDoc }: { doc: RawDoc; name: string; onDoc: (d: RawDoc) => void }) {
  const b = ['nodes', name];
  const dbs = Object.keys(doc.nodes ?? {}).filter((n) => nodeKind(doc.nodes[n]) === 'db');
  return (
    <>
      <h3>커넥션 풀러</h3>
      <p className="muted small">앱의 많은 연결을 적은 수의 DB 연결로 나눠 씁니다(트랜잭션 풀링). 호출하는 쪽은 DB 쿼리 이름을 그대로 씁니다.</p>
      <Fields
        doc={doc}
        onDoc={onDoc}
        defs={[
          { label: '종류', path: [...b, 'engine'], kind: 'select', def: 'pgbouncer', options: ['pgbouncer', 'proxysql', 'rds-proxy'] },
          { label: '대상 DB', path: [...b, 'target'], kind: 'select', def: dbs[0] ?? '', options: dbs },
          { label: 'DB 연결 수', hint: 'default_pool_size', path: [...b, 'poolSize'], kind: 'int', def: 20, min: 1, max: 500, log: true },
          { label: '클라이언트 연결 한도', hint: 'max_client_conn (넘으면 거절)', path: [...b, 'maxClientConn'], kind: 'int', def: 100, min: 10, max: 20000, log: true },
          { label: '쿼리 대기 timeout', hint: 'query_wait_timeout', path: [...b, 'queryWaitTimeout'], kind: 'dur', def: 120000, min: 100, max: 300000, log: true },
          { label: '인스턴스 수', path: [...b, 'instances'], kind: 'int', def: 1, min: 1, max: 10 },
        ]}
      />
    </>
  );
}

function QueuePanel({ doc, name, onDoc }: { doc: RawDoc; name: string; onDoc: (d: RawDoc) => void }) {
  const b = ['nodes', name];
  const broker = getPath(doc, [...b, 'broker']) ?? 'rabbitmq';
  const services = Object.entries<any>(doc.nodes ?? {}).filter(([, n]) => nodeKind(n) === 'service');
  const consumer = getPath(doc, [...b, 'consumer']);
  const consumerSvc = consumer?.service ?? '';
  const listeners = Object.keys(doc.nodes?.[consumerSvc]?.endpoints ?? {});
  const kafka = broker === 'kafka';
  return (
    <>
      <h3>브로커</h3>
      <Fields doc={doc} onDoc={onDoc} defs={[{ label: '종류', path: [...b, 'broker'], kind: 'select', def: 'rabbitmq', options: ['rabbitmq', 'kafka'] }]} />
      {kafka ? (
        <Fields
          doc={doc}
          onDoc={onDoc}
          defs={[
            { label: '파티션', path: [...b, 'kafka', 'partitions'], kind: 'int', def: 6, min: 1, max: 256, log: true },
            { label: '키 쏠림', hint: '핫 키 → 핫 파티션', path: [...b, 'kafka', 'keySkew'], kind: 'float', def: 0, min: 0, max: 3, step: 0.1 },
            { label: '브로커', path: [...b, 'kafka', 'brokers'], kind: 'int', def: 3, min: 1, max: 12 },
            { label: '복제 계수', path: [...b, 'kafka', 'replicationFactor'], kind: 'int', def: 3, min: 1, max: 5 },
            { label: 'min.insync.replicas', path: [...b, 'kafka', 'minInsyncReplicas'], kind: 'int', def: 2, min: 1, max: 5 },
            { label: 'acks', path: [...b, 'kafka', 'acks'], kind: 'select', def: 'all', options: ['all', '1'] },
            { label: '리더 선출 시간', path: [...b, 'kafka', 'electionTime'], kind: 'dur', def: 5000, min: 500, max: 60000, log: true },
            { label: '리밸런스 정지', hint: 'session.timeout', path: [...b, 'kafka', 'rebalanceTime'], kind: 'dur', def: 10000, min: 500, max: 60000, log: true },
          ]}
        />
      ) : (
        <Fields
          doc={doc}
          onDoc={onDoc}
          defs={[
            { label: '클러스터 노드', path: [...b, 'cluster', 'nodes'], kind: 'int', def: 1, min: 1, max: 7 },
            { label: '큐 종류', path: [...b, 'cluster', 'queueType'], kind: 'select', def: 'classic', options: ['classic', 'quorum'] },
            { label: '최대 메시지', hint: '0 = 무제한', path: [...b, 'capacity'], kind: 'int', def: 0, min: 0, max: 10000000 },
          ]}
        />
      )}
      <h3>컨슈머</h3>
      <label className="field kind-select">
        <span className="field-label">서비스</span>
        <select
          value={consumerSvc}
          onChange={(e) => {
            const svc = e.target.value;
            if (!svc) return onDoc(setPath(doc, [...b, 'consumer'], undefined));
            const eps = Object.keys(doc.nodes?.[svc]?.endpoints ?? {});
            let d = doc;
            let ep = eps.find((x) => /listener|consume|handle|@/i.test(x));
            if (!ep) {
              ep = `@${kafka ? 'Kafka' : 'Rabbit'}Listener ${name}`;
              d = setPath(d, ['nodes', svc, 'endpoints', ep], { selfTime: { p50: '5ms', p99: '20ms' } });
            }
            onDoc(setPath(d, [...b, 'consumer'], { ...(consumer ?? {}), service: svc, endpoint: ep, concurrency: consumer?.concurrency ?? 4 }));
          }}
        >
          <option value="">없음</option>
          {services.map(([n]) => (
            <option key={n}>{n}</option>
          ))}
        </select>
      </label>
      {consumer && (
        <>
          <label className="field kind-select">
            <span className="field-label">리스너 API</span>
            <select value={consumer.endpoint} onChange={(e) => onDoc(setPath(doc, [...b, 'consumer', 'endpoint'], e.target.value))}>
              {listeners.map((x) => (
                <option key={x}>{x}</option>
              ))}
            </select>
          </label>
          <Fields
            doc={doc}
            onDoc={onDoc}
            defs={[
              { label: '동시성', hint: '인스턴스당 리스너 스레드', path: [...b, 'consumer', 'concurrency'], kind: 'int', def: 1, min: 1, max: 64 },
              ...(kafka
                ? [
                    { label: 'max.poll.records', path: [...b, 'consumer', 'maxPollRecords'], kind: 'int' as const, def: 500, min: 1, max: 5000, log: true },
                    { label: '실패 처리', path: [...b, 'consumer', 'onError'], kind: 'select' as const, def: 'retry', options: ['retry', 'skip'] },
                    { label: '재시도 백오프', hint: '그동안 파티션이 멈춤', path: [...b, 'consumer', 'retryBackoff'], kind: 'dur' as const, def: 0, min: 0, max: 30000 },
                  ]
                : [
                    { label: 'prefetch', path: [...b, 'consumer', 'prefetch'], kind: 'int' as const, def: 250, min: 1, max: 1000, log: true },
                    { label: 'ack', path: [...b, 'consumer', 'ack'], kind: 'select' as const, def: 'manual', options: ['manual', 'auto'] },
                  ]),
              { label: '최대 재시도', hint: '넘으면 DLQ/DLT', path: [...b, 'consumer', 'maxRetries'], kind: 'int', def: kafka ? 9 : 1000, min: 0, max: 1000, log: false },
              { label: 'DLQ / DLT', path: [...b, 'consumer', 'dlq'], kind: 'bool', def: false },
            ]}
          />
        </>
      )}
    </>
  );
}

function ExternalPanel({ doc, name, onDoc }: { doc: RawDoc; name: string; onDoc: (d: RawDoc) => void }) {
  const b = ['nodes', name];
  return (
    <>
      <h3>외부 API</h3>
      <Fields
        doc={doc}
        onDoc={onDoc}
        defs={[
          { label: '상대 측 동시 처리', path: [...b, 'concurrency'], kind: 'int', def: 1000, min: 1, max: 5000, log: true },
          { label: '실패율', path: [...b, 'failureRate'], kind: 'ratio', def: 0, min: 0, max: 1, step: 0.0005 },
          { label: 'rate limit', hint: '초과 시 429', path: [...b, 'rateLimit'], kind: 'rate', def: 100000, min: 1, max: 100000, log: true },
        ]}
      />
      <DistFields doc={doc} path={[...b, 'latency']} onDoc={onDoc} label="응답 지연" />
    </>
  );
}

function EdgePanel({ doc, id, onDoc }: { doc: RawDoc; id: string; onDoc: (d: RawDoc) => void }) {
  const b = ['edges', id];
  const target = id.split('->')[1];
  const isDb = nodeKind(doc.nodes?.[target]) === 'db';
  const timeoutOn = getPath(doc, [...b, 'timeout']) !== undefined;
  return (
    <>
      <h3>네트워크</h3>
      <Fields
        doc={doc}
        onDoc={onDoc}
        defs={[
          { label: 'RTT', path: [...b, 'network', 'rtt'], kind: 'dur', def: 0.5, min: 0.05, max: 500, log: true },
          { label: '지터', path: [...b, 'network', 'jitter'], kind: 'dur', def: 0.1, min: 0.01, max: 200, log: true },
          { label: '패킷 손실', path: [...b, 'network', 'loss'], kind: 'ratio', def: 0, min: 0, max: 0.1, step: 0.0005 },
          { label: 'keep-alive', path: [...b, 'network', 'keepAlive'], kind: 'bool', def: true },
        ]}
      />
      <section className={`policy${timeoutOn ? ' on' : ''}`}>
        <header>
          <h4>Timeout</h4>
          <input
            type="checkbox"
            className="switch"
            checked={timeoutOn}
            onChange={(e) => onDoc(setPath(doc, [...b, 'timeout'], e.target.checked ? '2s' : undefined))}
            aria-label="Timeout 켜기"
          />
        </header>
        {timeoutOn && <Fields doc={doc} onDoc={onDoc} defs={[{ label: '읽기 timeout', path: [...b, 'timeout'], kind: 'dur', def: 2000, min: 10, max: 60000, log: true }]} />}
      </section>
      <Policy
        doc={doc}
        base={b}
        name="pool"
        title={isDb ? 'HikariCP 커넥션풀' : 'HTTP 커넥션풀'}
        defaults={{ size: 10, timeout: '3s' }}
        onDoc={onDoc}
        fields={[
          { label: '최대 크기', hint: '인스턴스마다', path: ['size'], kind: 'int', def: 10, min: 1, max: 500, log: true },
          { label: '대기 timeout', path: ['timeout'], kind: 'dur', def: 30000, min: 10, max: 60000, log: true },
        ]}
      />
      <Policy
        doc={doc}
        base={b}
        name="retry"
        title="Retry"
        defaults={{ max: 3, wait: '100ms', backoff: 'exponential', jitter: true }}
        onDoc={onDoc}
        fields={[
          { label: '최대 시도', path: ['max'], kind: 'int', def: 3, min: 1, max: 10 },
          { label: '대기', path: ['wait'], kind: 'dur', def: 500, min: 1, max: 10000, log: true },
          { label: '백오프', path: ['backoff'], kind: 'select', def: 'fixed', options: ['fixed', 'exponential'] },
          { label: 'jitter', path: ['jitter'], kind: 'bool', def: false },
        ]}
      />
      <Policy
        doc={doc}
        base={b}
        name="circuitBreaker"
        title="Circuit Breaker"
        defaults={{ failureRate: 50, slowCall: '1s', slowCallRate: 50, window: 50, minCalls: 20, openFor: '10s', halfOpenCalls: 5 }}
        onDoc={onDoc}
        fields={[
          { label: '실패율 임계값', path: ['failureRate'], kind: 'pctnum', def: 50, min: 1, max: 100 },
          { label: '느린 호출 기준', path: ['slowCall'], kind: 'dur', def: 60000, min: 10, max: 60000, log: true },
          { label: '느린 호출 비율', path: ['slowCallRate'], kind: 'pctnum', def: 100, min: 1, max: 100 },
          { label: '윈도우 크기', path: ['window'], kind: 'int', def: 100, min: 5, max: 1000, log: true },
          { label: '최소 호출 수', path: ['minCalls'], kind: 'int', def: 100, min: 1, max: 1000, log: true },
          { label: 'OPEN 유지', path: ['openFor'], kind: 'dur', def: 60000, min: 100, max: 120000, log: true },
          { label: 'HALF_OPEN 허용 호출', path: ['halfOpenCalls'], kind: 'int', def: 10, min: 1, max: 100, log: true },
        ]}
      />
      <Policy
        doc={doc}
        base={b}
        name="fallback"
        title="Fallback"
        defaults={{ latency: '2ms' }}
        onDoc={onDoc}
        fields={[{ label: '대체 응답 시간', path: ['latency'], kind: 'dur', def: 1, min: 0.1, max: 5000, log: true }]}
      />
      <Policy
        doc={doc}
        base={b}
        name="bulkhead"
        title="Bulkhead"
        defaults={{ maxConcurrent: 25, maxWait: '0ms' }}
        onDoc={onDoc}
        fields={[
          { label: '최대 동시 호출', path: ['maxConcurrent'], kind: 'int', def: 25, min: 1, max: 500, log: true },
          { label: '대기 시간', path: ['maxWait'], kind: 'dur', def: 0, min: 0, max: 5000 },
        ]}
      />
      <Policy
        doc={doc}
        base={b}
        name="rateLimiter"
        title="Rate Limiter"
        defaults={{ limit: 100, period: '1s', timeout: '0ms' }}
        onDoc={onDoc}
        fields={[
          { label: '주기별 허용 수', path: ['limit'], kind: 'int', def: 50, min: 1, max: 10000, log: true },
          { label: '주기', path: ['period'], kind: 'dur', def: 1000, min: 10, max: 60000, log: true },
          { label: '대기 timeout', path: ['timeout'], kind: 'dur', def: 0, min: 0, max: 5000 },
        ]}
      />
    </>
  );
}

function ScenarioPanel({ doc, onDoc }: { doc: RawDoc; onDoc: (d: RawDoc) => void }) {
  const t = ['scenario', 'traffic'];
  const type = getPath(doc, [...t, 'type']) ?? 'constant';
  const mix: Record<string, unknown> = getPath(doc, [...t, 'mix']) ?? {};
  const faults: any[] = getPath(doc, ['scenario', 'faults']) ?? [];
  const trafficDefs: FieldDef[] =
    type === 'spike'
      ? [
          { label: '평시', path: [...t, 'base'], kind: 'rate', def: 100, min: 1, max: 20000, log: true },
          { label: '피크', path: [...t, 'peak'], kind: 'rate', def: 1000, min: 1, max: 50000, log: true },
          { label: '피크 시작', path: [...t, 'at'], kind: 'dur', def: 30000, min: 0, max: 600000, step: 1000 },
          { label: '피크 유지', path: [...t, 'hold'], kind: 'dur', def: 30000, min: 1000, max: 600000, step: 1000 },
        ]
      : type === 'ramp'
        ? [
            { label: '시작 RPS', path: [...t, 'from'], kind: 'rate', def: 0, min: 0, max: 20000 },
            { label: '끝 RPS', path: [...t, 'to'], kind: 'rate', def: 1000, min: 1, max: 50000, log: true },
          ]
        : [{ label: 'RPS', path: [...t, 'rps'], kind: 'rate', def: 100, min: 1, max: 50000, log: true }];
  return (
    <>
      <h3>트래픽</h3>
      <Fields
        doc={doc}
        onDoc={onDoc}
        defs={[{ label: '패턴', path: [...t, 'type'], kind: 'select', def: 'constant', options: ['constant', 'spike', 'ramp'] }, ...trafficDefs]}
      />
      <h4 className="sub">진입 API 믹스</h4>
      <div className="fields">
        {Object.keys(mix).map((k) => (
          <div key={k} className="mix-row">
            <Field doc={doc} f={{ label: k, path: [...t, 'mix', k], kind: 'pctnum', def: 10, min: 0, max: 100 }} onDoc={onDoc} />
            <button className="ghost small" aria-label={`${k} 빼기`} onClick={() => onDoc(setPath(doc, [...t, 'mix', k], undefined))}>
              ✕
            </button>
          </div>
        ))}
        {(() => {
          const inMix = (svc: string, ep: string) => k(mix, svc, ep);
          const candidates = Object.entries<any>(doc.nodes ?? {})
            .filter(([, n]) => nodeKind(n) === 'service')
            .flatMap(([svc, n]) => Object.keys(n.endpoints ?? {}).filter((ep) => !ep.startsWith('@') && !inMix(svc, ep)).map((ep) => `${svc}:${ep}`));
          if (!candidates.length) return null;
          return (
            <select value="" onChange={(e) => e.target.value && onDoc(setPath(doc, [...t, 'mix', e.target.value], '10%'))} aria-label="진입 API 추가">
              <option value="">+ 진입 API 추가…</option>
              {candidates.map((c) => (
                <option key={c}>{c}</option>
              ))}
            </select>
          );
        })()}
      </div>
      <h3>실행</h3>
      <Fields
        doc={doc}
        onDoc={onDoc}
        defs={[
          { label: '시뮬레이션 시간', path: ['scenario', 'duration'], kind: 'dur', def: 60000, min: 5000, max: 600000, step: 5000 },
          { label: '클라이언트 timeout', path: ['scenario', 'clientTimeout'], kind: 'dur', def: 30000, min: 100, max: 120000, log: true },
          { label: '난수 시드', path: ['scenario', 'seed'], kind: 'int', def: 1, min: 1, max: 1000 },
        ]}
      />
      <h3>SLO</h3>
      <Fields
        doc={doc}
        onDoc={onDoc}
        defs={[
          { label: 'p99', path: ['scenario', 'slo', 'p99'], kind: 'dur', def: 300, min: 5, max: 10000, log: true },
          { label: '에러율', path: ['scenario', 'slo', 'errorRate'], kind: 'ratio', def: 0.001, min: 0, max: 0.1, step: 0.0005 },
        ]}
      />
      <h3>가용 영역</h3>
      <section className={`policy${doc.topology ? ' on' : ''}`}>
        <header>
          <h4>존 배치</h4>
          <input
            type="checkbox"
            className="switch"
            checked={!!doc.topology}
            onChange={(e) => onDoc(setPath(doc, ['topology'], e.target.checked ? { zones: ['a', 'b', 'c'], crossZoneRtt: '1ms', zoneAware: false } : undefined))}
            aria-label="존 배치 켜기"
          />
        </header>
        {doc.topology && (
          <div className="fields">
            <label className="field">
              <span className="field-label">존</span>
              <input
                className="text"
                defaultValue={(doc.topology.zones ?? []).join(', ')}
                onBlur={(e) => {
                  const z = e.target.value.split(',').map((x) => x.trim()).filter(Boolean);
                  if (z.length) onDoc(setPath(doc, ['topology', 'zones'], z));
                }}
              />
            </label>
            <Fields
              doc={doc}
              onDoc={onDoc}
              defs={[
                { label: '존 사이 왕복 지연', path: ['topology', 'crossZoneRtt'], kind: 'dur', def: 1, min: 0.1, max: 100, log: true },
                { label: '존 인지 라우팅', hint: '같은 존 우선', path: ['topology', 'zoneAware'], kind: 'bool', def: false },
              ]}
            />
          </div>
        )}
      </section>
      <h3>서비스 메시</h3>
      <Policy
        doc={doc}
        base={[]}
        name="mesh"
        title="사이드카 (Istio·Linkerd)"
        defaults={{ sidecarLatency: { p50: '0.3ms', p99: '2ms' }, sidecarCpu: '0.2ms' }}
        onDoc={onDoc}
        fields={[
          { label: '사이드카 지연 p50', path: ['sidecarLatency', 'p50'], kind: 'dur', def: 0.3, min: 0.01, max: 20, log: true },
          { label: '사이드카 지연 p99', path: ['sidecarLatency', 'p99'], kind: 'dur', def: 2, min: 0.01, max: 100, log: true },
          { label: '사이드카 CPU', hint: '파드 CPU에서 차감', path: ['sidecarCpu'], kind: 'dur', def: 0.2, min: 0.01, max: 10, log: true },
          { label: '메시 재시도 (추가 시도)', path: ['retries', 'attempts'], kind: 'int', def: 0, min: 0, max: 5 },
          { label: 'per-try timeout', path: ['retries', 'perTryTimeout'], kind: 'dur', def: 0, min: 10, max: 30000, log: true },
          { label: 'outlier: 연속 오류', hint: '넘으면 인스턴스 제외', path: ['outlierDetection', 'consecutiveErrors'], kind: 'int', def: 0, min: 1, max: 50 },
          { label: 'outlier: 제외 시간', path: ['outlierDetection', 'baseEjectionTime'], kind: 'dur', def: 30000, min: 1000, max: 300000, log: true },
          { label: '최대 동시 요청', hint: '넘으면 503 overflow', path: ['connectionPool', 'maxRequests'], kind: 'int', def: 100000, min: 1, max: 100000, log: true },
        ]}
      />
      <h3>장애 주입</h3>
      {faults.length === 0 && <p className="muted">장애가 없습니다.</p>}
      {faults.map((f, i) => {
        const p = ['scenario', 'faults', i];
        const on = f.enabled !== false;
        const what = [
          f.latencyX ? `지연 ×${f.latencyX}` : '',
          f.errorRate ? `오류 ${f.errorRate}` : '',
          f.loss ? `손실 ${f.loss}` : '',
          f.down ? (f.hang ? '무응답' : '단절') : '',
          f.flush ? '캐시 비움' : '',
          f.pause ? '컨슈머 정지' : '',
        ]
          .filter(Boolean)
          .join(', ');
        return (
          <section key={i} className={`policy${on ? ' on' : ''}`}>
            <header>
              <h4>
                {f.target}
                {f.instance !== undefined ? `#${Number(f.instance) + 1}` : ''} <small>{what}</small>
              </h4>
              <span className="row-actions">
                <input type="checkbox" className="switch" checked={on} onChange={(e) => onDoc(setPath(doc, [...p, 'enabled'], e.target.checked))} aria-label="장애 켜기" />
                <button className="ghost small" aria-label="장애 삭제" onClick={() => onDoc(setPath(doc, ['scenario', 'faults'], faults.filter((_, k) => k !== i)))}>
                  ✕
                </button>
              </span>
            </header>
            {on && (
              <Fields
                doc={doc}
                onDoc={onDoc}
                defs={[
                  { label: '시작', path: [...p, 'at'], kind: 'dur', def: 0, min: 0, max: 600000, step: 1000 },
                  { label: '종료', path: [...p, 'until'], kind: 'dur', def: 600000, min: 0, max: 600000, step: 1000 },
                  ...(f.latencyX !== undefined ? [{ label: '지연 배수', path: [...p, 'latencyX'], kind: 'float' as const, def: 1, min: 1, max: 100, log: true }] : []),
                  ...(f.errorRate !== undefined ? [{ label: '오류율', path: [...p, 'errorRate'], kind: 'ratio' as const, def: 0, min: 0, max: 1, step: 0.01 }] : []),
                  ...(f.loss !== undefined ? [{ label: '손실률', path: [...p, 'loss'], kind: 'ratio' as const, def: 0, min: 0, max: 0.2, step: 0.001 }] : []),
                ]}
              />
            )}
          </section>
        );
      })}
      <FaultAdder doc={doc} onDoc={onDoc} />
    </>
  );
}

function k(mix: Record<string, unknown>, svc: string, ep: string): boolean {
  return `${svc}:${ep}` in mix || ep in mix;
}

const KIND_EYEBROW: Record<string, string> = {
  service: '서비스',
  db: 'DB',
  cache: '캐시',
  external: '외부 API',
  queue: '메시지 큐',
  gateway: 'API 게이트웨이',
  loadbalancer: '로드밸런서',
  cdn: 'CDN',
  pooler: '커넥션 풀러',
  nosql: 'NoSQL · 검색',
  objectstore: '오브젝트 스토리지',
};

const FAULT_TYPES: { id: string; label: string; make: () => Record<string, unknown>; kinds: string[] }[] = [
  { id: 'slow', label: '지연 ×10', make: () => ({ latencyX: 10 }), kinds: ['service', 'gateway', 'loadbalancer', 'cdn', 'pooler', 'db', 'cache', 'nosql', 'objectstore', 'external', 'queue', 'edge', 'zone'] },
  { id: 'error', label: '오류 50%', make: () => ({ errorRate: '50%' }), kinds: ['service', 'gateway', 'db', 'cache', 'nosql', 'objectstore', 'external', 'queue'] },
  { id: 'down', label: '단절 (연결 거부)', make: () => ({ down: true }), kinds: ['service', 'gateway', 'loadbalancer', 'cdn', 'pooler', 'db', 'cache', 'nosql', 'external', 'queue', 'edge', 'zone'] },
  { id: 'hang', label: '무응답 (hang)', make: () => ({ down: true, hang: true }), kinds: ['service', 'gateway', 'zone'] },
  { id: 'loss', label: '패킷 손실 1%', make: () => ({ loss: '1%' }), kinds: ['edge'] },
  { id: 'flush', label: '캐시 전체 만료', make: () => ({ flush: true }), kinds: ['cache'] },
  { id: 'pause', label: '컨슈머 정지', make: () => ({ pause: true }), kinds: ['queue'] },
];

function members(raw: any): string[] {
  switch (nodeKind(raw)) {
    case 'service':
    case 'gateway':
    case 'loadbalancer':
    case 'pooler':
      return Array.from({ length: Number(raw.instances ?? 1) }, (_, i) => `인스턴스 #${i + 1}`);
    case 'nosql': {
      const engine = raw.engine ?? 'dynamodb';
      if (engine === 'mongodb') {
        const rs = Number(raw.replication ?? 3);
        const shards = Number(raw.partitions ?? raw.shards ?? 1);
        return Array.from({ length: shards * rs }, (_, i) => `${shards > 1 ? `shard ${Math.floor(i / rs)} ` : ''}member ${i % rs}${i % rs === 0 ? ' (primary)' : ''}`);
      }
      const n = Number(raw.nodes ?? (engine === 'dynamodb' ? raw.partitions ?? 4 : 3));
      return Array.from({ length: n }, (_, i) => `node ${i}`);
    }
    case 'db': {
      const shards = Number(raw.cluster?.shards ?? 1);
      const per = 1 + Number(raw.cluster?.replicas ?? 0);
      return Array.from({ length: shards * per }, (_, i) => `${shards > 1 ? `shard ${Math.floor(i / per)} ` : ''}${i % per === 0 ? 'primary' : `replica ${i % per}`}`);
    }
    case 'cache':
      return Array.from({ length: Number(raw.cluster?.shards ?? 1) }, (_, i) => `shard ${i}`);
    case 'queue':
      return Array.from({ length: Number(raw.broker === 'kafka' ? raw.kafka?.brokers ?? 3 : raw.cluster?.nodes ?? 1) }, (_, i) => (raw.broker === 'kafka' ? `broker ${i}` : `node ${i}`));
    default:
      return [];
  }
}

function FaultAdder({ doc, onDoc }: { doc: RawDoc; onDoc: (d: RawDoc) => void }) {
  const [target, setTarget] = useState('');
  const [type, setType] = useState('slow');
  const [member, setMember] = useState('');
  const nodes = Object.keys(doc.nodes ?? {});
  const edges = Object.keys(doc.edges ?? {});
  const zones: string[] = doc.topology?.zones ?? [];
  const isZone = target.startsWith('zone:');
  const isEdge = target.includes('->');
  const kind = isZone ? 'zone' : isEdge ? 'edge' : nodeKind(doc.nodes?.[target]);
  const types = FAULT_TYPES.filter((t) => t.kinds.includes(kind));
  const mem = !isEdge && !isZone && target ? members(doc.nodes[target]) : [];
  const effective = types.some((t) => t.id === type) ? type : types[0]?.id;
  const add = () => {
    const t = FAULT_TYPES.find((x) => x.id === effective);
    if (!target || !t) return;
    const fault: any = isZone ? { target: '*', zone: target.slice(5), at: '20s', until: '50s', ...t.make() } : { target, at: '20s', until: '50s', ...t.make() };
    if (member !== '') fault.instance = Number(member);
    onDoc(setPath(doc, ['scenario', 'faults'], [...(getPath(doc, ['scenario', 'faults']) ?? []), fault]));
  };
  return (
    <div className="fault-adder">
      <select value={target} onChange={(e) => (setTarget(e.target.value), setMember(''))} aria-label="장애 대상">
        <option value="">+ 장애 추가: 대상…</option>
        <optgroup label="노드">
          {nodes.map((n) => (
            <option key={n}>{n}</option>
          ))}
        </optgroup>
        {zones.length > 0 && (
          <optgroup label="가용 영역 전체">
            {zones.map((z) => (
              <option key={z} value={`zone:${z}`}>
                존 {z} 전체
              </option>
            ))}
          </optgroup>
        )}
        {edges.length > 0 && (
          <optgroup label="연결선 (네트워크)">
            {edges.map((e) => (
              <option key={e}>{e}</option>
            ))}
          </optgroup>
        )}
      </select>
      {target && (
        <>
          {mem.length > 1 && (
            <select value={member} onChange={(e) => setMember(e.target.value)} aria-label="장애 범위">
              <option value="">전체</option>
              {mem.map((m, i) => (
                <option key={m} value={i}>
                  {m}
                </option>
              ))}
            </select>
          )}
          <select value={effective} onChange={(e) => setType(e.target.value)} aria-label="장애 종류">
            {types.map((t) => (
              <option key={t.id} value={t.id}>
                {t.label}
              </option>
            ))}
          </select>
          <button className="primary small" onClick={add}>
            추가
          </button>
        </>
      )}
    </div>
  );
}

export function Inspector(p: { doc: RawDoc; selection: Selection; onDoc: (d: RawDoc) => void; onDelete: (s: Selection) => void; changed?: Path[] }) {
  return (
    <Changed.Provider value={(p.changed ?? []).map(key)}>
      <InspectorBody {...p} />
    </Changed.Provider>
  );
}

function InspectorBody({ doc, selection, onDoc, onDelete }: { doc: RawDoc; selection: Selection; onDoc: (d: RawDoc) => void; onDelete: (s: Selection) => void }) {
  if (!selection) return <ScenarioPanel doc={doc} onDoc={onDoc} />;
  if (selection.type === 'edge') {
    return (
      <>
        <div className="panel-title">
          <span className="eyebrow">연결선</span>
          <h2>{selection.id.replace('->', ' → ')}</h2>
          <button className="ghost danger" onClick={() => onDelete(selection)}>
            삭제
          </button>
        </div>
        <EdgePanel doc={doc} id={selection.id} onDoc={onDoc} />
      </>
    );
  }
  const raw = doc.nodes?.[selection.id];
  if (!raw) return null;
  const kind = nodeKind(raw);
  return (
    <>
      <div className="panel-title">
        <span className="eyebrow">{KIND_EYEBROW[kind] ?? kind}</span>
        <h2>{selection.id}</h2>
        <button className="ghost danger" onClick={() => onDelete(selection)}>
          삭제
        </button>
      </div>
      {kind === 'service' && <ServicePanel doc={doc} name={selection.id} onDoc={onDoc} />}
      {kind === 'db' && <DbPanel doc={doc} name={selection.id} onDoc={onDoc} />}
      {kind === 'cache' && <CachePanel doc={doc} name={selection.id} onDoc={onDoc} />}
      {kind === 'external' && <ExternalPanel doc={doc} name={selection.id} onDoc={onDoc} />}
      {kind === 'queue' && <QueuePanel doc={doc} name={selection.id} onDoc={onDoc} />}
      {kind === 'gateway' && <GatewayPanel doc={doc} name={selection.id} onDoc={onDoc} />}
      {kind === 'loadbalancer' && <LoadBalancerPanel doc={doc} name={selection.id} onDoc={onDoc} />}
      {(kind === 'nosql' || kind === 'objectstore') && <StorePanel doc={doc} name={selection.id} onDoc={onDoc} />}
      {kind === 'cdn' && <CdnPanel doc={doc} name={selection.id} onDoc={onDoc} />}
      {kind === 'pooler' && <PoolerPanel doc={doc} name={selection.id} onDoc={onDoc} />}
    </>
  );
}
