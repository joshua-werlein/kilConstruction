import type { APIRoute } from "astro";
import { runtimeEnv } from "../../../../utils/runtimeEnv";
import { verifyAdminToken } from "../../../../utils/adminToken";

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

export const POST: APIRoute = async ({ request, cookies }) => {
    // Admin only (same signed admin_auth session as the admin pages). Before
    // 2026-11-22 this endpoint had no check of its own.
    const ADMIN_SECRET = runtimeEnv.ADMIN_SECRET;
    const SESSION_VERSION = runtimeEnv.SESSION_VERSION ?? "1";
    if (!ADMIN_SECRET) return json({ error: "server_misconfigured" }, 500);
    const auth = cookies.get("admin_auth")?.value || "";
    if (!auth || !(await verifyAdminToken(auth, ADMIN_SECRET, SESSION_VERSION))) {
        return json({ error: "unauthorized" }, 401);
    }
    if (!(request.headers.get("content-type") || "").toLowerCase().startsWith("application/json")) {
        return json({ error: "unsupported_media_type" }, 415);
    }

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

        // Online payments are retired: an enabled ("listed") size needs no price or
        // Stripe Price ID. stripe_price_id is never written, so historical values stay.
        stmts.push(
            db.prepare(`
        UPDATE apparel_variants
        SET active = ?, price_cents = ?, stock = ?, updated_at = (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
        WHERE item_id = ? AND size = ?
      `).bind(active, priceCents, stock, item.id, size)
        );
    }

    try {
        await db.batch(stmts);
    } catch (e: any) {
        console.error("[admin] apparel save failed", e);
        return json({ error: "db_error" }, 500);
    }

    return json({ ok: true });
};
