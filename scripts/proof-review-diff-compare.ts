// Proof B for the merge gate's review render budget (REVIEW_DIFF_CHARS, src/config.ts): the
// end-to-end path including the raw-diff cap inside GitHubApp.compare() (src/sandbox.ts).
//
// compare() is driven off-line: the script stubs global fetch so api.github.com answers with fixed
// API responses (an installation token, the compare metadata, and a raw-diff body of a chosen size)
// while the REAL GitHubApp.compare() code runs — token minting, metadata, raw fetch, the
// `raw.length > REVIEW_DIFF_CHARS` cap in compare(), the slice. No stubbing of the arithmetic: the
// truncation decision and the cut come out of src/sandbox.ts, and the diff compare() produced is
// then rendered to the reviewer through the real startReviews() -> reviewMessage() path
// (scripts/review-render-driver.ts). GitHub App credentials are generated once into a throwaway
// DATA_DIR (an RSA key for the JWT signature), so no network and no secret is used.
//
// Two cases, both through the full compare() -> reviewMessage() path:
// 1. a ~240000-character raw diff (under the 300000 budget): compare() must hand the diff on
//    UNTRUNCATED (truncated false, full body), the reviewer input must contain the entire raw diff
//    and its tail sentinels, and no ", TRUNCATED" marker may appear.
// 2. a 400000-character raw diff (beyond the budget): compare() must pre-cut it to exactly
//    REVIEW_DIFF_CHARS characters and flag truncated, and the reviewer input must be marked
//    ", TRUNCATED" with exactly the first REVIEW_DIFF_CHARS characters.
//
// Exits 0 only when both hold (any failed assertion is an uncaught error, exit 1).
//
// Run from the repository root: node scripts/proof-review-diff-compare.ts
import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { diffOfChars, importOrchestra, reviewInputFor } from "./review-render-driver.ts";

// The proof runs against the default budget of 300000: no override, no ambient value.
delete process.env.REVIEW_DIFF_CHARS;
// A throwaway DATA_DIR must be in the environment BEFORE anything imports src/config.ts: compare()'s
// credentials come from that directory, and the stub key lives only there (removed at the end).
const dataDir = await mkdtemp(join(tmpdir(), "review-diff-cap-"));
process.env.DATA_DIR = dataDir;
try {
	const { REVIEW_DIFF_CHARS } = await importOrchestra(process.env.REVIEW_DIFF_CHARS);
	assert.equal(REVIEW_DIFF_CHARS, 300_000, `the proof runs against the default budget, got REVIEW_DIFF_CHARS=${REVIEW_DIFF_CHARS}`);

	const credentials = {
		appId: 123456,
		slug: "proof-app",
		privateKey: generateKeyPairSync("rsa", { modulusLength: 2048 })
			.privateKey.export({ type: "pkcs8", format: "pem" })
			.toString(),
		installationId: 42,
		org: "proof-org",
	};
	await mkdir(join(dataDir, "secrets"), { recursive: true, mode: 0o700 });
	await writeFile(join(dataDir, "secrets", "github-app.json"), JSON.stringify(credentials), { mode: 0o600 });

	const { GitHubApp } = await import("../src/sandbox.ts");

	/** The raw-diff body the stubbed api.github.com should answer with; set per case by runWithRawDiff. */
	let API_RAW_DIFF = "";
	/** Answers api.github.com locally with fixed responses; anything else is refused. */
	const stubbedFetch: typeof fetch = async (url, init) => {
		const method = (init?.method as string | undefined) ?? "GET";
		const target = url instanceof Request ? url.url : String(url);
		const parsed = new URL(target);
		assert.equal(`${parsed.protocol}//${parsed.host}`, "https://api.github.com", `off-line proof: every request must go to api.github.com, got ${target}`);
		const accept = (init?.headers as { accept?: string } | undefined)?.accept;
		const respond = (body: string, status: number, contentType: string) => new Response(body, { status, headers: { "content-type": contentType } });
		if (method === "POST" && /^\/app\/installations\/\d+\/access_tokens$/.test(parsed.pathname)) {
			return respond(JSON.stringify({ token: "stub-installation-token" }), 201, "application/json");
		}
		if (method === "GET" && /^\/repos\/[^/]+\/[^/]+\/compare\//.test(parsed.pathname)) {
			if (accept === "application/vnd.github.diff") return respond(API_RAW_DIFF, 200, "text/plain");
			return respond(
				JSON.stringify({ merge_base_commit: { sha: "basesha" }, files: [{ filename: "diff.txt" }], commits: [{ sha: "headsha123456" }] }),
				200,
				"application/json",
			);
		}
		throw new Error(`unexpected external request in an off-line proof: ${method} ${target}`);
	};
	const realFetch = globalThis.fetch;

	/** Runs `run` with the stubbed API answering `rawDiff` for the raw compare request, then restores fetch. */
	async function runWithRawDiff<T>(rawDiff: string, run: () => Promise<T>): Promise<T> {
		API_RAW_DIFF = rawDiff;
		globalThis.fetch = stubbedFetch;
		try {
			return await run();
		} finally {
			globalThis.fetch = realFetch;
		}
	}

	/** The REAL compare(), off-line, against what the stubbed API currently answers. */
	const compare = (repo: string, base: string, head: string) => runWithRawDiff(API_RAW_DIFF, () => new GitHubApp().compare(repo, base, head));

	// Case 1: a raw diff of 240000 characters, under the budget, survives compare() whole.
	const small = diffOfChars(240_000);
	const compared = await runWithRawDiff(small, () => new GitHubApp().compare("proof-org/proof-repo", "master", "agent/proof-branch"));
	assert.equal(compared.truncated, false, "compare() must NOT truncate a raw diff within the budget");
	assert.equal(compared.diff, small, "compare() must hand the whole raw diff on when it fits the budget");
	assert.equal(compared.files, 1, "compare() must pass the metadata through");
	assert.equal(compared.headSha, "headsha123456", "compare() must pass the head sha through");
	const github = { compare };
	const smallMessage = await reviewInputFor(small, github.compare);
	assert.ok(smallMessage.includes(small), "the ~240000-character raw diff must reach the reviewer input in full");
	assert.ok(smallMessage.includes("tailMarker_240000"), "the tail sentinel must reach the reviewer");
	assert.ok(smallMessage.includes("lastLine_240000"), "the second sentinel after it too");
	assert.doesNotMatch(smallMessage, /, TRUNCATED/, "a raw diff within the budget must not be marked TRUNCATED");

	// Case 2: a raw diff of 400000 characters, beyond the budget, is pre-cut by compare() itself.
	const big = diffOfChars(400_000);
	const bigCompared = await runWithRawDiff(big, () => new GitHubApp().compare("proof-org/proof-repo", "master", "agent/proof-branch"));
	assert.equal(bigCompared.truncated, true, "compare() must flag truncation for a raw diff beyond the budget");
	assert.equal(bigCompared.diff.length, REVIEW_DIFF_CHARS, `compare() must pre-cut the raw diff to ${REVIEW_DIFF_CHARS} characters`);
	assert.equal(bigCompared.diff, big.slice(0, REVIEW_DIFF_CHARS), "the pre-cut must be exactly the first budget characters of the raw diff");
	const bigMessage = await reviewInputFor(big, github.compare);
	assert.match(bigMessage, /, TRUNCATED/, `a raw diff beyond the ${REVIEW_DIFF_CHARS} budget must still be marked TRUNCATED by the reviewer input`);
	assert.ok(!bigMessage.includes("tailMarker_400000"), "nothing past the budget may reach the reviewer");
	assert.ok(!bigMessage.includes("lastLine_400000"), "the second sentinel past the budget may not reach the reviewer either");
	const start = bigMessage.indexOf(big.slice(0, 64));
	const end = bigMessage.indexOf("\n\nDecide with submit_review");
	assert.notEqual(start, -1, "the head of the raw diff must reach the reviewer");
	assert.equal(bigMessage.slice(start, end), big.slice(0, REVIEW_DIFF_CHARS), "the reviewer must read exactly the pre-cut diff");

	console.log(
		`PROOF OK: off-line (stubbed api.github.com responses; no network, no credential), the REAL GitHubApp.compare() with a ${small.length}-char raw diff passed ${compared.diff.length} chars through whole (truncated=false) and the reviewer input contained the whole diff, tail sentinels included, with no TRUNCATED marker; with a ${big.length}-char raw diff compare() pre-cut to ${bigCompared.diff.length} chars (truncated=true, the first ${REVIEW_DIFF_CHARS} of the raw), the ", TRUNCATED" marker was present and the reviewer read exactly the pre-cut.`,
	);
} finally {
	await rm(dataDir, { recursive: true, force: true });
}
