# Astro 5 → Astro 7 migration: Cloudflare Pages → Workers Static Assets

Status: **implemented and tested locally; not deployed.**
- **Branch:** `task/astro7-migration`, in worktree `C:\Users\Jwerl\dev\.worktrees\kil-construction\astro7-migration`.
- **Base:** `main` `587eeba`.
- **Production is unchanged:** Pages `449b7a41` (Astro 5) and Gallery Worker `0c251687`.

## Why the platform changes

- **Pages support is gone.** `@astrojs/cloudflare` 13+ (Astro 6+) **removed Cloudflare Pages
  support**, so Astro 7 on Cloudflare means a **Worker with Static Assets**.
  Source: [docs.astro.build/en/guides/integrations-guide/cloudflare](https://docs.astro.build/en/guides/integrations-guide/cloudflare/), "Removed: Cloudflare Pages support".
- **`Astro.locals.runtime` is removed.** Bindings come from `import { env } from "cloudflare:workers"`.
- **Your `grayzn-buffalo` migration** (2026-11-08) confirms the same path.

## Versions (npm, 2026-11-22)

| Package | Before | After |
|---|---|---|
| `astro` | 5.16.4 | **7.4.13** (requires Node ≥ 22.23.4; the pinned Node is 22.23.5) |
| `@astrojs/cloudflare` | 12.6.10 | **14.4.9** (peers: astro ^7.4, wrangler ^4.125) |
| Vite | 6.4 | 8.3 (Rolldown) |
| `wrangler` (dev) | 4.49 | 4.166.0 |
| `@cloudflare/workers-types` (dev) | 4.x | 5.20261122.2 |
| `@astrojs/check`, `typescript` (dev) | none | 0.9.12, 5.9 |

`npm audit` reports **0 vulnerabilities**, which closes the deferred "npm audit (Astro 7 / adapter 14)"
item.

## What changed in the code (no feature rewrites)

| Change | Why |
|---|---|
| `src/utils/runtimeEnv.ts` re-exports `env` from `cloudflare:workers`. 25 pages and API routes read `runtimeEnv` instead of `Astro.locals.runtime.env` (mechanical, 2–3 lines each). | The API was removed in adapter 13 |
| `astro.config.mjs`: `session: false` | Otherwise the adapter enables a `SESSION` KV binding and provisions a namespace. The site uses its own signed `admin_auth` cookie. |
| `astro.config.mjs`: `compressHTML: true` | Astro 7's default (`'jsx'`) can drop spaces between inline elements. This keeps the Astro 5 HTML. |
| The image setup is unchanged (`imageService: 'custom'`, `passthroughImageService()`, `/_image` → `image-endpoint-disabled.js`) | The built route still returns 404 `no-store` and never fetches. The test now checks the Astro 7 build output. |
| `wrangler.jsonc` defines the site Worker `kilcon-site` | It has the same bindings and variables as the Pages production project (below). It has **no routes, no `workers.dev` and no preview URLs**, so uploading it can't serve traffic. |
| `src/env.d.ts` | It drops the removed `Runtime` / `Locals` types and declares `cloudflare:workers`. |
| 10 unused `// @ts-expect-error` directives above `cf: {…}` removed | `@cloudflare/workers-types` 5 now types `RequestInit.cf` |
| **Bug fix:** a null response after every retry no longer crashes 4 gallery and apparel pages (`r1.status` on `null`) | Found by `astro check`; the same messages are shown |
| **Bug fix:** `reviews.astro` pagination used an undefined `PROD_ORIGIN` | It would throw once there's more than one page of reviews. It now uses `Astro.site`, and the links are unchanged. |
| npm scripts `gallery-worker:dry-run`, `gallery-worker:upload`, `contact-worker:dry-run`, `site:dry-run` and `check`; `engines.node` | Every Worker command passes an explicit `--config` (see the hazard below) |
| Tests | The apparel ordering check now uses the new helper. The `/_image` check reads `dist/server/chunks` and tolerates Vite 8's formatting. New: `tests/site-worker-config.test.mjs` (5 guardrails). |

**Unchanged:**
- `workers/kilcon-gallery-worker` and `workers/kilcon-contact`, including their bindings, routes,
  secrets, cron and Facebook flags;
- `public/_redirects`, which is honoured by Workers Static Assets;
- the security-header middleware;
- every URL.

## Hazard found: Wrangler's build redirect file

After `astro build`, the adapter writes `.wrangler/deploy/config.json` at the repository root. It
points at `dist/server/wrangler.json`. Wrangler searches **upward** for that file and gives it
priority, so a config-less `wrangler …` run inside `workers/kilcon-gallery-worker/` targets the
**site** Worker. This was reproduced: a dry run packaged 906 KiB with `ASSETS`. With `--config` it
packages the real 229 KiB Gallery Worker.

**Rule:** always pass `--config workers/<worker>/wrangler.toml`. The npm scripts do, the new test
enforces it, and docs/RESUME.md lists it as a rule.

## Bindings: Pages production → site Worker

Read with `wrangler pages download config kilconstruction` and `wrangler pages secret list`
(names only).

| Kind | Name | Value or target |
|---|---|---|
| D1 | `DB` | `kilcon-db` (`095cfe7f…`), the same database as the Gallery Worker |
| R2 | `GALLERY_BUCKET` | `kilcon-gallery` |
| Service | `GALLERY_WORKER` | `kilcon-gallery-worker` |
| Vars | `PAYMENTS_ENABLED`, `PUBLIC_CONTACT_ENDPOINT`, `PUBLIC_GALLERY_API`, `PUBLIC_TURNSTILE_SITE_KEY`, `SESSION_VERSION` | Same values as Pages production |
| Secrets | `ADMIN_USER`, `ADMIN_PASS`, `ADMIN_SECRET`, `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET` | **Values can't be read back from Pages.** The owner supplies them with `wrangler secret put … --config dist/server/wrangler.json`. Reuse, not rotation; `ADMIN_SECRET` must match, or admin sessions end. |

## Validation (local)

- **Suites:** site **97/97** (none skipped), Gallery Worker **205/205**.
- **Type checks:** `tsc` 0 errors, and `astro check` **0 errors, 0 warnings**.
- **Build and packaging:**
  - `astro build` succeeds;
  - the site dry run packages 906 KiB, 210 KiB gzipped, with exactly the bindings above;
  - the Gallery and Contact Worker dry runs, with `--config`, are unchanged.
- **Workers runtime (workerd) integration**, with `wrangler dev --local`:
  - the site, with local D1 and R2 and test secrets in `.dev.vars`, connected to a local Gallery
    Worker over the real service binding;
  - **54/54 checks:**
    - **production parity:** every public route's status matches production, including 301
      redirects, 404s and admin 302s;
    - **headers and images:** CSP identical to production, the other security headers, `/_astro/*`
      served immutable, `/_image` 404 `no-store`;
    - **galleries:** pages show gallery data through the binding;
    - **contact:** Turnstile site key and the Contact Worker endpoint;
    - **admin:** a wrong login is refused, a correct one sets `admin_auth`, all 7 admin pages load
      signed in, and a cross-origin login POST is refused (403);
    - **APIs:** `/api/item` returns seeded apparel; Stripe checkout returns 503 (payments off); the
      webhook refuses unsigned bodies.
- **What the local check couldn't cover:**
  - **HSTS and `X-Content-Type-Options`** are added by the Cloudflare zone, not the app. They apply
    to a Worker route just as they do to Pages.
  - **Live Turnstile and Resend** sends happen in the Contact Worker, which is unchanged.
  - **Real Stripe payments** are switched off in production.

## Production cutover (needs approval; not executed)

**The key point:** Pages builds and deploys `main` automatically. **Merging this branch while Pages
builds are on would make Pages build an Astro 7 / Workers output and break the live site.** So Pages
auto-deploys are paused first.

1. **Preflight (read-only):**
   - `git fetch` (owner commits);
   - production checks;
   - Gallery Worker = `0c251687`;
   - Pages = `449b7a41`;
   - record the Pages custom domains (`kilcon.work` and possibly `www`) in the dashboard.
2. **Pause Pages automatic production deployments.** Owner: Pages → kilconstruction → Settings →
   Builds. `449b7a41` stays live and becomes the rollback origin.
3. **Merge** `task/astro7-migration` into `main` and push.
4. **Build and upload the unrouted site Worker:** `npm ci && npm run build`, then
   `npx wrangler deploy --config dist/server/wrangler.json`. No routes exist, so nothing changes for
   visitors.
5. **Secrets:** the owner sets the 5 secrets on `kilcon-site` with `wrangler secret put <NAME>
   --config dist/server/wrangler.json`, using the existing values.
6. **Smoke test before routing.** Choose one:
   - **(a)** briefly enable `workers_dev`, test the `*.workers.dev` URL, then disable it;
   - **(b)** add a route for a test hostname. That needs a DNS record and owner approval.
7. **Route:** the owner adds the Worker route `kilcon.work/*` → `kilcon-site` (and `www.kilcon.work/*`
   if `www` is served by Pages).
   - **Unaffected routes:** the more-specific routes stay with their Workers: `/api/gallery-api*`,
     `/api/reviews*`, `/api/contact*` and both `images.kilcon.work` routes.
   - **Pages fallback:** the Pages custom domain and DNS stay in place as the origin behind the
     route. Don't detach anything.
8. **Verify:**
   - production checks;
   - admin login (existing sessions stay valid, because `ADMIN_SECRET` is the same);
   - galleries, Manage Images, the review page and Import Approved Photos;
   - contact form, reviews and apparel;
   - observability CPU time per request, against the Free 10 ms limit.
9. **CI:** pick **Workers Builds** (Git) or a GitHub Action, running `npm ci && npm run build &&
   npx wrangler deploy --config dist/server/wrangler.json`. Never `pages deploy dist`.

**Free plan:**
- **Request quota:** Pages Functions and Workers share the same Free limits, 100,000 requests a day
  account-wide and 10 ms CPU per request. Today's SSR pages already run under them.
- **Static assets:** these are served without invoking the Worker, so they don't count toward the
  request quota, just as on Pages today.
- **CPU risk:** Astro 7 rendering cost isn't measured in production. Watch CPU time after cutover,
  and roll back if requests approach 10 ms.

**Rollback** (any step, no data restore):
1. **Remove** the `kilcon.work/*` (and `www`) route. Traffic returns to the Pages origin `449b7a41`
   (Astro 5) at once.
2. **Keep Pages builds paused** until `main` is reverted, `git revert` of the merge. Then
   re-enable them, or Pages would build Astro 7 again.
3. **Data:** D1, R2 and secrets are shared and unchanged, so nothing needs restoring. The unrouted
   `kilcon-site` Worker can stay for diagnosis.

## Outstanding risks

1. **Pages auto-deploy on merge** (above): pause it first.
2. **Secret values must come from the owner.** A wrong `ADMIN_SECRET` signs everyone out, and the
   Stripe keys matter only when payments are on.
3. **CPU on Workers Free** is unmeasured for Astro 7 in production.
4. **`www.kilcon.work`:** confirm whether Pages serves it, and route it the same way.
5. **The Wrangler redirect hazard:** use `--config`, as above.
6. **Migration `012_order_items_snapshot.sql`** fails on a fresh local database. This is
   pre-existing and doesn't affect production, which applied it long ago.
