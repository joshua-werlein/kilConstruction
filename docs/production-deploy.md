# Production: Astro 7 on Cloudflare Workers (kilcon-site)

**Supported production architecture since 2026-11-23:** the site is the Worker `kilcon-site` (Astro 7 +
`@astrojs/cloudflare` 14, Workers Static Assets). It serves `kilcon.work/*` through a Worker route.
Astro 5 / Cloudflare Pages is **not** developed any further. It's kept only as an emergency rollback
until it is retired (below).

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

**Rolling back the code only:**
1. `npx wrangler versions list --name kilcon-site` to find the version to return to;
2. `npx wrangler versions deploy <previous-version-id>@100% --name kilcon-site -y`.

**Commit tags:** `[CF-Pages-Skip]` no longer matters for the site. Every push to `main` deploys
`kilcon-site`, including docs-only commits, which is a harmless rebuild.

## Emergency rollback to Astro 5 (Pages)

1. Delete the zone route `kilcon.work/*` → `kilcon-site` (dashboard: Websites → kilcon.work →
   Workers Routes, or the API). Traffic returns at once to the Pages custom domain, served by
   deployment **`08d48cf3`**: Astro 5 plus the apparel save auth hotfix, built 2026-11-23 with the
   current `ADMIN_SECRET`.
2. Data, secrets, the Gallery and Contact Workers, and Facebook settings need no change. All three
   sites share D1, R2 and the same `ADMIN_SECRET`.
3. Astro 5 doesn't have Request This Item: the apparel pages show the old Checkout, which answers
   503 because payments are off.
4. To return to Astro 7, re-add the route.

Pages automatic production builds stay **off**, and its production branch is `main` (Astro 7, which
Pages can't build). Don't re-enable them.

## Secrets

| Secret | kilcon-site | Pages (rollback) | Gallery Worker |
|---|---|---|---|
| `ADMIN_USER`, `ADMIN_PASS` | ✓ | ✓ | – |
| `ADMIN_SECRET` | ✓ same value | ✓ same value | ✓ same value |
| `SESSION_VERSION` (var) | `3` | `3` | `3` |

- **Rotation:** `ADMIN_SECRET` was rotated 2026-11-23 with `scripts/rotate-admin-secret.ps1`. The
  value was generated in memory and never displayed or stored, so nobody knows it. To change it,
  run the script again; it covers all three and pauses for the Pages rebuild.
- **After Pages is retired:** the script's Pages step goes away.
- **The repo `.env`** is a local development file. Never use its values in production.

## Retiring the old Pages project (separate approval required)

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
