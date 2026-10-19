# KilConstruction – Internal Development Context

This document is the single source of truth for how the kilConstruction system works.
Update it whenever we change architecture, security, or APIs.

---

## 1. High-level overview

**Goal:** Public marketing site + project gallery + client reviews for KIL Construction.

**Overall system stack**

- **Frontend:** Astro, static pages rendered on **Cloudflare Pages**.
- **Backend (system-wide):**
    - A **Cloudflare Worker** (`kilcon-gallery-worker`, defined and deployed directly in Cloudflare)  
      that handles `/api/gallery-api*` and `/api/reviews*` for gallery, reviews, and admin operations.
    - A **Cloudflare Worker** (`kilcon-contact`, also defined and deployed directly in Cloudflare)  
      that handles `POST /api/contact`, forwards form submissions to Resend, and always performs  
      Turnstile verification in production. This worker also does not live in this repository.

- **Storage:** Cloudflare **R2** for all photos and review JSON.
- **Spam protection:** Cloudflare **Turnstile** (contact + reviews).
- **Admin auth:** Cookie-based (`admin_auth`), backed by an `ADMIN_SECRET` in the external Worker
  and an Astro admin auth helper (`adminAuth.ts`) used by the admin frontend.

The public site is served from Cloudflare Pages at `https://kilcon.work`.

**This repository contains:**

- The **Astro frontend** deployed on Cloudflare Pages.

The gallery and review APIs used by the frontend:

- `kilcon.work/api/reviews*`
- `kilcon.work/api/gallery-api*`

> NOTE: The gallery and reviews endpoints described below are implemented in an
> external Cloudflare Worker, not in this repository. They are documented here
> so this repo’s frontend has a clear contract with the backend.
---

## 2. Architecture diagram

```text
Browser (public)
  |
  |  HTML/CSS/JS + POST /api/contact
  v
Cloudflare Pages (this repo)
  |
  |  forwards request to /api/contact (Cloudflare Worker)
  v
Contact Worker (kilcon-contact)
  |
  |  Resend API + Turnstile verify
  v
Email delivery

Browser (public + admin)
  |
  |  /api/gallery-api* and /api/reviews*
  v
Gallery + Reviews Worker (kilcon-gallery-worker)
  |
  |  R2 operations, Turnstile, admin_auth
  v
R2 bucket + review storage
```

**Facebook Page sync:** the gallery worker also serves the Meta Page `feed`
webhook (`/api/gallery-api/facebook/webhook`), an admin backfill and admin
controls (`/admin/facebook`). Facebook photos are grouped into projects in D1
`kilcon-db`; masters live in the private R2 bucket `kilcon-private` and a public
copy exists under `Facebook/` only while a photo is visible.

**Review photos are private:** new uploads go to `kilcon-private` and are served
only via `/api/reviews/photo?id=` (approved reviews, or admins).
`images.kilcon.work/Reviews/*` is blocked. See `docs/facebook-webhook.md`.
### 3. Admin credentials & session rotation

Admin authentication for the gallery/admin UI is backed by two key values in the runtime environment:

- `ADMIN_SECRET`
- `SESSION_VERSION`

#### ADMIN_SECRET

- Used as the HMAC key for signing `admin_auth` tokens.
- Never stored in this repository; configured only in Cloudflare.
- **Rotation policy:**
  - Rotate at least quarterly, and any time roles change or compromise is suspected.
  - When rotating `ADMIN_SECRET`, also bump `SESSION_VERSION` so all existing admin sessions are invalidated.

#### SESSION_VERSION

- Included as `ver` inside the token payload and enforced both:
  - In the Astro admin pages (login gate).
  - In the external gallery worker via `requireAdmin`.
- **Usage:**
  - Bump this value (e.g., `"1"` → `"2"`) whenever you want to force logout of all admin sessions without changing cookie names or other app logic.
  - Typical triggers: admin offboarding, major permission changes, or `ADMIN_SECRET` rotation.

