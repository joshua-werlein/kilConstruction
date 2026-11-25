// Constant-time comparisons for secrets (admin token signatures, Meta webhook
// signatures and verify tokens).
//
// Workers provide crypto.subtle.timingSafeEqual (a non-standard Web Crypto
// extension). Node's Web Crypto, used by the unit tests, does not, so a
// fixed-length XOR loop is the fallback. Both paths only ever see inputs of
// equal length: strings are hashed to 32-byte SHA-256 digests first, so
// neither their contents nor their lengths show up in the timing.

const encoder = new TextEncoder();

/** true when a and b (Uint8Array/ArrayBuffer) hold identical bytes. */
export function timingSafeEqualBytes(a, b) {
  const x = a instanceof Uint8Array ? a : new Uint8Array(a);
  const y = b instanceof Uint8Array ? b : new Uint8Array(b);
  // Lengths are not secret here: every caller compares fixed-size digests or
  // MACs, and timingSafeEqual throws on unequal lengths.
  if (x.byteLength !== y.byteLength) return false;
  const native = globalThis.crypto?.subtle?.timingSafeEqual;
  if (typeof native === "function") return native.call(crypto.subtle, x, y);
  let diff = 0;
  for (let i = 0; i < x.length; i++) diff |= x[i] ^ y[i];
  return diff === 0;
}

/** Compares two strings without leaking their contents or lengths. */
export async function timingSafeEqualStrings(a, b) {
  const [da, db] = await Promise.all([
    crypto.subtle.digest("SHA-256", encoder.encode(String(a ?? ""))),
    crypto.subtle.digest("SHA-256", encoder.encode(String(b ?? ""))),
  ]);
  return timingSafeEqualBytes(da, db);
}
