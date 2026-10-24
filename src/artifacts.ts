// Artifacts: every artefact this agent produces (canvas, blog, reports, repos, …) in one durable
// quick-access list. The list lives in DATA_DIR/artifacts.json so the agent adds one by editing
// data, never code and never a redeploy. When the file is absent, unreadable or misshapen, the
// loader falls back to built-in defaults (the canvas and the blog) so the section works on day one.
//
// This module is read-only: it never writes or creates the data file (the agent owns it), and it
// never reads env secrets — entries may MARK that they need the canvas access token
// (`auth: "canvas-token"`) or that their address comes from the environment (`auth: "blog-url"`),
// and the HTTP layer resolves those marked links from the environment at request time.
// Unauthenticated sessions never receive a resolved link.
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { config } from "./config.ts";

export type ArtifactKind = "canvas" | "blog" | "report" | "repo" | "other";

/**
 * Marker naming how a link is composed at request time (src/http.ts). `canvas-token`: behind the
 * canvas access token (composed onto a same-origin /canvas/ site path). `blog-url`: the blog's
 * public address, resolved from the `BLOG_PUBLIC_URL` environment variable — the entry carries no
 * address at all, so there is never a placeholder. The values themselves live only in the
 * environment; a data file never carries one.
 */
export type ArtifactAuth = "canvas-token" | "blog-url";

export interface ArtifactEntry {
	id: string;
	title: string;
	kind: ArtifactKind;
	/**
	 * Absolute `http(s)://` URL, or for `canvas-token` entries the site path the server composes
	 * from, or (for `blog-url` entries) empty — the address comes from the environment at request
	 * time (see src/http.ts).
	 */
	url: string;
	description: string;
	auth?: ArtifactAuth;
	/** ISO date string, when the agent notes when it was added. */
	added?: string;
}

/** An entry that failed validation: why, and the id when there was one. */
export interface SkippedEntry {
	id: string | null;
	reason: string;
}

export interface Artifacts {
	entries: ArtifactEntry[];
	skipped: SkippedEntry[];
	source: "file" | "defaults";
}

export const ARTIFACTS_FILE = "artifacts.json";
const KINDS: ReadonlySet<string> = new Set(["canvas", "blog", "report", "repo", "other"]);

/** The one path prefix a token-bearing link may ever be composed onto. */
export const CANVAS_PATH_PREFIX = "/canvas/";

/**
 * Why the given url may NOT carry the canvas token, or undefined when it is a same-origin canvas
 * path: a single leading slash, no backslash, no scheme, no authority, no query and no fragment
 * (the ?k= token is appended by the HTTP layer), and — after decoding percent escapes — no dot
 * segment, so normalisation can never move it outside /canvas/. Hostile data-file entries are
 * refused here, before any token is attached; src/http.ts re-checks right before composing.
 */
export function canvasPathError(url: unknown): string | undefined {
	if (typeof url !== "string" || url === "") return "not a site path for a token-gated entry";
	if (url !== url.trim()) return "whitespace-padded token-gated path";
	if (url.includes("\0")) return "NUL in token-gated path";
	if (!url.startsWith("/") || url.startsWith("//")) return "not a site path for a token-gated entry";
	if (url.includes("\\")) return "backslash in token-gated path";
	if (url.includes("?") || url.includes("#")) return "token-gated path must be a bare path (no query, no fragment)";
	let decoded: string;
	try {
		decoded = decodeURIComponent(url);
	} catch {
		return "malformed percent-encoding in token-gated path";
	}
	if (decoded.includes("\\") || decoded.includes("\0")) return "encoded backslash or NUL in token-gated path";
	if (decoded.includes("://")) return "embedded scheme separator in token-gated path";
	const segments = decoded.split("/");
	for (const segment of segments.slice(1)) if (segment === "." || segment === "..") return "dot segment in token-gated path";
	const stack: string[] = [];
	for (const segment of segments) {
		if (segment === "" || segment === ".") continue;
		if (segment === "..") stack.pop(); // unreachable: dot segments are refused above
		else stack.push(segment);
	}
	const resolved = `/${stack.join("/")}`;
	if (resolved !== "/canvas" && !resolved.startsWith("/canvas/")) return "token-gated path escapes /canvas/";
	return undefined;
}

/**
 * Built-in defaults shown when DATA_DIR/artifacts.json does not exist yet (or is unusable):
 * exactly the canvas and the blog, each MARKING how its address is obtained rather than carrying
 * one — no placeholder URL is ever built in. The blog's real address is resolved at request time
 * from `BLOG_PUBLIC_URL` (src/http.ts); when nothing is configured it renders as unavailable.
 */
export const DEFAULT_ARTIFACTS: ArtifactEntry[] = [
	{ id: "canvas", title: "Canvas", kind: "canvas", url: "/canvas/", description: "Drawings the agent has made.", auth: "canvas-token" },
	{ id: "blog", title: "Blog", kind: "blog", url: "", description: "Things the agent has written.", auth: "blog-url" },
];

/**
 * Why a URL is unusable, or undefined when it is fine. Absolute entries must parse as http:// or
 * https:// (so javascript:, data:, file:, protocol-relative, relative and malformed all fail).
 * Entries marked `canvas-token` must be a same-origin canvas path — see canvasPathError: that
 * link is composed server-side, and the HTTP layer only ever emits the composed http(s) URL.
 * Entries marked `blog-url` need no url in the data at all (the address comes from the
 * environment, so this stays env-free and pure) — the HTTP layer re-validates the resolved value
 * with this same function before it is served.
 */
export function urlError(url: unknown, auth: ArtifactAuth | undefined): string | undefined {
	if (auth === "blog-url") return undefined;
	if (typeof url !== "string" || url.trim() === "") return "missing url";
	if (url !== url.trim()) return "whitespace-padded url";
	if (auth === "canvas-token") return canvasPathError(url);
	let parsed: URL;
	try {
		parsed = new URL(url);
	} catch {
		return "not a URL";
	}
	if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return `unsupported protocol ${parsed.protocol}`;
	return undefined;
}

function missingString(value: unknown): boolean {
	return typeof value !== "string" || value.trim() === "";
}

/** Validate one raw entry from the file: a parsed entry, or why it is skipped. */
export function parseEntry(raw: unknown): { entry: ArtifactEntry } | { skip: SkippedEntry } {
	if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return { skip: { id: null, reason: "not an object" } };
	const r = raw as Record<string, unknown>;
	const id = typeof r.id === "string" ? r.id : null;
	if (!id || id.trim() === "") return { skip: { id, reason: "missing id" } };
	if (missingString(r.title)) return { skip: { id, reason: "missing title" } };
	const rawAuth = typeof r.auth === "string" ? r.auth : undefined;
	const auth = (rawAuth === "canvas-token" || rawAuth === "blog-url") ? (rawAuth as ArtifactAuth) : undefined;
	// A token-bearing entry may only ever be the genuine canvas: anything else carrying the marker
	// is refused here, so no token is ever attached to a non-canvas or off-origin target.
	if (auth === "canvas-token" && r.kind !== "canvas") return { skip: { id, reason: "token-gated entry is not the canvas (kind canvas)" } };
	const badUrl = urlError(r.url, auth);
	if (badUrl) return { skip: { id, reason: badUrl } };
	if (typeof r.description !== "string") return { skip: { id, reason: "description not a string" } };
	const entry: ArtifactEntry = {
		id,
		title: r.title as string,
		kind: KINDS.has(String(r.kind)) ? r.kind as ArtifactKind : "other",
		url: typeof r.url === "string" ? r.url : (auth === "blog-url" ? "" : String(r.url)),
		description: r.description,
		...(auth ? { auth } : {}),
	};
	if (typeof r.added === "string" && !Number.isNaN(Date.parse(r.added))) entry.added = r.added;
	return { entry };
}

const fromDefaults = (): Artifacts => ({ entries: DEFAULT_ARTIFACTS.map((entry) => ({ ...entry })), skipped: [], source: "defaults" });

/**
 * The one place a token-bearing link is composed. The token can only ever be attached to a
 * same-origin canvas path: the entry must genuinely be the canvas (kind canvas) and its url must
 * re-validate as a /canvas/ site path at the last moment, immediately before the composed link is
 * put in the response. Anything else is refused — no token, no token-bearing URL and no off-origin
 * URL leaves the server for it (the caller reports refusal and a reason).
 */
export function composeTokenLink(entry: ArtifactEntry, token: string): { url: string } | { refused: string } {
	if (entry.kind !== "canvas") return { refused: "token-gated entry is not the canvas (kind canvas)" };
	const bad = canvasPathError(entry.url);
	if (bad !== undefined) return { refused: bad };
	const url = `${entry.url}?k=${encodeURIComponent(token)}`;
	// Re-validate the composed URL's path immediately before it leaves the server: the entry had no
	// query or fragment, so the composed path is everything before the appended "?k=".
	const path = url.slice(0, url.indexOf("?"));
	if (canvasPathError(path) !== undefined) return { refused: "composed token link is not a same-origin canvas path" };
	return { url };
}

/**
 * Read the artifacts list. Reads DATA_DIR/artifacts.json at every call (no caching — the agent may
 * edit the file between requests) and never throws: absent, unreadable, invalid-JSON or wrong-
 * top-level-shape files fall back to the built-in defaults. Malformed individual entries inside an
 * otherwise-valid file are skipped and counted, never a reason to break the whole panel.
 */
export async function loadArtifacts(dataDir: string = config.dataDir): Promise<Artifacts> {
	let text: string;
	try {
		text = await readFile(join(dataDir, ARTIFACTS_FILE), "utf8");
	} catch {
		return fromDefaults();
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(text);
	} catch {
		return fromDefaults();
	}
	if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return fromDefaults();
	const list = (parsed as Record<string, unknown>).artifacts;
	if (!Array.isArray(list)) return fromDefaults();

	const entries: ArtifactEntry[] = [];
	const skipped: SkippedEntry[] = [];
	for (const raw of list) {
		const result = parseEntry(raw);
		if ("skip" in result) {
			skipped.push(result.skip);
			continue;
		}
		if (entries.some((entry) => entry.id === result.entry.id)) {
			skipped.push({ id: result.entry.id, reason: "duplicate id" });
			continue;
		}
		entries.push(result.entry);
	}
	return { entries, skipped, source: "file" };
}
