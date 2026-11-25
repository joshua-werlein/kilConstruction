# Production: Astro 7 on Cloudflare Workers (kilcon-site)

**Supported production architecture since 2026-11-23:** the site is the Worker `kilcon-site` (Astro 7 +
`@astrojs/cloudflare` 14, Workers Static Assets). It serves `kilcon.work/*` through a Worker route.
**Recovery is a Worker version rollback** (below). Astro 5 / Cloudflare Pages is retired: its Git
integration was disconnected and its custom domains detached on 2026-11-25, so it is **no longer a
rollback path**. Its source is tag `astro5-pages-final` (`8403269`).

## What serves what

| Host / path | Served by | Managed where |
|---|---|---|
| `kilcon.work/*` | `kilcon-site` | Zone Worker route, created by API 2026-11-23 03:21 UTC. **Not** in `wrangler.jsonc`, on purpose. |
| `kilcon.work/api/gallery-api*`, `kilcon.work/api/reviews*` | `kilcon-gallery-worker` | `workers/kilcon-gallery-worker/wrangler.toml` |
| `kilcon.work/api/contact*`, `www.kilcon.work/api/contact*` | `kilcon-contact` | `workers/kilcon-contact/wrangler.toml` |
| `images.kilcon.work/Reviews/*`, `images.kilcon.work/Facebook/*` | `kilcon-gallery-worker` | same; the Facebook route is **Fail closed** |
| `www.kilcon.work/*` | zone redirect rule → `https://kilcon.work/…` (301) | dashboard |

More specific routes win, so the Gallery and Contact Workers keep their paths. This was verified at
cutover: `kilcon-site` received zero `/api/gallery-api`, `/api/reviews` or `/api/contact` requests.

Why the route isn't in `wrangler.jsonc`: Wrangler rewrites a Worker's routes **only when its
config lists routes**. With none listed, `wrangler deploy` never touches the production route, and
`tests/site-worker-config.test.mjs` keeps it that way.

## Automatic deployments: Workers Builds (clean checkout)

Workers Builds builds every push to `main` in a fresh clone, which has no `.env`, then deploys
`kilcon-site`. It never touches the Gallery or Contact Workers: their configs, routes and secrets are
separate, and they are still deployed by hand with `--config`.

**One-time setup (owner, Cloudflare dashboard):** Workers & Pages → **kilcon-site** → Settings →
**Builds** → *Connect* → GitHub repository **joshua-werlein/kilConstruction**:

| Setting | Value |
|---|---|
| Production branch | `main` |
| Root directory | `/` (blank) |
| Build command | `npm run site:ci-build` (= `astro build` + `scripts/check-site-build.mjs`) |
| Deploy command | `npx wrangler deploy --config dist/server/wrangler.json` |
| Non-production branch builds | **Off** |
| Build variables | none needed. Node comes from `.nvmrc` (`22.23.5`); secrets are Worker secrets, never build variables. |

**What a build checks:**
- `site:ci-build` **fails the deploy** if the build contains a Turnstile test key, a localhost URL
  or a `.dev.vars` file, or if the production values are missing.
- A failed build changes nothing in production.

**After each deploy:**
- the new version is active on `kilcon-site`;
- `kilcon.work/*` still points at `kilcon-site` (`wrangler deployments status --name kilcon-site` and
  the zone's routes);
- `scratchpad prod-checks` / site checks pass.

**Manual deploy (fallback):** from a **fresh `git worktree`** of `main` (never the primary checkout,
which has a local `.env`), run `npm ci && npm run site:deploy`.

**Commit tags:** `[CF-Pages-Skip]` no longer matters. Every push to `main` deploys `kilcon-site`,
including docs-only commits, which is a harmless rebuild.

## Recovery: Worker version rollback (the supported procedure)

Every deploy keeps the previous versions (the last 100 can be reactivated). A rollback switches
traffic in seconds and changes no data, secrets, routes or bindings.

| Worker | Command (from the repo root) | Notes |
|---|---|---|
| `kilcon-site` | `npx wrangler versions list --config wrangler.jsonc`, then `npx wrangler versions deploy <id>@100% --config wrangler.jsonc -y` | Workers Builds redeploys on the next push to `main`; revert the bad commit too. |
| `kilcon-contact` | `npx wrangler versions deploy <id>@100% --config workers/kilcon-contact/wrangler.toml -y` | Only to versions **at or after `ac8cc59c`** (see below). |
| `kilcon-gallery-worker` | `npx wrangler versions deploy <id>@100% --config workers/kilcon-gallery-worker/wrangler.toml -y` | The cron and routes are not versioned and stay as they are. |

**After a rollback:** check `wrangler deployments status --config …`, the zone routes, and the
production checks (pages 200, admin 302/401, webhook 401 unsigned, contact `captcha` for a bad token).

**Durable Object limit:** Cloudflare can't roll a Worker back across a Durable Object migration.
The Contact Worker's migration `v1` (2026-11-25) makes **`ac8cc59c`** the oldest usable target: it
has the migrated class but still uses the old `WRITE_LIMITER` binding. `ec34f316` and older can no
longer be reactivated.

## Contact rate limiting

- **Authoritative:** the SQLite-backed Durable Object `ContactRateLimiter`
  (`workers/kilcon-contact/src/rate-limiter.js`): 3 accepted requests per rolling 60 s per client
  (IPv4 address; IPv6 /64), one object per client, so it is exact across locations and atomic under
  concurrency. It stores only the accepted timestamps of the current window, and an alarm deletes
  them afterwards.
- **Fails closed:** if the limiter is unavailable, the Worker answers 503 (form: `?err=server`) and
  sends nothing.
- **Also in place:** the zone WAF rule "KilCon API Abuse Protection" (`/api/*`, 50 requests per 10 s
  per IP), Turnstile, the honeypot and the input limits.
- **Free plan:** about 1–2 Durable Object requests and a few row writes per inquiry, against 100,000
  requests and 100,000 rows written per day.
- **Production check without sending email:** POST valid fields with **no** Turnstile token. Requests
  1–3 answer 403 `captcha`, 4–8 answer 429 `rate`. Wait 60 s between runs.
- **Tests:** `npm run test:contact-worker` includes real-runtime tests (`limiter.workerd.test.mjs`).

## Secrets

| Secret | kilcon-site | Gallery Worker |
|---|---|---|
| `ADMIN_USER`, `ADMIN_PASS` | ✓ | – |
| `ADMIN_SECRET` | ✓ same value | ✓ same value |
| `SESSION_VERSION` (var) | `3` | `3` |

- **Rotation:** `ADMIN_SECRET` was rotated 2026-11-23 with `scripts/rotate-admin-secret.ps1`. The
  value was generated in memory and never displayed or stored, so nobody knows it. To change it,
  run the script again.
- **Until the Pages project is deleted**, the script still also sets the secret on Pages and pauses
  for a Pages rebuild. Pages no longer serves anything, so at that pause just type CONTINUE. When the
  project is deleted, the script drops that step (a two-Worker version is ready).
- **The repo `.env`** is a local development file. Never use its values in production.

## Retiring the old Pages project

**Status (2026-11-25, owner-approved):**

| Step | Status |
|---|---|
| Watch period and automatic deploys | Done. Over 48 h: 2,090 requests, 0 errors, CPU p99 19.9 ms. Workers Builds green. |
| Astro 5 source preserved | Done: tag `astro5-pages-final` → `8403269` (the source of Pages deployment `08d48cf3`). |
| 1. Disconnect Pages from GitHub | Done. Only the project's link was removed; the GitHub app is still installed, and Workers Builds is unaffected. |
| 2. Detach custom domains (`kilcon.work`, `www.kilcon.work`) | Done. Site, redirects and TLS verified afterwards; the Universal SSL certificate covers `kilcon.work, *.kilcon.work`. |
| DNS placeholders | **Pending the owner's approval.** `kilcon.work` and `www.kilcon.work` are still proxied CNAMEs to `kilconstruction.pages.dev`. Traffic never reaches that origin: the Worker route and the www redirect rule answer first. Before deleting the project, change each record in place to proxied `AAAA 100::`. Otherwise they point at a `pages.dev` name anyone could claim. |
| 3–4. Delete the Pages project (and with it its Stripe and admin secrets) | **Waiting on the DNS step.** |
| 5. Branch `hotfix/astro5-apparel-auth` | Done: deleted locally and on GitHub. Its fix is on `main`, and its commits are kept by the tag. |

**Original checklist:**

**Before retiring:**
- **Watch period:** several days on Astro 7 with no rollback needed. Check daily: the production
  checks, `kilcon-site` errors and CPU (Workers observability), the admin flows, Facebook webhooks
  and the 12:00 and 18:00 discovery runs.
- **Automatic deploys:** Workers Builds is connected and has deployed at least once successfully.

**Steps (each needs the owner's approval; deleting the project or its history needs a separate,
explicit approval):**
1. **Disconnect Pages from GitHub** (Pages → kilconstruction → Settings → Builds → Disconnect), so
   branch pushes stop creating Pages preview builds. The production deployment `08d48cf3` keeps
   serving as the fallback origin.
2. **Detach the `kilcon.work` custom domain** from Pages, once the Worker route alone serves the
   site. First confirm that DNS for `kilcon.work` stays proxied: a Worker route needs a proxied
   record, and Pages created the record. Replace it with a proxied placeholder record if needed,
   and check that `kilcon.work` still serves Astro 7. This removes the instant rollback, so it
   comes last.
3. **Remove the Pages-only secrets** (`STRIPE_*`, `ADMIN_*`), and drop the Pages step from
   `scripts/rotate-admin-secret.ps1`.
4. **Delete the Pages project** `kilconstruction`, which deletes its deployment history: **only
   with the owner's separate approval.**
5. **Branches:** delete `hotfix/astro5-apparel-auth`, local and remote; remote deletion needs
   separate approval.
