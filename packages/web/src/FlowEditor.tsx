// An API's flow: the ordered steps it runs after its own processing — calls to DB / cache / queue / other services,
// local processing between them, parallel groups (fork + join) and cache-miss paths.
import { useEffect, useId, useState } from 'react';
import type { RawDoc } from '@load-simulator/engine';
import { addEndpoint, isFront, isReached, setPath, nodeKind, operationsOf, removeEndpoint, renameEndpoint, setFlow, toStep, type Step } from './doc';

const KIND_LABEL: Record<string, string> = {
  service: '서비스',
  db: 'DB',
  cache: '캐시',
  queue: '큐',
  external: '외부 API',
  gateway: '게이트웨이',
  loadbalancer: 'LB',
  cdn: 'CDN',
  pooler: '풀러',
  nosql: 'NoSQL',
  objectstore: 'S3',
};

/** text input that only commits on blur / Enter, so typing does not create half-typed queries */
function CommitInput({ value, onCommit, placeholder, list, className, ariaLabel }: {
  value: string;
  onCommit: (v: string) => void;
  placeholder?: string;
  list?: string;
  className?: string;
  ariaLabel?: string;
}) {
  const [v, setV] = useState(value);
  useEffect(() => setV(value), [value]);
  const commit = () => {
    if (v.trim() && v !== value) onCommit(v.trim());
    else setV(value);
  };
  return (
    <input
      className={className}
      value={v}
      list={list}
      placeholder={placeholder}
      aria-label={ariaLabel}
      onChange={(e) => setV(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
        if (e.key === 'Escape') setV(value);
      }}
    />
  );
}

function NumberInput({ value, onCommit, min, max, step, ariaLabel, suffix }: {
  value: number;
  onCommit: (v: number) => void;
  min: number;
  max: number;
  step?: number;
  ariaLabel: string;
  suffix?: string;
}) {
  return (
    <label className="num" title={ariaLabel}>
      <input
        type="number"
        value={value}
        min={min}
        max={max}
        step={step ?? 1}
        aria-label={ariaLabel}
        onChange={(e) => {
          const n = Number(e.target.value);
          if (Number.isFinite(n)) onCommit(Math.min(max, Math.max(min, n)));
        }}
      />
      {suffix && <span>{suffix}</span>}
    </label>
  );
}

interface Ctx {
  doc: RawDoc;
  svc: string;
  /** nodes a step can call */
  targets: string[];
}

function newCall(c: Ctx, prefer?: string): Step {
  const target = prefer ?? c.targets.find((t) => ['db', 'pooler', 'cache', 'nosql'].includes(nodeKind(c.doc.nodes[t]))) ?? c.targets[0] ?? '';
  return { type: 'call', target, op: target ? operationsOf(c.doc.nodes[target], c.doc)[0] ?? 'op' : '', count: 1, prob: 1, optional: false, async: false, onMiss: [] };
}

function StepList({ c, steps, onChange, depth, allow }: {
  c: Ctx;
  steps: Step[];
  onChange: (s: Step[]) => void;
  depth: number;
  allow: ('call' | 'work' | 'parallel')[];
}) {
  const set = (i: number, s: Step) => onChange(steps.map((x, k) => (k === i ? s : x)));
  const move = (i: number, d: number) => {
    const j = i + d;
    if (j < 0 || j >= steps.length) return;
    const n = [...steps];
    [n[i], n[j]] = [n[j], n[i]];
    onChange(n);
  };
  const remove = (i: number) => onChange(steps.filter((_, k) => k !== i));
  return (
    <div className={`flow-list depth-${depth}`}>
      {steps.length === 0 && <p className="muted small flow-empty">{depth === 0 ? '아직 호출이 없습니다. 아래에서 순서대로 추가하세요.' : '비어 있음'}</p>}
      <ol>
        {steps.map((s, i) => (
          <li key={i} className={`flow-step step-${s.type}`}>
            <span className="flow-idx">{depth === 0 ? i + 1 : '·'}</span>
            <div className="flow-body">
              {s.type === 'call' && <CallStep c={c} s={s} onChange={(x) => set(i, x)} depth={depth} />}
              {s.type === 'work' && <WorkStep s={s} onChange={(x) => set(i, x)} />}
              {s.type === 'parallel' && (
                <div className="flow-parallel">
                  <div className="flow-row">
                    <strong>병렬 실행</strong>
                    <span className="muted small">모두 끝날 때까지 대기 (allOf / zip)</span>
                    <label className="chk">
                      <input type="checkbox" checked={s.optional} onChange={(e) => set(i, { ...s, optional: e.target.checked })} /> 실패 무시
                    </label>
                  </div>
                  <StepList c={c} steps={s.steps} depth={depth + 1} allow={['call', 'work']} onChange={(x) => set(i, { ...s, steps: x })} />
                </div>
              )}
            </div>
            <span className="flow-ctl">
              <button className="ghost small" disabled={i === 0} onClick={() => move(i, -1)} aria-label="위로">
                ↑
              </button>
              <button className="ghost small" disabled={i === steps.length - 1} onClick={() => move(i, 1)} aria-label="아래로">
                ↓
              </button>
              <button className="ghost small" onClick={() => remove(i)} aria-label="단계 삭제">
                ✕
              </button>
            </span>
          </li>
        ))}
      </ol>
      <div className="flow-add">
        {allow.includes('call') && (
          <button className="ghost small" disabled={!c.targets.length} onClick={() => onChange([...steps, newCall(c)])} title={c.targets.length ? '' : '호출할 노드가 없습니다. 먼저 DB·캐시·큐를 추가하세요.'}>
            + 호출
          </button>
        )}
        {allow.includes('work') && (
          <button className="ghost small" onClick={() => onChange([...steps, { type: 'work', work: '5ms', cpu: 0.3, prob: 1 }])}>
            + 처리 시간
          </button>
        )}
        {allow.includes('parallel') && (
          <button className="ghost small" disabled={c.targets.length === 0} onClick={() => onChange([...steps, { type: 'parallel', optional: false, steps: [newCall(c), newCall(c, c.targets[1])] }])}>
            + 병렬 그룹
          </button>
        )}
      </div>
    </div>
  );
}

function CallStep({ c, s, onChange, depth }: { c: Ctx; s: Extract<Step, { type: 'call' }>; onChange: (s: Step) => void; depth: number }) {
  const listId = useId();
  const raw = c.doc.nodes?.[s.target];
  const kind = raw ? nodeKind(raw) : '';
  const ops = raw ? operationsOf(raw, c.doc) : [];
  const missing = !raw;
  return (
    <div className="flow-call">
      <div className="flow-row">
        <span className={`kind-tag k-${kind || 'none'}`}>{KIND_LABEL[kind] ?? '?'}</span>
        <select
          value={missing ? '' : s.target}
          aria-label="호출 대상"
          onChange={(e) => {
            const t = e.target.value;
            onChange({ ...s, target: t, op: operationsOf(c.doc.nodes[t], c.doc)[0] ?? s.op, onMiss: nodeKind(c.doc.nodes[t]) === 'cache' ? s.onMiss : [] });
          }}
        >
          {missing && <option value="">{s.target || '대상 선택'} (없음)</option>}
          {c.targets.map((t) => (
            <option key={t} value={t}>
              {t}
            </option>
          ))}
        </select>
        <CommitInput className="flow-op mono" value={s.op} list={listId} ariaLabel="오퍼레이션" placeholder={kind === 'db' || kind === 'pooler' ? 'selectOrder' : kind === 'cache' ? 'GET key' : kind === 'nosql' ? 'GetItem' : kind === 'objectstore' ? 'GetObject' : 'GET /path'} onCommit={(op) => onChange({ ...s, op })} />
        <datalist id={listId}>
          {ops.map((o) => (
            <option key={o} value={o} />
          ))}
        </datalist>
      </div>
      <div className="flow-row flow-opts">
        <NumberInput ariaLabel="반복 횟수 (N+1 루프 등)" value={s.count} min={1} max={500} onCommit={(count) => onChange({ ...s, count })} suffix="회" />
        <NumberInput ariaLabel="실행 확률" value={+(s.prob * 100).toFixed(2)} min={0} max={100} step={1} onCommit={(p) => onChange({ ...s, prob: p / 100 })} suffix="%" />
        <label className="chk" title="이 호출이 실패해도 API는 성공으로 응답 (try/catch, fallback 없는 무시)">
          <input type="checkbox" checked={s.optional} onChange={(e) => onChange({ ...s, optional: e.target.checked })} /> 실패 무시
        </label>
        {depth === 0 && (
          <label className="chk" title="@Async: 요청 스레드를 붙잡지 않고 별도 풀에서 실행">
            <input type="checkbox" checked={s.async} onChange={(e) => onChange({ ...s, async: e.target.checked })} /> 비동기
          </label>
        )}
      </div>
      {kind === 'cache' && (
        <div className="flow-miss">
          <span className="muted small">캐시 미스일 때 (cache-aside: 조회 후 캐시를 채움)</span>
          <StepList c={c} steps={s.onMiss} depth={depth + 1} allow={['call', 'work']} onChange={(onMiss) => onChange({ ...s, onMiss })} />
        </div>
      )}
    </div>
  );
}

function WorkStep({ s, onChange }: { s: Extract<Step, { type: 'work' }>; onChange: (s: Step) => void }) {
  return (
    <div className="flow-row">
      <span className="kind-tag k-work">처리</span>
      <CommitInput className="flow-dur mono" value={s.work} ariaLabel="처리 시간" placeholder="5ms" onCommit={(work) => onChange({ ...s, work })} />
      <NumberInput ariaLabel="그중 CPU 비율" value={Math.round(s.cpu * 100)} min={0} max={100} onCommit={(p) => onChange({ ...s, cpu: p / 100 })} suffix="% CPU" />
      <span className="muted small">직렬화·계산·락 대기 등 호출 사이의 작업</span>
    </div>
  );
}

/** Steps of one API, written back to the scenario on every change. */
export function FlowEditor({ doc, svc, ep, onDoc }: { doc: RawDoc; svc: string; ep: string; onDoc: (d: RawDoc) => void }) {
  const raw = doc.nodes?.[svc]?.endpoints?.[ep] ?? {};
  const steps: Step[] = (raw.calls ?? []).map(toStep);
  const targets = Object.keys(doc.nodes ?? {}).filter((n) => n !== svc && !isFront(doc.nodes[n]));
  const c: Ctx = { doc, svc, targets };
  return (
    <div className="flow">
      <div className="flow-head">
        <span className="small">호출 흐름</span>
        <span className="muted small">자체 처리 뒤 위에서부터 순서대로 실행</span>
      </div>
      <StepList c={c} steps={steps} depth={0} allow={['call', 'work', 'parallel']} onChange={(s) => onDoc(setFlow(doc, svc, ep, s))} />
    </div>
  );
}

const METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'];

export function AddEndpoint({ doc, svc, onDoc }: { doc: RawDoc; svc: string; onDoc: (d: RawDoc) => void }) {
  const [method, setMethod] = useState('GET');
  const [path, setPath] = useState('');
  const name = `${method} ${path.trim().startsWith('/') ? path.trim() : `/${path.trim()}`}`;
  const exists = !!doc.nodes?.[svc]?.endpoints?.[name];
  const add = () => {
    if (!path.trim() || exists) return;
    onDoc(addEndpoint(doc, svc, name));
    setPath('');
  };
  return (
    <div className="add-endpoint">
      <select value={method} onChange={(e) => setMethod(e.target.value)} aria-label="HTTP 메서드">
        {METHODS.map((m) => (
          <option key={m}>{m}</option>
        ))}
      </select>
      <input className="mono" value={path} placeholder="/orders/{id}" aria-label="API 경로" onChange={(e) => setPath(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && add()} />
      <button className="primary small" disabled={!path.trim() || exists} onClick={add}>
        API 추가
      </button>
      {exists && <span className="error-text small">이미 있습니다</span>}
    </div>
  );
}

/** Editable API name + delete, shown in the API's header. */
export function EndpointHeader({ doc, svc, ep, onDoc }: { doc: RawDoc; svc: string; ep: string; onDoc: (d: RawDoc) => void }) {
  const [editing, setEditing] = useState(false);
  const calls = (doc.nodes?.[svc]?.endpoints?.[ep]?.calls ?? []).length;
  const reached = isReached(doc, svc, ep);
  if (editing)
    return (
      <span className="ep-head" onClick={(e) => e.preventDefault()}>
        <CommitInput
          className="mono"
          value={ep}
          ariaLabel="API 이름"
          onCommit={(to) => {
            onDoc(renameEndpoint(doc, svc, ep, to));
            setEditing(false);
          }}
        />
        <button className="ghost small" onClick={() => setEditing(false)}>
          완료
        </button>
      </span>
    );
  return (
    <span className="ep-head">
      <code>{ep}</code>
      <span className="muted small">{calls ? `${calls}단계` : ''}</span>
      <span className="ep-actions">
        {!reached && (
          <button
            className="ghost small no-traffic"
            title="이 API로 들어오는 요청이 없습니다. 시나리오 트래픽 믹스에 10%로 추가합니다 (시나리오 탭에서 비율 조정)."
            onClick={(e) => {
              e.preventDefault();
              onDoc(setPath(doc, ['scenario', 'traffic', 'mix', `${svc}:${ep}`], '10%'));
            }}
          >
            트래픽 없음 · 추가
          </button>
        )}
        <button
          className="ghost small"
          aria-label="API 이름 바꾸기"
          onClick={(e) => {
            e.preventDefault();
            setEditing(true);
          }}
        >
          ✎
        </button>
        <button
          className="ghost small"
          aria-label="API 삭제"
          onClick={(e) => {
            e.preventDefault();
            if (confirm(`${svc}의 ${ep}를 삭제할까요? 이 API를 호출하는 곳과 트래픽 믹스에서도 빠집니다.`)) onDoc(removeEndpoint(doc, svc, ep));
          }}
        >
          ✕
        </button>
      </span>
    </span>
  );
}
