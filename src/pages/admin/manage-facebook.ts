// Facebook galleries inside Manage Images. They are D1 projects whose files
// sit flat under Facebook/ in R2, so they are managed only through the
// existing Facebook admin API (overview, photos, photo-update, purge), never
// through the manual R2 folder endpoints. Untrusted text goes in textContent.
import {
    PURGE_PHRASE, PURGE_BATCH, UPDATE_BATCH, actionTargets, chunk, facebookGalleries,
    matchesSearch, moveTargets, photoState, purgeConfirmed, safeAdminPath,
} from "../../lib/manage-facebook.js";

type Gallery = ReturnType<typeof facebookGalleries>[number];
type Photo = {
    photoId: string; projectId: number | null; hidden: boolean; status: string; caption: string | null;
    createdTime: string | null; removedOnFacebook: boolean; deleted: boolean; deleteAfter: string | null;
    previewUrl: string | null; error: string | null;
};
// appendChild, not append: the Worker types in this project override Element.append.
function put(parent: Node, ...kids: (Node | string)[]) {
    for (const k of kids) parent.appendChild(typeof k === "string" ? document.createTextNode(k) : k);
}


function el<K extends keyof HTMLElementTagNameMap>(tag: K, props: Record<string, unknown> = {}, ...kids: (Node | string)[]): HTMLElementTagNameMap[K] {
    const node: HTMLElementTagNameMap[K] = document.createElement(tag);
    Object.assign(node, props);
    put(node, ...kids);
    return node;
}

export default function initManageFacebook() {
    document.addEventListener("DOMContentLoaded", () => {
        const sectionN = document.getElementById("mf-section");
        const listN = document.getElementById("mf-results") as HTMLUListElement | null;
        const statusN = document.getElementById("mf-status");
        const searchN = document.getElementById("search") as HTMLInputElement | null;
        const refreshN = document.getElementById("refresh");
        if (!sectionN || !listN || !statusN || !searchN || !refreshN) return;
        const section: HTMLElement = sectionN, listEl: HTMLUListElement = listN, statusEl: HTMLElement = statusN;
        const searchEl: HTMLInputElement = searchN, refreshEl: HTMLElement = refreshN;
        const base = (section.dataset.fbApi || "").replace(/\/$/, "");
        if (!base.startsWith("/")) return;

        let overview: any = null;
        let galleries: Gallery[] = [];
        const open = new Set<number>();

        async function api<T>(path: string, body?: unknown): Promise<T> {
            const init: RequestInit = { credentials: "include" };
            if (body !== undefined) {
                init.method = "POST";
                init.headers = { "Content-Type": "application/json" };
                init.body = JSON.stringify(body);
            }
            const res = await fetch(`${base}${path}`, init);
            const data = await res.json().catch(() => ({})) as any;
            if (!res.ok) throw Object.assign(new Error(typeof data?.error === "string" ? data.error : `HTTP ${res.status}`), { status: res.status });
            return data as T;
        }
        const say = (msg: string, kind: "" | "success" | "error" = "") => {
            statusEl.textContent = msg;
            statusEl.classList.toggle("status--success", kind === "success");
            statusEl.classList.toggle("status--error", kind === "error");
        };

        async function load() {
            say("Loading Facebook galleries…");
            try {
                overview = await api("/overview");
            } catch (e: any) {
                // 404: the Facebook integration is switched off; nothing to manage here.
                if (e?.status === 404) { section.hidden = true; return; }
                say(`Could not load Facebook galleries: ${e.message}`, "error");
                return;
            }
            section.hidden = false;
            galleries = facebookGalleries(overview);
            say(galleries.length ? `${galleries.length} Facebook ${galleries.length === 1 ? "gallery" : "galleries"}.` : "No Facebook galleries yet.");
            render();
        }

        function render() {
            listEl.replaceChildren();
            const shown = galleries.filter((g) => matchesSearch(g, searchEl.value));
            if (!shown.length) {
                put(listEl, el("li", { className: "empty", textContent: galleries.length ? "No Facebook galleries match that search." : "No Facebook galleries yet." }));
                return;
            }
            for (const g of shown) put(listEl, card(g));
        }

        function card(g: Gallery) {
            const li = el("li", { className: "result-item mf-gallery" });
            li.dataset.projectId = String(g.id);
            const expand = el("button", { type: "button", className: "expand-btn", textContent: open.has(g.id) ? "▾" : "▸" });
            expand.setAttribute("aria-expanded", String(open.has(g.id)));
            expand.setAttribute("aria-label", `Show photos in ${g.name}`);
            const title = el("div", { className: "item-text" },
                el("span", { className: "result-title", textContent: g.name }), " ",
                el("span", { className: "mf-badge", textContent: g.badge }));
            const meta = el("div", { className: "image-meta", textContent: `${g.category} · ${g.visibleCount} of ${g.photoCount} photos visible · ${g.where}` });
            put(title, meta);
            if (g.publicPath) {
                const link = el("a", { href: g.publicPath, textContent: "View on site", target: "_blank", rel: "noopener" });
                put(meta, " · ", link);
            }
            const settings = el("a", { href: "/admin/facebook", className: "image-meta", textContent: "Gallery settings" });
            const header = el("div", { className: "item-header" }, expand, title, settings);
            const body = el("div", { className: "mf-gallery-body" });
            body.hidden = !open.has(g.id);
            put(li, header, body);
            expand.addEventListener("click", () => {
                const now = !open.has(g.id);
                if (now) open.add(g.id); else open.delete(g.id);
                expand.textContent = now ? "▾" : "▸";
                expand.setAttribute("aria-expanded", String(now));
                body.hidden = !now;
                if (now) void loadPhotos(g, body);
            });
            if (open.has(g.id)) void loadPhotos(g, body);
            return li;
        }

        async function loadPhotos(g: Gallery, body: HTMLElement) {
            body.replaceChildren(el("p", { className: "image-meta", textContent: "Loading photos…" }));
            let photos: Photo[];
            try {
                photos = (await api<{ photos: Photo[] }>(`/photos?projectId=${encodeURIComponent(String(g.id))}`)).photos || [];
            } catch (e: any) {
                body.replaceChildren(el("p", { className: "empty", textContent: `Could not load photos: ${e.message}` }));
                return;
            }
            const grid = el("ul", { className: "mf-photo-grid" });
            const boxes = new Map<string, HTMLInputElement>();
            for (const p of photos) {
                const state = photoState(p);
                const box = el("input", { type: "checkbox", className: "mf-select" });
                box.setAttribute("aria-label", `Select photo ${p.photoId}`);
                box.disabled = state.key === "deleted";
                boxes.set(p.photoId, box);
                const src = safeAdminPath(p.previewUrl);
                const thumb = src ? el("img", { src, alt: p.caption ? p.caption.slice(0, 120) : `Facebook photo ${p.photoId}`, loading: "lazy", decoding: "async" })
                    : el("div", { className: "mf-thumb-missing", textContent: "No file" });
                const label = el("label", { className: `mf-photo mf-photo--${state.key}` }, box, thumb,
                    el("span", { className: "mf-state", textContent: state.label }),
                    el("span", { className: "image-meta", textContent: p.photoId }));
                if (p.error && state.key === "failed") label.title = p.error.slice(0, 300);
                grid.appendChild(el("li", {}, label));
            }
            if (!photos.length) grid.appendChild(el("li", { className: "empty", textContent: "No photos in this gallery." }));

            const selected = () => photos.filter((p) => boxes.get(p.photoId)?.checked);
            const selectAll = el("input", { type: "checkbox" });
            selectAll.addEventListener("change", () => { for (const b of boxes.values()) if (!b.disabled) b.checked = selectAll.checked; });
            const hideBtn = el("button", { type: "button", className: "btn-small", textContent: "Hide" });
            const restoreBtn = el("button", { type: "button", className: "btn-small", textContent: "Restore" });
            const target = el("select", { className: "mf-move-target" });
            target.setAttribute("aria-label", "Move selected photos to");
            target.appendChild(el("option", { value: "", textContent: "Move to…" }));
            for (const t of moveTargets(overview, g.id)) target.appendChild(el("option", { value: String(t.id), textContent: t.label }));
            const moveBtn = el("button", { type: "button", className: "btn-small", textContent: "Move" });
            const phrase = el("input", { type: "text", className: "mf-purge-phrase", placeholder: `Type ${PURGE_PHRASE}`, autocomplete: "off" });
            phrase.setAttribute("aria-label", `Type ${PURGE_PHRASE} to enable permanent deletion`);
            const purgeBtn = el("button", { type: "button", className: "btn-small btn-danger", textContent: "Permanently delete", disabled: true });
            phrase.addEventListener("input", () => { purgeBtn.disabled = !purgeConfirmed(phrase.value); });
            const note = el("p", { className: "image-meta", textContent: "Hide removes a photo from the website and can be undone. Move keeps it in the chosen gallery from now on. Permanent deletion removes the files and cannot be undone." });
            const actions = el("div", { className: "toolbar-actions mf-actions" },
                el("label", {}, selectAll, " Select all"), hideBtn, restoreBtn, target, moveBtn, phrase, purgeBtn);

            const buttons = [hideBtn, restoreBtn, moveBtn, purgeBtn, target, phrase] as (HTMLButtonElement | HTMLInputElement | HTMLSelectElement)[];
            async function run(label: string, ids: string[], send: (batch: string[]) => Promise<number>, batchSize: number) {
                if (!ids.length) { say(`${label}: none of the selected photos can be changed that way.`, "error"); return; }
                for (const b of buttons) b.disabled = true;
                let done = 0;
                let result: [string, "success" | "error"];
                try {
                    for (const batch of chunk(ids, batchSize)) done += await send(batch);
                    result = [`${label}: ${done} of ${ids.length} photo(s) updated.`, done === ids.length ? "success" : "error"];
                } catch (e: any) {
                    result = [`${label} stopped after ${done} photo(s): ${e.message}`, "error"];
                }
                // Reload so counts and states match the server, then show the outcome.
                await load();
                say(...result);
            }
            hideBtn.addEventListener("click", () => run("Hide", actionTargets(selected()).hide,
                async (photoIds) => (await api<{ updated: number }>("/photo-update", { photoIds, hidden: true })).updated, UPDATE_BATCH));
            restoreBtn.addEventListener("click", () => run("Restore", actionTargets(selected()).restore,
                async (photoIds) => (await api<{ updated: number }>("/photo-update", { photoIds, hidden: false })).updated, UPDATE_BATCH));
            moveBtn.addEventListener("click", () => {
                const projectId = Number(target.value);
                if (!Number.isInteger(projectId) || projectId < 1) { say("Choose a gallery to move the photos to.", "error"); return; }
                void run("Move", actionTargets(selected()).move,
                    async (photoIds) => (await api<{ updated: number }>("/photo-update", { photoIds, projectId })).updated, UPDATE_BATCH);
            });
            purgeBtn.addEventListener("click", () => {
                if (!purgeConfirmed(phrase.value)) return;
                const ids = actionTargets(selected()).purge;
                if (!ids.length || !window.confirm(`Permanently delete ${ids.length} photo(s) from the website and storage? This cannot be undone.`)) return;
                void run("Permanent deletion", ids,
                    async (photoIds) => (await api<{ purged: number }>("/purge", { photoIds, confirm: PURGE_PHRASE })).purged, PURGE_BATCH);
            });
            body.replaceChildren(actions, note, grid);
        }

        searchEl.addEventListener("input", render);
        refreshEl.addEventListener("click", () => void load());
        void load();
    });
}
