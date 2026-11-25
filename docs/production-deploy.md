# Production: Astro 7 on Cloudflare Workers (kilcon-site)

**Supported production architecture since 2026-11-23:** the site is the Worker `kilcon-site` (Astro 7 +
`@astrojs/cloudflare` 14, Workers Static Assets). It serves `kilcon.work/*` through a Worker route.
**Recovery is a Worker version rollback** (below). Astro 5 / Cloudflare Pages was retired on 2026-11-25 (project deleted), so it is **no longer a
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
  run the script again. It sets both Workers, the site first; there is no pause.
- **The repo `.env`** is a local development file. Never use its values in production.

## Pages retirement (completed 2026-11-25)

The Astro 5 Cloudflare Pages project `kilconstruction` was retired with the owner's approval. There
is no Pages fallback any more: recovery is the Worker version rollback above.

| Step | Result |
|---|---|
| Stability before retiring | 48 h on Astro 7: 2,090 requests, 0 errors, CPU p99 19.9 ms; Workers Builds green. |
| Astro 5 source | Tag `astro5-pages-final` → `8403269` (the source of the last Pages deployment, `08d48cf3`). |
| Git integration | The project's link was disconnected. The shared Cloudflare GitHub app stays installed; Workers Builds for `kilcon-site` is unaffected. |
| Custom domains | `kilcon.work` and `www.kilcon.work` detached from Pages. |
| DNS | `kilcon.work` and `www.kilcon.work` changed **in place** from proxied CNAMEs (`kilconstruction.pages.dev`) to proxied `AAAA 100::` placeholders. No other record changed. Afterwards DNS resolution, TLS (Universal SSL, `kilcon.work, *.kilcon.work`), redirects, pages, the Contact and Gallery Workers, the Facebook webhook and all 7 Worker routes were verified. |
| Project | Its 493 old deployments were deleted, then the project itself (with its Stripe and admin secrets). `kilconstruction.pages.dev` no longer resolves. |
| Rotation script | `scripts/rotate-admin-secret.ps1` now sets only `kilcon-site` and `kilcon-gallery-worker`. |
| Branch | `hotfix/astro5-apparel-auth` deleted locally and on GitHub. Its fix is on `main`, and its commits are kept by the tag. |

**Why the DNS placeholders matter:** a Worker route only runs on a proxied hostname, so
`kilcon.work` and `www.kilcon.work` must stay proxied records. `100::` is a discard address that is
never contacted: the `kilcon.work/*` route and the zone's www→apex redirect rule answer every request.
Don't delete these records, and don't make them DNS-only.
