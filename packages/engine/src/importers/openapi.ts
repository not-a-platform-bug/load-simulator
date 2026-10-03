// OpenAPI (springdoc) → API list with estimated profiles, marked as unobserved until traces fill them in.
import { parse } from 'yaml';
import { slug, type ImportReport } from './util';

const METHODS = ['get', 'post', 'put', 'patch', 'delete', 'head', 'options'];

export function importOpenApi(spec: string | object, opts: { service?: string } = {}): ImportReport {
  const doc: any = typeof spec === 'string' ? parse(spec) : spec;
  const service = slug(opts.service ?? doc?.info?.title ?? 'service');
  const endpoints: Record<string, any> = {};
  for (const [path, item] of Object.entries<any>(doc?.paths ?? {})) {
    for (const m of METHODS) {
      const op = item?.[m];
      if (!op) continue;
      const ep: any = { observed: false, source: 'openapi', selfTime: { p50: '5ms', p99: '25ms' } };
      const size = estimateSize(op, doc);
      if (size) ep.responseSize = size;
      endpoints[`${m.toUpperCase()} ${path}`] = ep;
    }
  }
  const n = Object.keys(endpoints).length;
  return {
    doc: { nodes: { [service]: { kind: 'service', endpoints } } },
    notes: [`OpenAPI에서 API ${n}개를 찾았습니다. 처리 시간은 기본값(추정)이며 "미관측"으로 표시됩니다.`],
  };
}

/** Rough response size: arrays of objects ≈ 20 items × 200 bytes, objects ≈ 50 bytes per property. */
function estimateSize(op: any, root: any): string | undefined {
  const res = op.responses?.['200'] ?? op.responses?.['201'];
  const content = res?.content?.['application/json'] ?? res?.content?.['*/*'];
  let schema = content?.schema;
  if (!schema) return undefined;
  const deref = (s: any) => (s?.$ref ? s.$ref.split('/').slice(1).reduce((o: any, k: string) => o?.[k], root) : s);
  schema = deref(schema);
  const props = (s: any) => Object.keys(deref(s)?.properties ?? {}).length || 5;
  if (schema?.type === 'array') return `${Math.round((20 * props(schema.items) * 50) / 1024) || 1}kb`;
  return `${Math.max(256, props(schema) * 50)}`;
}
