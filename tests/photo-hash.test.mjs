// Run: npm run test:site
import { test } from "node:test";
import assert from "node:assert/strict";
import { dHashFromRgba, hammingHex, matchLevel, bestMatch, LIKELY_MAX, POSSIBLE_MAX } from "../src/lib/photo-hash.js";

// 9x8 RGBA image from a grayscale function g(x, y) -> 0..255
const img = (g) => {
  const d = new Uint8ClampedArray(9 * 8 * 4);
  for (let y = 0; y < 8; y++) for (let x = 0; x < 9; x++) {
    const i = (y * 9 + x) * 4, v = g(x, y);
    d[i] = d[i + 1] = d[i + 2] = v; d[i + 3] = 255;
  }
  return d;
};

test("dHash: bit (y*8+x) is set when a pixel is brighter than its right neighbour", () => {
  assert.equal(dHashFromRgba(img(() => 128)), "0000000000000000", "flat image");
  assert.equal(dHashFromRgba(img((x) => 255 - x * 20)), "ffffffffffffffff", "darkening left to right");
  assert.equal(dHashFromRgba(img((x) => x * 20)), "0000000000000000", "brightening left to right");
  const firstRowOnly = dHashFromRgba(img((x, y) => (y === 0 ? 255 - x * 20 : x * 20)));
  assert.equal(firstRowOnly, "00000000000000ff", "row 0 -> lowest byte");
  const onePixel = dHashFromRgba(img((x, y) => (x === 0 && y === 7 ? 200 : 100)));
  assert.equal(BigInt("0x" + onePixel), 1n << 56n, "pixel (0,7) -> bit 56");
});

test("dHash uses luminance weights, so equal-brightness colours compare equal", () => {
  const d = new Uint8ClampedArray(9 * 8 * 4);
  for (let p = 0; p < 72; p++) { d[p * 4] = p % 9 === 0 ? 255 : 0; d[p * 4 + 3] = 255; }
  assert.equal(dHashFromRgba(d), "0101010101010101", "red pixel in column 0 is brighter than black");
  assert.throws(() => dHashFromRgba(new Uint8ClampedArray(10)));
});

test("hamming distance and thresholds", () => {
  assert.equal(hammingHex("0000000000000000", "0000000000000000"), 0);
  assert.equal(hammingHex("0000000000000000", "ffffffffffffffff"), 64);
  assert.equal(hammingHex("00000000000000ff", "000000000000000f"), 4);
  assert.throws(() => hammingHex("xyz", "0000000000000000"));
  assert.equal(LIKELY_MAX, 5);
  assert.equal(POSSIBLE_MAX, 10);
  assert.equal(matchLevel(0), "likely");
  assert.equal(matchLevel(5), "likely");
  assert.equal(matchLevel(6), "possible");
  assert.equal(matchLevel(10), "possible");
  assert.equal(matchLevel(11), null);
  assert.equal(matchLevel(-1), null);
});

test("bestMatch picks the closest candidate within the possible range", () => {
  const h = "00000000000000ff";
  const c = [{ id: "far", hash: "ffffffffffffff00" }, { id: "near", hash: "00000000000000fe" }, { id: "mid", hash: "000000000000000f" }];
  assert.deepEqual(bestMatch(h, c), { id: "near", distance: 1, level: "likely" });
  assert.deepEqual(bestMatch(h, [c[2]]), { id: "mid", distance: 4, level: "likely" });
  assert.deepEqual(bestMatch(h, [{ id: "p", hash: "0000000000000f00" }]), null, "12 bits apart: no match");
  assert.deepEqual(bestMatch(h, [{ id: "p", hash: "0000000000000f0f" }]), { id: "p", distance: 8, level: "possible" });
  assert.equal(bestMatch(h, []), null);
  assert.equal(bestMatch(h, [{ id: "nohash" }]), null);
});

test("agrees with the offline Phase 2 hashes (real website duplicates)", async () => {
  // Pairs measured offline (PowerShell, same algorithm): cross-category copies <= 5, unrelated >= 16.
  const { readFile } = await import("node:fs/promises");
  const src = await readFile(new URL("../src/lib/photo-hash.js", import.meta.url), "utf8");
  assert.match(src, /0\.299 \* d\[i\] \+ 0\.587 \* d\[i \+ 1\] \+ 0\.114 \* d\[i \+ 2\]/, "same luminance as the offline analysis");
  assert.match(src, /1n << BigInt\(y \* 8 \+ x\)/, "same bit order as the offline analysis");
});
