export default function initAdminReviewsPage() {
    if (typeof document === "undefined") return;

    document.addEventListener("DOMContentLoaded", () => {
        const tbody = document.getElementById("reviews-tbody") as HTMLTableSectionElement | null;
        const statusEl = document.getElementById("reviews-status") as HTMLElement | null;
        const filterStatus = document.getElementById("filter-status") as HTMLSelectElement | null;
        const filterType = document.getElementById("filter-type") as HTMLSelectElement | null;
        const refreshBtn = document.getElementById("refresh-reviews") as HTMLButtonElement | null;

        function setStatus(msg: string, isError: boolean = false): void {
            if (!statusEl) return;
            statusEl.textContent = msg || "";
            statusEl.classList.toggle("status--error", isError);
        }

        function projectTypeLabel(type: string | null | undefined): string {
            switch (type) {
                case "new-construction":
                    return "New construction";
                case "remodel":
                    return "Remodel";
                case "furniture":
                    return "Furniture";
                default:
                    return "Other";
            }
        }

        async function fetchReviews(): Promise<void> {
            try {
                setStatus("Loading…");

                const params = new URLSearchParams();
                if (filterStatus && filterStatus.value) params.set("status", filterStatus.value);
                if (filterType && filterType.value) params.set("projectType", filterType.value);

                const res = await fetch(`/api/reviews/admin/list?${params.toString()}`, {
                    credentials: "include",
                });

                if (!res.ok) {
                    setStatus("Failed to load reviews.", true);
                    return;
                }

                const data = (await res.json()) as { reviews?: unknown };
                const reviews = Array.isArray(data.reviews) ? data.reviews : [];
                renderReviews(reviews);
                setStatus(
                    reviews.length ? `Loaded ${reviews.length} review(s).` : "No reviews found."
                );
            } catch (e) {
                console.error("admin reviews load error", e);
                setStatus("Error loading reviews.", true);
            }
        }

        type ReviewRecord = {
            id: string;
            clientNamePublic?: string;
            location?: string | null;
            text?: string;
            projectType?: string;
            rating?: number;
            status?: string;
            featured?: boolean;
            photoUrl?: string | null;
            adminReply?: string | null;
        };

        function renderReviews(reviews: ReviewRecord[]): void {
            if (!tbody) return;
            tbody.innerHTML = "";

            for (const r of reviews) {
                const tr = document.createElement("tr");
                tr.dataset.id = r.id;
                tr.dataset.reply = r.adminReply || "";

                const clientCell = document.createElement("td");
                clientCell.dataset.label = "Client";
                clientCell.innerHTML = `
          <strong>${escapeHtml(r.clientNamePublic || "Client")}</strong>
          ${r.location ? `<br><small>${escapeHtml(r.location)}</small>` : ""}
        `;

                const projectCell = document.createElement("td");
                projectCell.dataset.label = "Project";
                projectCell.innerHTML = `
          ${escapeHtml(projectTypeLabel(r.projectType))}
          ${r.text ? `<br><small class="admin-review-body">${escapeHtml(r.text)}</small>` : ""}
        `;

                const ratingCell = document.createElement("td");
                ratingCell.dataset.label = "Rating";
                ratingCell.textContent = `${r.rating ?? ""} ★`;

                const statusCell = document.createElement("td");
                statusCell.dataset.label = "Status";
                statusCell.textContent = r.status || "";

                const featuredCell = document.createElement("td");
                featuredCell.dataset.label = "Featured";
                featuredCell.textContent = r.featured ? "Yes" : "No";

                const photoCell = document.createElement("td");
                photoCell.dataset.label = "Photo";

                if (r.photoUrl) {
                    const url = escapeHtml(r.photoUrl);

                    const clientLabel = r.clientNamePublic?.trim() || "client";
                    const typeLabel = projectTypeLabel(r.projectType);
                    const locationLabel = (r.location || "").trim();

                    const altText = locationLabel
                        ? `Review photo from ${clientLabel} – ${typeLabel} in ${locationLabel}`
                        : `Review photo from ${clientLabel} – ${typeLabel}`;

                    photoCell.innerHTML = `
                        <a href="${url}" target="_blank" rel="noopener noreferrer" class="admin-review-thumb-link">
                          <img
                            src="${url}"
                            alt="${escapeHtml(altText)}"
                            class="admin-review-thumb"
                            loading="lazy"
                          />
                        </a>
                  `;
                } else {
                    photoCell.innerHTML = `<span class="admin-no-photo">—</span>`;
                }
                const isApproved = r.status === "approved";
                const isHidden = r.status === "hidden";
                const approveLabel = isApproved ? "Approved" : "Approve";
                const hideLabel = isHidden ? "Unhide" : "Hide";

                const actionsCell = document.createElement("td");
                actionsCell.dataset.label = "";
                actionsCell.innerHTML = `
          <button
            class="admin-button-sm js-approve${isApproved ? " is-disabled" : ""}"
            ${isApproved ? "disabled" : ""}
          >
            ${approveLabel}
          </button>
          <button class="admin-button-sm js-hide">
            ${hideLabel}
          </button>
          <button class="admin-button-sm js-toggle-feature">
            ${r.featured ? "Unfeature" : "Feature"}
          </button>
          <button class="admin-button-sm js-reply">Reply</button>
          <button class="admin-button-sm admin-button-danger js-delete">Delete</button>
        `;
                tr.appendChild(clientCell);
                tr.appendChild(projectCell);
                tr.appendChild(ratingCell);
                tr.appendChild(statusCell);
                tr.appendChild(featuredCell);
                tr.appendChild(photoCell);
                tr.appendChild(actionsCell);

                tbody.appendChild(tr);
            }
        }

        async function updateStatus(
            id: string,
            status: string,
            featured: boolean
        ): Promise<void> {
            try {
                const res = await fetch("/api/reviews/admin/status", {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    credentials: "include",
                    body: JSON.stringify({ id, status, featured }),
                });

                if (!res.ok) {
                    console.error("status update failed", res.status);
                    setStatus("Failed to update status.", true);
                    return;
                }

                await fetchReviews();
            } catch (e) {
                console.error(e);
                setStatus("Failed to update status.", true);
            }
        }

        async function sendReply(id: string, replyText: string): Promise<void> {
            try {
                const res = await fetch("/api/reviews/admin/reply", {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    credentials: "include",
                    body: JSON.stringify({ id, replyText }),
                });

                if (!res.ok) {
                    console.error("reply failed", res.status);
                    setStatus("Failed to save reply.", true);
                    return;
                }

                await fetchReviews();
            } catch (e) {
                console.error(e);
                setStatus("Failed to save reply.", true);
            }
        }

        async function deleteReview(id: string): Promise<void> {
            if (!confirm("Delete this review permanently?")) return;

            try {
                const res = await fetch("/api/reviews/admin/delete", {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    credentials: "include",
                    body: JSON.stringify({ id }),
                });

                if (!res.ok) {
                    console.error("delete failed", res.status);
                    setStatus("Failed to delete review.", true);
                    return;
                }

                await fetchReviews();
            } catch (e) {
                console.error(e);
                setStatus("Failed to delete review.", true);
            }
        }

        function escapeHtml(s: string | null | undefined): string {
            return String(s || "")
                .replaceAll("&", "&amp;")
                .replaceAll("<", "&lt;")
                .replaceAll(">", "&gt;")
                .replaceAll('"', "&quot;")
                .replaceAll("'", "&#39;");
        }

        if (tbody) {
            tbody.addEventListener("click", (ev: MouseEvent) => {
                const target = ev.target as HTMLElement | null;
                if (!target) return;

                const tr = target.closest("tr") as HTMLTableRowElement | null;
                if (!tr || !tr.dataset.id) return;
                const id = tr.dataset.id;

                if (target.classList.contains("js-approve")) {
                    if (target.hasAttribute("disabled")) return;

                    const featuredCell = tr.querySelector("td:nth-child(5)") as HTMLTableCellElement | null;
                    const isFeatured = (featuredCell?.textContent || "").trim() === "Yes";

                    void updateStatus(id, "approved", isFeatured);
                } else if (target.classList.contains("js-hide")) {
                    const statusCell = tr.querySelector("td:nth-child(4)") as HTMLTableCellElement | null;
                    const currentStatus = (statusCell?.textContent || "").trim();
                    const featuredCell = tr.querySelector("td:nth-child(5)") as HTMLTableCellElement | null;
                    const isFeatured = (featuredCell?.textContent || "").trim() === "Yes";

                    const nextStatus = currentStatus === "hidden" ? "approved" : "hidden";
                    void updateStatus(id, nextStatus, isFeatured);
                } else if (target.classList.contains("js-toggle-feature")) {
                    const currentlyFeatured = target.textContent === "Unfeature";
                    const statusCell = tr.querySelector("td:nth-child(4)") as HTMLTableCellElement | null;
                    const currentStatus = (statusCell?.textContent || "").trim() || "approved";
                    void updateStatus(id, currentStatus, !currentlyFeatured);
                } else if (target.classList.contains("js-reply")) {
                    const actionsCell = tr.querySelector("td:last-child") as HTMLTableCellElement | null;
                    if (!actionsCell) return;

                    let editor = actionsCell.querySelector<HTMLDivElement>(".reply-editor");
                    if (editor) {
                        editor.remove();
                        return;
                    }

                    editor = document.createElement("div");
                    editor.className = "reply-editor";

                    const existingText = tr.dataset.reply || "";

                    editor.innerHTML = `
            <textarea class="reply-input" rows="3" placeholder="Type your reply to the client...">${escapeHtml(
                        existingText
                    )}</textarea>
            <div class="reply-editor-actions">
              <button type="button" class="admin-button-sm js-save-reply">Save</button>
              <button type="button" class="admin-button-sm js-cancel-reply">Cancel</button>
            </div>
          `;

                    actionsCell.appendChild(editor);
                } else if (target.classList.contains("js-save-reply")) {
                    const editor = target.closest(".reply-editor") as HTMLDivElement | null;
                    if (!editor) return;

                    const textarea = editor.querySelector<HTMLTextAreaElement>(".reply-input");
                    const text = textarea ? textarea.value.trim() : "";
                    void sendReply(id, text);
                } else if (target.classList.contains("js-cancel-reply")) {
                    const editor = target.closest(".reply-editor") as HTMLDivElement | null;
                    if (editor) editor.remove();
                } else if (target.classList.contains("js-delete")) {
                    void deleteReview(id);
                }
            });
        }

        if (refreshBtn) {
            refreshBtn.addEventListener("click", () => {
                void fetchReviews();
            });
        }

        if (filterStatus) {
            filterStatus.addEventListener("change", () => {
                void fetchReviews();
            });
        }

        if (filterType) {
            filterType.addEventListener("change", () => {
                void fetchReviews();
            });
        }

        // initial load
        void fetchReviews();
    });
}
