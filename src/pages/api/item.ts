import type { APIRoute } from "astro";
import { runtimeEnv } from "../../utils/runtimeEnv";

function json(data: unknown, status = 200) {
    return new Response(JSON.stringify(data), {
        status,
        headers: {
            "content-type": "application/json; charset=utf-8",
            "cache-control": "no-store",
        },
    });
}

export const GET: APIRoute = async ({ request, locals }) => {
    const url = new URL(request.url);
    const slug = (url.searchParams.get("slug") || "").trim();

    if (!slug) return json({ error: "missing_slug" }, 400);

    const db = runtimeEnv.DB;
    if (!db) return json({ error: "missing_db_binding" }, 500);

    const item = await db
        .prepare(`SELECT id, slug, title, active FROM apparel_items WHERE slug = ?`)
        .bind(slug)
        .first();

    if (!item || item.active !== 1) return json({ error: "not_found" }, 404);

    const variants = await db
        .prepare(`
            SELECT size, price_cents AS priceCents, stock, active
            FROM apparel_variants
            WHERE item_id = ?
            ORDER BY
                CASE size
                WHEN 'S' THEN 1 WHEN 'M' THEN 2 WHEN 'L' THEN 3 WHEN 'XL' THEN 4
                WHEN 'XXL' THEN 5 WHEN 'XXXL' THEN 6 WHEN 'XXXXL' THEN 7
                ELSE 99
            END
        `)
        .bind(item.id)
        .all();

    return json({
        slug: item.slug,
        title: item.title,
        variants: (variants.results || []).map((v: any) => ({
            size: v.size,
            priceCents: v.priceCents,
            stock: Number(v.stock ?? 0),
            active: Number(v.active ?? 0),
        })),
    });
};
