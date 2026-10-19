type EventCounts = {
    pending: number;
    processing: number;
    retry: number;
    done: number;
    ignored: number;
    failed: number;
};

type Failure = {
    kind: "event" | "photo";
    ref: string;
    attempts: number | null;
    error: string | null;
    updatedAt: string;
};

type FbProject = {
    id: number;
    slug: string;
    name: string;
    kind: "project" | "recent";
    category: string;
    hidden: boolean;
    linkedPrefix: string | null;
    nameLocked: boolean;
    photoCount: number;
    visibleCount: number;
    publicPath: string | null;
};

type ManualProject = { prefix: string; name: string };

type Overview = {
    autoImport: boolean;
    sync: {
        lastEventReceivedAt: string | null;
        lastSuccessAt: string | null;
        lastBackfillAt: string | null;
        backfillCursor: string | null;
        events: EventCounts;
        photos: { imported: number; failed: number; hidden: number; deleted?: number; scheduledForDeletion?: number };
        removedRetentionDays?: number;
        recentFailures: Failure[];
    };
    projects: FbProject[];
    manualProjects: ManualProject[];
};

type FbPhoto = {
    photoId: string;
    postId: string | null;
    projectId: number | null;
    hidden: boolean;
    projectLocked: boolean;
    status: string;
    caption: string | null;
    createdTime: string | null;
    permalink: string | null;
    previewUrl: string | null;
    deleted?: boolean;
    removedOnFacebook?: boolean;
    hiddenReason?: string | null;
    deleteAfter?: string | null;
    publicUrl: string | null;
};

type Health = {
    integrationEnabled: boolean;
    autoImport: boolean;
    graphVersion: string | null;
    pageIdConfigured: boolean;
    appIdConfigured: boolean;
    secrets: { appSecret: boolean; verifyToken: boolean; pageAccessToken: boolean };
    token: "ok" | "wrong-page" | "page-id-missing" | "error" | "untested";
    page: { id: string | null; name: string | null } | null;
    feedSubscribed: boolean | null;
    errors: string[];
};

type BackfillPost = {
    postId: string;
    createdTime: string | null;
    caption: string | null;
    photos: number;
    newPhotos: number;
    project: { name: string; action: string; reason: string } | null;
    ignored: string | null;
};

type BackfillBatch = {
    dryRun: boolean;
    scanned: number;
    withoutPhotos: number;
    oldestCreatedTime: string | null;
    posts: BackfillPost[];
    imported: number;
    skipped: number;
    failed: { postId: string; error: string }[];
    next: string | null;
    complete: boolean;
};

type BackfillReport = {
    batches: number;
    scanned: number;
    withPhotos: number;
    withoutPhotos: number;
    oldest: string | null;
    newest: string | null;
    photos: number;
    newPhotos: number;
    imported: number;
    duplicates: number;
    galleries: Map<string, { name: string; action: string; reason: string; posts: number; photos: number }>;
    recent: number;
    failed: { postId: string; error: string }[];
    done: boolean;
};

type PhotoView = { type: "project"; projectId: number } | { type: "hidden" } | null;

const CATEGORIES: { value: string; label: string }[] = [
    { value: "projects", label: "Projects" },
    { value: "new-construction", label: "New Construction" },
    { value: "remodels", label: "Remodels" },
    { value: "furniture", label: "Furniture" },
];

function escapeHtml(s: string | number | null | undefined): string {
    return String(s ?? "")
        .replaceAll("&", "&amp;")
        .replaceAll("<", "&lt;")
        .replaceAll(">", "&gt;")
        .replaceAll('"', "&quot;")
        .replaceAll("'", "&#39;");
}

function formatDate(value: string | null | undefined): string {
    if (!value) return "Never";
    const d = new Date(value);
    return Number.isNaN(d.getTime()) ? value : d.toLocaleString();
}

/** Only allow http(s) URLs for external links. */
function safeHttpUrl(value: string | null | undefined, base?: string): string | null {
    if (!value) return null;
    try {
        const u = base ? new URL(value, base) : new URL(value);
        return u.protocol === "https:" || u.protocol === "http:" ? u.href : null;
    } catch {
        return null;
    }
}

/** Only allow same-site absolute paths like "/projects/x". */
function safeLocalPath(value: string | null | undefined): string | null {
    if (!value || !value.startsWith("/") || value.startsWith("//")) return null;
    return value;
}

export default function initFacebookPage() {
    document.addEventListener("DOMContentLoaded", () => {
        const rootEl = document.getElementById("fb-root") as HTMLDivElement | null;
        const statusEl = document.getElementById("fb-status") as HTMLDivElement | null;
        const syncEl = document.getElementById("fb-sync") as HTMLDivElement | null;
        const failuresEl = document.getElementById("fb-failures") as HTMLUListElement | null;
        const refreshBtn = document.getElementById("fb-refresh") as HTMLButtonElement | null;
        const retryBtn = document.getElementById("fb-retry") as HTMLButtonElement | null;
        const projectsTbody = document.getElementById("fb-projects-tbody") as HTMLTableSectionElement | null;
        const showHiddenBtn = document.getElementById("fb-show-hidden") as HTMLButtonElement | null;
        const photosLabel = document.getElementById("fb-photos-label") as HTMLParagraphElement | null;
        const photosEl = document.getElementById("fb-photos") as HTMLUListElement | null;
        const bulkEl = document.getElementById("fb-bulk") as HTMLDivElement | null;
        const selectAllEl = document.getElementById("fb-select-all") as HTMLInputElement | null;
        const bulkHideBtn = document.getElementById("fb-bulk-hide") as HTMLButtonElement | null;
        const bulkRestoreBtn = document.getElementById("fb-bulk-restore") as HTMLButtonElement | null;
        const moveTargetEl = document.getElementById("fb-move-target") as HTMLSelectElement | null;
        const bulkMoveBtn = document.getElementById("fb-bulk-move") as HTMLButtonElement | null;
        const newForm = document.getElementById("fb-new-form") as HTMLFormElement | null;
        const newNameEl = document.getElementById("fb-new-name") as HTMLInputElement | null;
        const newCategoryEl = document.getElementById("fb-new-category") as HTMLSelectElement | null;
        const newLinkEl = document.getElementById("fb-new-link") as HTMLSelectElement | null;

        if (
            !rootEl || !statusEl || !syncEl || !failuresEl || !refreshBtn || !retryBtn ||
            !projectsTbody || !showHiddenBtn || !photosLabel || !photosEl || !bulkEl ||
            !selectAllEl || !bulkHideBtn || !bulkRestoreBtn || !moveTargetEl || !bulkMoveBtn ||
            !newForm || !newNameEl || !newCategoryEl || !newLinkEl
        ) {
            console.error("[facebook] Missing one or more DOM elements");
            return;
        }

        const adminApiBase = (rootEl.dataset.adminApi || "").replace(/\/$/, "");
        if (!adminApiBase) {
            statusEl.textContent = "Missing gallery API URL.";
            return;
        }
        const fbBase = `${adminApiBase}/facebook/admin`;
        // previewUrl values are relative to the admin API origin
        const apiOrigin = new URL(adminApiBase, window.location.href).origin + "/";

        let overview: Overview | null = null;
        let photoView: PhotoView = null;
        let statusTimer: number | undefined;

        function flashStatus(
            message: string,
            variant: "info" | "success" | "error" = "info",
            timeoutMs: number = 3000
        ) {
            if (!statusEl) return;
            window.clearTimeout(statusTimer);
            statusEl.textContent = message;
            statusEl.classList.remove("status--success", "status--error");
            if (variant === "success") statusEl.classList.add("status--success");
            if (variant === "error") statusEl.classList.add("status--error");
            if (timeoutMs > 0) {
                statusTimer = window.setTimeout(() => {
                    statusEl.textContent = "";
                    statusEl.classList.remove("status--success", "status--error");
                }, timeoutMs);
            }
        }

        function api<T>(path: string, body?: unknown): Promise<T> {
            return apiUrl<T>(`${fbBase}${path}`, body);
        }

        async function apiUrl<T>(url: string, body?: unknown): Promise<T> {
            const init: RequestInit = { credentials: "include" };
            if (body !== undefined) {
                init.method = "POST";
                init.headers = { "Content-Type": "application/json" };
                init.body = JSON.stringify(body);
            }
            const res = await fetch(url, init);
            const data = (await res.json().catch(() => ({}))) as any;
            if (!res.ok) {
                const msg = typeof data?.error === "string" ? data.error : `HTTP ${res.status}`;
                throw new Error(msg);
            }
            return data as T;
        }

        function errMsg(err: unknown): string {
            return err instanceof Error ? err.message : String(err);
        }

        function projectLabel(p: FbProject): string {
            return p.kind === "recent" ? "Recent Project Updates" : p.name;
        }

        function categoryLabel(value: string): string {
            return CATEGORIES.find((c) => c.value === value)?.label || value;
        }

        // ---------- Overview ----------

        async function loadOverview(): Promise<void> {
            try {
                overview = await api<Overview>("/overview");
                renderSync();
                renderProjects();
                renderMoveTargets();
                renderManualOptions();
            } catch (err) {
                console.error("[facebook] overview error", err);
                flashStatus(`Could not load sync status: ${errMsg(err)}`, "error", 0);
            }
        }

        function renderSync() {
            if (!overview || !syncEl || !failuresEl) return;
            const { autoImport, sync } = overview;
            const e = sync.events;
            const p = sync.photos;

            syncEl.innerHTML = `
                <dl class="fb-stats">
                    <div><dt>Auto-import</dt><dd><span class="fb-badge ${autoImport ? "fb-badge--on" : "fb-badge--off"}">${autoImport ? "On" : "Off"}</span></dd></div>
                    <div><dt>Last event received</dt><dd>${escapeHtml(formatDate(sync.lastEventReceivedAt))}</dd></div>
                    <div><dt>Last successful sync</dt><dd>${escapeHtml(formatDate(sync.lastSuccessAt))}</dd></div>
                    <div><dt>Last backfill</dt><dd>${escapeHtml(formatDate(sync.lastBackfillAt))}${sync.backfillCursor ? " (in progress)" : ""}</dd></div>
                    <div><dt>Events</dt><dd>
                        ${escapeHtml(e.pending)} pending · ${escapeHtml(e.processing)} processing ·
                        ${escapeHtml(e.retry)} retry · ${escapeHtml(e.done)} done ·
                        ${escapeHtml(e.ignored)} ignored · <strong>${escapeHtml(e.failed)} failed</strong>
                    </dd></div>
                    <div><dt>Photos</dt><dd>
                        ${escapeHtml(p.imported)} imported · ${escapeHtml(p.hidden)} hidden ·
                        <strong>${escapeHtml(p.failed)} failed</strong>${p.deleted ? ` · ${escapeHtml(p.deleted)} deleted` : ""}${p.scheduledForDeletion ? ` · ${escapeHtml(p.scheduledForDeletion)} removed on Facebook (deleted after ${escapeHtml(sync.removedRetentionDays ?? 30)} days unless the post returns)` : ""}
                    </dd></div>
                </dl>`;

            const failures = sync.recentFailures || [];
            if (!failures.length) {
                failuresEl.innerHTML = `<li class="empty">No recent failures.</li>`;
                return;
            }
            failuresEl.innerHTML = failures
                .map(
                    (f) => `
                <li class="fb-failure">
                    <div><strong>${escapeHtml(f.kind === "photo" ? "Photo" : "Event")}</strong>
                        <code>${escapeHtml(f.ref)}</code></div>
                    <div class="hint">${escapeHtml(formatDate(f.updatedAt))}${
                        f.attempts != null ? ` · ${escapeHtml(f.attempts)} attempt(s)` : ""
                    }</div>
                    ${f.error ? `<div class="fb-failure-error">${escapeHtml(f.error)}</div>` : ""}
                </li>`
                )
                .join("");
        }

        function renderProjects() {
            if (!overview || !projectsTbody) return;
            const projects = overview.projects || [];
            projectsTbody.innerHTML = "";

            if (!projects.length) {
                projectsTbody.innerHTML = `<tr><td colspan="5" class="empty">No Facebook projects yet.</td></tr>`;
                return;
            }

            for (const p of projects) {
                const tr = document.createElement("tr");
                tr.dataset.id = String(p.id);
                if (photoView?.type === "project" && photoView.projectId === p.id) {
                    tr.classList.add("fb-row--active");
                }

                const publicPath = safeLocalPath(p.publicPath);
                const linkedNote = p.linkedPrefix
                    ? `<small class="hint">Merged into ${escapeHtml(p.linkedPrefix)}</small>`
                    : "";
                const viewLink = publicPath
                    ? `<a href="${escapeHtml(publicPath)}" target="_blank" rel="noopener noreferrer" class="fb-link">${escapeHtml(publicPath)}</a>`
                    : "";

                const nameCell = document.createElement("td");
                nameCell.dataset.label = "Name";
                nameCell.innerHTML = `
                    <div class="fb-name-display">
                        <strong>${escapeHtml(projectLabel(p))}</strong>
                        <span class="fb-badge fb-badge--fb">Facebook</span>
                        ${p.nameLocked ? `<span class="fb-badge">Renamed</span>` : ""}
                    </div>
                    <div class="fb-rename" hidden>
                        <input type="text" class="admin-input js-rename-input" maxlength="120"
                               aria-label="Project name" value="${escapeHtml(p.name)}" />
                        <button type="button" class="admin-button-sm js-rename-save">Save</button>
                        <button type="button" class="admin-button-sm js-rename-cancel">Cancel</button>
                    </div>
                    ${linkedNote}
                    ${viewLink}`;

                const catCell = document.createElement("td");
                catCell.dataset.label = "Category";
                if (p.linkedPrefix) {
                    // category follows the existing gallery it is merged into
                    catCell.textContent = categoryLabel(p.category);
                } else {
                    const opts = CATEGORIES.map(
                        (c) =>
                            `<option value="${escapeHtml(c.value)}"${c.value === p.category ? " selected" : ""}>${escapeHtml(c.label)}</option>`
                    ).join("");
                    catCell.innerHTML = `<select class="admin-input fb-select js-category" aria-label="Category">${opts}</select>`;
                }

                const photosCell = document.createElement("td");
                photosCell.dataset.label = "Photos";
                photosCell.textContent = `${p.visibleCount} / ${p.photoCount}`;

                const statusCell = document.createElement("td");
                statusCell.dataset.label = "Status";
                statusCell.innerHTML = p.hidden
                    ? `<span class="fb-badge fb-badge--off">Hidden</span>`
                    : `<span class="fb-badge fb-badge--on">Visible</span>`;

                const actionsCell = document.createElement("td");
                actionsCell.dataset.label = "Actions";
                actionsCell.className = "fb-actions";
                actionsCell.innerHTML = `
                    <button type="button" class="admin-button-sm js-view">View photos</button>
                    <button type="button" class="admin-button-sm js-rename">Rename</button>
                    <button type="button" class="admin-button-sm js-toggle-hidden${p.hidden ? "" : " admin-button-danger"}">${p.hidden ? "Restore" : "Hide"}</button>`;

                for (const cell of [nameCell, catCell, photosCell, statusCell, actionsCell]) tr.appendChild(cell);
                projectsTbody.appendChild(tr);
            }
        }

        function renderMoveTargets() {
            if (!overview || !moveTargetEl) return;
            const opts = (overview.projects || []).map((p) => {
                const suffix = p.linkedPrefix ? ` (→ ${p.linkedPrefix})` : "";
                const hidden = p.hidden ? " [hidden]" : "";
                return `<option value="${escapeHtml(p.id)}">${escapeHtml(projectLabel(p) + suffix + hidden)}</option>`;
            });
            moveTargetEl.innerHTML = `<option value="">Move to…</option>${opts.join("")}`;
        }

        function renderManualOptions() {
            if (!overview || !newLinkEl) return;
            const current = newLinkEl.value;
            const opts = (overview.manualProjects || []).map(
                (m) => `<option value="${escapeHtml(m.prefix)}">${escapeHtml(m.name)} (${escapeHtml(m.prefix)})</option>`
            );
            newLinkEl.innerHTML = `<option value="">— None (new gallery) —</option>${opts.join("")}`;
            newLinkEl.value = current;
        }

        function findProject(id: number): FbProject | undefined {
            return overview?.projects.find((p) => p.id === id);
        }

        async function updateProject(body: {
            projectId: number;
            name?: string;
            hidden?: boolean;
            category?: string;
        }, successMsg: string) {
            try {
                await api("/project-update", body);
                flashStatus(successMsg, "success");
                await loadOverview();
            } catch (err) {
                console.error("[facebook] project-update error", err);
                flashStatus(`Update failed: ${errMsg(err)}`, "error", 5000);
                renderProjects(); // reset any half-edited controls
            }
        }

        // ---------- Photos ----------

        async function loadPhotos(view: Exclude<PhotoView, null>) {
            if (!photosEl || !photosLabel || !bulkEl || !selectAllEl) return;
            photoView = view;
            renderProjects(); // update active row highlight

            let query: string;
            if (view.type === "hidden") {
                photosLabel.textContent = "All hidden photos";
                query = "?hidden=1";
            } else {
                const p = findProject(view.projectId);
                photosLabel.textContent = p ? `Photos in “${projectLabel(p)}”` : "Photos";
                query = `?projectId=${encodeURIComponent(String(view.projectId))}`;
            }

            photosEl.innerHTML = `<li class="empty">Loading photos…</li>`;
            selectAllEl.checked = false;

            try {
                const data = await api<{ photos: FbPhoto[] }>(`/photos${query}`);
                renderPhotos(Array.isArray(data.photos) ? data.photos : []);
            } catch (err) {
                console.error("[facebook] photos error", err);
                photosEl.innerHTML = `<li class="empty">Error loading photos: ${escapeHtml(errMsg(err))}</li>`;
                bulkEl.hidden = true;
            }
        }

        function renderPhotos(photos: FbPhoto[]) {
            if (!photosEl || !bulkEl) return;
            photosEl.innerHTML = "";

            if (!photos.length) {
                photosEl.innerHTML = `<li class="empty">No photos here.</li>`;
                bulkEl.hidden = true;
                return;
            }
            bulkEl.hidden = false;

            for (const ph of photos) {
                const li = document.createElement("li");
                li.className = "fb-photo" + (ph.hidden ? " fb-photo--hidden" : "");

                const src = safeHttpUrl(ph.previewUrl, apiOrigin);
                const permalink = safeHttpUrl(ph.permalink);
                const caption = (ph.caption || "").trim();
                const snippet = caption.length > 90 ? caption.slice(0, 90) + "…" : caption;
                const owner = ph.projectId != null ? findProject(ph.projectId) : undefined;
                const showOwner = photoView?.type === "hidden" && owner;

                li.innerHTML = `
                    <label class="fb-photo-select">
                        <input type="checkbox" class="select-checkbox js-photo-check"
                               data-photo-id="${escapeHtml(ph.photoId)}" aria-label="Select photo" />
                        ${src
                            ? `<img src="${escapeHtml(src)}" alt="${escapeHtml(snippet || "Facebook photo")}" loading="lazy" class="fb-thumb" />`
                            : `<span class="fb-thumb fb-thumb--missing">No preview</span>`}
                    </label>
                    <div class="fb-photo-meta">
                        ${ph.deleted
                            ? `<span class="fb-badge fb-badge--off">Deleted</span>`
                            : ph.hidden ? `<span class="fb-badge fb-badge--off">Hidden</span>` : ""}
                        ${!ph.deleted && ph.removedOnFacebook ? `<span class="fb-badge fb-badge--off">Removed on Facebook</span>` : ""}
                        ${!ph.deleted && ph.deleteAfter ? `<div class="hint">Deletes ${escapeHtml(formatDate(ph.deleteAfter))} unless the post is back on Facebook</div>` : ""}
                        ${ph.status && ph.status !== "imported" ? `<span class="fb-badge">${escapeHtml(ph.status)}</span>` : ""}
                        ${ph.projectLocked ? `<span class="fb-badge">Moved</span>` : ""}
                        <div class="hint">${escapeHtml(ph.createdTime ? formatDate(ph.createdTime) : "")}</div>
                        ${showOwner ? `<div class="hint">${escapeHtml(projectLabel(owner))}</div>` : ""}
                        ${snippet ? `<div class="fb-caption">${escapeHtml(snippet)}</div>` : ""}
                        ${permalink
                            ? `<a href="${escapeHtml(permalink)}" target="_blank" rel="noopener noreferrer" class="fb-link">View on Facebook</a>`
                            : ""}
                    </div>`;
                photosEl.appendChild(li);
            }
        }

        function selectedPhotoIds(): string[] {
            if (!photosEl) return [];
            return Array.from(photosEl.querySelectorAll<HTMLInputElement>(".js-photo-check:checked"))
                .map((cb) => cb.dataset.photoId || "")
                .filter(Boolean);
        }

        async function bulkUpdate(
            extra: { hidden?: boolean; projectId?: number },
            btn: HTMLButtonElement,
            verb: string
        ) {
            const photoIds = selectedPhotoIds();
            if (!photoIds.length) {
                flashStatus("Select at least one photo first.", "error");
                return;
            }
            btn.disabled = true;
            try {
                const res = await api<{ ok: boolean; updated: number; skipped?: number }>("/photo-update", { photoIds, ...extra });
                const skippedNote = extra.hidden === false && res.skipped
                    ? ` ${res.skipped} not restored: removed on Facebook or deleted (they return only if the post is back on Facebook).`
                    : "";
                flashStatus(`${verb} ${res.updated ?? photoIds.length} photo(s).${skippedNote}`, skippedNote ? "info" : "success", skippedNote ? 8000 : 3000);
                await loadOverview();
                if (photoView) await loadPhotos(photoView);
            } catch (err) {
                console.error("[facebook] photo-update error", err);
                flashStatus(`Update failed: ${errMsg(err)}`, "error", 5000);
            } finally {
                btn.disabled = false;
            }
        }

        // ---------- Events ----------

        refreshBtn.addEventListener("click", async () => {
            await loadOverview();
            if (photoView) await loadPhotos(photoView);
            flashStatus("Refreshed.", "success");
        });

        retryBtn.addEventListener("click", async () => {
            retryBtn.disabled = true;
            try {
                const res = await api<{ requeuedEvents: number; requeuedPhotos: number }>("/retry", {});
                flashStatus(
                    `Requeued ${res.requeuedEvents ?? 0} event(s) and ${res.requeuedPhotos ?? 0} photo(s).`,
                    "success",
                    4000
                );
                await loadOverview();
            } catch (err) {
                console.error("[facebook] retry error", err);
                flashStatus(`Retry failed: ${errMsg(err)}`, "error", 5000);
            } finally {
                retryBtn.disabled = false;
            }
        });

        showHiddenBtn.addEventListener("click", () => {
            void loadPhotos({ type: "hidden" });
        });

        projectsTbody.addEventListener("click", (ev) => {
            const target = ev.target as HTMLElement | null;
            if (!target) return;
            const btn = target.closest("button");
            if (!btn) return;
            const tr = btn.closest("tr") as HTMLTableRowElement | null;
            const id = Number(tr?.dataset.id);
            if (!tr || !Number.isFinite(id)) return;
            const project = findProject(id);
            if (!project) return;

            const display = tr.querySelector<HTMLDivElement>(".fb-name-display");
            const editor = tr.querySelector<HTMLDivElement>(".fb-rename");
            const input = tr.querySelector<HTMLInputElement>(".js-rename-input");

            if (btn.classList.contains("js-view")) {
                void loadPhotos({ type: "project", projectId: id });
                document.getElementById("fb-photos-heading")?.scrollIntoView({ behavior: "smooth", block: "start" });
            } else if (btn.classList.contains("js-rename")) {
                if (!display || !editor || !input) return;
                display.hidden = true;
                editor.hidden = false;
                input.focus();
                input.select();
            } else if (btn.classList.contains("js-rename-cancel")) {
                if (!display || !editor || !input) return;
                input.value = project.name;
                editor.hidden = true;
                display.hidden = false;
            } else if (btn.classList.contains("js-rename-save")) {
                if (!input) return;
                const name = input.value.trim();
                if (!name) {
                    flashStatus("Name cannot be empty.", "error");
                    return;
                }
                if (name === project.name) {
                    if (editor && display) {
                        editor.hidden = true;
                        display.hidden = false;
                    }
                    return;
                }
                btn.setAttribute("disabled", "");
                void updateProject({ projectId: id, name }, "Project renamed.");
            } else if (btn.classList.contains("js-toggle-hidden")) {
                btn.setAttribute("disabled", "");
                const hidden = !project.hidden;
                void updateProject(
                    { projectId: id, hidden },
                    hidden ? "Project hidden from the website." : "Project restored."
                );
            }
        });

        projectsTbody.addEventListener("keydown", (ev) => {
            const target = ev.target as HTMLElement | null;
            if (!target?.classList.contains("js-rename-input")) return;
            const tr = target.closest("tr");
            if (ev.key === "Enter") {
                ev.preventDefault();
                tr?.querySelector<HTMLButtonElement>(".js-rename-save")?.click();
            } else if (ev.key === "Escape") {
                tr?.querySelector<HTMLButtonElement>(".js-rename-cancel")?.click();
            }
        });

        projectsTbody.addEventListener("change", (ev) => {
            const target = ev.target as HTMLElement | null;
            if (!(target instanceof HTMLSelectElement) || !target.classList.contains("js-category")) return;
            const id = Number(target.closest("tr")?.dataset.id);
            if (!Number.isFinite(id)) return;
            target.disabled = true;
            void updateProject(
                { projectId: id, category: target.value },
                `Category changed to ${categoryLabel(target.value)}.`
            );
        });

        selectAllEl.addEventListener("change", () => {
            photosEl
                .querySelectorAll<HTMLInputElement>(".js-photo-check")
                .forEach((cb) => (cb.checked = selectAllEl.checked));
        });

        bulkHideBtn.addEventListener("click", () => void bulkUpdate({ hidden: true }, bulkHideBtn, "Hid"));
        bulkRestoreBtn.addEventListener("click", () => void bulkUpdate({ hidden: false }, bulkRestoreBtn, "Restored"));
        const bulkDeleteBtn = document.getElementById("fb-bulk-delete") as HTMLButtonElement | null;
        bulkDeleteBtn?.addEventListener("click", async () => {
            const photoIds = selectedPhotoIds();
            if (!photoIds.length) {
                flashStatus("Select at least one photo first.", "error");
                return;
            }
            const ok = window.confirm(
                `Permanently delete ${photoIds.length} photo(s) and their captions from the website and private storage?

` +
                "This cannot be undone and the photos will not be imported again. Use Hide instead if you may want them back."
            );
            if (!ok) return;
            bulkDeleteBtn.disabled = true;
            try {
                // The API takes at most 50 photos per call.
                let purged = 0;
                let failed = 0;
                for (let i = 0; i < photoIds.length; i += 50) {
                    const res = await api<{ purged: number; failed?: number }>("/purge", {
                        photoIds: photoIds.slice(i, i + 50),
                        confirm: "PERMANENTLY DELETE",
                    });
                    purged += res.purged || 0;
                    failed += res.failed || 0;
                }
                flashStatus(
                    failed ? `Deleted ${purged} photo(s); ${failed} failed — try again.` : `Permanently deleted ${purged} photo(s).`,
                    failed ? "error" : "success",
                    6000
                );
                await loadOverview();
                if (photoView) await loadPhotos(photoView);
            } catch (err) {
                flashStatus(`Delete failed: ${errMsg(err)}`, "error", 6000);
            } finally {
                bulkDeleteBtn.disabled = false;
            }
        });

        bulkMoveBtn.addEventListener("click", () => {
            const projectId = Number(moveTargetEl.value);
            if (!moveTargetEl.value || !Number.isFinite(projectId)) {
                flashStatus("Choose a project to move the photos to.", "error");
                return;
            }
            void bulkUpdate({ projectId }, bulkMoveBtn, "Moved");
        });

        // when merging into an existing gallery, category comes from that gallery
        newLinkEl.addEventListener("change", () => {
            newCategoryEl.disabled = !!newLinkEl.value;
        });

        newForm.addEventListener("submit", async (ev) => {
            ev.preventDefault();
            const name = newNameEl.value.trim();
            if (!name) {
                flashStatus("Enter a project name.", "error");
                return;
            }
            const body: { name: string; category?: string; linkedPrefix?: string } = { name };
            if (newLinkEl.value) body.linkedPrefix = newLinkEl.value;
            else body.category = newCategoryEl.value;

            const submitBtn = newForm.querySelector<HTMLButtonElement>('button[type="submit"]');
            if (submitBtn) submitBtn.disabled = true;
            try {
                await api("/project-create", body);
                flashStatus(`Created project “${name}”.`, "success");
                newForm.reset();
                newCategoryEl.disabled = false;
                await loadOverview();
            } catch (err) {
                console.error("[facebook] project-create error", err);
                flashStatus(`Create failed: ${errMsg(err)}`, "error", 5000);
            } finally {
                if (submitBtn) submitBtn.disabled = false;
            }
        });

        // ---------- Connection ----------

        const healthEl = document.getElementById("fb-health") as HTMLDivElement | null;
        const healthBtn = document.getElementById("fb-health-check") as HTMLButtonElement | null;
        const subscribeBtn = document.getElementById("fb-subscribe") as HTMLButtonElement | null;

        const yesNo = (ok: boolean | null | undefined, yes = "Yes", no = "No") =>
            `<span class="fb-badge ${ok ? "fb-badge--on" : "fb-badge--off"}">${ok ? yes : no}</span>`;

        async function checkHealth() {
            if (!healthEl || !healthBtn || !subscribeBtn) return;
            healthBtn.disabled = true;
            try {
                const h = await api<Health>("/health");
                const tokenText: Record<Health["token"], string> = {
                    "page-id-missing": "Working, but FB_PAGE_ID is not set",
                    ok: "Working",
                    "wrong-page": "Belongs to a different Page",
                    error: "Rejected by Facebook",
                    untested: "Not configured",
                };
                healthEl.innerHTML = `
                    <dl class="fb-stats">
                        <div><dt>Page</dt><dd>${escapeHtml(h.page?.name || (h.pageIdConfigured ? "Configured" : "FB_PAGE_ID not set"))}</dd></div>
                        <div><dt>Page token</dt><dd>${yesNo(h.token === "ok", "Working", escapeHtml(tokenText[h.token]))}</dd></div>
                        <div><dt>Webhook feed subscription</dt><dd>${h.feedSubscribed === null ? "Unknown" : yesNo(h.feedSubscribed, "Subscribed", "Not subscribed")}</dd></div>
                        <div><dt>Secrets set</dt><dd>
                            App secret ${yesNo(h.secrets.appSecret)} · Verify token ${yesNo(h.secrets.verifyToken)} · Page token ${yesNo(h.secrets.pageAccessToken)}
                        </dd></div>
                        <div><dt>Auto-import</dt><dd>${yesNo(h.autoImport, "On", "Off")}</dd></div>
                        <div><dt>Graph API</dt><dd>${escapeHtml(h.graphVersion || "—")}</dd></div>
                    </dl>
                    ${h.errors.length ? `<ul class="fb-failures">${h.errors.map((e) => `<li class="fb-failure"><div class="fb-failure-error">${escapeHtml(e)}</div></li>`).join("")}</ul>` : ""}`;
                subscribeBtn.hidden = !(h.token === "ok" && h.feedSubscribed === false);
            } catch (err) {
                healthEl.innerHTML = `<p class="fb-failure-error">${escapeHtml(errMsg(err))}</p>`;
            } finally {
                healthBtn.disabled = false;
            }
        }

        healthBtn?.addEventListener("click", () => void checkHealth());
        subscribeBtn?.addEventListener("click", async () => {
            if (!window.confirm("Subscribe the Facebook Page so new posts are sent to the website?")) return;
            subscribeBtn.disabled = true;
            try {
                await api("/subscribe", { confirm: "SUBSCRIBE FEED" });
                flashStatus("Page subscribed to feed updates.", "success", 4000);
                await checkHealth();
            } catch (err) {
                flashStatus(`Subscribe failed: ${errMsg(err)}`, "error", 6000);
            } finally {
                subscribeBtn.disabled = false;
            }
        });

        // ---------- Historical import ----------

        const backfillEl = document.getElementById("fb-backfill") as HTMLDivElement | null;
        const dryBtn = document.getElementById("fb-backfill-dry") as HTMLButtonElement | null;
        const runBtn = document.getElementById("fb-backfill-run") as HTMLButtonElement | null;
        const stopBtn = document.getElementById("fb-backfill-stop") as HTMLButtonElement | null;
        let stopRequested = false;

        function emptyReport(): BackfillReport {
            return { batches: 0, scanned: 0, withPhotos: 0, withoutPhotos: 0, oldest: null, newest: null,
                photos: 0, newPhotos: 0, imported: 0, duplicates: 0, galleries: new Map(), recent: 0, failed: [], done: false };
        }

        function addBatch(r: BackfillReport, b: BackfillBatch) {
            r.batches++;
            r.scanned += b.scanned || 0;
            r.withoutPhotos += b.withoutPhotos || 0;
            r.imported += b.imported || 0;
            if (b.oldestCreatedTime && (!r.oldest || b.oldestCreatedTime < r.oldest)) r.oldest = b.oldestCreatedTime;
            for (const p of b.posts) {
                if (p.createdTime && (!r.newest || p.createdTime > r.newest)) r.newest = p.createdTime;
                if (p.ignored) continue;
                r.withPhotos++;
                r.photos += p.photos;
                r.newPhotos += p.newPhotos;
                r.duplicates += Math.max(0, p.photos - p.newPhotos);
                if (!p.project) continue;
                if (p.project.action === "recent") r.recent += p.newPhotos;
                else {
                    const key = `${p.project.name}|${p.project.action}`;
                    const g = r.galleries.get(key) || { name: p.project.name, action: p.project.action, reason: p.project.reason, posts: 0, photos: 0 };
                    g.posts++;
                    g.photos += p.newPhotos;
                    r.galleries.set(key, g);
                }
            }
            r.failed.push(...b.failed);
        }

        function renderReport(r: BackfillReport, dry: boolean) {
            if (!backfillEl) return;
            const actionLabel: Record<string, string> = { create: "New gallery", reuse: "Existing", link: "Merge into existing" };
            const galleries = [...r.galleries.values()].sort((a, b) => b.photos - a.photos);
            backfillEl.innerHTML = `
                <dl class="fb-stats">
                    <div><dt>${dry ? "Preview" : "Import"}</dt><dd>${r.done ? "Complete" : stopRequested ? "Stopped" : "Running…"} · ${escapeHtml(r.batches)} batch(es)</dd></div>
                    <div><dt>Posts scanned</dt><dd>${escapeHtml(r.scanned)} (${escapeHtml(r.withPhotos)} with photos, ${escapeHtml(r.withoutPhotos)} without)</dd></div>
                    <div><dt>Date range</dt><dd>${escapeHtml(r.oldest ? r.oldest.slice(0, 10) : "—")} → ${escapeHtml(r.newest ? r.newest.slice(0, 10) : "—")}</dd></div>
                    <div><dt>Photos</dt><dd>${escapeHtml(r.photos)} found · ${escapeHtml(r.newPhotos)} new · ${escapeHtml(r.duplicates)} already imported${dry ? "" : ` · ${escapeHtml(r.imported)} imported`}</dd></div>
                    <div><dt>Recent Project Updates</dt><dd>${escapeHtml(r.recent)} photo(s)</dd></div>
                    <div><dt>Errors</dt><dd><strong>${escapeHtml(r.failed.length)}</strong></dd></div>
                </dl>
                ${galleries.length ? `<h3 class="fb-subheading">${dry ? "Proposed galleries" : "Galleries"}</h3>
                <div class="table-wrap"><table class="fb-table"><thead><tr><th>Gallery</th><th>Action</th><th>Posts</th><th>New photos</th></tr></thead><tbody>
                ${galleries.map((g) => `<tr><td>${escapeHtml(g.name)}</td><td>${escapeHtml(actionLabel[g.action] || g.action)} <span class="hint">(${escapeHtml(g.reason)})</span></td><td>${escapeHtml(g.posts)}</td><td>${escapeHtml(g.photos)}</td></tr>`).join("")}
                </tbody></table></div>` : ""}
                ${r.failed.length ? `<h3 class="fb-subheading">Errors</h3><ul class="fb-failures">${r.failed.slice(0, 50).map((f) => `<li class="fb-failure"><code>${escapeHtml(f.postId)}</code><div class="fb-failure-error">${escapeHtml(f.error)}</div></li>`).join("")}</ul>` : ""}`;
        }

        async function runBackfill(dry: boolean) {
            if (!dryBtn || !runBtn || !stopBtn) return;
            if (!dry && !window.confirm("Import and publish historical Facebook photos to the website now? Hidden photos stay hidden; existing galleries are not changed.")) return;
            stopRequested = false;
            dryBtn.disabled = runBtn.disabled = true;
            stopBtn.hidden = false;
            const report = emptyReport();
            let after: string | null = null;
            let first = true;
            try {
                // A dry run walks with explicit cursors; an import resumes from the cursor stored in D1.
                while (!stopRequested) {
                    const body: Record<string, unknown> = dry ? { dryRun: true, limit: 10, ...(after ? { after } : {}) } : { dryRun: false, limit: 10, resume: true };
                    const b: BackfillBatch = await apiUrl<BackfillBatch>(`${adminApiBase}/facebook/backfill`, body);
                    if (dry || b.complete) addBatch(report, b);
                    else {
                        // Batch ran out of time; the same posts are re-read next call.
                        report.batches++;
                        report.imported += b.imported || 0;
                    }
                    renderReport(report, dry);
                    if (!b.next && b.complete) {
                        report.done = true;
                        break;
                    }
                    if (dry) after = b.next;
                    first = false;
                }
            } catch (err) {
                flashStatus(`${dry ? "Preview" : "Import"} stopped: ${errMsg(err)}`, "error", 0);
            } finally {
                renderReport(report, dry);
                dryBtn.disabled = runBtn.disabled = false;
                stopBtn.hidden = true;
                if (!dry && !first) await loadOverview();
            }
        }

        dryBtn?.addEventListener("click", () => void runBackfill(true));
        runBtn?.addEventListener("click", () => void runBackfill(false));
        stopBtn?.addEventListener("click", () => {
            stopRequested = true;
            flashStatus("Stopping after the current batch…", "info", 3000);
        });

        void loadOverview().then(() => {
            if (statusEl.textContent === "Loading…") flashStatus("Loaded.", "success", 1500);
        });
        void checkHealth();
    });
}
