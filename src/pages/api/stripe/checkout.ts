import type { APIRoute } from "astro";
import { runtimeEnv } from "../../../utils/runtimeEnv";

function json(data: unknown, status = 200) {
    return new Response(JSON.stringify(data), {
        status,
        headers: {
            "content-type": "application/json; charset=utf-8",
            "cache-control": "no-store",
        },
    });
}

function text(body: string, status = 200) {
    return new Response(body, {
        status,
        headers: {
            "content-type": "text/plain; charset=utf-8",
            "cache-control": "no-store",
        },
    });
}

type CheckoutBody = {
    slug: string;     // e.g. "t-shirts"
    size: string;     // "S".."XXXXL"
    quantity: number; // 1..N
};

const ALLOWED_SIZES = new Set(["S", "M", "L", "XL", "XXL", "XXXL", "XXXXL"]);

async function stripePostForm(url: string, secretKey: string, params: URLSearchParams) {
    const r = await fetch(url, {
        method: "POST",
        headers: {
            Authorization: `Bearer ${secretKey}`,
            "content-type": "application/x-www-form-urlencoded",
        },
        body: params.toString(),
    });

    const text = await r.text();
    let data: any = null;
    try { data = JSON.parse(text); } catch { /* ignore */ }

    if (!r.ok) {
        // Stripe error objects are useful; return sanitized
        return { ok: false, status: r.status, data: data ?? { raw: text } };
    }
    return { ok: true, status: r.status, data: data ?? {} };
}

export const POST: APIRoute = async ({ request, locals }) => {
    const env = runtimeEnv;
    const db = env.DB;
    const STRIPE_SECRET_KEY: string | undefined = env.STRIPE_SECRET_KEY;

    // GUARD (disable store unless explicitly enabled + live key present)
    const PAYMENTS_ENABLED = env.PAYMENTS_ENABLED === "true";
    if (!PAYMENTS_ENABLED) return text("store temporarily unavailable", 503);
    if (!STRIPE_SECRET_KEY?.startsWith("sk_live_")) return text("payments not enabled", 503);

    // Default to current request origin for local/dev; allow override in prod via env.
    const reqOrigin = new URL(request.url).origin;
    const PUBLIC_SITE_ORIGIN: string = env.PUBLIC_SITE_ORIGIN || reqOrigin;

    if (!db) return json({ error: "missing_db_binding" }, 500);
    if (!STRIPE_SECRET_KEY) return json({ error: "missing_stripe_secret" }, 500);

    let body: CheckoutBody;
    try {
        body = await request.json();
    } catch {
        return json({ error: "invalid_json" }, 400);
    }

    const slug = String(body?.slug || "").trim();
    const size = String(body?.size || "").trim().toUpperCase();
    const quantity = Number(body?.quantity);

    if (!slug || !ALLOWED_SIZES.has(size) || !Number.isInteger(quantity) || quantity < 1 || quantity > 20) {
        return json({ error: "bad_input" }, 400);
    }

    // Fetch item + variant
    const row = await db
        .prepare(
            `
            SELECT
                i.slug,
                i.title,
                i.active as itemActive,
                v.size,
                v.active,
                v.stock,
                v.price_cents as priceCents,
                v.stripe_price_id as stripePriceId
            FROM apparel_items i
                     JOIN apparel_variants v ON v.item_id = i.id
            WHERE i.slug = ? AND v.size = ?
    `
        )
        .bind(slug, size)
        .first();

    if (!row) return json({ error: "not_found" }, 404);
    if (row.itemActive !== 1) return json({ error: "item_inactive" }, 409);

    const stock = Number(row.stock ?? 0);
    if (stock <= 0) return json({ error: "out_of_stock" }, 409);
    if (row.active !== 1) return json({ error: "variant_inactive" }, 409);
    if (!row.stripePriceId) return json({ error: "missing_stripe_price_id" }, 409);
    if (stock < quantity) return json({ error: "out_of_stock" }, 409);

    // Create Stripe Checkout Session
    // - shipping_address_collection: let Stripe collect shipping address reliably
    // - phone_number_collection: useful for the contractor
    // - metadata: lets webhook identify slug/size/qty even if line_items fetch fails
    const successUrl = `${PUBLIC_SITE_ORIGIN}/apparel/${encodeURIComponent(slug)}?paid=1&session_id={CHECKOUT_SESSION_ID}`;
    const cancelUrl = `${PUBLIC_SITE_ORIGIN}/apparel/${encodeURIComponent(slug)}?cancelled=1`;

    const params = new URLSearchParams();
    params.set("mode", "payment");
    params.set("success_url", successUrl);
    params.set("cancel_url", cancelUrl);

    params.set("line_items[0][price]", row.stripePriceId);
    params.set("line_items[0][quantity]", String(quantity));

    params.set("shipping_address_collection[allowed_countries][0]", "US");
    params.set("phone_number_collection[enabled]", "true");

    // Optional: require email (Stripe will request it automatically in Checkout)
    // params.set("customer_creation", "always");

    // Metadata for webhook correlation
    params.set("metadata[slug]", row.slug);
    params.set("metadata[size]", row.size);
    params.set("metadata[quantity]", String(quantity));

    // Helpful for identifying in Stripe dashboard
    params.set("client_reference_id", `${row.slug}:${row.size}`);

    const created = await stripePostForm(
        "https://api.stripe.com/v1/checkout/sessions",
        STRIPE_SECRET_KEY,
        params
    );

    if (!created.ok) {
        console.error("[stripe checkout] create session failed", {
            status: created.status,
            data: created.data,
            slug,
            size,
            quantity,
        });
        return json({ error: "stripe_error" }, 502);
    }

    // Return session URL so frontend can redirect
    return json({ url: created.data.url });
};
