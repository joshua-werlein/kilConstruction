// Admin review page for historical Facebook photos (/admin/facebook-review).
// All data and images come from same-origin admin endpoints; the browser never
// sees the Page token or Facebook CDN URLs. Same-origin images also let the
// page compute perceptual hashes in a canvas without tainting it.
import { dHashFromRgba, bestMatch } from "../../lib/photo-hash.js";

type Decision = "import" | "skip" | "later";
type Target = { value: string; name: string; category: string; prefix: string | null; source: string; id: number | null };
type Album = { id: string; name: string; kind: "project" | "generic" | "branding"; count: number; suggested: Target[];
    mapping: { projectId: number; name: string; prefix: string | null } | null; decisions: Record<Decision, number>; imported: number };
type Photo = { id: string; createdTime: string | null; state: string | null; decision: Decision | null; duplicateOf: string | null; note: string | null };
type SiteItem = { id: string; label: string; src: string; duplicateOf: string };
type Match = { id: string; distance: number; level: "likely" | "possible" };

const CONCURRENCY = 6;
const STORE_KEY = "kilcon-review-compare";

export default function initReviewPage() {
    if (typeof document === "undefined") return;
    document.addEventListener("DOMContentLoaded", () => void start());
}

// @cloudflare/workers-types (src/env.d.ts) overrides Element.append() with the
// HTMLRewriter signature, so DOM nodes are added with appendChild.
const put = (parent: any, ...kids: any[]) => { for (const k of kids) parent.appendChild(k); return parent; };

function el<K extends keyof HTMLElementTagNameMap>(tag: K, props: Record<string, string> = {}, text?: string) {
    const node = document.createElement(tag);
    for (const [k, v] of Object.entries(props)) node.setAttribute(k, v);
    if (text !== undefined) node.textContent = text;
    return node;
}

async function start() {
    const root = document.getElementById("rv-root");
    if (!root) return;
    const API = (root.dataset.adminApi || "/api/gallery-api/facebook/admin").replace(/\/$/, "");
    const $ = <T = HTMLElement>(id: string) => document.getElementById(id) as unknown as T;
    const statusEl = $("rv-status"), totalsEl = $("rv-totals"), albumEl = $("rv-album"), titleEl = $("rv-album-title"), emptyEl = $("rv-empty");
    const noteEl = $("rv-album-note"), compareEl = $<HTMLSelectElement>("rv-compare"), progressEl = $("rv-progress");
    const fbGrid = $("rv-fb"), siteGrid = $("rv-site");
    const lists: Record<string, HTMLElement> = { project: $("rv-list-project"), generic: $("rv-list-generic"), branding: $("rv-list-branding") };

    let albums: Album[] = [];
    let galleries: Target[] = [];
    let current: Album | null = null;
    let photos: Photo[] = [];
    let site: SiteItem[] = [];
    let generation = 0;
    const hashes = new Map<string, string | null>();      // image URL -> hash (null = failed)
    const matches = new Map<string, Match | null>();      // fb photo id -> best match
    const pending = new Map<string, { photoId: string; albumId: string | null; decision: Decision | "clear"; duplicateOf?: string | null }>();
    let saveTimer: number | undefined;

    async function api(path: string, init: RequestInit = {}) {
        const res = await fetch(`${API}/${path}`, { credentials: "include", ...init });
        const data: any = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(data?.error || `Request failed (${res.status})`);
        return data;
    }
    const fbImage = (id: string) => `${API}/review-image?id=${encodeURIComponent(id)}`;
    const setStatus = (t: string) => { statusEl.textContent = t; };

    function readStore(): Record<string, string> {
        try { return JSON.parse(localStorage.getItem(STORE_KEY) || "{}") || {}; } catch { return {}; }
    }
    function writeStore(albumId: string, value: string) {
        try { const s = readStore(); s[albumId] = value; localStorage.setItem(STORE_KEY, JSON.stringify(s)); } catch { /* per-viewer convenience only */ }
    }

    // --- perceptual hashing (same algorithm as the offline analysis) ----------
    const stage = document.createElement("canvas");
    stage.width = 72; stage.height = 64;
    const tiny = document.createElement("canvas");
    tiny.width = 9; tiny.height = 8;
    const stageCtx = stage.getContext("2d", { willReadFrequently: true })!;
    const tinyCtx = tiny.getContext("2d", { willReadFrequently: true })!;
    const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
    // The image endpoints are rate limited (429 + Retry-After); wait and retry.
    async function fetchImage(url: string): Promise<Blob> {
        for (let attempt = 0; attempt < 4; attempt++) {
            const res = await fetch(url, { credentials: "include" });
            if (res.status === 429) { await sleep((Number(res.headers.get("Retry-After")) || 10) * 1000); continue; }
            if (!res.ok) throw new Error(`Image request failed (${res.status})`);
            return await res.blob();
        }
        throw new Error("Image requests are rate limited");
    }
    async function hashUrl(url: string): Promise<string | null> {
        if (hashes.has(url)) return hashes.get(url)!;
        try {
            const bitmap = await createImageBitmap(await fetchImage(url));
            // Two-step downscale approximates area averaging.
            stageCtx.imageSmoothingQuality = "high";
            stageCtx.drawImage(bitmap, 0, 0, 72, 64);
            bitmap.close();
            tinyCtx.imageSmoothingQuality = "high";
            tinyCtx.drawImage(stage, 0, 0, 9, 8);
            const h = dHashFromRgba(tinyCtx.getImageData(0, 0, 9, 8).data);
            hashes.set(url, h);
            return h;
        } catch {
            return null; // not remembered: retried the next time the album is opened
        }
    }
    // Displayed thumbnails: one delayed retry if the first load is refused.
    function retryingImg(props: Record<string, string>) {
        const img = el("img", props);
        img.addEventListener("error", () => {
            window.setTimeout(() => { img.src = `${props.src}${props.src.includes("?") ? "&" : "?"}retry=1`; }, 10000);
        }, { once: true });
        return img;
    }
    async function hashAll(urls: string[], gen: number, label: string) {
        let done = 0;
        const queue = [...urls];
        const worker = async () => {
            while (queue.length && gen === generation) {
                await hashUrl(queue.shift()!);
                done++;
                if (done % 10 === 0 || done === urls.length) progressEl.textContent = `Fingerprinting ${label}: ${done}/${urls.length}`;
            }
        };
        await Promise.all(Array.from({ length: CONCURRENCY }, worker));
    }

    // --- rendering -------------------------------------------------------------
    function renderTotals(summary: any) {
        totalsEl.replaceChildren();
        const d = summary?.decisions || {};
        const rows: [string, string][] = [["Import", d.import ?? 0], ["Duplicate / Skip", d.skip ?? 0], ["Review later", d.later ?? 0], ["Approved, not yet imported", summary?.readyToImport ?? 0]];
        for (const [k, v] of rows) { const div = el("div"); put(div, el("dt", {}, k), el("dd", {}, String(v))); put(totalsEl, div); }
        if (summary && summary.migrated === false) put(totalsEl, el("div", {}, "Review storage is not set up yet (migration 017)."));
    }
    async function refreshTotals() { try { renderTotals(await api("review-summary")); } catch { /* totals are informational */ } }

    function renderAlbumList() {
        for (const ul of Object.values(lists)) ul.replaceChildren();
        for (const a of albums) {
            const decided = a.decisions.import + a.decisions.skip + a.decisions.later;
            const reviewable = Math.max(0, a.count - a.imported);
            const progress = a.kind === "branding" ? "never imported" : `${Math.min(decided, reviewable)}/${reviewable} reviewed`;
            const btn = el("button", {
                type: "button", class: "rv-row", "data-album": a.id,
                "aria-label": `${a.name}: ${a.count} photos, ${progress}${a.imported ? `, ${a.imported} already on the website` : ""}`,
            });
            put(btn, el("span", { class: "rv-row-name" }, a.name));
            const meta = el("span", { class: "rv-row-meta" });
            put(meta, el("span", {}, `${a.count} photo${a.count === 1 ? "" : "s"}`), el("span", {}, progress));
            if (a.imported) put(meta, el("span", {}, `${a.imported} on website`));
            put(btn, meta);
            if (a.kind !== "branding" && reviewable) {
                put(btn, el("progress", { class: "rv-row-progress", max: String(reviewable), value: String(Math.min(decided, reviewable)), "aria-hidden": "true" }));
            }
            if (current?.id === a.id) btn.setAttribute("aria-current", "true");
            btn.addEventListener("click", () => void openAlbum(a));
            const li = el("li"); put(li, btn);
            put((lists[a.kind] || lists.project), li);
        }
    }

    function compareOptions(a: Album) {
        compareEl.replaceChildren();
        const add = (value: string, label: string, parent: unknown = compareEl) => put(parent, el("option", { value }, label));
        add("none", "Nothing (just review)");
        add("all", "All website galleries (slower)");
        const suggested = el("optgroup", { label: "Suggested" });
        for (const t of a.suggested) add(t.value, `${t.name} — ${t.prefix || t.category}`, suggested);
        if (a.suggested.length) put(compareEl, suggested);
        const byCat = new Map<string, Target[]>();
        for (const g of galleries) { const k = g.category || "other"; (byCat.get(k) || byCat.set(k, []).get(k)!).push(g); }
        for (const [cat, list] of [...byCat].sort()) {
            const og = el("optgroup", { label: cat });
            for (const g of list.sort((x, y) => x.name.localeCompare(y.name))) add(g.value, `${g.name}${g.source === "facebook" ? " (Facebook project)" : ""}`, og);
            put(compareEl, og);
        }
        const mapped = a.mapping?.prefix ? `manual:${a.mapping.prefix}` : a.mapping ? `project:${a.mapping.projectId}` : null;
        const preferred = readStore()[a.id] || mapped || a.suggested[0]?.value || (a.kind === "generic" ? "all" : "none");
        compareEl.value = [...compareEl.options].some((o) => o.value === preferred) ? preferred : "none";
    }

    function badge(text: string, cls = "") { return el("span", { class: `rv-badge ${cls}`.trim() }, text); }

    function renderPhoto(p: Photo) {
        const li = el("li", { class: "rv-card", "data-photo": p.id, "data-decision": p.decision || "" });
        put(li, retryingImg({ src: fbImage(p.id), alt: `Facebook photo ${p.id}`, loading: "lazy" }));
        const badges = el("div", { class: "rv-badges" });
        if (p.createdTime) put(badges, badge(p.createdTime.slice(0, 10)));
        if (p.state === "imported") put(badges, badge("Already on website"));
        else if (p.state === "hidden") put(badges, badge("Imported, hidden"));
        else if (p.state) put(badges, badge(p.state));
        const m = matches.get(p.id);
        if (m) put(badges, badge(m.level === "likely" ? `Likely duplicate (${m.distance})` : `Possible match (${m.distance})`, `rv-badge--${m.level}`));
        put(li, badges);
        if (m) {
            const s = site.find((x) => x.id === m.id);
            if (s) {
                const jump = el("button", { type: "button", class: "rv-match", title: "Show the matching website photo" });
                put(jump, el("img", { src: s.src, alt: "" }), el("span", {}, s.label));
                jump.addEventListener("click", () => {
                    const target = siteGrid.querySelector<HTMLElement>(`[data-site="${CSS.escape(s.id)}"]`);
                    siteGrid.querySelectorAll(".rv-highlight").forEach((n) => n.classList.remove("rv-highlight"));
                    target?.classList.add("rv-highlight");
                    target?.scrollIntoView({ behavior: "smooth", block: "center" });
                });
                put(li, jump);
            }
        }
        const locked = current?.kind === "branding" || p.state === "imported" || p.state === "hidden";
        if (!locked) {
            const actions = el("div", { class: "rv-actions", role: "group", "aria-label": `Decision for photo ${p.id}` });
            const choices: [Decision, string][] = [["skip", "Duplicate / Skip"], ["import", "Import"], ["later", "Review later"]];
            for (const [value, label] of choices) {
                const b = el("button", { type: "button", class: "btn-small", "aria-pressed": String(p.decision === value) }, label);
                b.addEventListener("click", () => setDecision(p, p.decision === value ? null : value));
                put(actions, b);
            }
            put(li, actions);
        }
        return li;
    }

    function renderPhotos() { fbGrid.replaceChildren(...photos.map(renderPhoto)); }
    function rerenderPhoto(p: Photo) {
        const old = fbGrid.querySelector(`[data-photo="${CSS.escape(p.id)}"]`);
        if (old) old.replaceWith(renderPhoto(p));
    }
    function renderSite() {
        siteGrid.replaceChildren(...site.map((s) => {
            const li = el("li", { class: "rv-card", "data-site": s.id });
            put(li, retryingImg({ src: s.src, alt: s.label, loading: "lazy" }), el("span", { class: "rv-site-label" }, s.label));
            return li;
        }));
    }

    // --- decisions -------------------------------------------------------------
    function setDecision(p: Photo, decision: Decision | null, duplicateOf?: string | null) {
        if (!current) return;
        const before = p.decision;
        p.decision = decision;
        p.duplicateOf = decision === "skip" ? (duplicateOf ?? siteDuplicateOf(p)) : null;
        bumpAlbumCount(before, decision);
        rerenderPhoto(p);
        pending.set(p.id, { photoId: p.id, albumId: current.id, decision: decision || "clear", duplicateOf: p.duplicateOf });
        clearTimeout(saveTimer);
        saveTimer = window.setTimeout(() => void flush(), 300);
    }
    function siteDuplicateOf(p: Photo) {
        const m = matches.get(p.id);
        return m ? site.find((s) => s.id === m.id)?.duplicateOf ?? null : null;
    }
    function bumpAlbumCount(before: Decision | null, after: Decision | null) {
        if (!current) return;
        if (before) current.decisions[before] = Math.max(0, current.decisions[before] - 1);
        if (after) current.decisions[after]++;
        renderAlbumList();
    }
    async function flush() {
        if (!pending.size) return;
        const batch = [...pending.values()].slice(0, 100);
        for (const d of batch) pending.delete(d.photoId);
        setStatus(`Saving ${batch.length} decision${batch.length === 1 ? "" : "s"}…`);
        try {
            await api("review-decisions", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ decisions: batch }) });
            setStatus(pending.size ? "Saving…" : "All decisions saved.");
            void refreshTotals();
        } catch (e) {
            for (const d of batch) if (!pending.has(d.photoId)) pending.set(d.photoId, d);
            setStatus(`Not saved: ${(e as Error).message}. Retrying in 5 seconds.`);
            saveTimer = window.setTimeout(() => void flush(), 5000);
            return;
        }
        if (pending.size) void flush();
    }
    window.addEventListener("beforeunload", (e) => { if (pending.size) { e.preventDefault(); } });

    function armBulk(button: HTMLButtonElement, run: () => number, verb: string) {
        let armed = 0;
        let timer: number | undefined;
        const label = button.textContent || "";
        button.addEventListener("click", () => {
            if (!armed) {
                armed = countBulk(verb);
                if (!armed) { setStatus("No unreviewed photos match."); return; }
                button.textContent = `Click again to confirm (${armed} photos)`;
                timer = window.setTimeout(() => { armed = 0; button.textContent = label; }, 4000);
                return;
            }
            clearTimeout(timer);
            armed = 0;
            button.textContent = label;
            setStatus(`${run()} photos marked.`);
        });
    }
    const reviewable = () => current && current.kind !== "branding" ? photos.filter((p) => !p.decision && !p.state) : [];
    const countBulk = (verb: string) => verb === "dupes" ? reviewable().filter((p) => matches.get(p.id)?.level === "likely").length : reviewable().length;
    armBulk($("rv-bulk-dupes"), () => { const l = reviewable().filter((p) => matches.get(p.id)?.level === "likely"); l.forEach((p) => setDecision(p, "skip")); return l.length; }, "dupes");
    armBulk($("rv-bulk-import"), () => { const l = reviewable(); l.forEach((p) => setDecision(p, "import")); return l.length; }, "import");
    armBulk($("rv-bulk-later"), () => { const l = reviewable(); l.forEach((p) => setDecision(p, "later")); return l.length; }, "later");

    // --- loading ---------------------------------------------------------------
    async function loadSite(value: string): Promise<SiteItem[]> {
        if (value === "none") return [];
        let path = "";
        if (value === "all") path = "review-site-gallery?all=1";
        else if (value.startsWith("manual:")) path = `review-site-gallery?prefix=${encodeURIComponent(value.slice(7))}`;
        else if (value.startsWith("project:")) {
            const g = galleries.find((x) => x.value === value);
            path = g?.prefix ? `review-site-gallery?prefix=${encodeURIComponent(g.prefix)}` : `review-site-gallery?project=${encodeURIComponent(value.slice(8))}`;
        }
        if (!path) return [];
        const data = await api(path);
        return (data.items || []).map((i: any) => i.facebookPhotoId
            ? { id: `facebook:${i.facebookPhotoId}`, label: `Facebook ${i.facebookPhotoId}`, src: `${API}/photo-file?id=${encodeURIComponent(i.facebookPhotoId)}`, duplicateOf: `facebook:${i.facebookPhotoId}` }
            : { id: i.key, label: i.key, src: `${API}/review-site-image?key=${encodeURIComponent(i.key)}`, duplicateOf: i.key });
    }

    async function compare(gen: number) {
        matches.clear();
        renderPhotos();
        if (!site.length) { progressEl.textContent = "No website gallery selected."; return; }
        await hashAll(site.map((s) => s.src), gen, "website photos");
        await hashAll(photos.map((p) => fbImage(p.id)), gen, "Facebook photos");
        if (gen !== generation) return;
        const candidates = site.map((s) => ({ id: s.id, hash: hashes.get(s.src) })).filter((c) => c.hash) as { id: string; hash: string }[];
        let likely = 0, possible = 0, failed = 0;
        for (const p of photos) {
            const h = hashes.get(fbImage(p.id));
            if (!h) { failed++; continue; }
            const m = bestMatch(h, candidates) as Match | null;
            matches.set(p.id, m);
            if (m?.level === "likely") likely++; else if (m) possible++;
        }
        renderPhotos();
        progressEl.textContent = `${likely} likely duplicate${likely === 1 ? "" : "s"}, ${possible} possible match${possible === 1 ? "" : "es"}` +
            `${failed ? `, ${failed} photo${failed === 1 ? "" : "s"} could not be fingerprinted` : ""}. Fingerprints are a hint: look before deciding.`;
    }

    async function openAlbum(a: Album) {
        const gen = ++generation;
        current = a;
        renderAlbumList();
        emptyEl.hidden = true;
        albumEl.hidden = false;
        // Single-column (phone) layout: bring the workspace into view.
        if (window.matchMedia("(max-width: 860px)").matches) albumEl.scrollIntoView({ behavior: "smooth", block: "start" });
        titleEl.textContent = a.name;
        noteEl.textContent = a.kind === "branding" ? "Branding photos are never imported."
            : a.kind === "generic" ? "Unsorted album: compare with all galleries. Photos marked Import are assigned to a project in the import step."
            : `${a.count} photos. ${a.imported} already on the website.`;
        compareOptions(a);
        photos = []; site = []; matches.clear();
        fbGrid.replaceChildren(); siteGrid.replaceChildren();
        progressEl.textContent = "Loading photos…";
        try {
            let after: string | null = null;
            do {
                const data: any = await api(`review-album?id=${encodeURIComponent(a.id)}${after ? `&after=${encodeURIComponent(after)}` : ""}`);
                if (gen !== generation) return;
                photos.push(...data.photos);
                after = data.next;
                progressEl.textContent = `Loaded ${photos.length} photos…`;
            } while (after);
            renderPhotos();
            site = await loadSite(compareEl.value);
            if (gen !== generation) return;
            renderSite();
            await compare(gen);
        } catch (e) {
            progressEl.textContent = `Could not load this album: ${(e as Error).message}`;
        }
    }

    compareEl.addEventListener("change", async () => {
        if (!current) return;
        writeStore(current.id, compareEl.value);
        const gen = ++generation;
        try {
            site = await loadSite(compareEl.value);
            if (gen !== generation) return;
            renderSite();
            await compare(gen);
        } catch (e) {
            progressEl.textContent = `Could not load the website gallery: ${(e as Error).message}`;
        }
    });

    try {
        const [data, summary] = await Promise.all([api("review-albums"), api("review-summary")]);
        albums = data.albums || [];
        galleries = data.galleries || [];
        renderAlbumList();
        renderTotals(summary);
        setStatus(`${albums.length} albums. Pick one to start.${data.historicalImportEnabled ? "" : " Historical import is currently switched off."}`);
    } catch (e) {
        setStatus(`Could not load albums: ${(e as Error).message}`);
    }
}
