// Path helpers on raw (YAML) documents, shared by calibration and the web editor.
export type RawPath = (string | number)[];

export function getPath(doc: any, path: RawPath): any {
  let o = doc;
  for (const k of path) {
    if (o == null) return undefined;
    o = o[k];
  }
  return o;
}

/** Immutable set that creates intermediate objects. */
export function setPath<T>(doc: T, path: RawPath, value: unknown): T {
  const root: any = structuredClone(doc);
  let o = root;
  for (let i = 0; i < path.length - 1; i++) {
    if (o[path[i]] == null || typeof o[path[i]] !== 'object') o[path[i]] = {};
    o = o[path[i]];
  }
  if (value === undefined) delete o[path[path.length - 1]];
  else o[path[path.length - 1]] = value;
  return root;
}
