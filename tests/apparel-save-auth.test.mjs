// Run: npm run test:site
// Security hotfix 2026-11-23: the apparel save API requires an admin session.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

test("apparel save verifies the admin session before reading the body or the database", async () => {
  const src = await readFile(new URL("../src/pages/api/admin/apparel/variants.save.ts", import.meta.url), "utf8");
  assert.match(src, /import \{ verifyAdminToken \} from "\.\.\/\.\.\/\.\.\/\.\.\/utils\/adminToken";/);
  const authAt = src.indexOf("verifyAdminToken(auth, ADMIN_SECRET, SESSION_VERSION)");
  assert.ok(authAt > 0, "verifies the session");
  assert.ok(authAt < src.indexOf("request.json()"), "before reading the body");
  assert.ok(authAt < src.indexOf("db.prepare"), "before touching the database");
  assert.match(src, /cookies\.get\("admin_auth"\)/);
  assert.match(src, /return json\(\{ error: "unauthorized" \}, 401\)/);
  assert.match(src, /if \(!ADMIN_SECRET\) return json\(\{ error: "server_misconfigured" \}, 500\)/, "fails closed");
});
