// Cloudflare bindings, variables and secrets for the site Worker.
// Astro 6+ / @astrojs/cloudflare 13+ removed Astro.locals.runtime; bindings
// come from the Workers runtime module instead. Typed loosely on purpose:
// every caller already checks for missing values (and fails closed).
import { env } from "cloudflare:workers";

export const runtimeEnv = env as unknown as Record<string, any>;
