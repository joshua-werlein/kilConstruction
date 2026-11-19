// --- Upload validation for gallery and review images ----------------------
//
// Every uploaded image must pass all of these checks before it's stored:
//   1. The request body is bounded. A declared Content-Length over the limit is
//      refused before reading; without one, the body is read through a counting
//      reader that stops at the limit.
//   2. The file is non-empty and within the per-file byte limit.
//   3. The extension is one the site serves (jpg/jpeg/png/webp/avif).
//   4. The leading bytes are a structurally plausible header for that format
//      (not just a 3-byte prefix), so empty, truncated or disguised files fail.
//   5. The sniffed format matches the extension.
//   6. A client MIME type, if one is sent, must agree with the sniffed format.
//      An empty or generic application/octet-stream type is ignored.
// The stored Content-Type always comes from the sniffed format, never the client.

export const IMAGE_TYPE_BY_EXT = Object.freeze({
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  png: "image/png",
  webp: "image/webp",
  avif: "image/avif",
});

// Client MIME spellings that mean the same format.
const MIME_ALIASES = {
  "image/jpg": "image/jpeg",
  "image/pjpeg": "image/jpeg",
  "image/x-png": "image/png",
};
const GENERIC_MIME = new Set(["", "application/octet-stream"]);

// Bytes read from the start of each file to identify it. Large enough for an
// AVIF ftyp box with a long compatible-brands list.
const HEADER_BYTES = 256;

// JPEG markers that may follow SOI in real files (APPn, DQT, DHT, SOF0/1/2, COM).
// All of them carry a 2-byte segment length.
const JPEG_FIRST_MARKERS = new Set([
  0xe0, 0xe1, 0xe2, 0xe3, 0xe4, 0xe5, 0xe6, 0xe7, 0xe8, 0xe9, 0xea, 0xeb, 0xec, 0xed, 0xee, 0xef,
  0xdb, 0xc4, 0xc0, 0xc1, 0xc2, 0xfe,
]);

function extOf(name) {
  const m = /\.([a-z0-9]+)$/i.exec(String(name || ""));
  return m ? m[1].toLowerCase() : "";
}

export function typeForName(name) {
  return IMAGE_TYPE_BY_EXT[extOf(name)] || null;
}

const ascii = (b, from, to) => String.fromCharCode(...b.subarray(from, to));
const u32be = (b, i) => ((b[i] << 24) >>> 0) + (b[i + 1] << 16) + (b[i + 2] << 8) + b[i + 3];
const u32le = (b, i) => b[i] + (b[i + 1] << 8) + (b[i + 2] << 16) + ((b[i + 3] << 24) >>> 0);

/**
 * Identify an image from its first bytes.
 * @param {Uint8Array} b   leading bytes of the file (up to HEADER_BYTES)
 * @param {number} size    total file size in bytes
 * @returns {{ type: string } | { error: "truncated" | "unrecognized" }}
 */
export function inspectImageHeader(b, size) {
  // JPEG: SOI, then a real marker whose segment fits inside the file.
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) {
    if (b.length < 6) return { error: "truncated" };
    if (!JPEG_FIRST_MARKERS.has(b[3])) return { error: "unrecognized" };
    const segLen = (b[4] << 8) | b[5];
    if (segLen < 2 || 4 + segLen > size) return { error: "truncated" };
    return { type: "image/jpeg" };
  }

  // PNG: signature, then a 13-byte IHDR chunk with non-zero dimensions, and
  // room for at least the IEND chunk.
  if (b.length >= 8 && b[0] === 0x89 && ascii(b, 1, 4) === "PNG" &&
      b[4] === 0x0d && b[5] === 0x0a && b[6] === 0x1a && b[7] === 0x0a) {
    if (b.length < 24 || size < 8 + 25 + 12) return { error: "truncated" };
    if (u32be(b, 8) !== 13 || ascii(b, 12, 16) !== "IHDR") return { error: "unrecognized" };
    if (u32be(b, 16) === 0 || u32be(b, 20) === 0) return { error: "unrecognized" };
    return { type: "image/png" };
  }

  // WebP: RIFF container whose declared size fits in the file, with a VP8 chunk.
  if (b.length >= 12 && ascii(b, 0, 4) === "RIFF" && ascii(b, 8, 12) === "WEBP") {
    if (b.length < 16) return { error: "truncated" };
    if (!["VP8 ", "VP8L", "VP8X"].includes(ascii(b, 12, 16))) return { error: "unrecognized" };
    const riffSize = u32le(b, 4);
    if (riffSize < 12 || riffSize + 8 > size) return { error: "truncated" };
    return { type: "image/webp" };
  }

  // AVIF: an ftyp box whose major or compatible brands include avif/avis.
  // HEIC (heic/heix/mif1 without avif) is deliberately not accepted.
  if (b.length >= 8 && ascii(b, 4, 8) === "ftyp") {
    const boxSize = u32be(b, 0);
    if (b.length < 16) return { error: "truncated" };
    if (boxSize < 16 || boxSize % 4 !== 0 || boxSize > size) return { error: "truncated" };
    const end = Math.min(boxSize, b.length);
    const brands = [ascii(b, 8, 12)];
    for (let i = 16; i + 4 <= end; i += 4) brands.push(ascii(b, i, i + 4));
    if (brands.some((x) => x === "avif" || x === "avis")) return { type: "image/avif" };
    return { error: "unrecognized" };
  }

  return { error: b.length < 3 ? "truncated" : "unrecognized" };
}

/**
 * Validate one uploaded file without reading more than its header.
 * @param {File} file
 * @param {{ name?: string, maxBytes: number }} opts  name: key/filename whose
 *        extension decides the expected format (defaults to file.name)
 * @returns {Promise<{ ok: true, contentType: string } | { ok: false, reason: string }>}
 */
export async function validateImageFile(file, { name, maxBytes }) {
  if (!file || typeof file.size !== "number" || typeof file.slice !== "function") {
    return { ok: false, reason: "not-a-file" };
  }
  if (file.size === 0) return { ok: false, reason: "empty" };
  if (file.size > maxBytes) return { ok: false, reason: "too-large" };

  const expected = typeForName(name ?? file.name);
  if (!expected) return { ok: false, reason: "unsupported-extension" };

  const header = new Uint8Array(await file.slice(0, HEADER_BYTES).arrayBuffer());
  const found = inspectImageHeader(header, file.size);
  if (found.error) return { ok: false, reason: found.error === "truncated" ? "truncated" : "not-an-image" };
  if (found.type !== expected) return { ok: false, reason: "extension-mismatch" };

  const declared = String(file.type || "").split(";")[0].trim().toLowerCase();
  if (!GENERIC_MIME.has(declared) && (MIME_ALIASES[declared] || declared) !== found.type) {
    return { ok: false, reason: "mime-mismatch" };
  }
  return { ok: true, contentType: found.type };
}

/**
 * Parse a multipart body without accepting more than maxBytes.
 * @returns {Promise<{ form: FormData } | { status: number, error: string }>}
 */
export async function readBoundedFormData(request, maxBytes) {
  const contentType = request.headers.get("Content-Type") || "";
  if (!contentType.toLowerCase().includes("multipart/form-data")) {
    return { status: 400, error: "Expected multipart/form-data" };
  }

  const declared = request.headers.get("Content-Length");
  if (declared !== null) {
    if (!/^\d{1,15}$/.test(declared.trim())) return { status: 400, error: "Invalid Content-Length" };
    if (Number(declared) > maxBytes) return { status: 413, error: "Upload too large" };
    // The runtime enforces the declared length, so the parsed body is bounded.
    try {
      return { form: await request.formData() };
    } catch {
      return { status: 400, error: "Malformed form data" };
    }
  }

  // No declared length (e.g. a chunked request): count bytes as they arrive.
  if (!request.body) return { status: 400, error: "Empty body" };
  const reader = request.body.getReader();
  const chunks = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel().catch(() => {});
      return { status: 413, error: "Upload too large" };
    }
    chunks.push(value);
  }
  const body = new Uint8Array(total);
  let offset = 0;
  for (const c of chunks) {
    body.set(c, offset);
    offset += c.byteLength;
  }
  try {
    const form = await new Response(body, { headers: { "Content-Type": contentType } }).formData();
    return { form };
  } catch {
    return { status: 400, error: "Malformed form data" };
  }
}

// R2 keys for admin uploads: printable, bounded, and no bidi/zero-width tricks
// that would make a filename display as something else in the admin UI.
const UNSAFE_KEY_CHARS = /[\u0000-\u001f\u007f​-‏‪-‮⁦-⁩﻿]/;
const MAX_KEY_BYTES = 512;
const MAX_SEGMENT_CHARS = 200;

export function isSafeUploadKey(key) {
  if (typeof key !== "string" || !key) return false;
  if (UNSAFE_KEY_CHARS.test(key)) return false;
  if (new TextEncoder().encode(key).byteLength > MAX_KEY_BYTES) return false;
  const parts = key.split("/");
  return parts.every((p) => p.length > 0 && p.length <= MAX_SEGMENT_CHARS && p === p.trim() && p !== "." && p !== "..");
}
