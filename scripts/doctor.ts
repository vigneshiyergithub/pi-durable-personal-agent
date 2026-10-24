// Readiness report: model ids, data dir, and presence/absence of sandbox/GitHub-related settings.
// Never prints a secret value — only the literal words "set" or "missing".
//
// The sandbox/worker group lists every environment variable src/config.ts reads in its sandbox
// section (the Railway project token, the two Railway identifiers, the public-domain variables,
// the OpenRouter management key, the sandbox image, opencode version, the coder model, attempt
// budget/time/parallelism, sandbox units, and git author) plus OPENROUTER_API_KEY, which
// src/main.ts requires. The GitHub App group covers the credentials stored in
// dataDir/secrets/github-app.json.
//
// Presence is read straight from process.env rather than from config: config.ts falls back to a
// default when a variable is unset, empty or whitespace-only, so a config value can never tell
// whether the variable itself was configured. The same rule config.ts applies (trim, then empty
// means unset) decides set vs missing; the model section shows the effective values either way.
//
// Imports are done dynamically inside the report so that an invalid env value thrown while the
// config module loads is caught here, not leaked in a Node stack trace.
//
// Re-landed from PR #3 (head b31e073, merged as 714b921) onto current master. Follow-up: the
// sandbox/GitHub lines report the presence of each variable itself (labels are the exact variable
// names, one per line) rather than the presence of the config value, so unset, empty and
// whitespace-only variables all report "missing" even where config.ts would fall back to a default.

const present = (value: string | number | undefined | null): boolean => {
	if (value === undefined || value === null) return false;
	if (typeof value === "number") return !Number.isNaN(value);
	return String(value).trim() !== "";
};

/** Print `label: set|missing`. On any failure, print `label: missing` and never interpolate the value. */
const reportPresence = (label: string, value: string | number | undefined | null): void => {
	try {
		console.log(`${label}: ${present(value) ? "set" : "missing"}`);
	} catch {
		console.log(`${label}: missing`);
	}
};

/** Presence of one environment variable, under the same rule config.ts's env() applies. */
const reportEnv = (name: string): void => reportPresence(name, process.env[name]);

const run = async (): Promise<void> => {
	// Load dependencies dynamically so import-time failures are handled by the caller.
	const { config } = await import("../src/config.ts");
	const { readGitHubApp } = await import("../src/sandbox.ts");

	// (a) Model ids in use and the data dir. These are identifiers/paths, not secrets.
	console.log(`agent model: ${config.model}`);
	console.log(`foreman model: ${config.foremanModel}`);
	console.log(`reviewer model: ${config.reviewerModel}`);
	console.log(`coder model: ${config.sandbox.coderModel}`);
	console.log(`data dir: ${config.dataDir}`);

	// (b) Sandbox/worker-related settings: every environment variable src/config.ts reads in its
	// sandbox section, plus OPENROUTER_API_KEY (src/main.ts). Labels are the exact variable names;
	// an unset, empty or whitespace-only variable reports "missing". Values are never logged.
	for (const name of [
		"OPENROUTER_API_KEY",
		"OPENROUTER_MANAGEMENT_KEY",
		"SANDBOX_RAILWAY_TOKEN",
		"SANDBOX_PROJECT_ID",
		"SANDBOX_ENVIRONMENT_ID",
		"PUBLIC_URL",
		"RAILWAY_PUBLIC_DOMAIN",
		"SANDBOX_IMAGE",
		"OPENCODE_VERSION",
		"CODER_MODEL",
		"ATTEMPT_BUDGET_USD",
		"ATTEMPT_MINUTES",
		"MAX_PARALLEL_TASKS",
		"SANDBOX_VCPUS",
		"SANDBOX_MEMORY_GB",
		"GIT_AUTHOR_NAME",
		"GIT_AUTHOR_EMAIL",
	]) reportEnv(name);

	// (c) GitHub App credentials stored in dataDir/secrets/github-app.json. Values are never logged.
	let app: Awaited<ReturnType<typeof readGitHubApp>>;
	try {
		app = await readGitHubApp();
	} catch {
		app = undefined;
	}
	reportPresence("GitHub App appId", app?.appId);
	reportPresence("GitHub App slug", app?.slug);
	reportPresence("GitHub App privateKey", app?.privateKey);
	reportPresence("GitHub App installationId", app?.installationId);
	reportPresence("GitHub App org", app?.org);
};

try {
	await run();
} catch {
	// Do not include the error message or any value in output; just note the failure.
	console.error("doctor: report failed");
	process.exitCode = 1;
}
