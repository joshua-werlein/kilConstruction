export default function initUploadPage() {
    // Do nothing during SSR
    if (typeof document === "undefined") return;

    document.addEventListener("DOMContentLoaded", () => {
        // Grab DOM elements with concrete types (same pattern as manage-script.ts)
        const formEl = document.getElementById("admin-upload-form") as HTMLFormElement;
        const categoryEl = document.getElementById("category") as unknown as HTMLSelectElement;
        const fileInput = document.getElementById("fileInput") as HTMLInputElement;
        const statusEl = document.getElementById("status") as HTMLDivElement;
        const resultEl = document.getElementById("result") as HTMLDivElement;
        const submitBtn = document.getElementById("submitBtn") as HTMLButtonElement;
        const subfolderSelectEl = document.getElementById("subfolder-select") as unknown as HTMLSelectElement;
        const subfolderCustomEl = document.getElementById("subfolder-custom") as HTMLInputElement;

        function sanitizeSubfolderInput(raw: string): string | null {
            let s = (raw || "").trim();
            if (!s) return null;

            // normalize slashes
            s = s.replace(/\\/g, "/");

            // block traversal + absolute + control chars
            if (s.includes("..")) return null;
            if (s.startsWith("/")) return null;
            if (/[\u0000-\u001F\u007F]/.test(s)) return null;

            // collapse repeated slashes and trim trailing
            s = s.replace(/\/+/g, "/").replace(/\/+$/, "");

            // prevent empty segments from sneaking in
            const parts = s.split("/").filter(Boolean);
            if (!parts.length) return null;

            // Optional: keep names reasonably safe for R2 keys/UI
            // (allows letters, numbers, space, underscore, dash)
            // If you want to be permissive, remove this block.
            for (const p of parts) {
                if (!/^[a-zA-Z0-9 _-]+$/.test(p)) return null;
            }

            return parts.join("/");
        }

        // Runtime safety: if markup is missing, bail out quietly
        if (
            !formEl ||
            !categoryEl ||
            !fileInput ||
            !statusEl ||
            !resultEl ||
            !submitBtn ||
            !subfolderSelectEl ||
            !subfolderCustomEl
        ) {
            console.error("[upload] Missing one or more admin upload elements");
            return;
        }

        const subfoldersByCategory = new Map<string, Set<string>>();
        const defaultStatusText = statusEl.textContent || "";

        type StatusVariant = "info" | "success" | "error";

        function flashStatus(
            message: string,
            variant: StatusVariant = "info",
            timeoutMs = 2200
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

        // same base we use for uploads
        const API_BASE =
            import.meta.env.DEV
                ? (import.meta.env.PUBLIC_GALLERY_API ||
                    "https://kilcon.work/api/gallery-api")
                : "/api/gallery-api";

        async function loadAllFolders(): Promise<void> {
            try {
                const res = await fetch(`${API_BASE}?all=1`, {
                    credentials: "include",
                });

                const data: unknown = await res.json().catch(() => ({} as unknown));
                const projects = Array.isArray((data as any).projects)
                    ? (data as any).projects
                    : [];

                subfoldersByCategory.clear();

                for (const p of projects) {
                    const rawPrefix: string =
                        (p && (p.prefix as string)) ||
                        decodeURIComponent((p && (p.slug as string)) || "");

                    if (!rawPrefix) continue;

                    const noSlash = rawPrefix.replace(/\/$/, "");
                    const [top, ...rest] = noSlash.split("/");
                    if (!top || !rest.length) continue;

                    const folderName = rest.join("/");
                    if (!folderName) continue;

                    if (!subfoldersByCategory.has(top)) {
                        subfoldersByCategory.set(top, new Set<string>());
                    }

                    subfoldersByCategory.get(top)!.add(folderName);
                }

                rebuildSubfolderSelect();
            } catch (e) {
                console.error("[upload] failed to load folders", e);
                flashStatus("Failed to load folder list.", "error", 3000);
            }
        }

        function rebuildSubfolderSelect(): void {
            const category = (categoryEl.value || "").trim();
            const isHighlights = category === "Highlights";

            subfolderSelectEl.innerHTML = "";

            // always have base options
            subfolderSelectEl.appendChild(new Option("— Select folder —", ""));

            const set =
                subfoldersByCategory.get(category) ||
                subfoldersByCategory.get(category.toLowerCase()) ||
                new Set<string>();

            const sorted = Array.from(set).sort((a, b) =>
                a.localeCompare(b, undefined, { sensitivity: "base", numeric: true })
            );

            for (const name of sorted) {
                const label = name.replace(/_/g, " ");
                subfolderSelectEl.appendChild(new Option(label, name));
            }

            subfolderSelectEl.appendChild(new Option("➕ Create new folder…", "__NEW__"));
            subfolderSelectEl.value = "";
            subfolderCustomEl.style.display = "none";
            subfolderCustomEl.value = "";
        }

        // reload list when category changes
        categoryEl.addEventListener("change", () => {
            rebuildSubfolderSelect();
            const isHighlights = categoryEl.value.trim() === "Highlights";
            subfolderSelectEl.disabled = isHighlights;
            subfolderCustomEl.style.display = "none";
            subfolderCustomEl.value = "";
        });

        subfolderSelectEl.addEventListener("change", () => {
            if (subfolderSelectEl.value === "__NEW__") {
                subfolderCustomEl.style.display = "block";
                subfolderCustomEl.focus();
            } else {
                subfolderCustomEl.style.display = "none";
                subfolderCustomEl.value = "";
            }
        });

        // initial load
        void loadAllFolders();

        formEl.addEventListener("submit", async (e: SubmitEvent) => {
            e.preventDefault();

            const files = fileInput.files;
            if (!files || !files.length) {
                flashStatus("Please choose at least one image.", "error", 2600);
                return;
            }

            const ALLOWED_CATEGORIES = new Set([
                "Projects",
                "New Construction",
                "Remodels",
                "Furniture",
                "Apparel",
                "Highlights",
            ]);

            const category = categoryEl.value.trim();
            if (!category) {
                flashStatus("Please choose a category.", "error", 2600);
                return;
            }


            if (!ALLOWED_CATEGORIES.has(category)) {
                flashStatus("Invalid category.", "error", 3000);
                return;
            }

            let subfolder = "";

            const isHighlights = category === "Highlights";

            if (!isHighlights) {
                // 1) existing folder from dropdown
                if (subfolderSelectEl.value && subfolderSelectEl.value !== "__NEW__") {
                    subfolder = subfolderSelectEl.value.trim();
                }

                // 2) "Create new" path → use custom text
                if (!subfolder && subfolderSelectEl.value === "__NEW__") {
                    subfolder = subfolderCustomEl.value.trim();
                }

                // 3) Fallbacks
                if (!subfolder) {
                    if (category === "Projects") {
                        const first = files[0];
                        const base = (first.webkitRelativePath || first.name || "project").split(
                            "/"
                        )[0];
                        subfolder = base || "project";
                    } else {
                        subfolder = "misc";
                    }
                }

                const sanitized = sanitizeSubfolderInput(subfolder);
                if (!sanitized) {
                    flashStatus("Invalid folder name.", "error", 3000);
                    submitBtn.disabled = false;
                    return;
                }
                subfolder = sanitized;
            }

            const formData = new FormData();

            for (const file of Array.from(files)) {
                const cleanedName = file.name || "image";
                const fullPath = isHighlights
                    ? `${category}/${cleanedName}`
                    : `${category}/${subfolder}/${cleanedName}`.replace(/\/+/g, "/");

                formData.append(fullPath, file);
            }

            flashStatus("Uploading…", "info", 0);
            resultEl.innerHTML = "";
            submitBtn.disabled = true;

            try {
                const res = await fetch(`${API_BASE}/upload`, {
                    method: "POST",
                    body: formData,
                    credentials: "include",
                });

                const data: any = await res.json().catch(() => ({}));

                if (res.ok) {
                    const urls: string[] = Array.isArray(data.urls) ? data.urls : [];
                    const list = urls
                        .map(
                            (u) =>
                                `<li><a href="${u}" target="_blank" rel="noreferrer">${u}</a></li>`
                        )
                        .join("");

                    const count =
                        (typeof data.uploaded === "number" && data.uploaded) ||
                        urls.length ||
                        0;

                    resultEl.innerHTML = `<p>Uploaded ${count} files:</p><ul>${list}</ul>`;
                    flashStatus("Upload complete.", "success");
                    fileInput.value = "";
                    void loadAllFolders();
                } else {
                    flashStatus("Upload failed.", "error", 4000);
                    resultEl.textContent = data?.error || "Server returned an error.";
                }
            } catch (err) {
                console.error(err);
                flashStatus("Upload error – see console.", "error", 4000);
                resultEl.textContent = "";
            } finally {
                submitBtn.disabled = false;
            }
        });
    });
}