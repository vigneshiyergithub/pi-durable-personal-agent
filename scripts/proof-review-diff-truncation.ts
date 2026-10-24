// Proof B for the merge gate's review render budget (REVIEW_DIFF_CHARS, src/config.ts): a
// synthetic diff clearly beyond the new default (400000 characters against 300000) must still
// truncate through the real render path (startReviews() -> reviewMessage(), via the driver in
// scripts/review-render-driver.ts): the ", TRUNCATED" marker must be present, neither sentinel past
// the budget may reach the reviewer, and the rendered body must be exactly the first
// REVIEW_DIFF_CHARS characters of the diff.
//
// Exits 0 only in that case (any failed assertion is an uncaught error, exit 1) — so if the budget
// were raised to/above the diff or truncation disabled, this proof fails loudly instead of silently
// passing on "found nothing".
//
// Run from the repository root: node scripts/proof-review-diff-truncation.ts
import assert from "node:assert/strict";
import { diffOfChars, importOrchestra, reviewInputFor } from "./review-render-driver.ts";

const chars = 400_000;
// The ambient environment is passed through explicitly, so an override (e.g. REVIEW_DIFF_CHARS=500000)
// changes the effective budget and this proof fails, as it must: the criterion is the default of 300000.
const { REVIEW_DIFF_CHARS } = await importOrchestra(process.env.REVIEW_DIFF_CHARS);
assert.equal(REVIEW_DIFF_CHARS, 300_000, `the proof runs against the default budget, got REVIEW_DIFF_CHARS=${REVIEW_DIFF_CHARS}`);
const diff = diffOfChars(chars);
const message = await reviewInputFor(diff);
assert.match(message, /, TRUNCATED/, `a ${chars}-character diff beyond the ${REVIEW_DIFF_CHARS} budget must still be marked TRUNCATED`);
assert.ok(!message.includes(`tailMarker_${chars}`), "nothing past the budget may reach the reviewer");
assert.ok(!message.includes(`lastLine_${chars}`), "the second sentinel past the budget may not reach the reviewer either");
const start = message.indexOf(diff.slice(0, 64));
const end = message.indexOf("\n\nDecide with submit_review");
assert.notEqual(start, -1, "the head of the diff must reach the reviewer");
assert.equal(message.slice(start, end), diff.slice(0, REVIEW_DIFF_CHARS), `the reviewer must read exactly the first ${REVIEW_DIFF_CHARS} characters of the diff`);
console.log(`PROOF OK: a ${chars}-character diff rendered ${message.length} characters to the reviewer, marked TRUNCATED, cut at exactly ${REVIEW_DIFF_CHARS}`);
