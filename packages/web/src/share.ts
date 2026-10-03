// Architecture + settings + scenario + seed in one URL: deflate-raw + base64url in the hash.
import type { RawDoc } from '@load-simulator/engine';

function b64url(bytes: Uint8Array): string {
  let s = '';
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function unb64url(s: string): Uint8Array {
  const b = atob(s.replace(/-/g, '+').replace(/_/g, '/'));
  const out = new Uint8Array(b.length);
  for (let i = 0; i < b.length; i++) out[i] = b.charCodeAt(i);
  return out;
}

async function pipe(data: Uint8Array, stream: CompressionStream | DecompressionStream): Promise<Uint8Array> {
  const res = new Response(new Blob([data as BlobPart]).stream().pipeThrough(stream));
  return new Uint8Array(await res.arrayBuffer());
}

export async function encodeShare(doc: RawDoc): Promise<string> {
  const json = new TextEncoder().encode(JSON.stringify(doc));
  return b64url(await pipe(json, new CompressionStream('deflate-raw')));
}

export async function decodeShare(s: string): Promise<RawDoc> {
  const bytes = await pipe(unb64url(s), new DecompressionStream('deflate-raw'));
  return JSON.parse(new TextDecoder().decode(bytes));
}

export async function shareUrl(doc: RawDoc): Promise<string> {
  const u = new URL(location.href);
  u.hash = `m=${await encodeShare(doc)}`;
  return u.toString();
}

export async function readShareFromHash(): Promise<RawDoc | null> {
  const m = /[#&]m=([A-Za-z0-9_-]+)/.exec(location.hash);
  if (!m) return null;
  try {
    return await decodeShare(m[1]);
  } catch {
    return null;
  }
}
