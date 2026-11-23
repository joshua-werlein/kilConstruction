import type { APIRoute } from "astro";

// Stripe online payments were retired on 2026-11-22: apparel is requested through
// the contact form ("Request This Item", src/lib/apparel-inquiry.js).
//
// This endpoint is kept only to answer 410 Gone, so old clients and any Stripe
// webhook delivery get a clear, permanent answer. It reads no environment
// variables, secrets or database, so the site needs no Stripe secrets.
// Historical orders stay in D1 (apparel_orders, apparel_order_items) untouched.
export const prerender = false;

export const ALL: APIRoute = () =>
    new Response(JSON.stringify({ error: "online_payments_retired" }), {
        status: 410,
        headers: {
            "content-type": "application/json; charset=utf-8",
            "cache-control": "no-store",
        },
    });
