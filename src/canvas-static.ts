import { timingSafeEqual } from "node:crypto";
import { lstat, readFile, realpath } from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import { extname, join, resolve, sep } from "node:path";

const PREFIX = "/canvas";
const COOKIE_NAME = "canvas_access";
const COOKIE_MAX_AGE = 30 * 24 * 60 * 60; // ~30 days

const TYPES: Record<string, string> = {
	".html": "text/html; charset=utf-8",
	".svg": "image/svg+xml",
	".png": "image/png",
	".json": "application/json",
};

const ALLOWED_EXTS = new Set(Object.keys(TYPES));

/**
 * Sent on every /canvas response. Canvas files are written by the agent (model-driven code) and served from the same
 * origin as the owner's passkey-protected app, so they must never run script in that origin: a page that could would
 * act with the owner's session (approve plans, mint recovery codes). The CSP sandbox disables scripts, forms, popups
 * and plugins in canvas documents (HTML and SVG alike); allow-same-origin only keeps the gallery's own images
 * loadable with its cookie. The gallery must therefore be static: images and CSS, no JavaScript.
 */
export const CANVAS_HEADERS = {
	"x-content-type-options": "nosniff",
	"content-security-policy":
		"sandbox allow-same-origin; default-src 'none'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; font-src 'self' data:; media-src 'self'; script-src 'none'; connect-src 'none'; object-src 'none'; frame-src 'none'; frame-ancestors 'none'; form-action 'none'; base-uri 'none'",
	"x-frame-options": "DENY",
	"referrer-policy": "no-referrer",
	"cross-origin-opener-policy": "same-origin",
	"cross-origin-resource-policy": "same-origin",
	"permissions-policy": "camera=(), microphone=(), geolocation=(), payment=(), usb=(), publickey-credentials-get=(), publickey-credentials-create=()",
} as const;

/** Decode a cookie value by name from a Cookie header, if present. */
function cookieValue(header: string | undefined, name: string): string | undefined {
	if (!header) return undefined;
	for (const part of header.split(";")) {
		const idx = part.indexOf("=");
		if (idx === -1) continue;
		const key = part.slice(0, idx).trim();
		const value = part.slice(idx + 1).trim();
		if (key === name) {
			try {
				return decodeURIComponent(value);
			} catch {
				return value;
			}
		}
	}
	return undefined;
}

/** Constant-time string comparison. Length mismatch is leaked but values are not. */
function constantTimeEqual(a: string, b: string): boolean {
	const ab = Buffer.from(a);
	const bb = Buffer.from(b);
	if (ab.length !== bb.length) return false;
	return timingSafeEqual(ab, bb);
}

export interface ResolveResult {
	ok: true;
	file: string;
}

export interface RejectResult {
	ok: false;
	reason: string;
}

/**
 * Resolve a request path to a real file under the canvas public root.
 *
 * This is the security-critical helper: it rejects NUL bytes, backslashes,
 * percent-encoded traversal, double-encoded traversal, absolute paths, `..`
 * segments, symlinks escaping the root, directories, and non-regular files.
 */
export async function resolveCanvasPath(
	root: string,
	rawUrl: string,
	pathname: string,
): Promise<ResolveResult | RejectResult> {
	// Reject NUL bytes and backslashes in both raw and decoded forms.
	if (rawUrl.includes("\0") || rawUrl.includes("%00")) return { ok: false, reason: "nul byte" };
	if (rawUrl.includes("\\") || /%5[cC]/.test(rawUrl)) return { ok: false, reason: "backslash" };
	if (pathname.includes("\0") || pathname.includes("\\")) return { ok: false, reason: "nul or backslash" };
	// Reject encoded path separators / dots that could be double-decoded by a proxy.
	if (/%2[eE]|%2[fF]|%5[cC]|%00/.test(pathname)) return { ok: false, reason: "encoded separator" };

	if (pathname !== PREFIX && !pathname.startsWith(PREFIX + "/")) return { ok: false, reason: "prefix" };
	let sub = pathname.slice(PREFIX.length);
	if (sub.startsWith("/")) sub = sub.slice(1);

	const segments = sub.split("/");
	if (segments.some((s) => s === "..")) return { ok: false, reason: "traversal" };

	let realRoot: string;
	try {
		realRoot = await realpath(root);
	} catch {
		realRoot = resolve(root);
	}

	const candidate = sub === "" ? realRoot : resolve(realRoot, sub);

	let realCandidate: string;
	try {
		realCandidate = await realpath(candidate);
	} catch {
		return { ok: false, reason: "not found" };
	}

	if (realCandidate !== realRoot && !realCandidate.startsWith(realRoot + sep)) {
		return { ok: false, reason: "outside root" };
	}

	let stats: import("node:fs").Stats;
	try {
		stats = await lstat(realCandidate);
	} catch {
		return { ok: false, reason: "not found" };
	}

	if (stats.isDirectory()) {
		if (realCandidate === realRoot && sub === "") {
			const indexPath = join(realRoot, "index.html");
			let realIndex: string;
			try {
				realIndex = await realpath(indexPath);
			} catch {
				return { ok: false, reason: "missing index" };
			}
			if (realIndex !== realRoot && realIndex.startsWith(realRoot + sep)) {
				return { ok: true, file: realIndex };
			}
			return { ok: false, reason: "index outside root" };
		}
		return { ok: false, reason: "directory listing" };
	}

	if (!stats.isFile()) return { ok: false, reason: "not a regular file" };
	return { ok: true, file: realCandidate };
}

/** Read the bearer token from query string or cookie. */
function extractToken(request: IncomingMessage, url: URL): { fromQuery: string | undefined; fromCookie: string | undefined } {
	return {
		fromQuery: url.searchParams.get("k") ?? undefined,
		fromCookie: cookieValue(request.headers.cookie, COOKIE_NAME),
	};
}

/**
 * True when the request arrived over TLS: either a directly-TLS connection or,
 * on Railway, an HTTPS request the proxy forwarded (x-forwarded-proto). Plain
 * http (a local `node src/main.ts` on http://localhost) is not secure, so the
 * cookie is left without the Secure attribute there.
 */
function isSecureRequest(request: IncomingMessage): boolean {
	const forwarded = request.headers["x-forwarded-proto"];
	const first = (Array.isArray(forwarded) ? forwarded[0] : forwarded)?.split(",")[0]?.trim().toLowerCase();
	if (first === "https") return true;
	return (request.socket as { encrypted?: boolean } | undefined)?.encrypted === true;
}

/**
 * Factory for the /canvas static handler.
 *
 * @param root - Absolute path to the public canvas tree.
 * @param token - Shared access token. If empty, the route is disabled (404).
 */
export function createCanvasHandler(root: string, token: string) {
	return async (request: IncomingMessage, response: ServerResponse): Promise<void> => {
		if (!token) {
			response.writeHead(404, { "content-type": "text/plain", ...CANVAS_HEADERS });
			response.end("Not found");
			return;
		}

		let url: URL;
		try {
			url = new URL(request.url ?? "/", "http://localhost");
		} catch {
			response.writeHead(404, { "content-type": "text/plain", ...CANVAS_HEADERS });
			response.end("Not found");
			return;
		}

		// Authentication comes before the method check so an unauthenticated
		// request of any method gets the uniform 401, never a 405 that confirms
		// the route exists.
		const { fromQuery, fromCookie } = extractToken(request, url);
		const queryOk = fromQuery !== undefined && constantTimeEqual(token, fromQuery);
		const cookieOk = fromCookie !== undefined && constantTimeEqual(token, fromCookie);

		if (!queryOk && !cookieOk) {
			response.writeHead(401, { "content-type": "text/plain", ...CANVAS_HEADERS });
			response.end("Unauthorized");
			return;
		}

		if (request.method !== "GET" && request.method !== "HEAD") {
			response.writeHead(405, { "content-type": "text/plain", ...CANVAS_HEADERS });
			response.end("Method not allowed");
			return;
		}

		// Defensive: only ever redirect back into the canvas prefix, so the
		// Location can never become an off-site or protocol-relative target.
		const inPrefix = url.pathname === PREFIX || url.pathname.startsWith(`${PREFIX}/`);
		if (!inPrefix) {
			response.writeHead(404, { "content-type": "text/plain", ...CANVAS_HEADERS });
			response.end("Not found");
			return;
		}

		if (queryOk) {
			// Drop the token from the address bar by redirecting to the same canvas
			// path without the query (a bare /canvas becomes /canvas/ so the page's
			// relative links resolve under the route).
			const secure = isSecureRequest(request) ? "; Secure" : "";
			response.writeHead(302, {
				location: url.pathname === PREFIX ? `${PREFIX}/` : url.pathname,
				...CANVAS_HEADERS,
				"set-cookie": `${COOKIE_NAME}=${encodeURIComponent(token)}; HttpOnly; SameSite=Lax; Path=${PREFIX}; Max-Age=${COOKIE_MAX_AGE}${secure}`,
			});
			response.end();
			return;
		}

		// Already authenticated by cookie: a bare /canvas has no trailing slash, so
		// relative links in the page would resolve against the origin root. Send it
		// to /canvas/ rather than serving the index at the wrong base.
		if (url.pathname === PREFIX) {
			response.writeHead(302, { location: `${PREFIX}/`, ...CANVAS_HEADERS });
			response.end();
			return;
		}

		const resolved = await resolveCanvasPath(root, request.url ?? "/", url.pathname);
		if (!resolved.ok) {
			response.writeHead(404, { "content-type": "text/plain", ...CANVAS_HEADERS });
			response.end("Not found");
			return;
		}

		const ext = extname(resolved.file).toLowerCase();
		if (!ALLOWED_EXTS.has(ext)) {
			response.writeHead(404, { "content-type": "text/plain", ...CANVAS_HEADERS });
			response.end("Not found");
			return;
		}

		let data: Buffer;
		try {
			data = await readFile(resolved.file);
		} catch {
			response.writeHead(404, { "content-type": "text/plain", ...CANVAS_HEADERS });
			response.end("Not found");
			return;
		}

		response.writeHead(200, {
			"content-type": TYPES[ext]!,
			...CANVAS_HEADERS,
			"cache-control": "no-cache",
		});

		if (request.method === "HEAD") {
			response.end();
		} else {
			response.end(data);
		}
	};
}
