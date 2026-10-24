// Unit tests for the Artifacts data module (src/artifacts.ts).
//
// One line per case — case name, expected, actual, PASS/FAIL — and a non-zero exit when any case
// fails. All I/O happens in a throwaway directory: no dependencies, credentials or network.
//
// Run with: npm run test:artifacts
//       or: node scripts/artifacts.test.ts
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_ARTIFACTS, loadArtifacts } from "../src/artifacts.ts";

const dataRoot = await mkdtemp(join(tmpdir(), "artifacts-test-"));
process.on("exit", () => rmSync(dataRoot, { recursive: true, force: true }));

let failures = 0;
let n = 0;
const show = (status: "PASS" | "FAIL", name: string, expected: string, actual: string) => {
	if (status === "FAIL") failures++;
	console.log(`${status} case=${++n} ${name} | expected: ${expected} | actual: ${actual}`);
};
const equal = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
const check = (name: string, expected: unknown, actual: unknown) =>
	show(equal(expected, actual) ? "PASS" : "FAIL", name, JSON.stringify(expected), JSON.stringify(actual));

const withFile = async (name: string, data: unknown): Promise<string> => {
	const path = join(dataRoot, name);
	await mkdir(path, { recursive: true });
	await writeFile(join(path, "artifacts.json"), typeof data === "string" ? data : JSON.stringify(data));
	return path;
};

const ids = (r: { entries: Array<{ id: string }> }) => r.entries.map((e) => e.id);
const reasons = (r: { skipped: Array<{ reason: string }> }) => r.skipped.map((s) => s.reason);

// 1. valid file → its entries; unknown kind coerced to "other"; added date kept
const validDir = await withFile("valid", {
	artifacts: [
		{ id: "blog", title: "Agent blog", kind: "blog", url: "https://blog.example.com/", description: "Notes.", added: "2026-10-01" },
		{ id: "weird-kind", title: "Odd", kind: "sculpture", url: "https://odd.example.com/", description: "Unknown kind." },
	],
});
{
	const r = await loadArtifacts(validDir);
	check("valid file: entries kept, file source", { source: "file", entries: [{ id: "blog", kind: "blog", added: "2026-10-01" }, { id: "weird-kind", kind: "other" }] }, { source: r.source, entries: r.entries.map((e) => ({ id: e.id, kind: e.kind, added: e.added })) });
	check("valid file: skipped stays empty", 0, r.skipped.length);
}

// 2. invalid URL shapes are skipped and counted, one reason each; good ones survive
const badUrls = await withFile("bad-urls", {
	artifacts: [
		{ id: "js", title: "JS", url: "javascript:alert(1)", description: "x" },
		{ id: "data", title: "Data", url: "data:text/html,hi", description: "x" },
		{ id: "rel", title: "Rel", url: "page/notes.html", description: "x" },
		{ id: "proto-rel", title: "ProtoRel", url: "//evil.example.com/", description: "x" },
		{ id: "padded", title: "Padded", url: " https://padded.example.com/", description: "x" },
		{ id: "file", title: "File", url: "file:///etc/passwd", description: "x" },
		{ id: "good", title: "Good", url: "https://ok.example.com/", description: "x" },
	],
});
{
	const r = await loadArtifacts(badUrls);
	check("bad urls skipped with reasons, good kept", { entries: ["good"], skipped: 6 }, { entries: ids(r), skipped: r.skipped.length });
	check("javascript: url reason", "unsupported protocol javascript:", reasons(r)[0]);
	check("data: url reason", "unsupported protocol data:", reasons(r)[1]);
	check("relative url reason", "not a URL", reasons(r)[2]);
	check("malformed url reason", "not a URL", reasons(r)[3]);
}

// 3. missing required fields skipped; non-string description skipped; valid entry kept
const missingFields = await withFile("missing", {
	artifacts: [
		{ title: "No id", url: "https://a.example.com/", description: "x" },
		{ id: "nourl", title: "No url", description: "x" },
		{ id: "nondesc", title: "Numbers", url: "https://b.example.com/", description: 7 },
		{ id: "kept", title: "Kept", kind: "repo", url: "https://kept.example.com/", description: "y" },
	],
});
{
	const r = await loadArtifacts(missingFields);
	check("missing id/url and non-string description skipped with reasons, valid entry kept", { entries: ["kept"], skipped: ["missing id", "missing url", "description not a string"] }, { entries: ids(r), skipped: reasons(r) });
}

// 4. duplicate ids: first kept, later ones counted as skipped
const dupDir = await withFile("dup", {
	artifacts: [
		{ id: "twice", title: "First", url: "https://first.example.com/", description: "x" },
		{ id: "twice", title: "Second", url: "https://second.example.com/", description: "x" },
	],
});
{
	const r = await loadArtifacts(dupDir);
	check("duplicate id: first kept, second skipped with reason", { titles: ["First"], skipped: ["duplicate id"] }, { titles: r.entries.map((e) => e.title), skipped: reasons(r) });
}

// 5. missing file → built-in defaults (canvas + blog), nothing skipped;
// the blog default carries the blog-url marker and NO placeholder address anywhere
{
	const r = await loadArtifacts(join(dataRoot, "no-such-dir"));
	check("missing file → defaults with canvas+blog, none skipped", { source: "defaults", entries: ["canvas", "blog"], skipped: 0 }, { source: r.source, entries: ids(r), skipped: r.skipped.length });
	check("built-in defaults are exactly canvas and blog", ["canvas", "blog"], DEFAULT_ARTIFACTS.map((e) => e.id));
	check("canvas default keeps the canvas-token marker", "canvas-token", DEFAULT_ARTIFACTS.find((e) => e.id === "canvas")?.auth);
	check("blog default carries the blog-url marker", "blog-url", DEFAULT_ARTIFACTS.find((e) => e.id === "blog")?.auth);
	check(
		"no built-in default carries a placeholder or example.com URL (the blog's address comes from the environment)",
		[],
		DEFAULT_ARTIFACTS.filter((e) => e.url.includes("example.com") || e.url.includes("placeholder")),
	);
}

// 6. malformed JSON / wrong top-level shape → defaults
{
	const r1 = await loadArtifacts(await withFile("badjson", "{ not json"));
	const r2 = await loadArtifacts(await withFile("wrong", { entries: [{ id: "x" }] }));
	const r3 = await loadArtifacts(await withFile("wrongarray", [{ id: "x" }]));
	check("malformed JSON and wrong shapes → defaults", { sources: ["defaults", "defaults", "defaults"], entries: ["canvas", "blog"] }, { sources: [r1.source, r2.source, r3.source], entries: ids(r3) });
}

// 7. empty entries array → zero entries, not defaults
{
	const r = await loadArtifacts(await withFile("empty", { artifacts: [] }));
	check("empty entries array: zero entries, not defaults", { source: "file", entries: 0, skipped: 0 }, { source: r.source, entries: r.entries.length, skipped: r.skipped.length });
}

// 8. the loader reads the file at call time: editing it between calls changes the answer
const liveDir = await withFile("live", { artifacts: [{ id: "v1", title: "V1", url: "https://v1.example.com/", description: "x" }] });
{
	const before = await loadArtifacts(liveDir);
	await writeFile(join(liveDir, "artifacts.json"), JSON.stringify({ artifacts: [{ id: "v2", title: "V2", url: "https://v2.example.com/", description: "x" }] }));
	const after = await loadArtifacts(liveDir);
	check("file read at call time (v1 then v2 after edit)", ["v1", "v2"], [before.entries[0]?.id, after.entries[0]?.id]);
}

// 9. token-gated entries may carry a site path; mark unknown auth coerced away; verdict not a secret anywhere
{
	const r = await loadArtifacts(await withFile("auth", {
		artifacts: [
		{ id: "canvas-entry", title: "Canvas", kind: "canvas", url: "/canvas/", description: "x", auth: "canvas-token" },
		{ id: "unknown-auth", title: "X", url: "https://u.example.com/", description: "x", auth: "something-else" },
	],
}));
	check("auth entry with site path kept; unknown auth marker coerced to none", { kept: ["canvas-entry", "unknown-auth"], skipped: [] }, { kept: ids(r), skipped: reasons(r) });
	const noSecret = DEFAULT_ARTIFACTS.some((e) => e.url.includes("?") || e.url.includes("=") || e.url.length > 0 && /[0-9a-f]{32}/.test(e.url));
	check("no token shape in built-in defaults", false, noSecret);
}

// 9b. blog-url marked entries: no url needed (address comes from the environment at request
// time); the marker stays on the parsed entry, and a url set on one is not required either way
{
	const r = await loadArtifacts(await withFile("blog-auth", {
		artifacts: [
			{ id: "blog-marked", title: "Blog", kind: "blog", description: "no url in the data", auth: "blog-url" },
			{ id: "blog-marked-with-url", title: "Blog 2", kind: "blog", url: "https://kept.example.com/", description: "url present but the server still resolves from the environment; kept by the loader", auth: "blog-url" },
		],
	}));
	check("blog-url marked entries kept with and without a url in the data", { kept: ["blog-marked", "blog-marked-with-url"], skipped: [] }, { kept: ids(r), skipped: reasons(r) });
	check("blog-url entry with no url parses to an empty url", { urls: ["", "https://kept.example.com/"], auths: ["blog-url", "blog-url"] }, { urls: r.entries.map((e) => e.url), auths: r.entries.map((e) => e.auth) });
}

// 10. token-gated entries: only a genuine same-origin /canvas/ path on a canvas entry is kept;
// anything else carrying the marker is refused and counted, with a reason
{
	const r = await loadArtifacts(await withFile("auth-hostile", {
		artifacts: [
			{ id: "ok-canvas", title: "Canvas", kind: "canvas", url: "/canvas/", description: "x", auth: "canvas-token" },
			{ id: "deep-canvas", title: "Deep", kind: "canvas", url: "/canvas/notes/1", description: "x", auth: "canvas-token" },
			{ id: "bare-canvas", title: "Bare", kind: "canvas", url: "/canvas", description: "x", auth: "canvas-token" },
			{ id: "proto-rel", title: "ProtoRel", kind: "canvas", url: "//evil.example.com/", description: "x", auth: "canvas-token" },
			{ id: "abs-http", title: "AbsHttp", kind: "canvas", url: "http://evil.example.com/", description: "x", auth: "canvas-token" },
			{ id: "abs-https", title: "AbsHttps", kind: "canvas", url: "https://evil.example.com/x", description: "x", auth: "canvas-token" },
			{ id: "js", title: "Js", kind: "canvas", url: "javascript:alert(1)", description: "x", auth: "canvas-token" },
			{ id: "dotdot", title: "DotDot", kind: "canvas", url: "/canvas/../secret", description: "x", auth: "canvas-token" },
			{ id: "enc-dotdot", title: "EncDotDot", kind: "canvas", url: "/canvas/%2e%2e/secret", description: "x", auth: "canvas-token" },
			{ id: "dot", title: "Dot", kind: "canvas", url: "/canvas/./secret", description: "x", auth: "canvas-token" },
			{ id: "backslash", title: "Backslash", kind: "canvas", url: "/\\evil.example.com", description: "x", auth: "canvas-token" },
			{ id: "enc-backslash", title: "EncBackslash", kind: "canvas", url: "/canvas/%5Cevil.example.com", description: "x", auth: "canvas-token" },
			{ id: "query", title: "Query", kind: "canvas", url: "/canvas/?next=//evil.example.com", description: "x", auth: "canvas-token" },
			{ id: "fragment", title: "Fragment", kind: "canvas", url: "/canvas/#/../evil", description: "x", auth: "canvas-token" },
			{ id: "scheme-inside", title: "SchemeInside", kind: "canvas", url: "/canvas/%3a%2f%2fevil.example.com/", description: "x", auth: "canvas-token" },
			{ id: "outside-canvas", title: "Outside", kind: "canvas", url: "/other/", description: "x", auth: "canvas-token" },
			{ id: "wrong-kind", title: "WrongKind", kind: "report", url: "/steal/", description: "x", auth: "canvas-token" },
			{ id: "wrong-case", title: "WrongCase", kind: "Canvas", url: "/canvas/", description: "x", auth: "canvas-token" },
		],
	}));
	check("auth entries: only genuine same-origin /canvas/ paths on kind canvas kept", { kept: ["ok-canvas", "deep-canvas", "bare-canvas"], skipped: 15 }, { kept: ids(r), skipped: r.skipped.length });
	check("non-canvas kind with auth marker reason", "token-gated entry is not the canvas (kind canvas)", reasons(r).find((s) => s.includes("kind canvas")));
	check("dot-segment reason", "dot segment in token-gated path", reasons(r).find((s) => s.includes("dot segment")));
	check("off-origin path reason", "token-gated path escapes /canvas/", reasons(r).find((s) => s.includes("escapes /canvas/")));
}

await rm(dataRoot, { recursive: true, force: true }).catch(() => {});
if (failures > 0) {
	console.log(`\n${failures} case(s) failed`);
	process.exit(1);
}
console.log(`\nall ${n} cases passed`);
