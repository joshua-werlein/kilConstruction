import type { APIRoute } from "astro";
import { runtimeEnv } from "../../utils/runtimeEnv";
import { parseCspReports, MAX_REPORT_BYTES } from "../../lib/csp-report.js";

// Receives violation reports from the enforced CSP on HTML responses
// (htmlCsp in src/utils/securityHeaders.ts, report-uri) and logs a short,
// privacy-safe summary to Workers Logs ("[csp-report]"). Nothing is stored.
// Always answers 204, so it reveals nothing and browsers never retry.
//
// Abuse bound: the existing LOGIN_LIMITER binding (5 per 60 s per key) under a
// separate "csp-report:<ip>" key; over the limit, reports are dropped unlogged.
// Fails open like the login use if the binding is missing.

const done = () => new Response(null, { status: 204, headers: { "Cache-Control": "no-store" } });

async function readCapped(request: Request): Promise<string | null> {
  const declared = Number(request.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > MAX_REPORT_BYTES) return null;
  if (!request.body) return null;
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done: end, value } = await reader.read();
    if (end) break;
    size += value.byteLength;
    if (size > MAX_REPORT_BYTES) { await reader.cancel(); return null; }
    chunks.push(value);
  }
  const all = new Uint8Array(size);
  let off = 0;
  for (const c of chunks) { all.set(c, off); off += c.byteLength; }
  return new TextDecoder().decode(all);
}

export const POST: APIRoute = async ({ request }) => {
  const type = request.headers.get("content-type") ?? "";
  if (!/^application\/(csp-report|reports\+json|json)\b/i.test(type)) return done();

  const ip = request.headers.get("CF-Connecting-IP") || "unknown";
  const limiter = runtimeEnv.LOGIN_LIMITER as { limit(o: { key: string }): Promise<{ success: boolean }> } | undefined;
  if (limiter) {
    try { if (!(await limiter.limit({ key: `csp-report:${ip}` })).success) return done(); }
    catch { /* fail open */ }
  }

  const text = await readCapped(request);
  for (const report of parseCspReports(text ?? "")) console.log("[csp-report]", JSON.stringify(report));
  return done();
};

export const ALL: APIRoute = () =>
  new Response("Method not allowed", { status: 405, headers: { Allow: "POST", "Cache-Control": "no-store" } });
