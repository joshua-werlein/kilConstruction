# Apparel: Request This Item (Stripe retired 2026-11-22)

KIL Construction doesn't take payment online. Each apparel item page (`/apparel/<slug>`) has a
**Request This Item** form in place of Checkout.

## Customer flow

1. **On the item page,** the customer picks a **size**, enters a **quantity** (1–99), and can
   add **notes** (up to 500 characters).
   - **Sizes listed:** the sizes enabled in Admin → Apparel. If an item has none enabled, which is
     the case for all five items today, its defined sizes are offered.
   - **Other sizes:** *Other size (not listed)* opens a text box for any size, such as 5XL, Tall L
     or Youth M.
   - **Stock and price never block a request.**
2. **On submit,** the customer goes to `/contact?inquiry=apparel&item=…&title=…&size=…&qty=…`.
   - **The message box is prefilled** with the request, unless it already has text, and the page
     shows a short note.
   - **Notes travel in this tab's `sessionStorage`,** never in the URL, so they stay out of logs
     and Referer headers. They're removed once used.
3. **The customer adds their name and email,** completes Turnstile, and presses **Send**. That's
   the **unchanged** contact form and Contact Worker: Turnstile, the honeypot, the rate limit,
   Resend delivery and `reply_to`. The owner receives an ordinary contact email starting with
   "Apparel request".

Without JavaScript, the form still opens `/contact` (a GET), but nothing is prefilled.

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

- `tests/apparel-inquiry.test.mjs`: the form logic, the URL and notes handling, the 410 stubs,
  no Stripe reads, admin auth on save, and no new migration.
- `tests/legal-pages.test.mjs`
- `scripts/check-site-build.mjs`
