import { useCallback, useEffect, useRef, useState } from 'react';
import type { Advice, CapacityProbe, CapacityResult, RawDoc, SimResult, Warning } from '@load-simulator/engine';
import type { WorkerRequest } from './sim.worker';

export interface RunState {
  result: SimResult | null;
  /** the document that produced `result` */
  doc: RawDoc | null;
  warnings: Warning[];
  error: { message: string; path: string } | null;
  running: boolean;
  ms: number;
}

export interface AdviceState {
  running: boolean;
  progress: { done: number; total: number; label: string } | null;
  advice: Advice | null;
  /** the document the advice was computed for */
  doc: RawDoc | null;
  error: string | null;
  ms: number;
}

export interface CapacityState {
  running: boolean;
  probes: CapacityProbe[];
  result: CapacityResult | null;
  ms: number;
}

function makeWorker(): Worker {
  return new Worker(new URL('./sim.worker.ts', import.meta.url), { type: 'module' });
}

/**
 * Re-runs the simulation whenever the document changes. A newer request terminates a still-running worker
 * so dragging a slider never queues up stale runs.
 */
export function useSimulation(doc: RawDoc | null, debounceMs = 120) {
  const [run, setRun] = useState<RunState>({ result: null, doc: null, warnings: [], error: null, running: false, ms: 0 });
  const [cap, setCap] = useState<CapacityState>({ running: false, probes: [], result: null, ms: 0 });
  const worker = useRef<Worker | null>(null);
  const busy = useRef(false);
  const capWorker = useRef<Worker | null>(null);
  const advWorker = useRef<Worker | null>(null);
  const seq = useRef(0);
  const [adv, setAdv] = useState<AdviceState>({ running: false, progress: null, advice: null, doc: null, error: null, ms: 0 });

  useEffect(() => {
    if (!doc) return;
    const timer = setTimeout(() => {
      const id = ++seq.current;
      if (busy.current && worker.current) {
        worker.current.terminate();
        worker.current = null;
      }
      if (!worker.current) worker.current = makeWorker();
      const w = worker.current;
      busy.current = true;
      setRun((r) => ({ ...r, running: true }));
      w.onmessage = (ev) => {
        const m = ev.data;
        if (m.id !== seq.current) return;
        busy.current = false;
        if (m.type === 'error') setRun((r) => ({ ...r, running: false, error: { message: m.message, path: m.path } }));
        else setRun({ result: m.result, doc, warnings: m.warnings, error: null, running: false, ms: m.ms });
      };
      w.postMessage({ id, type: 'run', doc } satisfies WorkerRequest);
    }, debounceMs);
    return () => clearTimeout(timer);
  }, [doc, debounceMs]);

  useEffect(() => () => {
    worker.current?.terminate();
    capWorker.current?.terminate();
    advWorker.current?.terminate();
  }, []);

  const runAdvice = useCallback((d: RawDoc) => {
    advWorker.current?.terminate();
    const w = makeWorker();
    advWorker.current = w;
    setAdv({ running: true, progress: null, advice: null, doc: d, error: null, ms: 0 });
    w.onmessage = (ev) => {
      const m = ev.data;
      if (m.type === 'progress') setAdv((a) => ({ ...a, progress: { done: m.done, total: m.total, label: m.label } }));
      else if (m.type === 'advice') {
        setAdv((a) => ({ ...a, running: false, progress: null, advice: m.advice, ms: m.ms }));
        w.terminate();
      } else if (m.type === 'error') {
        setAdv((a) => ({ ...a, running: false, progress: null, error: m.message }));
        w.terminate();
      }
    };
    w.postMessage({ id: 1, type: 'advise', doc: d } satisfies WorkerRequest);
  }, []);

  const clearAdvice = useCallback(() => {
    advWorker.current?.terminate();
    setAdv({ running: false, progress: null, advice: null, doc: null, error: null, ms: 0 });
  }, []);

  const runCapacity = useCallback((d: RawDoc, slo: { p99?: number; errorRate?: number }) => {
    capWorker.current?.terminate();
    const w = makeWorker();
    capWorker.current = w;
    setCap({ running: true, probes: [], result: null, ms: 0 });
    w.onmessage = (ev) => {
      const m = ev.data;
      if (m.type === 'probe') setCap((c) => ({ ...c, probes: [...c.probes, m.probe] }));
      else if (m.type === 'capacity') {
        setCap((c) => ({ ...c, running: false, result: m.capacity, ms: m.ms }));
        w.terminate();
      } else if (m.type === 'error') {
        setCap((c) => ({ ...c, running: false }));
        w.terminate();
      }
    };
    w.postMessage({ id: 1, type: 'capacity', doc: d, slo } satisfies WorkerRequest);
  }, []);

  const clearCapacity = useCallback(() => {
    capWorker.current?.terminate();
    setCap({ running: false, probes: [], result: null, ms: 0 });
  }, []);

  return { run, cap, runCapacity, clearCapacity, adv, runAdvice, clearAdvice };
}
