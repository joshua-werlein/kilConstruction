import { test } from "node:test";
import assert from "node:assert/strict";
import { timingSafeEqualBytes, timingSafeEqualStrings } from "../src/timing-safe.js";

const bytes = (...v) => new Uint8Array(v);

async function withNative(fn) {
  const calls = [];
  const had = Object.prototype.hasOwnProperty.call(crypto.subtle, "timingSafeEqual");
  const prev = crypto.subtle.timingSafeEqual;
  // Stand-in for the Workers-only API; records that it was used.
  crypto.subtle.timingSafeEqual = (a, b) => {
    calls.push([a.byteLength, b.byteLength]);
    if (a.byteLength !== b.byteLength) throw new TypeError("unequal lengths");
    return a.every((x, i) => x === b[i]);
  };
  try { await fn(calls); }
  finally { if (had) crypto.subtle.timingSafeEqual = prev; else delete crypto.subtle.timingSafeEqual; }
}

test("bytes: equal, different, unequal length, ArrayBuffer input (fallback path)", () => {
  assert.equal(typeof crypto.subtle.timingSafeEqual, "undefined", "Node has no native timingSafeEqual");
  assert.equal(timingSafeEqualBytes(bytes(1, 2, 3), bytes(1, 2, 3)), true);
  assert.equal(timingSafeEqualBytes(bytes(1, 2, 3), bytes(1, 2, 4)), false);
  assert.equal(timingSafeEqualBytes(bytes(1, 2, 3), bytes(1, 2)), false);
  assert.equal(timingSafeEqualBytes(bytes(), bytes()), true);
  assert.equal(timingSafeEqualBytes(bytes(9, 9).buffer, bytes(9, 9)), true);
});

test("bytes: uses crypto.subtle.timingSafeEqual when present, never with unequal lengths", async () => {
  await withNative(async (calls) => {
    assert.equal(timingSafeEqualBytes(bytes(1, 2), bytes(1, 2)), true);
    assert.equal(timingSafeEqualBytes(bytes(1, 2), bytes(1, 3)), false);
    assert.equal(timingSafeEqualBytes(bytes(1, 2), bytes(1)), false); // must not throw
    assert.deepEqual(calls, [[2, 2], [2, 2]]);
  });
});

test("strings: content and length differences, unicode, nullish", async () => {
  for (const native of [false, true]) {
    const run = async () => {
      assert.equal(await timingSafeEqualStrings("s3cret-pass", "s3cret-pass"), true);
      assert.equal(await timingSafeEqualStrings("s3cret-pass", "s3cret-pasS"), false);
      assert.equal(await timingSafeEqualStrings("short", "a much longer value"), false);
      assert.equal(await timingSafeEqualStrings("", ""), true);
      assert.equal(await timingSafeEqualStrings("", "x"), false);
      assert.equal(await timingSafeEqualStrings("pässwörd✓", "pässwörd✓"), true);
      assert.equal(await timingSafeEqualStrings("pässwörd✓", "passwörd✓"), false);
      assert.equal(await timingSafeEqualStrings(null, ""), true);
      assert.equal(await timingSafeEqualStrings(undefined, "undefined"), false);
    };
    if (native) await withNative(async (calls) => { await run(); assert.ok(calls.every(([a, b]) => a === 32 && b === 32)); });
    else await run();
  }
});
