// Contact page status line for ?sent=1 / ?err=<code>, set by the Contact Worker's
// redirect. Runs from the page's bundled module script (no inline script, so the
// CSP needs no 'unsafe-inline' for it). It must run before the draft restore,
// which reads the status--error class this sets.

export const CONTACT_STATUS_MESSAGES = Object.freeze({
  sent: "Thanks! We’ll be in touch shortly.",
  captcha: "Please complete the CAPTCHA and try again.",
  phone: "Please enter a valid phone number or leave it blank.",
  input: "Please check your details and try again. Names can be up to 100 characters and project details up to 5,000.",
  other: "Sorry, something went wrong. Please try again.",
});

/** Message and kind for a query string, or null when there is nothing to show. */
export function contactStatusFor(search) {
  const params = new URLSearchParams(search);
  if (params.get("sent") === "1") return { kind: "success", message: CONTACT_STATUS_MESSAGES.sent, param: "sent" };
  const err = params.get("err");
  if (err) {
    const message = Object.hasOwn(CONTACT_STATUS_MESSAGES, err) && err !== "sent" && err !== "other"
      ? CONTACT_STATUS_MESSAGES[err]
      : CONTACT_STATUS_MESSAGES.other;
    return { kind: "error", message, param: "err" };
  }
  return null;
}

/**
 * Shows the status in `result` and removes its parameter from the URL (same
 * behaviour as the former inline script). Returns the status or null.
 */
export function applyContactStatus(result, loc = window.location, hist = window.history) {
  if (!result) return null;
  const status = contactStatusFor(loc.search);
  if (!status) return null;
  result.textContent = status.message;
  if (status.kind === "success") {
    result.classList.remove("status--error", "status--empty");
    result.classList.add("status--success");
  } else {
    result.classList.remove("status--ok", "status--empty");
    result.classList.add("status--error");
  }
  const url = new URL(loc.href);
  url.searchParams.delete(status.param);
  hist.replaceState({}, "", url.pathname + url.search);
  return status;
}
