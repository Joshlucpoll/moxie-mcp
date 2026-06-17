// Pure, runtime-agnostic helpers (importable in both Workers and `node --test`).

export function buildUrl(
  base: string,
  path: string,
  query?: Record<string, unknown>,
): string {
  const url = new URL(base.replace(/\/$/, "") + path);
  if (query) {
    for (const [k, v] of Object.entries(query)) {
      if (v !== undefined && v !== null && v !== "") url.searchParams.set(k, String(v));
    }
  }
  return url.toString();
}

// Decode base64 -> bytes without Buffer (atob exists in Workers and Node 16+).
export function base64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

// multipart/form-data body for the two attachment endpoints. FormData is native
// in Workers and Node 18+; fetch sets the boundary header itself.
export function buildAttachmentForm(fields: Record<string, string>, file?: { name: string; b64: string }): FormData {
  const form = new FormData();
  for (const [k, v] of Object.entries(fields)) form.set(k, v);
  if (file) form.set("file", new File([base64ToBytes(file.b64)], file.name));
  return form;
}
