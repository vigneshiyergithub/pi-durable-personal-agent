// The three external systems a coding task touches, each with the narrowest credential that works:
// - Railway: an environment-scoped project token for the separate "agent-sandboxes" project. It can create, run, read
//   and delete containers there, and is refused everywhere else (verified: "Not Authorized" on the agent's project).
// - GitHub: a GitHub App on a dedicated org. A container only ever gets a 1-hour READ token for one repo. Its commits
//   come back as a git bundle and the agent pushes them, only ever to an agent/... branch. Repo creation, PRs and merges
//   use their own narrowly scoped tokens and stay in the agent, never in a container.
// - OpenRouter: a management key that mints a fresh model key per attempt, with a spend cap, deleted afterwards.
import { execFile } from "node:child_process";
import { createHash, createSign, randomBytes } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { config } from "./config.ts";

const sha256 = (value: string) => createHash("sha256").update(value).digest("hex");
export const newSecret = () => randomBytes(32).toString("base64url");
export const hashSecret = sha256;
/** The raw diff's character cap: the same review render budget as the reviewer input (src/config.ts), so a larger
 *  budget is not pre-empted by compare() keeping a smaller head. */
const REVIEW_DIFF_CHARS = config.reviewDiffChars;

// ── Railway ──────────────────────────────────────────────────────────────────────────────────────────────────────────

/** Import into a fresh bare receiver. Production supplies only its configured GitHub repository as the remote. */
export async function receiveBundle(
	git: (...args: string[]) => Promise<{ stdout: string }>, file: string, branch: string, remote: string, prerequisite?: string, expectedHead?: string,
): Promise<string> {
	if (!/^agent\/[\w.-]+$/.test(branch)) throw new Error("only agent/... branches");
	if (prerequisite) {
		if (!/^[a-f0-9]{40}$/.test(prerequisite)) throw new Error("invalid bundle prerequisite");
		await git("--git-dir", "repo.git", "fetch", "--quiet", remote, prerequisite);
	}
	await git("--git-dir", "repo.git", "bundle", "verify", file);
	await git("--git-dir", "repo.git", "fetch", "--quiet", file, `HEAD:refs/heads/${branch}`);
	const head = (await git("--git-dir", "repo.git", "rev-parse", `refs/heads/${branch}`)).stdout.trim();
	if (expectedHead && (!/^[a-f0-9]{40}$/.test(expectedHead) || head !== expectedHead)) throw new Error("bundle head does not match the independently verified commit");
	return head;
}

export class RailwaySandboxes {
	private async gql<T>(query: string, variables: Record<string, unknown>): Promise<T> {
		const { sandboxToken } = config.sandbox;
		if (!sandboxToken) throw new Error("SANDBOX_RAILWAY_TOKEN is not set");
		const response = await fetch("https://backboard.railway.com/graphql/v2", {
			method: "POST",
			headers: { "content-type": "application/json", "project-access-token": sandboxToken },
			body: JSON.stringify({ query, variables }),
			signal: AbortSignal.timeout(30_000),
		});
		const body = (await response.json()) as { data?: T; errors?: Array<{ message: string }> };
		if (body.errors?.length) throw new Error(`railway: ${body.errors.map((e) => e.message).join("; ")}`);
		return body.data as T;
	}

	/** Creates a container from the stock node image and starts it once. Returns the service id. */
	async launch(name: string, variables: Record<string, string>, startCommand: string, onCreated?: (serviceId: string) => Promise<void>): Promise<{ serviceId: string; deploymentId: string }> {
		const { projectId, environmentId } = config.sandbox;
		const { serviceCreate } = await this.gql<{ serviceCreate: { id: string } }>(
			`mutation($i: ServiceCreateInput!) { serviceCreate(input: $i) { id } }`,
			{ i: { projectId, environmentId, name, variables } },
		);
		const serviceId = serviceCreate.id;
		try {
			await onCreated?.(serviceId);
			await this.gql(
				`mutation($e: String!, $s: String!, $i: ServiceInstanceUpdateInput!) { serviceInstanceUpdate(environmentId: $e, serviceId: $s, input: $i) }`,
				{ e: environmentId, s: serviceId, i: { source: { image: config.sandbox.image }, startCommand, restartPolicyType: "NEVER" } },
			);
			await this.gql(
				`mutation($i: ServiceInstanceLimitsUpdateInput!) { serviceInstanceLimitsUpdate(input: $i) }`,
				{ i: { environmentId, serviceId, vCPUs: config.sandbox.vCPUs, memoryGB: config.sandbox.memoryGB } },
			);
			const { serviceInstanceDeployV2 } = await this.gql<{ serviceInstanceDeployV2: string }>(
				`mutation($e: String!, $s: String!) { serviceInstanceDeployV2(environmentId: $e, serviceId: $s) }`,
				{ e: environmentId, s: serviceId },
			);
			return { serviceId, deploymentId: serviceInstanceDeployV2 };
		} catch (error) {
			await this.destroy(serviceId).catch(() => {});
			throw error;
		}
	}

	async logs(deploymentId: string, limit = 80): Promise<string> {
		const { deploymentLogs } = await this.gql<{ deploymentLogs: Array<{ message: string }> }>(
			`query($id: String!, $n: Int) { deploymentLogs(deploymentId: $id, limit: $n) { message } }`,
			{ id: deploymentId, n: limit },
		);
		return deploymentLogs.map((l) => l.message).join("\n");
	}

	async destroy(serviceId: string): Promise<void> {
		await this.gql(`mutation($e: String!, $s: String!) { serviceDelete(environmentId: $e, id: $s) }`, {
			e: config.sandbox.environmentId,
			s: serviceId,
		});
	}

	/** Every container currently in the sandbox project, for sweeping up anything left behind. */
	async list(): Promise<Array<{ id: string; name: string }>> {
		const { project } = await this.gql<{ project: { services: { edges: Array<{ node: { id: string; name: string } }> } } }>(
			`query($p: String!) { project(id: $p) { services { edges { node { id name } } } } }`,
			{ p: config.sandbox.projectId },
		);
		return project.services.edges.map((e) => e.node);
	}
}

// ── GitHub App ───────────────────────────────────────────────────────────────────────────────────────────────────────

type AppCredentials = { appId: number; slug: string; privateKey: string; installationId?: number; org?: string };
const credentialsFile = () => join(config.dataDir, "secrets", "github-app.json");

export async function readGitHubApp(): Promise<AppCredentials | undefined> {
	try {
		return JSON.parse(await readFile(credentialsFile(), "utf8")) as AppCredentials;
	} catch {
		return undefined;
	}
}

export async function writeGitHubApp(credentials: AppCredentials): Promise<void> {
	await mkdir(join(config.dataDir, "secrets"), { recursive: true, mode: 0o700 });
	await writeFile(credentialsFile(), JSON.stringify(credentials, null, 2), { mode: 0o600 });
}

const b64url = (value: string | Buffer) => Buffer.from(value).toString("base64url");

/** A 9-minute JWT that identifies the app itself (only used to mint installation tokens). */
function appJwt(appId: number, privateKey: string): string {
	const now = Math.floor(Date.now() / 1000);
	const header = b64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
	const payload = b64url(JSON.stringify({ iat: now - 30, exp: now + 540, iss: appId }));
	const signature = createSign("RSA-SHA256").update(`${header}.${payload}`).sign(privateKey);
	return `${header}.${payload}.${b64url(signature)}`;
}

/**
 * Swaps in a new private key for the GitHub App (key rotation). The key must sign for this app: GitHub has to accept
 * it before anything is written, so a wrong or mistyped key never replaces a working one.
 */
export async function replaceGitHubAppKey(privateKey: string): Promise<{ slug: string }> {
	const current = await readGitHubApp();
	if (!current) throw new Error("the GitHub App is not set up yet");
	const key = privateKey.trim();
	if (!/^-----BEGIN (RSA )?PRIVATE KEY-----[\s\S]+-----END (RSA )?PRIVATE KEY-----$/.test(key)) throw new Error("that is not a PEM private key");
	const response = await fetch("https://api.github.com/app", {
		headers: { accept: "application/vnd.github+json", authorization: `Bearer ${appJwt(current.appId, key)}`, "user-agent": "pi-durable-agent" },
		signal: AbortSignal.timeout(30_000),
	});
	const app = (await response.json().catch(() => ({}))) as { id?: number; slug?: string };
	if (!response.ok || app.id !== current.appId) throw new Error(`GitHub did not accept this key for ${current.slug} (${response.status})`);
	await writeGitHubApp({ ...current, privateKey: `${key}\n` });
	return { slug: current.slug };
}

export class GitHubApp {
	private async credentials(): Promise<AppCredentials & { installationId: number; org: string }> {
		const credentials = await readGitHubApp();
		if (!credentials) throw new Error("the GitHub App is not set up yet");
		if (!credentials.installationId || !credentials.org) {
			const [installation] = await this.asApp<Array<{ id: number; account: { login: string } }>>("GET", "/app/installations", credentials);
			if (!installation) throw new Error(`the GitHub App "${credentials.slug}" is not installed on an org yet`);
			credentials.installationId = installation.id;
			credentials.org = installation.account.login;
			await writeGitHubApp(credentials);
		}
		return credentials as AppCredentials & { installationId: number; org: string };
	}

	private jwt(credentials: AppCredentials): string {
		return appJwt(credentials.appId, credentials.privateKey);
	}

	/** JSON by default; pass `accept: "application/vnd.github.diff"` to get the raw text back instead. */
	private async request<T>(method: string, path: string, token: string, body?: unknown, options: { accept?: string; timeoutMs?: number } = {}): Promise<T> {
		const accept = options.accept ?? "application/vnd.github+json";
		const response = await fetch(`https://api.github.com${path}`, {
			method,
			headers: { accept, authorization: `Bearer ${token}`, "x-github-api-version": "2022-11-28", "user-agent": "pi-durable-agent" },
			body: body === undefined ? undefined : JSON.stringify(body),
			signal: AbortSignal.timeout(options.timeoutMs ?? 30_000),
		});
		const text = await response.text();
		if (!response.ok) throw new Error(`github ${method} ${path}: ${response.status} ${text.slice(0, 300)}`);
		if (accept !== "application/vnd.github+json") return text as T;
		return (text ? JSON.parse(text) : {}) as T;
	}

	private asApp<T>(method: string, path: string, credentials: AppCredentials, body?: unknown): Promise<T> {
		return this.request<T>(method, path, this.jwt(credentials), body);
	}

	/** A token for exactly these repositories and permissions, valid for one hour. */
	async token(repos: string[], permissions: Record<string, "read" | "write">): Promise<string> {
		const credentials = await this.credentials();
		const { token } = await this.asApp<{ token: string }>("POST", `/app/installations/${credentials.installationId}/access_tokens`, credentials, {
			repositories: repos.map((r) => r.split("/").pop()!),
			permissions,
		});
		return token;
	}

	async org(): Promise<string> {
		return (await this.credentials()).org;
	}

	/** Creates a private repo in the org. Uses an org-wide administration token that never leaves the agent. */
	async createRepo(name: string, description: string): Promise<{ fullName: string; defaultBranch: string }> {
		const credentials = await this.credentials();
		const { token } = await this.asApp<{ token: string }>("POST", `/app/installations/${credentials.installationId}/access_tokens`, credentials, {
			permissions: { administration: "write", contents: "write" },
		});
		const repo = await this.request<{ full_name: string; default_branch: string }>("POST", `/orgs/${credentials.org}/repos`, token, {
			name,
			description,
			private: true,
			auto_init: true,
		});
		return { fullName: repo.full_name, defaultBranch: repo.default_branch };
	}

	async openPullRequest(repo: string, head: string, base: string, title: string, body: string): Promise<{ number: number; url: string }> {
		const token = await this.token([repo], { pull_requests: "write", contents: "read" });
		const existing = await this.request<Array<{ number: number; html_url: string }>>("GET", `/repos/${repo}/pulls?head=${repo.split("/")[0]}:${head}&state=open`, token);
		if (existing[0]) return { number: existing[0].number, url: existing[0].html_url };
		const pr = await this.request<{ number: number; html_url: string }>("POST", `/repos/${repo}/pulls`, token, { head, base, title, body });
		return { number: pr.number, url: pr.html_url };
	}

	/**
	 * Pushes a container's commits (a git bundle of its branch) to `branch`. Only agent/... branches can be written, so
	 * nothing a container produces can land on a default branch except through a reviewed PR. Not a force push.
	 */
	async pushBundle(repo: string, branch: string, bundleBase64: string, prerequisite?: string, expectedHead?: string): Promise<string> {
		if (!/^agent\/[\w.-]+$/.test(branch)) throw new Error(`refusing to push to ${branch}: only agent/... branches`);
		const token = await this.token([repo], { contents: "write" });
		const dir = await mkdtemp(join(tmpdir(), "bundle-"));
		const git = (...args: string[]) => promisify(execFile)("git", args, { cwd: dir, maxBuffer: 50 * 2 ** 20 });
		try {
			await writeFile(join(dir, "branch.bundle"), Buffer.from(bundleBase64, "base64"));
			await git("init", "--quiet", "--bare", "repo.git");
			const head = await receiveBundle(git, join(dir, "branch.bundle"), branch, `https://x-access-token:${token}@github.com/${repo}.git`, prerequisite, expectedHead);
			await git("--git-dir", "repo.git", "push", "--quiet", `https://x-access-token:${token}@github.com/${repo}.git`, `refs/heads/${branch}:refs/heads/${branch}`);
			return head;
		} catch (error) {
			throw new Error(String(error instanceof Error ? error.message : error).replaceAll(token, "***"));
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	}

	/** The full diff of head against base (three-dot compare), for the reviewer. */
	async compare(repo: string, base: string, head: string): Promise<{ headSha: string; diff: string; files: number; paths: string[]; truncated: boolean }> {
		const token = await this.token([repo], { contents: "read" });
		const path = `/repos/${repo}/compare/${encodeURIComponent(base)}...${encodeURIComponent(head)}`;
		const info = await this.request<{ merge_base_commit: { sha: string }; files: Array<{ filename: string; previous_filename?: string }>; commits: Array<{ sha: string }> }>("GET", path, token);
		const headSha = info.commits.at(-1)?.sha ?? (await this.request<{ sha: string }>("GET", `/repos/${repo}/commits/${encodeURIComponent(head)}`, token)).sha;
		const raw = await this.request<string>("GET", path, token, undefined, { accept: "application/vnd.github.diff", timeoutMs: 60_000 });
		const truncated = raw.length > REVIEW_DIFF_CHARS;
		// A rename touches both its old and new path.
		const paths = [...new Set(info.files.flatMap((f) => [f.filename, ...(f.previous_filename ? [f.previous_filename] : [])]))];
		return { headSha, diff: truncated ? raw.slice(0, REVIEW_DIFF_CHARS) : raw, files: info.files.length, paths, truncated };
	}

	/** Whether `descendant` contains `ancestor` (the same commit, or ahead of it). Cheap: no diff is fetched. */
	async contains(repo: string, ancestor: string, descendant: string): Promise<boolean> {
		const token = await this.token([repo], { contents: "read" });
		const c = await this.request<{ status: string }>("GET", `/repos/${repo}/compare/${encodeURIComponent(ancestor)}...${encodeURIComponent(descendant)}`, token);
		return c.status === "identical" || c.status === "ahead";
	}

	/** A PR's current head, state and mergeability (mergeable is null while GitHub is still computing it). */
	async pullRequest(
		repo: string,
		number: number,
	): Promise<{ headSha: string; state: "open" | "closed"; merged: boolean; mergeable: boolean | null; mergeSha?: string }> {
		const token = await this.token([repo], { pull_requests: "read", contents: "read" });
		const pr = await this.request<{ head: { sha: string }; state: "open" | "closed"; merged: boolean; mergeable: boolean | null; merge_commit_sha: string | null }>(
			"GET",
			`/repos/${repo}/pulls/${number}`,
			token,
		);
		return { headSha: pr.head.sha, state: pr.state, merged: pr.merged, mergeable: pr.mergeable, ...(pr.merged && pr.merge_commit_sha ? { mergeSha: pr.merge_commit_sha } : {}) };
	}

	/** Posts a comment on a PR (issue comments endpoint). */
	async comment(repo: string, number: number, body: string): Promise<void> {
		const token = await this.token([repo], { pull_requests: "write" });
		await this.request("POST", `/repos/${repo}/issues/${number}/comments`, token, { body });
	}

	/** Squash-merges a PR. With `sha`, GitHub refuses the merge unless the head is still that commit. */
	/** Squash-merges a PR and returns the commit it made on the base branch. With `sha`, only if the head is still that. */
	async merge(repo: string, number: number, sha?: string): Promise<{ sha: string }> {
		const token = await this.token([repo], { pull_requests: "write", contents: "write" });
		const merged = await this.request<{ sha: string }>("PUT", `/repos/${repo}/pulls/${number}/merge`, token, { merge_method: "squash", ...(sha ? { sha } : {}) });
		return { sha: merged.sha };
	}

	/**
	 * Reverts one commit of the base branch onto a new agent/revert-... branch (for a rollback): a shallow clone, `git
	 * revert`, and a push of that branch only. Returns the branch, ready for a PR.
	 */
	async revertCommit(repo: string, base: string, sha: string): Promise<{ branch: string }> {
		if (!/^[0-9a-f]{7,40}$/.test(sha)) throw new Error(`not a commit sha: ${sha}`);
		const branch = `agent/revert-${sha.slice(0, 7)}`;
		const token = await this.token([repo], { contents: "write" });
		const dir = await mkdtemp(join(tmpdir(), "revert-"));
		const git = (...args: string[]) => promisify(execFile)("git", args, { cwd: dir, maxBuffer: 50 * 2 ** 20 });
		const remote = `https://x-access-token:${token}@github.com/${repo}.git`;
		try {
			await git("init", "--quiet");
			await git("fetch", "--quiet", "--depth", "30", remote, `refs/heads/${base}`);
			await git("checkout", "--quiet", "-b", branch, "FETCH_HEAD");
			// A merge commit (the owner merged with "Create a merge commit") is reverted against its first parent.
			const parents = (await git("rev-list", "--parents", "-n", "1", sha)).stdout.trim().split(" ").length - 1;
			await git("-c", `user.name=${config.sandbox.gitName}`, "-c", `user.email=${config.sandbox.gitEmail}`, "revert", "--no-edit", ...(parents > 1 ? ["-m", "1"] : []), sha);
			await git("push", "--quiet", remote, `HEAD:refs/heads/${branch}`);
			return { branch };
		} catch (error) {
			throw new Error(String(error instanceof Error ? error.message : error).replaceAll(token, "***"));
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	}
}

// ── OpenRouter keys ──────────────────────────────────────────────────────────────────────────────────────────────────

export class ModelKeys {
	private async call<T>(method: string, path: string, body?: unknown): Promise<T> {
		if (!config.sandbox.openrouterManagementKey) throw new Error("OPENROUTER_MANAGEMENT_KEY is not set");
		const response = await fetch(`https://openrouter.ai/api/v1${path}`, {
			method,
			headers: { "content-type": "application/json", authorization: `Bearer ${config.sandbox.openrouterManagementKey}` },
			body: body === undefined ? undefined : JSON.stringify(body),
			signal: AbortSignal.timeout(30_000),
		});
		const text = await response.text();
		if (!response.ok) throw new Error(`openrouter ${method} ${path}: ${response.status} ${text.slice(0, 200)}`);
		return (text ? JSON.parse(text) : {}) as T;
	}

	/** A model key that can spend at most `limitUsd`, for one attempt. */
	async create(name: string, limitUsd: number): Promise<{ key: string; hash: string }> {
		const created = await this.call<{ key?: string; data?: { key?: string; hash: string } }>("POST", "/keys", { name, limit: limitUsd });
		const key = created.key ?? created.data?.key;
		const hash = created.data?.hash;
		if (!key || !hash) throw new Error("openrouter did not return a key");
		return { key, hash };
	}

	async delete(hash: string): Promise<void> {
		await this.call("DELETE", `/keys/${hash}`);
	}
}
