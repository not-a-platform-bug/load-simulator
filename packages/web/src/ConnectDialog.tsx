import { useState } from 'react';
import type { RawDoc } from '@load-simulator/engine';
import { isFront, nodeKind, operationsOf, type ConnectSpec } from './doc';

/** Connecting two blocks means "this API of A calls that operation of B" — ask which, instead of guessing. */
export function ConnectDialog({ doc, from, to, onCancel, onConfirm }: { doc: RawDoc; from: string; to: string; onCancel: () => void; onConfirm: (c: ConnectSpec) => void }) {
  const src = doc.nodes?.[from];
  const dst = doc.nodes?.[to];
  // a gateway exposes the target API under the same path; a load balancer just fronts the target
  const endpoints = isFront(src) ? ['(라우트)'] : Object.keys(src?.endpoints ?? {});
  const ops = operationsOf(dst, doc);
  const [fromEndpoint, setFromEndpoint] = useState(endpoints[0] ?? '');
  const [op, setOp] = useState(ops[0] ?? '');
  const [custom, setCustom] = useState('');
  const [prob, setProb] = useState('100');
  const [count, setCount] = useState('1');
  const canCustom = nodeKind(dst) !== 'service' && nodeKind(dst) !== 'queue';
  if (nodeKind(src) !== 'service' && !isFront(src)) {
    return (
      <div className="modal-backdrop" onClick={onCancel}>
        <div className="modal small" onClick={(e) => e.stopPropagation()}>
          <p>호출은 서비스에서만 시작할 수 있습니다. 메시지 큐의 소비자는 큐 설정의 컨슈머에서 지정하세요.</p>
          <footer>
            <button className="primary" onClick={onCancel}>
              확인
            </button>
          </footer>
        </div>
      </div>
    );
  }
  return (
    <div className="modal-backdrop" onClick={onCancel}>
      <div className="modal small" role="dialog" aria-modal="true" aria-label="호출 추가" onClick={(e) => e.stopPropagation()}>
        <header>
          <h2>
            {from} → {to} 호출 추가
          </h2>
        </header>
        <div className="modal-body form">
          <label>
            호출하는 API ({from})
            <select value={fromEndpoint} onChange={(e) => setFromEndpoint(e.target.value)}>
              {endpoints.map((x) => (
                <option key={x}>{x}</option>
              ))}
            </select>
          </label>
          <label>
            호출 대상 ({to})
            <select value={op} onChange={(e) => setOp(e.target.value)}>
              {ops.map((x) => (
                <option key={x}>{x}</option>
              ))}
              {canCustom && <option value="__new">새 오퍼레이션…</option>}
            </select>
          </label>
          {op === '__new' && (
            <label>
              이름 <input value={custom} onChange={(e) => setCustom(e.target.value)} placeholder={nodeKind(dst) === 'db' ? 'selectOrder' : 'GET key'} />
            </label>
          )}
          <div className="row2">
            <label>
              호출 확률 (%) <input value={prob} onChange={(e) => setProb(e.target.value)} />
            </label>
            <label>
              요청당 횟수 <input value={count} onChange={(e) => setCount(e.target.value)} />
            </label>
          </div>
        </div>
        <footer>
          <button className="ghost" onClick={onCancel}>
            취소
          </button>
          <button
            className="primary"
            disabled={!fromEndpoint || (op === '__new' && !custom.trim())}
            onClick={() => onConfirm({ from, to, fromEndpoint, op: op === '__new' ? custom.trim() : op, prob: Math.min(1, Number(prob) / 100 || 1), count: Math.max(1, Math.round(Number(count) || 1)) })}
          >
            추가
          </button>
        </footer>
      </div>
    </div>
  );
}
