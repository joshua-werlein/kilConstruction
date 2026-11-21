// Perceptual "difference hash" (dHash) for the admin photo review page.
// 9x8 grayscale samples -> 64 bits; bit (y*8+x) is set when pixel (x,y) is
// brighter than its right neighbour. Matches the offline Phase 2 analysis,
// where website duplicates measured <= 5 bits apart and unrelated images >= 16.

export const LIKELY_MAX = 5;
export const POSSIBLE_MAX = 10;
export const HASH_W = 9;
export const HASH_H = 8;

const lum = (d, i) => 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2];

/** dHash from RGBA pixel data of a 9x8 image. Returns 16 lowercase hex chars. */
export function dHashFromRgba(data) {
  if (!data || data.length < HASH_W * HASH_H * 4) throw new Error("Expected 9x8 RGBA pixel data");
  let hash = 0n;
  for (let y = 0; y < HASH_H; y++) {
    for (let x = 0; x < HASH_W - 1; x++) {
      const i = (y * HASH_W + x) * 4;
      if (lum(data, i) > lum(data, i + 4)) hash |= 1n << BigInt(y * 8 + x);
    }
  }
  return hash.toString(16).padStart(16, "0");
}

/** Number of differing bits between two 16-hex-char hashes. */
export function hammingHex(a, b) {
  if (!/^[0-9a-f]{16}$/.test(a) || !/^[0-9a-f]{16}$/.test(b)) throw new Error("Invalid hash");
  let x = BigInt("0x" + a) ^ BigInt("0x" + b);
  let n = 0;
  while (x) { n += Number(x & 1n); x >>= 1n; }
  return n;
}

/** "likely" (<= 5), "possible" (6-10) or null. */
export function matchLevel(distance) {
  if (!Number.isInteger(distance) || distance < 0) return null;
  return distance <= LIKELY_MAX ? "likely" : distance <= POSSIBLE_MAX ? "possible" : null;
}

/** Closest candidate {id, hash}; ties keep the first. Null when none is within POSSIBLE_MAX. */
export function bestMatch(hash, candidates) {
  let best = null;
  for (const c of candidates || []) {
    if (!c?.hash) continue;
    const distance = hammingHex(hash, c.hash);
    if (!best || distance < best.distance) best = { id: c.id, distance };
  }
  if (!best) return null;
  const level = matchLevel(best.distance);
  return level ? { ...best, level } : null;
}
