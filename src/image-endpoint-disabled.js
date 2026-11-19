// Replacement for Astro's built-in /_image endpoint (see astro.config.mjs).
//
// The site doesn't use astro:assets (<Image>, <Picture>, getImage()). Gallery
// thumbnails come from Cloudflare Image Transformations (/cdn-cgi/image/…),
// which run at the edge and never reach this app. Astro still injects /_image
// into every server build, and both stock implementations are unsafe here:
//   - adapter "compile" endpoint: fetches any same-origin ?href= and returns it
//     verbatim, so it can proxy other paths past path-based WAF rules.
//   - generic endpoint (used by imageService "passthrough"): forwards every
//     request header, including the admin_auth cookie, to the same-origin
//     fetch, and replies with Cache-Control: public, max-age=31536000.
// So the route stays registered but always answers 404 and never fetches.

export const prerender = false;

const NOT_FOUND_HEADERS = {
  "Content-Type": "text/plain; charset=utf-8",
  "Cache-Control": "no-store",
  "X-Content-Type-Options": "nosniff",
};

export const ALL = () => new Response("Not found", { status: 404, headers: NOT_FOUND_HEADERS });
