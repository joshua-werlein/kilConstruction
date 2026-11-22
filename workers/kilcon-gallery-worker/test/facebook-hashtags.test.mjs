// Run: npm run test:gallery-worker
import { test } from "node:test";
import assert from "node:assert/strict";
import { parseControlTags, stripControlTags } from "../src/facebook-hashtags.js";

test("category and highlight tags are recognised case-insensitively", () => {
  assert.deepEqual(parseControlTags("Finished the Ripley shop! #NewConstruction #highlight"),
    { category: "new-construction", conflict: false, highlight: true, tags: ["newconstruction", "highlight"] });
  assert.equal(parseControlTags("#remodel").category, "remodels");
  assert.equal(parseControlTags("#Projects").category, "projects");
  assert.equal(parseControlTags("#furniture #furniture").category, "furniture");
  assert.equal(parseControlTags("#highlights").highlight, true);
});

test("ambiguous or look-alike tags are not acted on", () => {
  assert.deepEqual([parseControlTags("#remodels #furniture").category, parseControlTags("#remodels #furniture").conflict], [null, true]);
  for (const t of ["#projectmanager", "#remodelsale", "email@x.com#project", "##project", "&#project", "remodels", "", null, undefined]) {
    const r = parseControlTags(t);
    assert.deepEqual([r.category, r.highlight], [null, false], String(t));
  }
  assert.equal(parseControlTags("(#project)").category, "projects");
});

test("only control tags are removed from captions", () => {
  assert.equal(stripControlTags("Deck done #remodels #DeckLife\n#highlight"), "Deck done #DeckLife");
  assert.equal(stripControlTags("#project New garage.  Thanks!"), "New garage. Thanks!");
  assert.equal(stripControlTags("No tags here #woodwork"), "No tags here #woodwork");
  assert.equal(stripControlTags(null), null);
});
