// Details of the selected block at the current playhead, shown over the canvas (the side panel stays where it is).
import type { Finding, RawDoc, SimResult } from '@load-simulator/engine';
import { resourceName } from '@load-simulator/engine';
import { ms, num, pct } from './format';
import { clusterLabel, satColor, type Selection } from './Canvas';
import { nodeKind } from './doc';

const KIND: Record<string, string> = { service: '서비스', db: 'DB', cache: '캐시', external: '외부 API', queue: '메시지 큐', gateway: 'API 게이트웨이', loadbalancer: '로드밸런서' };

export function NodeCard({ doc, selection, result, sec, findings, onEdit, onClose }: {
  doc: RawDoc;
  selection: NonNullable<Selection>;
  result: SimResult | null;
  sec: number;
  findings: Finding[];
  onEdit: () => void;
  onClose: () => void;
}) {
  const b = Math.max(0, Math.min((result?.buckets ?? 1) - 1, sec));
  const id = selection.id;
  const mine = findings.filter((f) => f.target === id || (selection.type === 'node' && f.target?.startsWith(`${id}->`)));
  let title = id.replace('->', ' → ');
  let sub = '';
  const rows: { label: string; value: number; text: string }[] = [];
  const facts: string[] = [];
  if (selection.type === 'node') {
    const raw = doc.nodes?.[id] ?? {};
    sub = [KIND[nodeKind(raw)], ['service', 'gateway', 'loadbalancer'].includes(nodeKind(raw)) && (raw.instances ?? 1) > 1 ? `${raw.instances}대` : '', clusterLabel(raw)].filter(Boolean).join(' · ');
    const nr = result?.nodes.find((n) => n.name === id);
    for (const r of result?.resources.filter((x) => x.node === id && x.kind !== 'fd' && x.kind !== 'ports') ?? []) {
      if (r.util[b] === undefined) continue;
      rows.push({ label: resourceName(r).replace(`${id} `, ''), value: r.util[b], text: `${pct(r.util[b], 0)}${r.queue[b] >= 1 ? ` · 대기 ${num(r.queue[b])}` : ''}` });
    }
    if (nr) {
      facts.push(`처리 ${num(nr.served[b])}/s`);
      if (nr.os) {
        if (nr.os.gcPauseMs[b] > 0) facts.push(`GC 정지 ${ms(nr.os.gcPauseMs[b])}/s`);
        if (nr.os.synDrops[b] > 0) facts.push(`SYN 드롭 ${nr.os.synDrops[b]}`);
        if (nr.os.throttledMs[b] > 0) facts.push(`쓰로틀 ${ms(nr.os.throttledMs[b])}`);
        if (nr.os.healthy[b] < nr.instances) facts.push(`정상 인스턴스 ${nr.os.healthy[b]}/${nr.instances}`);
      }
      if (nr.queue) {
        facts.push(`적체 ${num(nr.queue.depth[b])}`, `발행 ${num(nr.queue.published[b])}/s`, `처리 ${num(nr.queue.acked[b])}/s`);
        if (nr.queue.oldestAgeMs[b] > 0) facts.push(`가장 오래된 메시지 ${ms(nr.queue.oldestAgeMs[b])}`);
      }
      if (nr.cache) facts.push(`적중 ${num(nr.cache.hits[b])}/s · 미스 ${num(nr.cache.misses[b])}/s`);
    }
    const eps = result?.endpoints.filter((e) => e.node === id && e.count > 0) ?? [];
    for (const e of eps.slice(0, 4)) facts.push(`${e.op}: p99 ${ms(e.p99)}, 에러 ${pct(e.errorRate)}${e.observed ? '' : ' (추정 프로파일)'}`);
  } else {
    sub = '연결선';
    const er = result?.edges.find((e) => e.key === id);
    if (er) {
      facts.push(`시도 ${num(er.series.attempts[b])}/s`, `재시도 ${num(er.series.retries[b])}/s`, `실패 ${num(er.series.failures[b])}/s`);
      if (er.series.cbOpen[b] > 0.01) facts.push(`서킷 OPEN ${pct(er.series.cbOpen[b], 0)}`);
      facts.push(`진입 요청당 ${er.amplification.toFixed(2)}회 시도`);
    }
    for (const r of result?.resources.filter((x) => x.edge === id) ?? []) rows.push({ label: resourceName(r).split(' ').slice(1).join(' '), value: r.util[b], text: `${pct(r.util[b], 0)}${r.queue[b] >= 1 ? ` · 대기 ${num(r.queue[b])}` : ''}` });
    title = id.replace('->', ' → ');
  }
  return (
    <aside className="node-card" aria-label={`${title} 상세`}>
      <header>
        <div>
          <small>{sub}</small>
          <h3>{title}</h3>
        </div>
        <button className="ghost small" onClick={onClose} aria-label="닫기">
          ✕
        </button>
      </header>
      <p className="muted small">{(b + 1).toString()}초 시점</p>
      {rows.map((r) => (
        <div className="gauge" key={r.label}>
          <span className="gauge-label" title={r.label}>
            {r.label}
          </span>
          <span className="gauge-bar">
            <span style={{ width: `${Math.min(100, r.value * 100)}%`, background: satColor(r.value) }} />
          </span>
          <span className="gauge-text">{r.text}</span>
        </div>
      ))}
      {facts.length > 0 && (
        <ul className="facts">
          {facts.map((f) => (
            <li key={f}>{f}</li>
          ))}
        </ul>
      )}
      {mine.length > 0 && (
        <ul className="card-findings">
          {mine.slice(0, 3).map((f, i) => (
            <li key={i} className={f.severity}>
              {f.title}
            </li>
          ))}
        </ul>
      )}
      <footer>
        <button className="primary small" onClick={onEdit}>
          설정 편집
        </button>
      </footer>
    </aside>
  );
}
