// Plans admin gallery uploads into requests the Gallery Worker will accept.
// Limits must match workers/kilcon-gallery-worker/src/index.js
// (MAX_GALLERY_UPLOAD_FILE_BYTES / _REQUEST_BYTES / _FILES); a site test checks it.
//
// BATCH_TARGET_BYTES is a soft target for grouping small files, not a per-file
// limit: a file larger than the target (up to MAX_FILE_BYTES) is always sent
// in a request of its own, which stays far below the 50 MB request limit.

export const MAX_FILE_BYTES = 25 * 1024 * 1024;
export const BATCH_TARGET_BYTES = 20 * 1024 * 1024;
export const BATCH_MAX_FILES = 20;
export const SUPPORTED_EXT = /\.(jpe?g|png|webp|avif)$/i;

/**
 * @template {{ name: string, size: number }} F
 * @param {F[]} files
 * @param {(file: F) => string} pathFor  R2 key the file is uploaded under
 * @returns {{ batches: { path: string, file: F }[][], rejected: { name: string, reason: string }[] }}
 */
export function planUploadBatches(files, pathFor) {
  const rejected = [];
  const batches = [];
  let current = [];
  let currentBytes = 0;

  const flush = () => {
    if (current.length) batches.push(current);
    current = [];
    currentBytes = 0;
  };

  for (const file of files) {
    const name = file.name || "image";
    // Same checks the server enforces, so obvious problems show up without
    // uploading. The server still validates the bytes.
    if (!SUPPORTED_EXT.test(name)) {
      rejected.push({ name, reason: "unsupported-extension" });
      continue;
    }
    if (file.size === 0) {
      rejected.push({ name, reason: "empty" });
      continue;
    }
    if (file.size > MAX_FILE_BYTES) {
      rejected.push({ name, reason: "too-large" });
      continue;
    }

    const entry = { path: pathFor(file), file };
    if (file.size > BATCH_TARGET_BYTES) {
      // Large but valid: its own request.
      flush();
      batches.push([entry]);
      continue;
    }
    if (current.length && (currentBytes + file.size > BATCH_TARGET_BYTES || current.length >= BATCH_MAX_FILES)) {
      flush();
    }
    current.push(entry);
    currentBytes += file.size;
  }
  flush();
  return { batches, rejected };
}
