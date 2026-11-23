import type { APIRoute } from "astro";
import { runtimeEnv } from "../../../../utils/runtimeEnv";

function json(data: unknown, status = 200) {
    return new Response(JSON.stringify(data), {
        status,
        headers: {
            "content-type": "application/json; charset=utf-8",
            "cache-control": "no-store",
        },
    });
}

const ALLOWED_SIZES = new Set(["S","M","L","XL","XXL","XXXL","XXXXL"]);

export const POST: APIRoute = async ({ request, locals }) => {
    const db = runtimeEnv.DB;
    if (!db) return json({ error: "missing_db_binding" }, 500);

    let body: any;
    try {
        body = await request.json();
    } catch {
        return json({ error: "invalid_json" }, 400);
    }

    const slug = String(body?.slug || "").trim();
    const variants = body?.variants;

    if (!slug || !Array.isArray(variants)) {
        return json({ error: "bad_input" }, 400);
    }

    const item = await db
        .prepare(`SELECT id FROM apparel_items WHERE slug = ?`)
        .bind(slug)
        .first();

    if (!item) return json({ error: "not_found" }, 404);

    // Validate and apply in a transaction
    const stmts: any[] = [];

    for (const v of variants) {
        const size = String(v?.size || "").trim();
        if (!ALLOWED_SIZES.has(size)) return json({ error: "bad_size", size }, 400);

        const active = v?.active ? 1 : 0;

        const priceCents = Number(v?.priceCents);
        const stock = Number(v?.stock);

        if (!Number.isInteger(priceCents) || priceCents < 0) {
            return json({ error: "bad_price", size }, 400);
        }
        if (!Number.isInteger(stock) || stock < 0) {
            return json({ error: "bad_stock", size }, 400);
        }

        const stripePriceIdRaw = v?.stripePriceId ?? null;
        const stripePriceId =
            stripePriceIdRaw === null || stripePriceIdRaw === ""
                ? null
                : String(stripePriceIdRaw).trim();

        // If enabling a size, require both a price and a stripe price id
        if (active === 1) {
            if (priceCents <= 0) return json({ error: "active_requires_price", size }, 400);
            if (!stripePriceId) return json({ error: "active_requires_stripe_price_id", size }, 400);
        }

        stmts.push(
            db.prepare(`
        UPDATE apparel_variants
        SET active = ?, price_cents = ?, stock = ?, stripe_price_id = ?, updated_at = (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
        WHERE item_id = ? AND size = ?
      `).bind(active, priceCents, stock, stripePriceId, item.id, size)
        );
    }

    try {
        await db.batch(stmts);
    } catch (e: any) {
        return json({ error: "db_error", detail: e?.message || "unknown" }, 500);
    }

    return json({ ok: true });
};
