# Apparel: Request This Item (Stripe retired 2026-11-22)

KIL Construction doesn't take payment online. Each apparel item page (`/apparel/<slug>`) has a
**Request This Item** form in place of Checkout.

## Customer flow

1. **On the item page,** the customer enters their **Full Name** and **Email Address**, picks a
   **size**, enters a **quantity** (1–99), and can add **notes** (up to 500 characters).
   - **Validation:** a name is 2–100 characters, starting with a letter. Letters in any script,
     spaces, hyphens, apostrophes and periods are allowed. An email needs a practical
     `local@domain.tld` format of at most 254 characters, stricter than the Contact Worker's, so
     anything accepted here is accepted there. Each invalid field is marked (`aria-invalid`, an
     error under the field), the summary is announced (`role="alert"`), and focus moves to the
     first invalid field.
   - **Sizes listed:** the sizes enabled in Admin → Apparel. If an item has none enabled, which is
     the case for all five items today, its defined sizes are offered.
   - **Other sizes:** *Other size (not listed)* opens a text box for any size, such as 5XL, Tall L
     or Youth M.
   - **Stock and price never block a request.**
2. **The customer completes Turnstile on the item page** and presses **Request This Item**. The
   request is sent directly from the page (`src/lib/apparel-submit.js`). The customer isn't
   redirected.
   - **Transport:** a `fetch` POST of form data to the Contact Worker (`/api/contact`) with
     `Accept: application/json`. Name, email and notes are only in the POST body, never in a URL.
     Cookies are omitted, and redirects are treated as errors.
   - **Same pipeline as `/contact`:** the honeypot (an off-screen field with no `name`), the
     `WRITE_LIMITER` rate limit (3 per minute per IP, shared with `/contact`), the phone and
     input checks, Turnstile siteverify, and Resend delivery with `reply_to` set to the customer.
     The owner receives an ordinary contact email whose message starts with "Apparel request".
   - **Success:** shown only when the Worker answers `{"ok":true}`, which it sends only after
     Resend accepts the message. The form is replaced by a "Request sent" panel (`role="status"`,
     focused). *Request another item* brings the form back.
   - **Failure:** a clear message in the `role="alert"` area; every entry is kept and the
     customer can press the button again.

     | Code | Cause |
     |---|---|
     | `captcha` | Turnstile failed or the token expired |
     | `rate` | Rate limited (429) |
     | `input` | Name, email or message rejected |
     | `delivery` | Resend rejected or unreachable (502) |
     | `server` | Missing configuration |
     | `network` | Offline, or a non-JSON answer |
   - **Double submissions:** while a request is in flight, the button is disabled and reads
     "Sending…", the form is `aria-busy`, and further submits are ignored.
   - **Turnstile:** the token is read on submit. A missing or expired token stops the send and
     asks the customer to complete the check (`data-refresh-expired="auto"` also renews tokens).
     The widget is reset after every attempt, because a token is valid for one verification only.

**Without JavaScript,** the form is a GET to `/contact`, which carries only item, title, size and
quantity. Name, email, notes, the honeypot and the Turnstile token have no `name` attribute
(Turnstile uses `data-response-field="false"`), so nothing personal can enter that URL. A
`<noscript>` note explains that the button opens the contact page.

**The `/contact` page is unchanged.** It still reads the older sessionStorage hand-off and restores
its own draft after an error redirect. Nothing sends customers there with JavaScript on anymore.

### Contact Worker responses

`workers/kilcon-contact/src/index.js`:
- **Ordinary form POSTs:** answered exactly as before, with 303 redirects to `/contact?sent=1`
  or `?err=…`, a 502 text page for provider failures, and a 415 text page for JSON bodies.
- **Requests with `Accept: application/json` from an allowed `Origin`:** answered with JSON:

  | Status | Body |
  |---|---|
  | 200 | `{ok:true}` (also returned for a filled honeypot, and nothing is sent) |
  | 400 | `input`, `phone` |
  | 403 | `captcha` |
  | 429 | `rate`, with `Retry-After: 60` |
  | 500 | `server` |
  | 502 | `delivery` |
  | 415 | `media_type` |

  Any other `Origin` gets 403 `origin` before any check or send.

## Deployment and rollback (coordinated: Contact Worker first, site second)

The Worker change is backward compatible: the `/contact` form gets identical responses. The new
item page depends on the JSON responses, so the order matters.

1. **Contact Worker:**
   - Upload: `CLOUDFLARE_ACCOUNT_ID=8481dbc471ac3a4aa14cc26ea366f956 npm run contact-worker:upload`.
   - Promote: `npx wrangler versions deploy <new-version>@100% --config workers/kilcon-contact/wrangler.toml`.
   - Versions upload/deploy changes only code and the same vars. Routes, workers.dev, secrets
     and the rate limit are untouched.
   - Verify: `/contact` still redirects. A JSON POST without a token returns 403 `captcha`.
     `Origin: https://evil.example` returns 403 `origin`.
2. **Site:** merge to `main`; Workers Builds deploys `kilcon-site`. Verify in a browser:
   - An invalid submission shows errors.
   - A token-less retry is blocked.
   - One real request shows "Request sent" and the email arrives with Reply-To.
   - The ordinary `/contact` form still works.
3. **Rollback, site first:**
   - Site: `npx wrangler rollback <previous kilcon-site version> --name kilcon-site`, or revert
     the merge on `main`.
   - Contact Worker: `npx wrangler versions deploy 906fe661-232b-40c6-aacd-a466da549215@100% --config workers/kilcon-contact/wrangler.toml`.
   - **Why this order:** rolling back only the Contact Worker would leave the new item page
     getting redirects. It would show a "couldn't send" error and never a false success, but no
     request would go through. A rolled-back site works with either Worker version.

## Admin

Admin → Apparel → item:
- **Settings:** each size can be **enabled**, meaning listed on the form, with a reference
  **price** and **stock**.
- **No Stripe requirements:** a size no longer needs a price or a Stripe Price ID to be enabled.
  The editor doesn't show Stripe Price IDs, and saving never writes `stripe_price_id`, so stored
  values are kept.
- **Requests never change stock.**
- **The save API** (`/api/admin/apparel/variants.save`) now **requires the admin session**.
  Before this change it had no check of its own, and anyone could change prices, stock and
  enabled sizes. It accepts JSON only.

## Stripe

- **Endpoints:** `/api/stripe/checkout` and `/api/stripe/webhook` answer **410 Gone** for every
  method. They read no environment values, secrets or database. If a webhook endpoint is still
  configured in the Stripe dashboard, the owner can disable it there; Stripe will see 410s.
- **Secrets:** the site Worker needs no Stripe secrets, and `PAYMENTS_ENABLED` is gone.
- **History is preserved:** nothing was deleted or migrated. The tables `apparel_orders` (10
  rows) and `apparel_order_items` (8 rows) and every `stripe_*` column stay as they are. Stripe
  keeps its own payment records.
- **Legal text:** privacy, terms and data deletion were updated on 2026-11-22. Requests are
  inquiries, not orders, and past online orders are described as such. **This needs owner
  review.**

## Tests

- `tests/apparel-inquiry.test.mjs`: the form logic, name and email validation, the no-JS field
  names, the Turnstile widget settings, double-submit and success/failure handling on the page,
  the 410 stubs, no Stripe reads, admin auth on save, and no new migration.
- `tests/apparel-submit.test.mjs`: the page's submission run against the real Contact Worker
  code (Turnstile and Resend mocked). It covers success with Reply-To, privacy (POST body only),
  validation, rate limit, Turnstile failure and expiry, delivery failure, network and non-JSON
  answers, and the honeypot.
- `workers/kilcon-contact/test/contact.test.mjs` (`npm run test:contact-worker`): every JSON
  outcome, the origin check, and the unchanged form-mode redirects.
- `tests/legal-pages.test.mjs`
- `scripts/check-site-build.mjs`
