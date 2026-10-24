// Railway readiness and the PAUSE_ALL maintenance switch, run from the owner's machine.
//
//   npm run railway -- check    read-only: is Railway healthy enough for the agent to work again?
//   npm run railway -- pause    sets PAUSE_ALL=true on the agent service (goals paused, no jobs, no reflection)
//   npm run railway -- resume   runs every check, and only if all pass sets PAUSE_ALL=false (--force skips the gate)
//
// Needs the Railway CLI logged in (`railway login`) with this folder linked to the agent service (`railway link`).
// Setting a variable redeploys the agent from its last build; no new build is needed, so pause works while builds
// are paused, as long as Railway's API answers.
//
// Checks, each PASS / WARN / FAIL:
//   1. status.railway.com: no open incident on builds, deployments, the API, compute, sandboxes or GitHub deploys
//   2. the Railway CLI is logged in (the dashboard API answers for the owner)
//   3. the agent service's latest deployment is not failed or crashed
//   4. production /health answers, and runs origin/master (behind is a WARN: Railway deploys it once builds run)
//   5. the sandbox project token still works (the "railway: Not Authorized" container launches)
// Never prints a secret value.

import { execFile } from "node:child_process";
import { promisify } from "node:util";

const run = promisify(execFile);
/** Your agent's public address, e.g. https://<service>.up.railway.app. */
const AGENT_URL = (process.env.AGENT_URL ?? "").replace(/\/$/, "");
/** Status-page components whose outage stops the agent: deploys of itself, and its coding containers. */
const CRITICAL = /builds|deployments|api|compute|sandboxes|auto-deploys|provisioning/i;

type Result = { name: string; level: "PASS" | "WARN" | "FAIL"; detail: string };

async function railway(...args: string[]): Promise<string> {
	try {
		return (await run("railway", args, { timeout: 60_000, maxBuffer: 16 * 1024 * 1024 })).stdout;
	} catch (error) {
		const e = error as { stderr?: string; stdout?: string; message: string };
		throw new Error(`railway ${args[0]}: ${(e.stderr || e.stdout || e.message).trim().split("\n")[0]}`);
	}
}

let variablesCache: Record<string, string> | undefined;
async function variables(): Promise<Record<string, string>> {
	return (variablesCache ??= JSON.parse(await railway("variables", "--json")) as Record<string, string>);
}

async function statusPage(): Promise<Result> {
	const name = "Railway status";
	try {
		const response = await fetch("https://status.railway.com/api/status", { signal: AbortSignal.timeout(15_000) });
		const body = (await response.json()) as {
			activeIncidents: Array<{ title: string; status: string; createdAt: string; components: Array<{ name: string; impact: string }>; updates?: Array<{ message: string; createdAt: string }> }>;
		};
		const open = body.activeIncidents.filter((i) => i.components.some((c) => CRITICAL.test(c.name) && c.impact !== "OPERATIONAL"));
		if (!open.length) return { name, level: "PASS", detail: body.activeIncidents.length ? `${body.activeIncidents.length} open incident(s), none on builds/deploys/API/sandboxes` : "no open incidents" };
		return {
			name,
			level: "FAIL",
			detail: open.map((i) => `"${i.title}" (${i.status}, since ${i.createdAt.slice(0, 16)}Z): ${i.updates?.[0]?.message ?? ""}`).join("\n      "),
		};
	} catch (error) {
		return { name, level: "WARN", detail: `status page unreadable: ${(error as Error).message}` };
	}
}

async function cliLogin(): Promise<Result> {
	const name = "Railway CLI login";
	try {
		const me = JSON.parse(await railway("whoami", "--json")) as { email?: string; name?: string };
		return { name, level: "PASS", detail: `logged in${me.email ? ` as ${me.email}` : ""}` };
	} catch (error) {
		return { name, level: "FAIL", detail: `${(error as Error).message} — run \`railway login\`, then \`railway link\` to the agent service` };
	}
}

async function latestDeployment(): Promise<Result> {
	const name = "Agent deployment";
	try {
		const list = JSON.parse(await railway("deployment", "list", "--limit", "5", "--json")) as Array<Record<string, unknown>>;
		const latest = list[0];
		if (!latest) return { name, level: "WARN", detail: "no deployments listed" };
		const status = String(latest.status ?? "unknown").toUpperCase();
		const at = String(latest.createdAt ?? latest.created_at ?? "");
		const detail = `latest ${status}${at ? ` at ${at}` : ""}; recent: ${list.map((d) => String(d.status ?? "?").toUpperCase()).join(", ")}`;
		if (/FAILED|CRASHED/.test(status)) return { name, level: "FAIL", detail };
		if (status !== "SUCCESS") return { name, level: "WARN", detail };
		return { name, level: "PASS", detail };
	} catch (error) {
		return { name, level: "FAIL", detail: (error as Error).message };
	}
}

async function production(): Promise<Result> {
	const name = "Production version";
	let version: string;
	if (!AGENT_URL) return { name, level: "FAIL", detail: "set AGENT_URL to your agent's public address" };
	try {
		const response = await fetch(`${AGENT_URL}/health`, { signal: AbortSignal.timeout(15_000) });
		if (response.status !== 200) return { name, level: "FAIL", detail: `${AGENT_URL}/health answered HTTP ${response.status}` };
		version = ((await response.json()) as { version: string }).version;
	} catch (error) {
		return { name, level: "FAIL", detail: `${AGENT_URL}/health: ${(error as Error).message}` };
	}
	try {
		await run("git", ["fetch", "--quiet", "origin", "master"], { timeout: 60_000 });
		const head = (await run("git", ["rev-parse", "origin/master"])).stdout.trim();
		if (head.startsWith(version)) return { name, level: "PASS", detail: `production runs origin/master (${version})` };
		const behind = (await run("git", ["log", "--oneline", `${version}..origin/master`])).stdout.trim();
		return {
			name,
			level: "WARN",
			detail: `production runs ${version}; origin/master is ${head.slice(0, 7)}, not deployed yet:\n      ${behind.split("\n").join("\n      ")}`,
		};
	} catch (error) {
		return { name, level: "WARN", detail: `production runs ${version}; could not compare with origin/master: ${(error as Error).message}` };
	}
}

async function sandboxToken(): Promise<Result> {
	const name = "Sandbox token";
	try {
		const token = process.env.SANDBOX_RAILWAY_TOKEN?.trim() || (await variables()).SANDBOX_RAILWAY_TOKEN;
		if (!token) return { name, level: "FAIL", detail: "SANDBOX_RAILWAY_TOKEN is not set on the agent service" };
		const response = await fetch("https://backboard.railway.com/graphql/v2", {
			method: "POST",
			headers: { "content-type": "application/json", "project-access-token": token },
			body: JSON.stringify({ query: "{ projectToken { projectId environmentId } }" }),
			signal: AbortSignal.timeout(30_000),
		});
		const body = (await response.json()) as { data?: { projectToken?: { projectId: string } }; errors?: Array<{ message: string }> };
		if (body.errors?.length) return { name, level: "FAIL", detail: `railway: ${body.errors.map((e) => e.message).join("; ")}` };
		return { name, level: "PASS", detail: `accepted for project ${body.data?.projectToken?.projectId ?? "?"}` };
	} catch (error) {
		return { name, level: "FAIL", detail: (error as Error).message };
	}
}

async function check(): Promise<boolean> {
	const results = [await statusPage(), await cliLogin(), await latestDeployment(), await production(), await sandboxToken()];
	try {
		const pauseAll = (await variables()).PAUSE_ALL ?? "unset";
		results.push({ name: "PAUSE_ALL", level: "PASS", detail: pauseAll === "true" ? "true (agent is paused)" : `${pauseAll} (agent is running)` });
	} catch {
		// Already reported by the CLI check.
	}
	for (const r of results) console.log(`${r.level === "PASS" ? "✓" : r.level === "WARN" ? "!" : "✗"} ${r.level.padEnd(4)} ${r.name}: ${r.detail}`);
	const ok = !results.some((r) => r.level === "FAIL");
	console.log(ok ? "\nRailway looks ready." : "\nNot ready: fix or wait out the FAIL lines above.");
	return ok;
}

async function latestDeploymentId(): Promise<string | undefined> {
	const list = JSON.parse(await railway("deployment", "list", "--limit", "1", "--json")) as Array<{ id?: string }>;
	return list[0]?.id;
}

/** The variable only reaches the running agent through a new deployment, so wait for one (not the old SUCCESS). */
async function setPauseAll(value: "true" | "false"): Promise<void> {
	const before = await latestDeploymentId();
	await railway("variables", "--set", `PAUSE_ALL=${value}`);
	console.log(`PAUSE_ALL=${value} set; waiting for Railway to redeploy the agent with it…`);
	const deadline = Date.now() + 10 * 60_000;
	while (Date.now() < deadline) {
		await new Promise((r) => setTimeout(r, 15_000));
		if ((await latestDeploymentId()) === before) continue;
		const result = await latestDeployment();
		if (result.level === "FAIL") throw new Error(`deployment failed: ${result.detail}`);
		if (result.level === "PASS" && (await production()).level !== "FAIL") return void console.log(`✓ ${result.detail}`);
	}
	throw new Error(`no new deployment within 10 minutes, so the running agent still has the old PAUSE_ALL. The variable is saved; run \`railway redeploy\` or redeploy from the dashboard once Railway's API allows it`);
}

const [command, ...flags] = process.argv.slice(2);
try {
	if (command === "check") process.exitCode = (await check()) ? 0 : 1;
	else if (command === "pause") await setPauseAll("true");
	else if (command === "resume") {
		if (!(await check()) && !flags.includes("--force")) {
			console.log("Not resuming. Re-run when the checks pass, or `npm run railway -- resume --force` to resume anyway.");
			process.exitCode = 1;
		} else await setPauseAll("false");
	} else {
		console.log("usage: npm run railway -- check | pause | resume [--force]");
		process.exitCode = 2;
	}
} catch (error) {
	console.error(`✗ ${(error as Error).message}`);
	process.exitCode = 1;
}
