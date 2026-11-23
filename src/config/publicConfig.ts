// Public (non-secret) values baked into pages at build time.
//
// Production builds always use the production values below. A local .env may
// point `astro dev` at a local Contact Worker and Cloudflare's test Turnstile
// key, but it must never leak into a production build: Vite reads .env at build
// time, so a deploy built on a developer machine would otherwise ship those
// local values (found 2026-11-22 while staging the Astro 7 site Worker).
export const PROD_TURNSTILE_SITE_KEY = "0x4AAAAAAB_kYYCq8dRwlAsE";
export const PROD_CONTACT_ENDPOINT = "https://kilcon.work/api/contact";

export const TURNSTILE_SITE_KEY: string = import.meta.env.DEV
    ? import.meta.env.PUBLIC_TURNSTILE_SITE_KEY || PROD_TURNSTILE_SITE_KEY
    : PROD_TURNSTILE_SITE_KEY;

export const CONTACT_ENDPOINT: string = import.meta.env.DEV
    ? import.meta.env.PUBLIC_CONTACT_ENDPOINT || PROD_CONTACT_ENDPOINT
    : PROD_CONTACT_ENDPOINT;
