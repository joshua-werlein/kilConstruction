export default function initManagePage() {
    document.addEventListener("DOMContentLoaded", () => {
        const listEl = document.getElementById("results") as HTMLUListElement;
        const statusEl = document.getElementById("status") as HTMLDivElement;
        const searchEl = document.getElementById("search") as HTMLInputElement;
        const refreshEl = document.getElementById("refresh") as HTMLButtonElement;
        const bulkDeleteEl = document.getElementById("bulk-delete") as HTMLButtonElement;
        const defaultStatusText = statusEl.textContent || "";

        function flashStatus(
            message: string,
            variant: "info" | "success" | "error" = "info",
            timeoutMs: number = 2200
        ) {
            statusEl.textContent = message;
            statusEl.classList.remove("status--success", "status--error");

            if (variant === "success") statusEl.classList.add("status--success");
            if (variant === "error") statusEl.classList.add("status--error");

            if (timeoutMs > 0) {
                setTimeout(() => {
                    statusEl.textContent = defaultStatusText || "";
                    statusEl.classList.remove("status--success", "status--error");
                }, timeoutMs);
            }
        }

        if (!listEl || !statusEl || !searchEl || !refreshEl || !bulkDeleteEl) {
            console.error("[manage] Missing one or more DOM elements");
            return;
        }

        const publicApiBase = (listEl.dataset.publicApi || "").replace(/\/$/, "");
        const adminApiBase = (listEl.dataset.adminApi || "").replace(/\/$/, "");

        if (!publicApiBase || !adminApiBase) {
            statusEl.textContent = "Missing gallery API URL.";
            return;
        }

        type ProjectFolder = {
            slug: string;
            name?: string;
            prefix: string;
        };

        let allProjects: ProjectFolder[] = [];
        const ALLOWED_ROOTS = new Set([
            "Projects",
            "New Construction",
            "Remodels",
            "Furniture",
            "Highlights",
        ]);

        allProjects = allProjects.filter((p) => {
            const rawPrefix = (p && (p.prefix as string)) || "";
            const displayPrefix = rawPrefix.replace(/\/$/, "");
            const root = displayPrefix.split("/").filter(Boolean)[0] || "";
            return ALLOWED_ROOTS.has(root);
        });

        const expandedPrefixes: Set<string> = new Set();

        async function loadProjects() {
            try {
                statusEl.textContent = "Loading projects…";
                listEl.innerHTML = "";

                const res = await fetch(`${publicApiBase}?all=1`, {
                    credentials: "include",
                });
                if (!res.ok) {
                    console.error(`HTTP ${res.status}`);
                    statusEl.textContent = "Error loading projects.";
                    return;
                }

                const data = (await res.json()) as { projects?: typeof allProjects };
                allProjects = (data.projects || []);

                statusEl.textContent = `Loaded ${allProjects.length} folders.`;
                renderProjects();
            } catch (err) {
                console.error(err);
                statusEl.textContent = "Error loading projects.";
            }
        }

        function renderProjects() {
            const q = searchEl.value.trim().toLowerCase();
            listEl.innerHTML = "";

            const items = allProjects.filter((p) => {
                if (!q) return true;
                const name = (p.name || "").toLowerCase();
                const slug = (p.slug || "").toLowerCase();
                const prefix = (p.prefix || "").toLowerCase();
                return (
                    name.includes(q) ||
                    slug.includes(q) ||
                    prefix.includes(q)
                );
            });

            if (!items.length) {
                listEl.innerHTML =
                    '<li class="empty">No folders match that search.</li>';
                return;
            }

            for (const p of items) {
                const li = document.createElement("li");
                li.className = "result-item";

                const rawPrefix = p.prefix || decodeURIComponent(p.slug || "");
                const prefix = rawPrefix.endsWith("/") ? rawPrefix : rawPrefix + "/"; // e.g. "Furniture/Cabinets/"
                li.dataset.prefix = prefix;

                // ---- header row ----
                const header = document.createElement("div");
                header.className = "item-header";

                const checkbox = document.createElement("input");
                checkbox.type = "checkbox";
                checkbox.className = "select-checkbox";
                checkbox.dataset.type = "project";
                checkbox.dataset.prefix = prefix;

                const expandBtn = document.createElement("button");
                expandBtn.type = "button";
                expandBtn.className = "expand-btn";
                expandBtn.textContent = expandedPrefixes.has(prefix) ? "▾" : "▸";
                expandBtn.dataset.prefix = prefix;

                const textWrap = document.createElement("div");
                textWrap.className = "item-text";

                // Show full directory path as the *only* label, e.g. "Furniture/Cabinets"
                const title = document.createElement("div");
                title.className = "result-title";

                const displayPrefix = prefix.replace(/\/$/, "");
                const parts = displayPrefix.split("/");
                const root = parts[0] || "";
                const folderNameRaw = parts.slice(1).join("/") || root;
                const folderNamePretty = folderNameRaw.replace(/_/g, " ");
                const labelText =
                    root && folderNamePretty && root !== folderNamePretty
                        ? `${root} / ${folderNamePretty}`
                        : folderNamePretty || root;

                // pretty label for user
                const folderNameDisplay = document.createElement("span");
                folderNameDisplay.className = "folder-name-display";
                folderNameDisplay.textContent = labelText;

                // input only edits the folder name portion, not the root
                const folderNameInput = document.createElement("input");
                folderNameInput.type = "text";
                folderNameInput.className = "folder-rename-input";
                folderNameInput.value = folderNamePretty;
                folderNameInput.style.display = "none";

                title.appendChild(folderNameDisplay);
                title.appendChild(folderNameInput);
                textWrap.appendChild(title);

                // Order: [checkbox] [caret] [Folder path]
                // Visual order: [caret] [Folder path] [checkbox]
                header.appendChild(expandBtn);
                header.appendChild(textWrap);
                header.appendChild(checkbox);

                li.appendChild(header);

                // ---- children container (files) ----
                const children = document.createElement("ul");
                children.className = "children-list";
                children.dataset.prefix = prefix;
                if (!expandedPrefixes.has(prefix)) {
                    children.style.display = "none";
                }

                li.appendChild(children);
                listEl.appendChild(li);
                let currentFolderName = folderNamePretty;

                function resetFolderRename() {
                    folderNameDisplay.style.display = "inline";
                    folderNameInput.style.display = "none";
                    folderNameInput.value = currentFolderName;
                }

                async function commitFolderRename() {
                    const newName = folderNameInput.value.trim();
                    const currentName = currentFolderName;

                    if (!newName || newName === currentName) {
                        resetFolderRename();
                        return;
                    }

                    const parts = displayPrefix.split("/"); // e.g. ["Projects", "Fox_Hollow"]
                    const category = parts[0] || "";
                    const newPrefix =
                        (category ? category + "/" : "") +
                        newName.replace(/\/+$/, "") + "/";

                    try {
                        const res = await fetch(`${adminApiBase}/rename-prefix`, {
                            method: "POST",
                            headers: { "Content-Type": "application/json" },
                            credentials: "include",
                            body: JSON.stringify({
                                oldPrefix: displayPrefix,
                                newPrefix,
                            }),
                        });

                        if (res.ok) {
                            currentFolderName = newName;

                            folderNameDisplay.textContent = category && newName && category !== newName
                                ? `${category} / ${newName}`
                                : newName || category;
                            li.dataset.prefix = newPrefix;

                            li.classList.add("just-renamed");
                            setTimeout(() => {
                                li.classList.remove("just-renamed");
                            }, 1200);

                            expandedPrefixes.clear();
                            await loadProjects();
                            flashStatus("Folder renamed successfully.", "success");
                        } else {
                            flashStatus("Folder rename failed.", "error");
                        }
                    } catch (err) {
                        console.error("Folder rename error", err);
                        flashStatus("Folder rename failed.", "error");
                    } finally {
                        resetFolderRename();
                    }
                }

                folderNameDisplay.addEventListener("click", () => {
                    folderNameDisplay.style.display = "none";
                    folderNameInput.style.display = "inline-block";
                    folderNameInput.focus();
                    folderNameInput.select();
                });

                folderNameInput.addEventListener("blur", commitFolderRename);
                folderNameInput.addEventListener("keydown", (e) => {
                    if (e.key === "Enter") void commitFolderRename();
                    if (e.key === "Escape") resetFolderRename();
                });
            }
        }

        async function loadFolderFiles(childrenEl: HTMLUListElement, prefix: string) {
            if (!childrenEl || !prefix) return;

            childrenEl.dataset.prefix = prefix.endsWith("/") ? prefix : prefix + "/";
            childrenEl.dataset.loaded = "0";
            childrenEl.innerHTML = `<li class="empty">Loading files…</li>`;

            try {
                const res = await fetch(
                    `${adminApiBase}/list-images?` + new URLSearchParams({ prefix }),
                    { method: "GET",credentials: "include" }
                );

                const data = (await res.json().catch(() => ({}))) as { objects?: any[] };

                childrenEl.innerHTML = "";

                if (Array.isArray(data.objects) && data.objects.length) {
                    renderFiles(childrenEl, data.objects);
                    childrenEl.dataset.loaded = "1";
                } else {
                    childrenEl.innerHTML = `<li class="empty">No image files found.</li>`;
                }
            } catch (err) {
                console.error("loadFolderFiles error", err);
                childrenEl.innerHTML = `<li class="empty">Error loading files.</li>`;
            }
        }

        async function toggleFolder(prefix: string, li: HTMLLIElement) {
            const children = li.querySelector(".children-list") as HTMLUListElement | null;
            const expandBtn = li.querySelector(".expand-btn") as HTMLButtonElement | null;
            if (!children || !expandBtn) return;

            const isExpanded = expandedPrefixes.has(prefix);
            if (isExpanded) {
                expandedPrefixes.delete(prefix);
                children.style.display = "none";
                expandBtn.textContent = "▸";
                return;
            }

            expandedPrefixes.add(prefix);
            children.style.display = "block";
            expandBtn.textContent = "▾";

            if (children.dataset.loaded !== "1") {
                // REPLACE previous fetch block with:
                await loadFolderFiles(children, prefix);
            }
        }

        function renderFiles(
            container: HTMLUListElement,
            objects: { key: string; name: string; size?: number; uploaded?: string | null }[]
        ) {
            container.innerHTML = "";

            if (!objects.length) {
                const li = document.createElement("li");
                li.className = "child-item empty";
                li.textContent = "No files in this folder.";
                container.appendChild(li);
                return;
            }

            for (const obj of objects) {
                const li = document.createElement("li");
                li.className = "child-item";
                li.dataset.key = obj.key;

                const checkbox = document.createElement("input");
                checkbox.type = "checkbox";
                checkbox.className = "select-checkbox";
                checkbox.dataset.type = "file";
                checkbox.dataset.key = obj.key;

                const info = document.createElement("div");
                info.className = "child-info";

                const nameWrapper = document.createElement("div");
                nameWrapper.className = "rename-wrapper";

                const nameDisplay = document.createElement("span") as HTMLSpanElement;
                nameDisplay.className = "name-display";
                nameDisplay.textContent = obj.name;

                const nameInput = document.createElement("input") as HTMLInputElement;
                nameInput.type = "text";
                nameInput.className = "rename-input";
                nameInput.value = obj.name;
                nameInput.style.display = "none";

                nameWrapper.appendChild(nameDisplay);
                nameWrapper.appendChild(nameInput);

                const metaEl = document.createElement("div");
                metaEl.className = "image-meta";
                const sizeKB = obj.size
                    ? (obj.size / 1024).toFixed(1) + " KB"
                    : "";
                const when = obj.uploaded
                    ? new Date(obj.uploaded).toLocaleString()
                    : "";
                const metaParts = [];
                if (sizeKB) metaParts.push(sizeKB);
                if (when) metaParts.push(when);

                // size and date on separate lines
                metaEl.innerHTML = metaParts.join("<br>");

                info.appendChild(nameWrapper);
                info.appendChild(metaEl);

                li.appendChild(info);
                li.appendChild(checkbox);
                container.appendChild(li);

                // --- Rename handlers
                function resetRename() {
                    nameDisplay.style.display = "inline-block";
                    nameInput.style.display = "none";
                }

                async function commitRename() {
                    const newName = nameInput.value.trim();
                    if (!newName || newName === obj.name) {
                        resetRename();
                        return;
                    }

                    const folder = obj.key.split("/").slice(0, -1).join("/");
                    const newKey = folder + "/" + newName;
                    try {
                        const res = await fetch(`${adminApiBase}/rename`, {
                            method: "POST",
                            headers: { "Content-Type": "application/json" },
                            body: JSON.stringify({ oldKey: obj.key, newKey }),
                            credentials: "include",
                        });

                        if (res.ok) {
                            obj.name = newName;
                            obj.key = newKey;
                            nameDisplay.textContent = newName;

                            const row = li;
                            row.classList.add("just-renamed");

                            setTimeout(() => {
                                row.classList.remove("just-renamed");
                            }, 1200);

                            const children = row.closest("ul.children-list")as HTMLUListElement | null;
                            if (children && folder) {
                                await loadFolderFiles(children, folder + "/");
                            }
                            flashStatus("Renamed successfully.", "success");
                        } else {
                            flashStatus("Rename failed.", "error");
                        }
                    } catch (err) {
                        console.error("Rename error", err);
                        flashStatus("Rename failed.", "error");
                    }
                    resetRename();
                }

                nameDisplay.addEventListener("click", () => {
                    nameDisplay.style.display = "none";
                    nameInput.style.display = "inline-block";
                    nameInput.focus();
                });

                nameInput.addEventListener("blur", commitRename);
                nameInput.addEventListener("keydown", (e) => {
                    if (e.key === "Enter") void commitRename();
                    if (e.key === "Escape") resetRename();
                });

            }
        }

        // search / refresh
        searchEl.addEventListener("input", () => {
            renderProjects();
        });

        refreshEl.addEventListener("click", () => {
            expandedPrefixes.clear();
            void loadProjects();
        });

        // folder expand / collapse
        listEl.addEventListener("click", async (event) => {
            const target = event.target as HTMLElement | null;
            if (!target) return;

            const expandBtn = target.closest(".expand-btn")as HTMLButtonElement | null;
            if (expandBtn && expandBtn.dataset.prefix) {
                const prefix = expandBtn.dataset.prefix;
                const row = expandBtn.closest(".result-item")as HTMLLIElement | null;
                if (!row) return;
                await toggleFolder(prefix, row);
            }
            // --- Folder checkbox toggles all child file checkboxes ---
            const input = target as HTMLInputElement;

            if (input && input.type === "checkbox" && input.dataset.type === "project") {
                const folderPrefix = input.dataset.prefix;
                const li = input.closest("li.result-item") as HTMLLIElement | null;
                if (!li || !folderPrefix) return;

                const childList = li.querySelector(".children-list") as HTMLUListElement | null;
                if (!childList) return;

                const childCheckboxes = Array.from(
                    childList.querySelectorAll<HTMLInputElement>('input[type="checkbox"][data-type="file"]')
                );

                for (const cb of childCheckboxes) {
                    cb.checked = input.checked;
                }
            }
        });

        // bulk delete
        bulkDeleteEl.addEventListener("click", async () => {
            const checked = Array.from(
                listEl.querySelectorAll<HTMLInputElement>(".select-checkbox:checked")
            );

            if (!checked.length) {
                alert("No items selected.");
                return;
            }

            const projectPrefixes = [];
            const fileKeys = [];

            for (const input of checked) {
                if (input.dataset.type === "project" && input.dataset.prefix) {
                    projectPrefixes.push(input.dataset.prefix);
                } else if (input.dataset.type === "file" && input.dataset.key) {
                    fileKeys.push(input.dataset.key);
                }
            }

            if (!projectPrefixes.length && !fileKeys.length) {
                alert("No valid items selected.");
                return;
            }

            const confirmMsg = [
                projectPrefixes.length
                    ? `Projects: ${projectPrefixes.length}`
                    : null,
                fileKeys.length ? `Files: ${fileKeys.length}` : null,
                "",
                "This cannot be undone.",
            ]
                .filter(Boolean)
                .join("\n");

            if (!confirm(confirmMsg)) return;

            bulkDeleteEl.disabled = true;
            const originalText = bulkDeleteEl.textContent || "Delete selected";
            bulkDeleteEl.textContent = "Deleting…";

            try {
                // delete projects
                for (const prefix of projectPrefixes) {
                    try {
                        const res = await fetch(`${adminApiBase}/delete-project`, {
                            method: "POST",
                            headers: { "content-type": "application/json" },
                            body: JSON.stringify({ prefix }),
                            credentials: "include",
                        });
                        if (!res.ok) {
                            console.error("Project delete failed for", prefix, res.status);
                        }
                    } catch (err) {
                        console.error("Project delete error for", prefix, err);
                    }
                }

                // delete files
                for (const key of fileKeys) {
                    try {
                        const res = await fetch(`${adminApiBase}/delete`, {
                            method: "POST",
                            headers: { "content-type": "application/json" },
                            body: JSON.stringify({ key }),
                            credentials: "include",
                        });
                        if (!res.ok) {
                            console.error("File delete failed for", key, res.status);
                        }
                    } catch (err) {
                        console.error("File delete error for", key, err);
                    }
                }

                // reload everything so UI matches bucket state
                expandedPrefixes.clear();
                await loadProjects();
                flashStatus("Delete finished. Some failures (if any) are logged in console.", "success", 3000);
            } finally {
                bulkDeleteEl.disabled = false;
                bulkDeleteEl.textContent = originalText;
            }
        });
        void loadProjects();
    });
}