// noinspection SpellCheckingInspection
import type { APIRoute } from "astro";

export const prerender = true; // generate at build time

function normalizePath(path: string): string {
    // Ensure leading slash and remove trailing slash except for root.
    if (!path.startsWith("/")) path = `/${path}`;
    if (path !== "/" && path.endsWith("/")) path = path.slice(0, -1);
    return path;
}

function forceHttps(u: URL): URL {
  const out = new URL(u.toString());
  out.protocol = "https:";
  return out;
}

async function fetchSlugs(origin: URL, list: string): Promise<string[]> {
    try {
        const api = new URL("/api/gallery-api", origin);
        api.searchParams.set("list", list);

        const res = await fetch(api.toString(), { cache: "no-store" });
        if (!res.ok) {
            console.warn(`sitemap: gallery API list="${list}" returned ${res.status}`);
            return [];
        }
        if (!res.headers.get("content-type")?.includes("application/json")) {
            console.warn(`sitemap: gallery API list="${list}" returned non-JSON`);
            return [];
        }

        const json = (await res.json()) as Record<string, unknown>;

        // Expect arrays of items with { slug }, but be resilient to key naming.
        const arr =
            (json.projects as unknown[]) ??
            (json.albums as unknown[]) ??
            (json.items as unknown[]) ??
            (json[list] as unknown[]) ??
            [];

        if (!Array.isArray(arr)) return [];

        return arr
            .map((x) => (x && typeof x === "object" ? (x as any).slug : undefined))
            .filter((s): s is string => typeof s === "string" && s.length > 0);
    } catch (err) {
        console.error(`sitemap: failed to load slugs for list="${list}"`, err);
        return [];
    }
}

export const GET: APIRoute = async ({ site }) => {
    // Canonical site origin (from astro.config.mjs `site`, or fallback)
    const origin = forceHttps(site ?? new URL("https://kilcon.work"));

    // Core static pages (NO trailing slashes; match trailingSlash: "never")
    const staticPaths = [
        "/",
        "/projects",
        "/services/new-construction",
        "/services/remodels",
        "/services/furniture",
        "/apparel",
        "/reviews",
        "/contact",
        "/privacy",
        "/terms",
        "/data-deletion",
    ].map(normalizePath);

    // Dynamic slugs (best-effort; empty if API doesn't support)
    const projectSlugs = await fetchSlugs(origin, "projects");
    const apparelSlugs = await fetchSlugs(origin, "apparel");
    const ncSlugs = await fetchSlugs(origin, "new-construction");
    const remodelSlugs = await fetchSlugs(origin, "remodels");
    const furnitureSlugs = await fetchSlugs(origin, "furniture");

    const urls = [
        ...staticPaths,
        ...projectSlugs.map((slug) => normalizePath(`/projects/${slug}`)),
        ...apparelSlugs.map((slug) => normalizePath(`/apparel/${slug}`)),
        ...ncSlugs.map((slug) => normalizePath(`/services/new-construction/${slug}`)),
        ...remodelSlugs.map((slug) => normalizePath(`/services/remodels/${slug}`)),
        ...furnitureSlugs.map((slug) => normalizePath(`/services/furniture/${slug}`)),
    ];

    // Dedupe while preserving order
    const seen = new Set<string>();
    const uniqueUrls = urls.filter((p) => {
        const key = normalizePath(p);
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
    });

    const xml =
        `<?xml version="1.0" encoding="UTF-8"?>\n` +
        `<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n` +
        uniqueUrls
            .map((path) => {
                const loc = new URL(path, origin).toString();

                const isHome = path === "/";
                const isProjectsIndex = path === "/projects";
                const isProjectDetail = path.startsWith("/projects/") && path !== "/projects";

                const priority = isHome ? "1.0" : isProjectsIndex || isProjectDetail ? "0.9" : "0.8";
                const changefreq = isHome || isProjectsIndex || isProjectDetail ? "weekly" : "monthly";

                return [
                    "  <url>",
                    `    <loc>${loc}</loc>`,
                    `    <changefreq>${changefreq}</changefreq>`,
                    `    <priority>${priority}</priority>`,
                    "  </url>",
                ].join("\n");
            })
            .join("\n") +
        `\n</urlset>\n`;

    return new Response(xml, {
        status: 200,
        headers: { "Content-Type": "application/xml; charset=utf-8" },
    });
};
