import type { Finding, Metrics, Recommendation } from '@load-simulator/engine';
import { ms, num, pct } from './format';
import type { AdviceState } from './useSim';
import type { Selection } from './Canvas';

const CATEGORY: Record<Recommendation['category'], string> = {
  resilience: '회복성',
  capacity: '용량',
  config: '설정',
  architecture: '구조',
};

function Delta({ label, a, b, fmt, higherIsBetter = false }: { label: string; a: number; b: number; fmt: (v: number) => string; higherIsBetter?: boolean }) {
  const better = higherIsBetter ? b > a * 1.02 : b < a * 0.98;
  const worse = higherIsBetter ? b < a * 0.98 : b > a * 1.02;
  if (!better && !worse) return null;
  return (
    <span className={`delta ${better ? 'good' : 'bad'}`}>
      {label} {fmt(a)} → <b>{fmt(b)}</b>
    </span>
  );
}

function Impact({ before, after }: { before: Metrics; after: Metrics }) {
  return (
    <div className="impact">
      {after.sloPass && !before.sloPass && <span className="delta good">SLO 충족</span>}
      <Delta label="에러율" a={before.errorRate} b={after.errorRate} fmt={(v) => pct(v, 1)} />
      <Delta label="p99" a={before.p99} b={after.p99} fmt={ms} />
      <Delta label="처리량" a={before.throughput} b={after.throughput} fmt={(v) => `${num(v)}rps`} higherIsBetter />
      {before.maxBacklog > 0 && <Delta label="최대 적체" a={before.maxBacklog} b={after.maxBacklog} fmt={(v) => num(v)} />}
    </div>
  );
}

function selectionOf(target?: string): Selection {
  if (!target) return null;
  return target.includes('->') ? { type: 'edge', id: target } : { type: 'node', id: target };
}

export function AdvisorPanel({
  adv,
  stale,
  onRun,
  onApply,
  onApplyPlan,
  onSelect,
}: {
  adv: AdviceState;
  /** the scenario changed since the advice was computed */
  stale: boolean;
  onRun: () => void;
  onApply: (r: Recommendation) => void;
  onApplyPlan: () => void;
  onSelect: (s: Selection) => void;
}) {
  const a = adv.advice;
  if (adv.running) {
    const p = adv.progress;
    return (
      <div className="advisor">
        <div className="advisor-running">
          <div className="spinner" aria-hidden />
          <div>
            <strong>진단하고 해결책을 시뮬레이션하는 중</strong>
            <p className="muted small">{p ? `${p.label} (${p.done + 1}/${p.total})` : '현재 상태를 분석하는 중…'}</p>
          </div>
        </div>
      </div>
    );
  }
  if (!a) {
    return (
      <div className="advisor empty">
        <p>
          지금 시나리오를 진단해 <b>어디서 문제가 시작됐는지</b> 찾고, 해결책 후보를 하나씩 같은 시나리오로 시뮬레이션해 효과가 큰 순서로 권장합니다.
        </p>
        <button className="primary" onClick={onRun}>
          진단 및 권장 받기
        </button>
        {adv.error && <p className="error-text">{adv.error}</p>}
      </div>
    );
  }
  const findings = a.findings.filter((f) => f.severity !== 'minor');
  const minor = a.findings.filter((f) => f.severity === 'minor');
  const useful = a.recommendations.filter((r) => r.score > 0.01 && r.improvement > 0.03);
  const plan = a.plan;
  const finalAfter = plan.length ? plan[plan.length - 1].after : null;
  return (
    <div className="advisor">
      <div className="advisor-head">
        <span className="muted small">
          {stale ? '시나리오가 바뀌어 아래 결과는 이전 상태 기준입니다.' : `현재 시나리오 기준 · ${a.evaluated}개 후보 시뮬레이션 · ${(adv.ms / 1000).toFixed(1)}초`}
        </span>
        <button className={stale ? 'primary small' : 'ghost small'} onClick={onRun} title="현재 시나리오로 다시 진단하고 해결책을 다시 시뮬레이션합니다">
          ↻ 다시 진단
        </button>
      </div>
      <section>
        <h3>진단</h3>
        {findings.length === 0 && <p className="muted">문제를 찾지 못했습니다. SLO를 지키고 있습니다.</p>}
        <ul className="findings">
          {findings.map((f, i) => (
            <FindingItem key={i} f={f} onSelect={onSelect} />
          ))}
        </ul>
      </section>

      {plan.length > 0 && finalAfter && (
        <section className="plan">
          <h3>권장 조치 순서</h3>
          <ol>
            {plan.map((p, i) => (
              <li key={p.step.id}>
                <span>{p.step.title}</span>
                {i === plan.length - 1 && <Impact before={a.baseline} after={finalAfter} />}
              </li>
            ))}
          </ol>
          <button className="primary" onClick={onApplyPlan}>
            {plan.length > 1 ? `${plan.length}단계 모두 적용` : '적용'}
          </button>
        </section>
      )}

      {useful.length > 0 && (
        <section>
          <h3>해결책 후보 {useful.length}개</h3>
          <div className="recs">
            {useful.map((r) => (
              <article key={r.id} className="rec">
                <header>
                  <span className={`cat cat-${r.category}`}>{CATEGORY[r.category]}</span>
                  <h4>{r.title}</h4>
                  <span className="gain">문제의 {Math.round(r.improvement * 100)}% 해소</span>
                </header>
                <p>{r.why}</p>
                <Impact before={r.before} after={r.after} />
                <footer>
                  <small className="muted">대가: {r.tradeoff}</small>
                  <span className="rec-actions">
                    {r.target && (
                      <button className="link" onClick={() => onSelect(selectionOf(r.target))}>
                        위치 보기
                      </button>
                    )}
                    <button className="primary small" onClick={() => onApply(r)}>
                      적용
                    </button>
                  </span>
                </footer>
              </article>
            ))}
          </div>
        </section>
      )}
      {useful.length === 0 && findings.length > 0 && <p className="muted">시뮬레이션한 해결책 후보 중 효과가 확인된 것이 없습니다. 설정 탭에서 직접 바꿔 보세요.</p>}

      {minor.length > 0 && (
        <details className="minor">
          <summary>설정 경고 {minor.length}개</summary>
          <ul className="findings">
            {minor.map((f, i) => (
              <FindingItem key={i} f={f} onSelect={onSelect} />
            ))}
          </ul>
        </details>
      )}
      <p className="muted small">같은 시나리오·시드로 후보 {a.evaluated}개를 실행해 효과가 확인된 것만 보여 줍니다.</p>
    </div>
  );
}

function FindingItem({ f, onSelect }: { f: Finding; onSelect: (s: Selection) => void }) {
  return (
    <li className={`finding ${f.severity}`} onClick={() => onSelect(selectionOf(f.target))}>
      <strong>{f.title}</strong>
      <span>{f.detail}</span>
    </li>
  );
}
