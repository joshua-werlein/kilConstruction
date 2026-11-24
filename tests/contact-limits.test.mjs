// Contact form length limits: the page, the draft and the Contact Worker agree.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { CONTACT_LIMITS, lengthProblem, counterText, MIN_MESSAGE_LENGTH } from "../src/lib/contact-limits.js";
import { DRAFT_FIELDS, encodeDraft, decodeDraft } from "../src/lib/contact-draft.js";
import { MAX } from "../workers/kilcon-contact/src/index.js";

const read = (p) => readFile(new URL(`../${p}`, import.meta.url), "utf8");

test("client limits match the Contact Worker's server caps", () => {
  for (const k of ["name", "email", "address", "message"]) {
    assert.equal(CONTACT_LIMITS[k], MAX[k], k);
  }
  assert.equal(CONTACT_LIMITS.message, 5000);
  assert.ok(CONTACT_LIMITS.phone <= MAX.phone, "the form is never looser than the Worker");
});

test("clear messages: over the limit names the field, the limit and the current count", () => {
  assert.equal(lengthProblem("message", "M".repeat(5000)), "");
  assert.equal(
    lengthProblem("message", "M".repeat(5001)),
    "Please shorten your project details to 5,000 characters or fewer (currently 5,001).",
  );
  assert.match(lengthProblem("name", "N".repeat(101)), /^Please shorten your name to 100 characters or fewer/);
  assert.match(lengthProblem("address", "A".repeat(301)), /the job address to 300 characters/);
  assert.match(lengthProblem("email", `${"e".repeat(250)}@x.co`), /your email address to 254 characters/);
  assert.equal(lengthProblem("message", "too short"), `Please add a little more detail (at least ${MIN_MESSAGE_LENGTH} characters).`);
  assert.equal(lengthProblem("name", "P"), "Please enter at least 2 characters for your name.");
  assert.equal(lengthProblem("message", ""), "", "empty is left to `required`");
  assert.equal(lengthProblem("message", `  ${"M".repeat(5000)}  `), "", "trimmed, as the Worker counts");
  assert.equal(lengthProblem("company", "x".repeat(9999)), "", "unlisted fields are ignored");
});

test("message counter text", () => {
  assert.equal(counterText(""), "0 / 5,000 characters");
  assert.equal(counterText("M".repeat(1234)), "1,234 / 5,000 characters");
});

test("contact page: every field carries the shared limits, and limits are re-checked on submit", async () => {
  const page = await read("src/pages/contact.astro");
  for (const k of ["name", "email", "phone", "address", "message"]) {
    assert.match(page, new RegExp(`id="${k}"[^>]*maxlength=\\{CONTACT_LIMITS\\.${k}\\}`), k);
  }
  assert.match(page, /aria-describedby="messageCount"/);
  assert.match(page, /<p id="messageCount" class="field-count">\{counterText\(""\)\}<\/p>/);
  assert.match(page, /field\.setCustomValidity\(lengthProblem\(field\.name, field\.value\)\)/);
  assert.match(page, /if \(!contactForm\.checkValidity\(\)\) \{\s*event\.preventDefault\(\);\s*event\.stopImmediatePropagation\(\);/);
  assert.match(page, /contactForm\.reportValidity\(\)/);
  // The validation listener is registered before the draft-saving listener.
  assert.ok(page.indexOf("contactForm.checkValidity()") < page.indexOf("encodeDraft(values)"));
  assert.match(page, /project details up to 5,000/, "the ?err=input message states the limit");
  assert.doesNotMatch(page, /innerHTML/);
});

test("the error-redirect draft keeps exactly what the form allows", () => {
  assert.deepEqual(DRAFT_FIELDS, { ...CONTACT_LIMITS });
  const now = Date.now();
  const back = decodeDraft(encodeDraft({ address: "A".repeat(400), message: "M".repeat(6000) }, now), now);
  assert.equal(back.address.length, 300);
  assert.equal(back.message.length, 5000);
});
