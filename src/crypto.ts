// Random ID and PIN generation. Password hashing removed — auth is via
// Cloudflare Zero Trust Access, see src/auth.ts.

export function generatePIN(): string {
  const n = crypto.getRandomValues(new Uint32Array(1))[0] % 1_000_000;
  return n.toString().padStart(6, '0');
}

export function newId(prefix = ''): string {
  const bytes = crypto.getRandomValues(new Uint8Array(12));
  let s = '';
  for (const b of bytes) s += b.toString(16).padStart(2, '0');
  return prefix ? `${prefix}_${s}` : s;
}
