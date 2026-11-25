// Lets Node's test runner import Worker modules that use `cloudflare:workers`.
// Only the DurableObject base class is needed; the real runtime is exercised by
// workers/kilcon-contact/test/limiter.workerd.test.mjs (Miniflare / workerd).
// Used via: node --import ./tests/support/cloudflare-workers-shim.mjs --test ...
import { register } from "node:module";

const stub = "export class DurableObject { constructor(ctx, env) { this.ctx = ctx; this.env = env; } }";
const hooks = `
export async function resolve(specifier, context, next) {
  if (specifier === "cloudflare:workers") {
    return { url: "data:text/javascript," + encodeURIComponent(${JSON.stringify(stub)}), shortCircuit: true };
  }
  return next(specifier, context);
}`;
register("data:text/javascript," + encodeURIComponent(hooks));
