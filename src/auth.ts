// Owner authentication: passkeys (WebAuthn) instead of a shared bearer token. Signing in with a passkey (Touch ID,
// Face ID, a security key) creates a 24-hour session in an HttpOnly, Secure, SameSite=Strict cookie. Eight one-time
// recovery codes, shown once at enrolment, let the owner back in to add a new passkey if a device is lost.
//
// Nothing secret is stored in the clear: passkeys are public keys, and sessions and recovery codes are kept only as
// SHA-256 hashes, in DATA_DIR/secrets/owner.json (mode 600), so they survive deploys. The very first passkey is enrolled
// with the legacy AUTH_TOKEN, once; after that AUTH_TOKEN can be removed and bearer access stops entirely.
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import { join } from "node:path";
import {
	generateAuthenticationOptions,
	generateRegistrationOptions,
	verifyAuthenticationResponse,
	verifyRegistrationResponse,
} from "@simplewebauthn/server";
import { config } from "./config.ts";

const SESSION_MS = 24 * 60 * 60_000;
const CHALLENGE_MS = 5 * 60_000;
const COOKIE = "agent_session";
const RECOVERY_CODES = 8;

type StoredCredential = {
	id: string;
	/** base64url of the COSE public key */
	publicKey: string;
	counter: number;
	transports?: string[];
	name: string;
	createdAt: string;
	lastUsedAt?: string;
};

type OwnerFile = {
	userId: string;
	credentials: StoredCredential[];
	/** SHA-256 of unused recovery codes */
	recoveryCodes: string[];
	sessions: Array<{ hash: string; expires: number; via: "passkey" | "recovery" | "bootstrap" }>;
};

const sha256 = (value: string) => createHash("sha256").update(value).digest("hex");
const file = () => join(config.dataDir, "secrets", "owner.json");

function sameSecret(a: string, b: string): boolean {
	const x = Buffer.from(a);
	const y = Buffer.from(b);
	return x.length === y.length && timingSafeEqual(x, y);
}

/** Codes like "K7QF-2M9X-HD3P": 60 bits, unambiguous characters. */
function recoveryCode(): string {
	const alphabet = "23456789ABCDEFGHJKLMNPQRSTUVWXYZ";
	const bytes = randomBytes(12);
	const chars = [...bytes].map((b) => alphabet[b % alphabet.length]).join("");
	return `${chars.slice(0, 4)}-${chars.slice(4, 8)}-${chars.slice(8, 12)}`;
}
const normalizeCode = (code: string) => code.toUpperCase().replace(/[^0-9A-Z]/g, "");

export type Requester = { authenticated: boolean; via?: "session" | "bearer" };

export class OwnerAuth {
	private cache: OwnerFile | undefined;
	private readonly challenges = new Map<string, { kind: "register" | "login"; expires: number }>();
	private readonly attempts = new Map<string, number[]>();

	get rpID(): string {
		return config.auth.rpId;
	}

	private async load(): Promise<OwnerFile> {
		if (this.cache) return this.cache;
		try {
			this.cache = JSON.parse(await readFile(file(), "utf8")) as OwnerFile;
		} catch {
			this.cache = { userId: randomBytes(16).toString("base64url"), credentials: [], recoveryCodes: [], sessions: [] };
		}
		return this.cache;
	}

	private async save(): Promise<void> {
		const data = this.cache!;
		data.sessions = data.sessions.filter((s) => s.expires > Date.now());
		await mkdir(join(config.dataDir, "secrets"), { recursive: true, mode: 0o700 });
		const tmp = `${file()}.tmp`;
		await writeFile(tmp, JSON.stringify(data, null, 2), { mode: 0o600 });
		await rename(tmp, file());
	}

	async enrolled(): Promise<boolean> {
		return (await this.load()).credentials.length > 0;
	}

	// ── Who is asking ──────────────────────────────────────────────────────────────────────────────────────────────

	private sessionId(request: IncomingMessage): string | undefined {
		for (const part of (request.headers.cookie ?? "").split(";")) {
			const [name, ...value] = part.trim().split("=");
			if (name === COOKIE) return value.join("=");
		}
		return undefined;
	}

	async requester(request: IncomingMessage): Promise<Requester> {
		const sid = this.sessionId(request);
		if (sid) {
			const hash = sha256(sid);
			const session = (await this.load()).sessions.find((s) => s.expires > Date.now() && sameSecret(s.hash, hash));
			if (session) return { authenticated: true, via: "session" };
		}
		// Legacy bearer token: only while AUTH_TOKEN is still configured. Remove it to turn this path off.
		const bearer = request.headers.authorization?.replace(/^Bearer\s+/i, "");
		if (config.authToken && bearer && sameSecret(bearer, config.authToken)) return { authenticated: true, via: "bearer" };
		return { authenticated: false };
	}

	/** Browsers send Origin on every POST; a session cookie is only honoured for requests from the app itself. */
	sameOrigin(request: IncomingMessage): boolean {
		const origin = request.headers.origin;
		return origin === undefined || config.auth.origins.includes(origin);
	}

	private async createSession(response: ServerResponse, via: OwnerFile["sessions"][number]["via"]): Promise<void> {
		const sid = randomBytes(32).toString("base64url");
		(await this.load()).sessions.push({ hash: sha256(sid), expires: Date.now() + SESSION_MS, via });
		await this.save();
		const secure = config.auth.origins[0]!.startsWith("https://") ? "; Secure" : "";
		response.setHeader("set-cookie", `${COOKIE}=${sid}; HttpOnly${secure}; SameSite=Strict; Path=/; Max-Age=${SESSION_MS / 1000}`);
	}

	async signOut(request: IncomingMessage, response: ServerResponse): Promise<void> {
		const sid = this.sessionId(request);
		if (sid) {
			const data = await this.load();
			data.sessions = data.sessions.filter((s) => !sameSecret(s.hash, sha256(sid)));
			await this.save();
		}
		response.setHeader("set-cookie", `${COOKIE}=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0`);
	}

	async signOutEverywhere(): Promise<void> {
		(await this.load()).sessions = [];
		await this.save();
	}

	// ── Rate limiting (per client IP) for anything that guesses a secret ───────────────────────────────────────────

	allow(request: IncomingMessage, limit = 10, windowMs = 5 * 60_000): boolean {
		const ip = String(request.headers["x-forwarded-for"] ?? request.socket.remoteAddress ?? "?").split(",")[0]!.trim();
		const now = Date.now();
		const recent = (this.attempts.get(ip) ?? []).filter((t) => now - t < windowMs);
		recent.push(now);
		this.attempts.set(ip, recent);
		return recent.length <= limit;
	}

	private takeChallenge(challenge: string, kind: "register" | "login"): boolean {
		const entry = this.challenges.get(challenge);
		this.challenges.delete(challenge);
		return entry !== undefined && entry.kind === kind && entry.expires > Date.now();
	}

	private rememberChallenge(challenge: string, kind: "register" | "login"): void {
		for (const [c, e] of this.challenges) if (e.expires < Date.now()) this.challenges.delete(c);
		this.challenges.set(challenge, { kind, expires: Date.now() + CHALLENGE_MS });
	}

	// ── Passkeys ───────────────────────────────────────────────────────────────────────────────────────────────────

	async registrationOptions() {
		const data = await this.load();
		const options = await generateRegistrationOptions({
			rpName: "Personal Agent",
			rpID: this.rpID,
			userName: "owner",
			userDisplayName: "Owner",
			userID: Buffer.from(data.userId, "base64url"),
			attestationType: "none",
			excludeCredentials: data.credentials.map((c) => ({ id: c.id, transports: c.transports })),
			authenticatorSelection: { residentKey: "required", userVerification: "required" },
		});
		this.rememberChallenge(options.challenge, "register");
		return options;
	}

	/** Stores a new passkey. The first one also creates the recovery codes, returned exactly once. */
	async register(response: ServerResponse, body: { response: unknown; name?: unknown }): Promise<{ recoveryCodes?: string[] }> {
		const data = await this.load();
		const verified = await verifyRegistrationResponse({
			response: body.response as never,
			expectedChallenge: (challenge) => this.takeChallenge(challenge, "register"),
			expectedOrigin: config.auth.origins,
			expectedRPID: this.rpID,
			requireUserVerification: true,
		});
		if (!verified.verified || !verified.registrationInfo) throw new Error("passkey registration was not verified");
		const { credential } = verified.registrationInfo;
		const first = data.credentials.length === 0;
		data.credentials.push({
			id: credential.id,
			publicKey: Buffer.from(credential.publicKey).toString("base64url"),
			counter: credential.counter,
			transports: credential.transports,
			name: typeof body.name === "string" && body.name.trim() ? body.name.trim().slice(0, 60) : "Passkey",
			createdAt: new Date().toISOString(),
		});
		let recoveryCodes: string[] | undefined;
		if (first) {
			recoveryCodes = Array.from({ length: RECOVERY_CODES }, recoveryCode);
			data.recoveryCodes = recoveryCodes.map((c) => sha256(normalizeCode(c)));
		}
		await this.save();
		if (first) await this.createSession(response, "bootstrap");
		return recoveryCodes ? { recoveryCodes } : {};
	}

	async authenticationOptions() {
		const data = await this.load();
		const options = await generateAuthenticationOptions({
			rpID: this.rpID,
			allowCredentials: data.credentials.map((c) => ({ id: c.id, transports: c.transports })),
			userVerification: "required",
		});
		this.rememberChallenge(options.challenge, "login");
		return options;
	}

	async signIn(response: ServerResponse, body: { response: { id?: string } }): Promise<void> {
		const data = await this.load();
		const stored = data.credentials.find((c) => c.id === body.response?.id);
		if (!stored) throw new Error("unknown passkey");
		const verified = await verifyAuthenticationResponse({
			response: body.response as never,
			expectedChallenge: (challenge) => this.takeChallenge(challenge, "login"),
			expectedOrigin: config.auth.origins,
			expectedRPID: this.rpID,
			credential: { id: stored.id, publicKey: Buffer.from(stored.publicKey, "base64url"), counter: stored.counter, transports: stored.transports },
			requireUserVerification: true,
		});
		if (!verified.verified) throw new Error("passkey sign-in was not verified");
		stored.counter = verified.authenticationInfo.newCounter;
		stored.lastUsedAt = new Date().toISOString();
		await this.save();
		await this.createSession(response, "passkey");
	}

	// ── Recovery codes ─────────────────────────────────────────────────────────────────────────────────────────────

	/** Signs in with an unused recovery code, which is then spent. */
	async recover(response: ServerResponse, code: string): Promise<{ remaining: number }> {
		const data = await this.load();
		const hash = sha256(normalizeCode(code));
		const index = data.recoveryCodes.findIndex((h) => sameSecret(h, hash));
		if (index < 0) throw new Error("that recovery code is not valid");
		data.recoveryCodes.splice(index, 1);
		await this.save();
		await this.createSession(response, "recovery");
		return { remaining: data.recoveryCodes.length };
	}

	async regenerateRecoveryCodes(): Promise<string[]> {
		const codes = Array.from({ length: RECOVERY_CODES }, recoveryCode);
		(await this.load()).recoveryCodes = codes.map((c) => sha256(normalizeCode(c)));
		await this.save();
		return codes;
	}

	async overview() {
		const data = await this.load();
		return {
			passkeys: data.credentials.map(({ id, name, createdAt, lastUsedAt }) => ({ id, name, createdAt, lastUsedAt: lastUsedAt ?? null })),
			recoveryCodesLeft: data.recoveryCodes.length,
			activeSessions: data.sessions.filter((s) => s.expires > Date.now()).length,
			bearerTokenEnabled: Boolean(config.authToken),
		};
	}

	async removePasskey(id: string): Promise<void> {
		const data = await this.load();
		if (data.credentials.length <= 1) throw new Error("you cannot remove your only passkey; add another one first");
		data.credentials = data.credentials.filter((c) => c.id !== id);
		await this.save();
	}
}

export const ownerAuth = new OwnerAuth();
