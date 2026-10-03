import { useState } from 'react';
import { bottleneckName, rankSaturation, type SimResult, type Warning } from '@load-simulator/engine';
import { ms, num, pct, toMs, toRatio } from './format';
import type { CapacityState } from './useSim';
import type { Selection } from './Canvas';

function Delta({ a, b, lowerIsBetter = true, fmt }: { a?: number; b: number; lowerIsBetter?: boolean; fmt: (v: number) => string }) {
  if (a === undefined || !Number.isFinite(a) || !Number.isFinite(b)) return null;
  const better = lowerIsBetter ? b < a * 0.97 : b > a * 1.03;
  const worse = lowerIsBetter ? b > a * 1.03 : b < a * 0.97;
  return <small className={better ? 'good' : worse ? 'bad' : 'muted'}> (A {fmt(a)})</small>;
}

export function Results({
  result,
  compare,
  warnings,
  cap,
  sloDefaults,
  onCapacity,
  onSelect,
  onApplyCapacity,
}: {
  result: SimResult | null;
  compare: SimResult | null;
  warnings: Warning[];
  cap: CapacityState;
  sloDefaults: { p99: unknown; errorRate: unknown };
  onCapacity: (slo: { p99: number; errorRate: number }) => void;
  onSelect: (s: Selection) => void;
  onApplyCapacity?: () => void;
}) {
  const [p99, setP99] = useState(String(toMs(sloDefaults.p99, 300)));
  const [err, setErr] = useState(String(+(toRatio(sloDefaults.errorRate, 0.001) * 100).toFixed(3)));
  if (!result) return <p className="muted">계산 중…</p>;
  const s = result.summary;
  const cs = compare?.summary;
  const sat = rankSaturation(result).slice(0, 6);
  const select = (target?: string) => {
    if (!target) return;
    onSelect(target.includes('->') ? { type: 'edge', id: target } : { type: 'node', id: target });
  };

  return (
    <div className="results">
      <section className={`verdict ${s.sloPass ? 'pass' : 'fail'}`}>
        <strong>{s.sloPass ? 'SLO 충족' : 'SLO 위반'}</strong>
        {!s.sloPass && (
          <ul>
            {s.sloViolations.slice(0, 4).map((v) => (
              <li key={v}>{v}</li>
            ))}
          </ul>
        )}
      </section>

      <div className="stats">
        <div>
          <span>처리량</span>
          <b>{num(s.throughput)}</b>
          <small>rps</small>
          <Delta a={cs?.throughput} b={s.throughput} lowerIsBetter={false} fmt={num} />
        </div>
        <div>
          <span>p50</span>
          <b>{ms(s.p50)}</b>
          <Delta a={cs?.p50} b={s.p50} fmt={ms} />
        </div>
        <div>
          <span>p99</span>
          <b>{ms(s.p99)}</b>
          <Delta a={cs?.p99} b={s.p99} fmt={ms} />
        </div>
        <div>
          <span>에러율</span>
          <b>{pct(s.errorRate, 2)}</b>
          <Delta a={cs?.errorRate} b={s.errorRate} fmt={(v) => pct(v, 2)} />
        </div>
      </div>
      {s.degraded > 0 && <p className="note">fallback 응답 {s.degraded.toLocaleString()}건 (성공으로 집계)</p>}

      <h3>API별 결과</h3>
      <table className="api-table">
        <thead>
          <tr>
            <th>API</th>
            <th>rps</th>
            <th>p99</th>
            <th>에러</th>
            <th>SLO</th>
          </tr>
        </thead>
        <tbody>
          {result.endpoints
            .filter((e) => e.count > 0)
            .sort((a, b) => Number(b.entry) - Number(a.entry))
            .map((e) => (
              <tr key={e.id} className={e.entry ? 'entry' : ''} onClick={() => onSelect({ type: 'node', id: e.node })}>
                <td>
                  <code>{e.op}</code>
                  <small>
                    {e.node}
                    {!e.observed && (
                      <span className="estimated" title="트레이스에서 관측되지 않아 기본 프로파일(추정값)을 썼습니다">
                        추정
                      </span>
                    )}
                  </small>
                </td>
                <td>{num(e.throughput)}</td>
                <td>{ms(e.p99)}</td>
                <td>{pct(e.errorRate)}</td>
                <td>{e.slo ? (e.slo.pass ? '✓' : '✗') : ''}</td>
              </tr>
            ))}
        </tbody>
      </table>

      <h3>용량 산출</h3>
      <div className="capacity">
        <div className="cap-inputs">
          <label>
            p99 <input value={p99} onChange={(e) => setP99(e.target.value)} aria-label="SLO p99 (ms)" /> ms
          </label>
          <label>
            에러율 <input value={err} onChange={(e) => setErr(e.target.value)} aria-label="SLO 에러율 (%)" /> %
          </label>
          <button className="primary" disabled={cap.running} onClick={() => onCapacity({ p99: Number(p99), errorRate: Number(err) / 100 })}>
            {cap.running ? `탐색 중… (${cap.probes.length})` : '산출'}
          </button>
        </div>
        {cap.result && (
          <>
            <p className="cap-summary">{cap.result.summary}</p>
            {cap.result.bottleneck && (
              <button className="link" onClick={() => onSelect({ type: cap.result!.bottleneck!.edge ? 'edge' : 'node', id: cap.result!.bottleneck!.edge ?? cap.result!.bottleneck!.node })}>
                병목 보기: {bottleneckName(cap.result.bottleneck)}
              </button>
            )}
            {onApplyCapacity && (
              <button className="ghost" onClick={onApplyCapacity}>
                산출 RPS로 트래픽 설정
              </button>
            )}
          </>
        )}
        {cap.probes.length > 0 && (
          <div className="probes">
            {[...cap.probes]
              .sort((a, b) => a.rps - b.rps)
              .map((p) => (
                <span key={p.rps} className={p.pass ? 'pass' : 'fail'} title={`${p.worst.endpoint} p99 ${ms(p.worst.p99)}, 에러 ${pct(p.worst.errorRate, 2)}`}>
                  {num(p.rps)}
                </span>
              ))}
          </div>
        )}
      </div>

      <h3>자원 포화도</h3>
      <ul className="sat-list">
        {sat.map((r) => (
          <li key={r.resource} onClick={() => select(r.edge ?? r.node)}>
            <span className="sat-bar">
              <span style={{ width: `${Math.min(100, r.util * 100)}%` }} className={r.util > 0.95 ? 'hot' : r.util > 0.7 ? 'warm' : ''} />
            </span>
            <span>{bottleneckName(r)}</span>
            <small>
              {pct(r.util, 0)}
              {r.queue >= 0.5 ? ` · 대기 ${num(r.queue)}` : ''}
            </small>
          </li>
        ))}
      </ul>

      {s.errorCauses.length > 0 && (
        <>
          <h3>실패 원인</h3>
          <ul className="causes">
            {s.errorCauses.slice(0, 5).map((c) => (
              <li key={c.cause}>
                <code>{c.cause}</code> <small>{c.count.toLocaleString()}</small>
              </li>
            ))}
          </ul>
        </>
      )}

      {result.edges.some((e) => e.retries > 0 || e.cbRejected > 0 || e.fallbacks > 0) && (
        <>
          <h3>회복성 정책 동작</h3>
          <table className="api-table">
            <thead>
              <tr>
                <th>연결선</th>
                <th>증폭</th>
                <th>재시도</th>
                <th>서킷 거부</th>
                <th>fallback</th>
              </tr>
            </thead>
            <tbody>
              {result.edges
                .filter((e) => e.from !== 'client' && (e.retries > 0 || e.cbRejected > 0 || e.fallbacks > 0))
                .map((e) => (
                  <tr key={e.key} onClick={() => onSelect({ type: 'edge', id: e.key })}>
                    <td>
                      <code>{e.key}</code>
                    </td>
                    <td>×{e.amplification.toFixed(2)}</td>
                    <td>{e.retries.toLocaleString()}</td>
                    <td>{e.cbRejected.toLocaleString()}</td>
                    <td>{e.fallbacks.toLocaleString()}</td>
                  </tr>
                ))}
            </tbody>
          </table>
        </>
      )}

      <h3>정적 검사</h3>
      {warnings.length === 0 ? (
        <p className="muted">경고 없음</p>
      ) : (
        <ul className="warnings">
          {warnings.map((w, i) => (
            <li key={i} className={w.level} onClick={() => select(w.target)}>
              <span className="lvl">{w.level === 'error' ? '오류' : w.level === 'warn' ? '경고' : '참고'}</span>
              {w.message}
            </li>
          ))}
        </ul>
      )}
      <p className="muted small">
        진입 요청 {s.roots.toLocaleString()}건 · 사건 {s.eventsProcessed.toLocaleString()}개 · 엔진 {s.wallMs}ms · 측정 구간 {ms(result.window[0])}–{ms(result.window[1])}
      </p>
    </div>
  );
}
