// Runs the engine off the UI thread. Every message carries the raw document so the worker is stateless.
import { advise, checkModel, findCapacity, parseModel, simulate, ModelError, type RawDoc } from '@load-simulator/engine';

export type WorkerRequest =
  | { id: number; type: 'run'; doc: RawDoc; seed?: number }
  | { id: number; type: 'capacity'; doc: RawDoc; slo: { p99?: number; errorRate?: number } }
  | { id: number; type: 'advise'; doc: RawDoc };

self.onmessage = (ev: MessageEvent<WorkerRequest>) => {
  const req = ev.data;
  try {
    const model = parseModel(req.doc);
    if (req.type === 'run') {
      const t = performance.now();
      const warnings = checkModel(model);
      const result = simulate(model, model.scenario, req.seed ?? model.scenario.seed);
      (self as any).postMessage({ id: req.id, type: 'run', result, warnings, ms: performance.now() - t });
    } else if (req.type === 'advise') {
      const t = performance.now();
      const advice = advise(req.doc, {
        onProgress: (done, total, label) => (self as any).postMessage({ id: req.id, type: 'progress', done, total, label }),
      });
      (self as any).postMessage({ id: req.id, type: 'advice', advice, ms: performance.now() - t });
    } else {
      const t = performance.now();
      const capacity = findCapacity(model, {
        slo: req.slo,
        onProbe: (p) => (self as any).postMessage({ id: req.id, type: 'probe', probe: p }),
      });
      (self as any).postMessage({ id: req.id, type: 'capacity', capacity, ms: performance.now() - t });
    }
  } catch (e) {
    const err = e as Error;
    (self as any).postMessage({ id: req.id, type: 'error', message: err.message, path: e instanceof ModelError ? e.path : '' });
  }
};
