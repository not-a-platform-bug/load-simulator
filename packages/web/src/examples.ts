// Demo scenarios: every YAML file in /examples is picked up automatically (drop a file there to add a demo).
import { parse } from 'yaml';
import type { RawDoc } from '@load-simulator/engine';

export interface Demo {
  id: string;
  title: string;
  /** what goes wrong, shown until the diagnosis is ready */
  problem: string;
  focus?: string;
  doc: RawDoc;
  yaml: string;
}

const files = import.meta.glob('../../../examples/*.yaml', { query: '?raw', import: 'default', eager: true }) as Record<string, string>;

export const DEMOS: Demo[] = Object.entries(files)
  .sort(([a], [b]) => a.localeCompare(b))
  .map(([path, yaml]) => {
    const doc = parse(yaml) as RawDoc;
    const d = doc.demo ?? {};
    const file = path.split('/').pop()!.replace(/\.ya?ml$/, '');
    return { id: d.id ?? file, title: d.title ?? file, problem: d.break ?? d.problem ?? '', focus: d.focus, doc, yaml };
  });
