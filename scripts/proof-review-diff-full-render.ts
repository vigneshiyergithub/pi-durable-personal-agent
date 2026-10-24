// Proof A for the merge gate's review render budget (REVIEW_DIFF_CHARS, src/config.ts): a
// synthetic diff of ~240000 characters — under the new 300000 default — must render IN FULL to the
// reviewer input through the real render path (startReviews() -> reviewMessage(), via the driver in
// scripts/review-render-driver.ts): the tail sentinel and the second sentinel after it must be
// present and no ", TRUNCATED" marker may appear.
//
// Exits 0 only in that case (any failed assertion is an uncaught error, exit 1).
//
// Run from the repository root: node scripts/proof-review-diff-full-render.ts
import assert from "node:assert/strict";
import { diffOfChars, importOrchestra, reviewInputFor } from "./review-render-driver.ts";

const chars = 240_000;
// The ambient environment is passed through explicitly, so an override (e.g. REVIEW_DIFF_CHARS=150000)
// changes the effective budget and this proof fails, as it must: the criterion is the default of 300000.
const { REVIEW_DIFF_CHARS } = await importOrchestra(process.env.REVIEW_DIFF_CHARS);
assert.equal(REVIEW_DIFF_CHARS, 300_000, `the proof runs against the default budget, got REVIEW_DIFF_CHARS=${REVIEW_DIFF_CHARS}`);
const diff = diffOfChars(chars);
const message = await reviewInputFor(diff);
assert.ok(message.includes(diff), `the full ${chars}-character diff must be present in the reviewer input`);
assert.ok(message.includes(`tailMarker_${chars}`), "the tail sentinel must reach the reviewer");
assert.ok(message.includes(`lastLine_${chars}`), "the second sentinel after the tail must reach the reviewer");
assert.doesNotMatch(message, /, TRUNCATED/, "a diff within the budget must not be marked TRUNCATED");
console.log(`PROOF OK: a ${chars}-character diff rendered ${message.length} characters to the reviewer in full (tail sentinel and last line present), with no TRUNCATED marker`);
