import { useEffect, useRef } from 'react';
import uPlot from 'uplot';
import 'uplot/dist/uPlot.min.css';
import type { SimResult } from '@load-simulator/engine';
import { clock } from './clock';
import { ms } from './format';

interface Props {
  result: SimResult | null;
  compare: SimResult | null;
  compareLabel: string;
  sloP99: number;
  /** edge whose breaker state is plotted; defaults to the edge with most OPEN time */
  cbEdge?: string;
}

const css = (el: Element, name: string, fallback: string) => getComputedStyle(el).getPropertyValue(name).trim() || fallback;
const clean = (a: number[]) => a.map((v) => (Number.isFinite(v) ? v : null));

function pickCbEdge(r: SimResult, preferred?: string): string | undefined {
  if (preferred && r.edges.some((e) => e.key === preferred && e.series.cbOpen.some((v) => v > 0))) return preferred;
  let best: string | undefined;
  let bestSum = 0;
  for (const e of r.edges) {
    const s = e.series.cbOpen.reduce((a, b) => a + b, 0) + e.series.cbHalfOpen.reduce((a, b) => a + b, 0) * 0.5;
    if (s > bestSum) {
      bestSum = s;
      best = e.key;
    }
  }
  return best ?? preferred;
}

export function Timeline({ result, compare, compareLabel, sloP99, cbEdge }: Props) {
  const host = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = host.current;
    if (!el || !result) return;
    el.innerHTML = '';
    const plots: uPlot[] = [];
    const heads: HTMLDivElement[] = [];
    const xs = result.time.map((t) => t - result.bucketMs / 2000);
    const C = {
      ok: css(el, '--c-ok', '#14b8a6'),
      err: css(el, '--c-err', '#ef4444'),
      arr: css(el, '--c-muted', '#94a3b8'),
      p50: css(el, '--c-p50', '#6366f1'),
      p99: css(el, '--c-p99', '#f59e0b'),
      cmp: css(el, '--c-compare', '#64748b'),
      grid: css(el, '--c-grid', 'rgba(148,163,184,.18)'),
      text: css(el, '--c-axis', '#64748b'),
      fault: css(el, '--c-fault', 'rgba(239,68,68,.08)'),
      cb: css(el, '--c-cb', '#dc2626'),
    };
    const faults: [number, number][] = [];
    const starts = result.events.filter((e) => e.type === 'fault-start');
    for (const s of starts) {
      const end = result.events.find((e) => e.type === 'fault-end' && e.target === s.target && e.t > s.t);
      faults.push([s.t / 1000, (end?.t ?? result.duration) / 1000]);
    }
    const cmpX = compare ? compare.time.map((t) => t - compare.bucketMs / 2000) : null;
    const align = (arr: number[] | undefined) => {
      if (!compare || !arr || !cmpX) return xs.map(() => null);
      return xs.map((x) => {
        const i = cmpX.findIndex((cx) => Math.abs(cx - x) < 1e-6);
        return i >= 0 && Number.isFinite(arr[i]) ? arr[i] : null;
      });
    };
    const edgeKey = pickCbEdge(result, cbEdge);
    const cbSeries = (r: SimResult | null) => {
      const e = r?.edges.find((x) => x.key === edgeKey);
      return e ? e.series.cbOpen.map((v, i) => v + e.series.cbHalfOpen[i] * 0.5) : null;
    };

    const axis = (label: string, fmt?: (v: number) => string): uPlot.Axis => ({
      stroke: C.text,
      grid: { stroke: C.grid, width: 1 },
      ticks: { stroke: C.grid, width: 1 },
      label,
      labelSize: 14,
      labelFont: '11px system-ui',
      font: '11px system-ui',
      size: 48,
      values: fmt ? (_u, vals) => vals.map((v) => (v == null ? '' : fmt(v))) : undefined,
    });

    const LEGEND = 20;
    const width = el.clientWidth;
    const slot = () => Math.max(70, Math.floor((el.clientHeight - 4 - 20) / 3) - LEGEND);
    const height = slot();
    let syncing = false;

    const shade: uPlot.Plugin = {
      hooks: {
        drawClear: (u) => {
          const ctx = u.ctx;
          ctx.save();
          ctx.fillStyle = C.fault;
          for (const [a, b] of faults) {
            const x0 = u.valToPos(a, 'x', true);
            const x1 = u.valToPos(b, 'x', true);
            ctx.fillRect(x0, u.bbox.top, x1 - x0, u.bbox.height);
          }
          ctx.restore();
        },
      },
    };

    let chartIndex = 0;
    const make = (title: string, series: uPlot.Series[], data: uPlot.AlignedData, axes: uPlot.Axis[], scales: uPlot.Scales = {}, extra?: uPlot.Plugin) => {
      const last = chartIndex++ === 2;
      const opts: uPlot.Options = {
        width,
        height,
        legend: { show: true, live: true },
        cursor: { sync: { key: 'timeline' }, drag: { x: true, y: false, setScale: false }, points: { size: 6 } },
        select: { show: true, left: 0, top: 0, width: 0, height: 0 },
        scales: { x: { time: false }, ...scales },
        axes: [last ? { ...axis('', (v) => `${v}s`), size: 24, labelSize: 0 } : { ...axis(''), size: 4, labelSize: 0, values: () => [], ticks: { show: false } }, ...axes],
        series: [{ label: '시간', value: (_u, v) => (v == null ? '' : `${v.toFixed(0)}s`) }, ...series],
        plugins: [shade, ...(extra ? [extra] : [])],
        hooks: {
          setSelect: [
            (u) => {
              if (u.select.width > 4) {
                const min = u.posToVal(u.select.left, 'x');
                const max = u.posToVal(u.select.left + u.select.width, 'x');
                for (const p of plots) p.setScale('x', { min, max });
              }
              u.setSelect({ left: 0, top: 0, width: 0, height: 0 }, false);
            },
          ],
          setScale: [
            (u, key) => {
              if (key !== 'x' || syncing) return;
              syncing = true;
              const { min, max } = u.scales.x;
              for (const p of plots) if (p !== u) p.setScale('x', { min: min!, max: max! });
              syncing = false;
              moveHeads(clock.t);
            },
          ],
        },
      };
      for (const sr of opts.series.slice(1)) sr.points = { show: false };
      const u = new uPlot(opts, data, el);
      plots.push(u);
      const label = document.createElement('div');
      label.className = 'chart-title';
      label.textContent = title;
      u.root.appendChild(label);
      const head = document.createElement('div');
      head.className = 'playhead';
      u.over.appendChild(head);
      heads.push(head);
      let down = 0;
      u.over.addEventListener('mousedown', (e) => (down = e.clientX));
      u.over.addEventListener('click', (e) => {
        if (Math.abs(e.clientX - down) > 4) return;
        const v = u.posToVal(u.cursor.left ?? 0, 'x');
        clock.seek(Math.max(0, v * 1000));
      });
      u.over.addEventListener('dblclick', () => {
        for (const p of plots) p.setScale('x', { min: xs[0], max: xs[xs.length - 1] });
      });
      return u;
    };

    const s = result.series;
    const cs = compare?.series;
    const dashed = { dash: [5, 4], width: 1.5, stroke: C.cmp };

    make(
      '처리량 (요청/s)',
      [
        { label: '도착', stroke: C.arr, width: 1, dash: [2, 3], value: (_u, v) => (v == null ? '' : v.toFixed(0)) },
        { label: '성공', stroke: C.ok, width: 2, fill: C.ok + '22', value: (_u, v) => (v == null ? '' : v.toFixed(0)) },
        { label: '실패', stroke: C.err, width: 2, fill: C.err + '22', value: (_u, v) => (v == null ? '' : v.toFixed(0)) },
        ...(compare ? [{ label: `성공 (${compareLabel})`, ...dashed, value: (_u: uPlot, v: number | null) => (v == null ? '' : v.toFixed(0)) }] : []),
      ],
      [xs, s.arrivals, s.throughput, s.errors, ...(compare ? [align(cs!.throughput)] : [])] as uPlot.AlignedData,
      [axis('')],
    );

    const sloPlugin: uPlot.Plugin = {
      hooks: {
        draw: (u) => {
          const y = u.valToPos(sloP99, 'y', true);
          if (y < u.bbox.top || y > u.bbox.top + u.bbox.height) return;
          const ctx = u.ctx;
          ctx.save();
          ctx.strokeStyle = C.err;
          ctx.setLineDash([3, 3]);
          ctx.lineWidth = 1;
          ctx.beginPath();
          ctx.moveTo(u.bbox.left, y);
          ctx.lineTo(u.bbox.left + u.bbox.width, y);
          ctx.stroke();
          ctx.fillStyle = C.err;
          ctx.font = `${10 * devicePixelRatio}px system-ui`;
          const text = `SLO p99 ${ms(sloP99)}`;
          ctx.fillText(text, u.bbox.left + u.bbox.width - ctx.measureText(text).width - 6 * devicePixelRatio, y - 4 * devicePixelRatio);
          ctx.restore();
        },
      },
    };
    make(
      '지연 (ms, 로그)',
      [
        { label: 'p50', stroke: C.p50, width: 1.5, value: (_u, v) => (v == null ? '' : ms(v)) },
        { label: 'p99', stroke: C.p99, width: 2, value: (_u, v) => (v == null ? '' : ms(v)) },
        ...(compare ? [{ label: `p99 (${compareLabel})`, ...dashed, value: (_u: uPlot, v: number | null) => (v == null ? '' : ms(v)) }] : []),
      ],
      [xs, clean(s.p50), clean(s.p99), ...(compare ? [align(cs!.p99)] : [])] as uPlot.AlignedData,
      [axis('', (v) => ms(v))],
      { y: { distr: 3, range: (_u, min, max) => [Math.max(0.5, (min ?? 1) * 0.8), Math.max(sloP99 * 1.3, (max ?? 10) * 1.3)] } },
      sloPlugin,
    );

    const cb = cbSeries(result);
    make(
      `에러율 · 서킷${edgeKey ? ` (${edgeKey})` : ''}`,
      [
        { label: '에러율', stroke: C.err, width: 2, fill: C.err + '18', scale: '%', value: (_u, v) => (v == null ? '' : `${(v * 100).toFixed(1)}%`) },
        ...(cb ? [{ label: '서킷 OPEN', stroke: C.cb, width: 1.5, scale: '%', paths: uPlot.paths.stepped!({ align: 1 }), value: (_u: uPlot, v: number | null) => (v == null ? '' : v >= 0.99 ? 'OPEN' : v > 0.01 ? `${(v * 100).toFixed(0)}%` : 'CLOSED') }] : []),
        ...(compare ? [{ label: `에러율 (${compareLabel})`, ...dashed, scale: '%', value: (_u: uPlot, v: number | null) => (v == null ? '' : `${(v * 100).toFixed(1)}%`) }] : []),
      ],
      [xs, s.errorRate, ...(cb ? [cb] : []), ...(compare ? [align(cs!.errorRate)] : [])] as uPlot.AlignedData,
      [{ ...axis('', (v) => `${(v * 100).toFixed(0)}%`), scale: '%' }],
      { '%': { range: [0, 1] } },
    );

    const moveHeads = (t: number) => {
      for (let i = 0; i < plots.length; i++) {
        const left = plots[i].valToPos(t / 1000, 'x');
        heads[i].style.transform = `translateX(${left}px)`;
        heads[i].style.display = left < 0 || left > plots[i].over.clientWidth ? 'none' : 'block';
      }
    };
    moveHeads(clock.t);
    const off = clock.subscribe(moveHeads);

    const ro = new ResizeObserver(() => {
      const w = el.clientWidth;
      const h = slot();
      for (const p of plots) p.setSize({ width: w, height: h });
      moveHeads(clock.t);
    });
    ro.observe(el);
    return () => {
      off();
      ro.disconnect();
      for (const p of plots) p.destroy();
    };
  }, [result, compare, compareLabel, sloP99, cbEdge]);

  return <div className="timeline" ref={host} />;
}
