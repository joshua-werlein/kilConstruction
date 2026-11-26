// Parses CSP violation reports into short, privacy-safe log summaries.
// Accepts the report-uri format ({"csp-report": {...}}, application/csp-report)
// and the Reporting API format ([{type: "csp-violation", body: {...}}]).
// Query strings and fragments are dropped from URLs (they can carry form or
// item details); only origin + path are kept.

export const MAX_REPORT_BYTES = 8 * 1024;
export const MAX_REPORTS_PER_REQUEST = 10;

function cleanUrl(value) {
  if (typeof value !== "string" || !value) return "";
  if (/^(inline|eval|wasm-eval|data|blob|self|trusted-types-policy|trusted-types-sink)$/i.test(value)) return value.toLowerCase();
  try {
    const u = new URL(value);
    if (u.protocol === "data:" || u.protocol === "blob:") return u.protocol.slice(0, -1);
    return `${u.origin}${u.pathname}`.slice(0, 200);
  } catch {
    return value.slice(0, 40);
  }
}

const str = (v, n) => (typeof v === "string" ? v.slice(0, n) : "");
const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : undefined);

function summarize(body) {
  if (!body || typeof body !== "object") return null;
  const g = (...keys) => keys.map((k) => body[k]).find((v) => v !== undefined && v !== null);
  return {
    directive: str(g("effectiveDirective", "effective-directive", "violated-directive", "violatedDirective"), 60),
    blocked: cleanUrl(g("blockedURL", "blocked-uri", "blockedURI")),
    page: cleanUrl(g("documentURL", "document-uri", "documentURI")),
    source: cleanUrl(g("sourceFile", "source-file")),
    line: num(g("lineNumber", "line-number")),
    sample: str(g("sample", "script-sample"), 60),
    disposition: str(g("disposition"), 12),
  };
}

/** Returns up to MAX_REPORTS_PER_REQUEST summaries from a report body, or [] when unusable. */
export function parseCspReports(text) {
  if (typeof text !== "string" || !text || text.length > MAX_REPORT_BYTES) return [];
  let data;
  try { data = JSON.parse(text); } catch { return []; }
  const bodies = Array.isArray(data)
    ? data.filter((r) => r && r.type === "csp-violation").map((r) => r.body)
    : [data?.["csp-report"]];
  return bodies.map(summarize).filter(Boolean).slice(0, MAX_REPORTS_PER_REQUEST);
}
