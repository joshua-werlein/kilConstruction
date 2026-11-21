import { defineMiddleware } from "astro:middleware";
import { applySecurityHeaders } from "./utils/securityHeaders";

// Runs for every on-demand page and API route. See src/utils/securityHeaders.ts.
export const onRequest = defineMiddleware(async (_context, next) => {
  return applySecurityHeaders(await next());
});
