import { join, resolve } from "node:path";

const env = (name: string, fallback?: string): string | undefined => {
	const value = process.env[name]?.trim();
	return value === undefined || value === "" ? fallback : value;
};

/** Hard upper bound on the review render budget: keeps the reviewer input inside a sane context budget
 *  (the default is 300,000; the ceiling still allows a large raise above it) while never letting
 *  REVIEW_DIFF_CHARS grow unbounded or switch the guard off. */
const REVIEW_DIFF_CHARS_MAX = 1_000_000;
/** The environment value as an integer at most `max`, or undefined when it is missing, invalid, or ABOVE max
 *  (so above the maximum falls back to the 300,000 default — it is never clamped to something unasked-for). */
const bounded = (value: number | undefined, max: number): number | undefined =>
	value === undefined || value > max ? undefined : value;

/** A positive decimal integer read from the environment, or undefined when the value is missing or not one. */
const parsePositiveInt = (value: string | undefined): number | undefined => {
	const parsed = /^\d+$/.test(value ?? "") ? Number(value) : Number.NaN;
	return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : undefined;
};

const dataDir = resolve(env("DATA_DIR", "./data")!);
/** Where coding containers get their model: per-attempt OpenRouter keys, or OpenCode Go through the agent's proxy. */
const coderProvider: "openrouter" | "opencode-go" = env("CODER_PROVIDER", "openrouter") === "opencode-go" ? "opencode-go" : "openrouter";

export const config = {
	dataDir,
	dbPath: join(dataDir, "agent.sqlite"),
	skillsDir: join(dataDir, "skills"),
	workspaceDir: join(dataDir, "workspace"),
	memoryPath: join(dataDir, "MEMORY.md"),

	port: Number(env("PORT", "3000")),
	/** Bearer token for the HTTP API and web chat. Required in production. */
	authToken: env("AUTH_TOKEN"),

	telegramToken: env("TELEGRAM_BOT_TOKEN"),
	/** Only this Telegram user/chat id may talk to the agent. */
	telegramOwnerId: env("TELEGRAM_OWNER_ID"),

	model: env("AGENT_MODEL", "deepseek/deepseek-v4.1-flash")!,
	reflectModel: env("REFLECT_MODEL", "qwen/qwen3.7-flash")!,
	/** Plans goals and judges the coding agents' evidence. */
	foremanModel: env("FOREMAN_MODEL", env("AGENT_MODEL", "deepseek/deepseek-v4.1-flash"))!,
	/**
	 * ELR System One decision models (spec §6). Primary and second opinion, both classifier models
	 * served by OpenRouter's TypeSafe System One protocol. Text input only.
	 */
	systemOneModel: env("ELR_SYSTEM_ONE_MODEL", "perplexity/pplx-decider-v1.1-27b")!,
	systemOneSecond: env("ELR_SYSTEM_ONE_SECOND", "inception/mercury-decide")!,
	/** Reviews each goal's whole change before it merges. Keep it a different vendor from CODER_MODEL. */
	/** Where the reviewer's model comes from: "openrouter" or "opencode-go" (the agent's OPENCODE_API_KEY, via pi-ai). */
	reviewerProvider: (env("REVIEWER_PROVIDER", "openrouter") === "opencode-go" ? "opencode-go" : "openrouter") as "openrouter" | "opencode-go",
	reviewerModel: env("REVIEWER_MODEL", env("REVIEWER_PROVIDER") === "opencode-go" ? "gpt-6-luna" : "z-ai/glm-5.3")!,
	/** Writes each goal's hidden holdout checks from its acceptance criteria alone. Defaults to the reviewer's model. */
	examinerProvider: (env("EXAMINER_PROVIDER", env("REVIEWER_PROVIDER", "openrouter")) === "opencode-go" ? "opencode-go" : "openrouter") as "openrouter" | "opencode-go",
	examinerModel: env("EXAMINER_MODEL", env("REVIEWER_MODEL", env("REVIEWER_PROVIDER") === "opencode-go" ? "gpt-6-luna" : "z-ai/glm-5.3"))!,
	/** Who merges changes to the agent's own repo once they pass the gate: "veto" (the agent, after a window) or "owner". */
	selfMerge: (env("SELF_MERGE", "veto") === "owner" ? "owner" : "veto") as "owner" | "veto",
	/**
	 * Maintenance switch: pauses every goal (running attempts stop and go back to the queue uncounted), and stops
	 * scheduled jobs and reflection. The owner's chat still works. Turning it off resumes exactly the goals it paused.
	 */
	pauseAll: env("PAUSE_ALL", "false") === "true",
	/** One-shot: resume every paused goal (whoever paused it) once when the process starts. Unset it afterwards. */
	resumePaused: env("RESUME_PAUSED", "false") === "true",
	/** Autonomy mode: plans start without the owner's approval code. The owner is still notified and can cancel or veto. */
	autoApprovePlans: env("AUTO_APPROVE_PLANS", "false") === "true",
	/** After the agent merges into its own repo: how long production is watched once the merge is live. */
	observeMinutes: Number(env("OBSERVE_MINUTES", "5")),
	/** How long a merge may take to go live before it counts as a failed deploy (and is reverted). */
	deployDeadlineMinutes: Number(env("DEPLOY_DEADLINE_MINUTES", "15")),
	/** How long the owner has to veto a merge into the agent's own repo. */
	vetoMinutes: Number(env("MERGE_VETO_MINUTES", "5")),
	thinkingLevel: env("THINKING_LEVEL", "medium") as "off" | "minimal" | "low" | "medium" | "high",

	/** Outer loop: how often the reflector reviews recent work and improves the agent. 0 disables it. */
	reflectEveryHours: Number(env("REFLECT_EVERY_HOURS", "12")),
	/** Hard cap on what the whole session may spend, in USD. Requests stop once exceeded. */
	maxSpendUsd: Number(env("MAX_SPEND_USD", "20")),
	/** Review render budget: how many characters of a goal's diff reach the independent reviewer, and the raw-diff cap
	 *  in compare() (src/orchestra.ts, src/sandbox.ts). REVIEW_DIFF_CHARS overrides it for tests; missing, blank,
	 *  non-numeric, zero, negative, or a value above REVIEW_DIFF_CHARS_MAX all fall back to the default, so the
	 *  budget can never be silently disabled — and never unbounded: the hard ceiling keeps the reviewer input inside
	 *  a sane context budget (the default is 300,000; the ceiling at 1,000,000 still allows a large raise). */
	reviewDiffChars: bounded(parsePositiveInt(env("REVIEW_DIFF_CHARS")), REVIEW_DIFF_CHARS_MAX) ?? 300_000,
	timezone: env("TZ", "UTC")!,

	/** Passkey sign-in (see src/auth.ts). The relying party is the app's own host; passkeys are bound to it. */
	auth: (() => {
		const publicUrl = env("PUBLIC_URL", env("RAILWAY_PUBLIC_DOMAIN") ? `https://${env("RAILWAY_PUBLIC_DOMAIN")}` : undefined);
		const port = env("PORT", "3000");
		const origins = publicUrl ? [publicUrl.replace(/\/$/, "")] : [`http://localhost:${port}`, "http://localhost:5173"];
		return { rpId: env("RP_ID", new URL(origins[0]!).hostname)!, origins };
	})(),

	/** Where coding tasks run: throwaway containers in a separate Railway project (see src/sandbox.ts). */
	sandbox: {
		/** Environment-scoped project token for the agent-sandboxes project. Cannot touch any other project. */
		sandboxToken: env("SANDBOX_RAILWAY_TOKEN"),
		projectId: env("SANDBOX_PROJECT_ID"),
		environmentId: env("SANDBOX_ENVIRONMENT_ID"),
		/** Mints a capped model key per attempt. */
		openrouterManagementKey: env("OPENROUTER_MANAGEMENT_KEY"),
		/** How containers reach the agent to report back. Railway sets RAILWAY_PUBLIC_DOMAIN. */
		callbackUrl: env("PUBLIC_URL", env("RAILWAY_PUBLIC_DOMAIN") ? `https://${env("RAILWAY_PUBLIC_DOMAIN")}` : undefined),
		image: env("SANDBOX_IMAGE", "node:24")!,
		opencodeVersion: env("OPENCODE_VERSION", "1.19.3")!,
		/** Where the coding model comes from (CODER_PROVIDER): "openrouter" (a capped key per attempt) or "opencode-go". */
		coderProvider,
		/**
		 * The coding model, as the provider names it (OpenRouter: moonshotai/kimi-k2.7-code; OpenCode Go: kimi-k2.7-code).
		 * With opencode-go, a comma-separated list is a fallback chain: the proxy moves down it when a model hits its limit.
		 */
		coderModel: env("CODER_MODEL", coderProvider === "opencode-go" ? "kimi-k2.7-code" : "moonshotai/kimi-k2.7-code")!,
		/** OpenCode Go: the owner's API key (held by the agent only; containers reach it through the proxy). */
		opencodeApiKey: env("OPENCODE_API_KEY"),
		opencodeBaseUrl: env("OPENCODE_GO_BASE_URL", "https://opencode.ai/inference/go/openai/v1")!,
		/** Most a single attempt may spend on the model. */
		attemptBudgetUsd: Number(env("ATTEMPT_BUDGET_USD", "3")),
		attemptMinutes: Number(env("ATTEMPT_MINUTES", "40")),
		/** How many containers may run at once, across all goals. */
		maxParallel: Number(env("MAX_PARALLEL_TASKS", "2")),
		vCPUs: Number(env("SANDBOX_VCPUS", "2")),
		memoryGB: Number(env("SANDBOX_MEMORY_GB", "4")),
		gitName: env("GIT_AUTHOR_NAME", "pi-agent")!,
		gitEmail: env("GIT_AUTHOR_EMAIL", "pi-agent@users.noreply.github.com")!,
	},
} as const;
