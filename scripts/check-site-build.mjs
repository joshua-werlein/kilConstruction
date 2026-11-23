#!/usr/bin/env node
// Refuse to deploy a site build that carries local development values.
//
// Astro and the Cloudflare tooling read the repository .env at build time and
// bake every PUBLIC_* value into dist/server (and copy .env to
// dist/server/.dev.vars). A build made in a checkout that has a local .env
// therefore ships the local Contact Worker endpoint and Cloudflare's test
// Turnstile key. Production builds must come from a clean checkout (CI, or a
// fresh `git worktree`), which has no .env. Run after `npm run build`.
//
// Prints file names only, never values.
import { readdir, readFile, access } from "node:fs/promises";

export const LOCAL_MARKERS = [
  /\b[123]x0{20}A[AB]\b|\b3x0{20}FF\b/, // Cloudflare Turnstile test site keys
  /https?:\/\/(?:127\.0\.0\.1|localhost|\[::1\])(?::\d+)?\//, // local endpoints
];
export const REQUIRED = [
  ["production Turnstile key", /0x4AAAAAAB_kYYCq8dRwlAsE/],
  ["production contact endpoint", /https:\/\/kilcon\.work\/api\/contact/],
];

export async function checkSiteBuild(distUrl) {
  const problems = [];
  const exists = async (u) => access(u).then(() => true, () => false);
  if (!(await exists(new URL("server/wrangler.json", distUrl)))) return ["no build output: run npm run build"];
  if (await exists(new URL("server/.dev.vars", distUrl))) {
    problems.push("dist/server/.dev.vars exists: this build read a local .env (build from a clean checkout)");
  }
  let all = "";
  for (const dir of ["server", "client"]) {
    for (const f of await readdir(new URL(`${dir}/`, distUrl), { recursive: true })) {
      if (!/\.(m?js|html|json)$/.test(f)) continue;
      const rel = `${dir}/${f.split(String.fromCharCode(92)).join("/")}`;
      const src = await readFile(new URL(rel, distUrl), "utf8");
      if (LOCAL_MARKERS.some((re) => re.test(src))) problems.push(`dist/${rel} contains a local development value`);
      if (dir === "server") all += src;
    }
  }
  for (const [name, re] of REQUIRED) if (!re.test(all)) problems.push(`missing ${name}`);
  return problems;
}

if (import.meta.url === new URL(process.argv[1], "file:").href || process.argv[1]?.endsWith("check-site-build.mjs")) {
  const problems = await checkSiteBuild(new URL("../dist/", import.meta.url));
  if (problems.length) {
    console.error("Site build check FAILED:\n- " + problems.join("\n- "));
    process.exit(1);
  }
  console.log("Site build check passed: production public values only, no local .env.");
}
