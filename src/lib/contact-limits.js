// Contact form field limits (characters). They match the Contact Worker's
// server-side caps (workers/kilcon-contact/src/index.js, MAX), which the
// Worker enforces on trimmed values; tests/contact-limits.test.mjs keeps the
// two in step. Phone is stricter here (20) because the input's pattern already
// allows at most 20 characters; the Worker accepts up to 40 raw characters.
export const CONTACT_LIMITS = Object.freeze({
  name: 100,
  email: 254,
  phone: 20,
  address: 300,
  message: 5000,
});

export const MIN_NAME_LENGTH = 2;
export const MIN_MESSAGE_LENGTH = 10;

const LABELS = {
  name: "your name",
  email: "your email address",
  phone: "your phone number",
  address: "the job address",
  message: "your project details",
};

const fmt = (n) => n.toLocaleString("en-US");

/**
 * The validation message for a field's length, or "" when it is fine.
 * Counts trimmed characters, as the Worker does.
 */
export function lengthProblem(field, value) {
  const max = CONTACT_LIMITS[field];
  if (!max) return "";
  const length = String(value ?? "").trim().length;
  if (length > max) {
    return `Please shorten ${LABELS[field]} to ${fmt(max)} characters or fewer (currently ${fmt(length)}).`;
  }
  if (field === "name" && length > 0 && length < MIN_NAME_LENGTH) {
    return `Please enter at least ${MIN_NAME_LENGTH} characters for your name.`;
  }
  if (field === "message" && length > 0 && length < MIN_MESSAGE_LENGTH) {
    return `Please add a little more detail (at least ${MIN_MESSAGE_LENGTH} characters).`;
  }
  return "";
}

/** "1,234 / 5,000 characters" for the message counter. */
export function counterText(value) {
  return `${fmt(String(value ?? "").length)} / ${fmt(CONTACT_LIMITS.message)} characters`;
}
