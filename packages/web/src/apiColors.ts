// One colour per entry API, shared by the particle view, its legend and the results tables.
// Red and amber are left out: they mean failure and fallback everywhere in the UI.
import type { SimResult } from '@load-simulator/engine';

const PALETTE = ['#3b82f6', '#a855f7', '#14b8a6', '#ec4899', '#06b6d4', '#84cc16', '#6366f1', '#d946ef', '#0ea5e9', '#22c55e'];

export interface ApiColor {
  id: string;
  node: string;
  op: string;
  color: string;
  /** position among the entry APIs, used to give each API its own lane on an edge */
  lane: number;
}

const cache = new WeakMap<SimResult, Map<string, ApiColor>>();

export function apiColors(result: SimResult | null): Map<string, ApiColor> {
  if (!result) return new Map();
  let m = cache.get(result);
  if (m) return m;
  m = new Map();
  const entries = result.endpoints.filter((e) => e.entry);
  entries.forEach((e, i) => m!.set(e.id, { id: e.id, node: e.node, op: e.op, color: PALETTE[i % PALETTE.length], lane: i - (entries.length - 1) / 2 }));
  cache.set(result, m);
  return m;
}
