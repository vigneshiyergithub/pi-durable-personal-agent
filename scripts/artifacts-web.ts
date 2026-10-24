// Proofs for the Artifacts section of the web app (web/src/components/artifacts-panel.tsx).
//
// Each subcommand exits 0 exactly when its criterion holds, and prints what it found:
//
//   node scripts/artifacts-web.ts render      (i)–(iii): against fixtures, the real component built
//                                             with vite --ssr prints one line per row (title, kind,
//                                             description, url), the empty-state text for zero
//                                             entries, and the unavailable note for a token-less
//                                             entry.
//   node scripts/artifacts-web.ts error-state (iv):  the failure path — a plain error line with a
//                                             Retry button, fetched via the authenticated
//                                             /api/artifacts endpoint (source check + render).
//   node scripts/artifacts-web.ts nav-label   built assets contain the 'Artifacts' nav label
//                                             (run npm run build:web first).
//   node scripts/artifacts-web.ts no-fixture-urls
//                                             built assets contain none of the fixture URLs, so
//                                             the list is not inlined at build time (run
//                                             npm run build:web first).
import { readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join, resolve } from "node:path";

const fail = (message: string): never => {
	console.error(`FAIL ${message}`);
	process.exit(1);
};

// Unique markers used by the render fixtures; the built app assets must contain none of them,
// because the list is fetched at runtime and never inlined at build time.
const FIXTURE_HOST = "fixtures.example.net";
const FIXTURE_CANVAS_URL = "/canvas-fixture-entry/?k=token-alpha";

const fixtureOfSizeTwo = { source: "file", skipped: 0, entries: [
	{ id: "canvas", title: "Canvas", kind: "canvas", description: "Drawings the agent has made.", url: FIXTURE_CANVAS_URL, available: true },
	{ id: "blog", title: "Blog", kind: "blog", description: "Things the agent has written.", url: `https://${FIXTURE_HOST}/blog/`, available: true },
] } as const;

const ssrEntryAndRenderer = async (): Promise<(dataJson: string, initialError?: string) => string> => {
	// Build the proof-only SSR entry with the web app's own bundler (vite, same aliases and react
	// plugin), exactly as bench/proofs.ts `lab-render` does. Nothing here touches web/dist.
	rmSync(resolve("web/dist-ssr"), { recursive: true, force: true });
	const built = spawnSync(
		process.execPath,
		["node_modules/vite/bin/vite.js", "build", "--ssr", "src/artifacts-ssr.tsx", "--outDir", "dist-ssr", "--emptyOutDir"],
		{ cwd: resolve("web"), encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
	);
	if (built.status !== 0) fail(`the Artifacts SSR bundle failed to build:\n${built.stdout}${built.stderr}`);
	const moduleId = resolve("web/dist-ssr/artifacts-ssr.js");
	try {
		return (await import(moduleId)).renderArtifacts as (dataJson: string, initialError?: string) => string;
	} catch (error) {
		return fail(`could not load ${moduleId}: ${error}`);
	}
};

const must = (html: string, needle: string, what: string): void => {
	if (!html.includes(needle)) fail(`the rendered Artifacts section is missing ${what}: "${needle}"`);
};

async function renderProof(): Promise<void> {
	const render = await ssrEntryAndRenderer();

	// (i) two entries → one printed line per row, and the markup really carries it.
	const html2 = render(JSON.stringify(fixtureOfSizeTwo));
	for (const entry of fixtureOfSizeTwo.entries) {
		must(html2, `>${entry.title}<`, "the title");
		must(html2, entry.kind, "the kind");
		must(html2, entry.description, "the description");
		must(html2, entry.url, "the URL");
	}
	must(html2, 'target="_blank"', "the new-tab link");
	must(html2, 'rel="noopener noreferrer"', "the noopener rel");
	for (let i = 0; i < fixtureOfSizeTwo.entries.length; i++) {
		const entry = fixtureOfSizeTwo.entries[i]!;
		console.log(`ROW ${i + 1}: title=${entry.title} | kind=${entry.kind} | description=${entry.description} | url=${entry.url}`);
	}
	console.log(`PASS render (two entries): ${fixtureOfSizeTwo.entries.length} rows rendered with title, kind, description, url, target=_blank and rel=noopener noreferrer`);
	if (html2.includes("No artefacts yet.")) fail("the two-entry render must not show the empty state");

	// (ii) zero entries → the empty state, not an error.
	const htmlEmpty = render(JSON.stringify({ source: "defaults", skipped: 0, entries: [] }));
	must(htmlEmpty, "No artefacts yet.", "the empty-state text");
	console.log("EMPTY STATE: No artefacts yet.");
	console.log("PASS render (zero entries): the empty-state text renders");

	// (iii) a token-less entry (server says unavailable, url null) → the note, not a dead link.
	const htmlUnavailable = render(JSON.stringify({ source: "defaults", skipped: 0, entries: [
		{ id: "canvas", title: "Canvas", kind: "canvas", description: "Drawings the agent has made.", url: null, available: false, reason: "unavailable: canvas access token is not configured" },
	] }));
	must(htmlUnavailable, "Link unavailable", "the unavailable note");
	must(htmlUnavailable, "canvas access token is not configured", "the server's reason");
	if (htmlUnavailable.includes(FIXTURE_CANVAS_URL)) fail("an unavailable entry must not render an href");
	console.log("UNAVAILABLE: Link unavailable — unavailable: canvas access token is not configured");
	console.log("PASS render (unavailable entry): the note renders and no link is emitted");
}

const FAILED_500 = "Request failed (500)";

async function errorStateProof(): Promise<void> {
	// The component must talk to the authenticated endpoint and settle every promise, so a failed
	// request is the error state and never an unhandled rejection.
	const source = readFileSync(resolve("web/src/components/artifacts-panel.tsx"), "utf8");
	if (!source.includes('api<ArtifactsData>("/api/artifacts")')) fail("the panel does not fetch the authenticated /api/artifacts endpoint through api()");
	if (!source.includes(".catch(")) fail("the fetch has no settled catch, risking an unhandled rejection");
	if (!source.includes("Retry")) fail("the error state has no Retry affordance");

	const render = await ssrEntryAndRenderer();
	const htmlError = render("", FAILED_500);
	// renderToStaticMarkup escapes the apostrophe (&#x27;), so check the message without it.
	must(htmlError, "Couldn", "the plain error message start");
	must(htmlError, " load artifacts: Request failed (500)", "the plain error message body");
	if (!htmlError.includes("Retry")) fail("the error state has no Retry");
	console.log(`ERROR STATE: Couldn't load artifacts: ${FAILED_500} + a Retry button`);
	console.log("PASS error-state: the failure path renders a plain error line with a Retry, fetched via the session-authenticated endpoint");
}

const filesUnder = (root: string, acc: string[] = []): string[] => {
	if (acc.length === 0 && statSync(root).isFile()) return [root];
	for (const name of readdirSync(root, { withFileTypes: true })) {
		const path = join(root, name.name);
		if (name.isDirectory()) filesUnder(path, acc);
		else acc.push(path);
	}
	return acc;
};

function navLabelProof(): void {
	if (!statSync(resolve("web/dist"), { throwIfNoEntry: false })) fail("web/dist does not exist; run npm run build:web first");
	const hits = filesUnder(resolve("web/dist")).filter((path) => path.endsWith(".js") && readFileSync(path, "utf8").includes("Artifacts"));
	if (hits.length === 0) fail("no built asset contains the 'Artifacts' nav label");
	console.log(`NAV LABEL: "Artifacts" found in ${hits.length} built asset(s)`);
	console.log("PASS nav-label: the built app assets contain the 'Artifacts' nav entry");
}

function noFixtureUrlsProof(): void {
	if (!statSync(resolve("web/dist"), { throwIfNoEntry: false })) fail("web/dist does not exist; run npm run build:web first");
	const dirty = filesUnder(resolve("web/dist")).filter((path) => {
		const text = readFileSync(path, "utf8");
		return text.includes(FIXTURE_HOST) || text.includes(FIXTURE_CANVAS_URL.split("?")[0]!);
	});
	if (dirty.length > 0) fail(`fixture URLs are baked into the build: ${dirty.join(", ")}`);
	console.log("NO FIXTURE URLS: neither fixtures.example.net nor the fixture canvas path appears in any built asset");
	console.log("PASS no-fixture-urls: the list is not inlined at build time");
}

const arg = process.argv[2];
if (arg === "render") await renderProof();
else if (arg === "error-state") await errorStateProof();
else if (arg === "nav-label") navLabelProof();
else if (arg === "no-fixture-urls") noFixtureUrlsProof();
else fail('usage: node scripts/artifacts-web.ts render | error-state | nav-label | no-fixture-urls');
