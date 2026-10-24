// §7 provider pinning — ONE shared helper for every benchmark model call
// (spec docs/elr-canvas-spec.md §7: "Same model and pinned provider (`provider.order`,
// `allow_fallbacks: false`), with fixed temperature and reasoning effort"). The bench episode
// driver and the System One evaluators both inherit it; nothing in the
// server's boot or request path imports this module. pi-ai 1.3.0 mechanics, cited where used
// below: chat sends `model.compat.openRouterRouting` as the request's `provider` object and merges
// `model.samplingParams`; the classify body is `{ model, state, questions }`, replaceable through
// the options' documented `onPayload` hook.
import { hasApi, type AnyModel, type Model, type Provider } from "@earendil-works/pi-ai";
import { openrouterProvider } from "@earendil-works/pi-ai/providers/openrouter";

/** The fixed reasoning effort for every benchmark request (§7). */
export const BENCH_REASONING_EFFORT = "off" as const;

/** OpenRouter routing preferences: `provider.order` with fallbacks off (§7). */
export type ProviderRouting = { order: string[]; allow_fallbacks: false };

/** The §7 pin for one model: routing, fixed temperature, fixed reasoning effort. */
export type BenchPin = { modelId: string; routing: ProviderRouting; temperature: number; reasoningEffort: typeof BENCH_REASONING_EFFORT };

/**
 * The §7 pin for `modelId`. The provider order is ELR_BENCH_PROVIDER_ORDER (comma-separated) or,
 * unset, the model id's vendor segment — the same value for the same model in every arm. Fallbacks
 * are always off. The temperature is ELR_BENCH_TEMPERATURE or 0.
 */
export function benchPinForModel(modelId: string, env: NodeJS.ProcessEnv = process.env): BenchPin {
	const rawOrder = env.ELR_BENCH_PROVIDER_ORDER?.trim();
	const order = rawOrder ? rawOrder.split(",").map((entry) => entry.trim()).filter((entry) => entry !== "") : [modelId.split("/")[0]!.trim()];
	const raw = env.ELR_BENCH_TEMPERATURE?.trim();
	const temperature = raw === undefined || raw === "" ? 0 : Number(raw);
	if (!Number.isFinite(temperature) || temperature < 0) throw new RangeError(`ELR_BENCH_TEMPERATURE must be a number >= 0, got "${raw}"`);
	return { modelId, routing: { order, allow_fallbacks: false }, temperature, reasoningEffort: BENCH_REASONING_EFFORT };
}

/** A copy of a chat model whose every request is pinned; the catalog entry is not mutated. */
export function pinnedChatModel(model: Model<"openai-completions">, pin: BenchPin): Model<"openai-completions"> {
	return {
		...model,
		compat: { ...model.compat, openRouterRouting: pin.routing },
		samplingParams: { ...model.samplingParams, temperature: pin.temperature },
	};
}

/**
 * The OpenRouter provider with `modelId`'s chat model pinned (§7). The bench agent driver registers
 * this instead of `openrouterProvider()`; every other model passes through untouched.
 */
export function pinnedOpenRouterProvider(modelId: string, env: NodeJS.ProcessEnv = process.env): Provider {
	const base = openrouterProvider();
	const pin = benchPinForModel(modelId, env);
	const pinModel = <M extends AnyModel>(model: M): M =>
		model.id === modelId && hasApi(model, "openai-completions") ? (pinnedChatModel(model, pin) as M) : model;
	return { ...base, getModels: () => base.getModels().map(pinModel), getAllModels: () => (base.getAllModels?.() ?? base.getModels()).map(pinModel) };
}

/** What pi-ai 1.3.0 cannot pin on the System One classify path; recorded per B′ episode. */
export const SYSTEM_ONE_UNPINNED = [
	"system-one classify: temperature is not sent — the body is only {model, state, questions} " +
		"(pi-ai 1.3.0 dist/api/typesafe-system-one.js:11); ClassifierOptions.temperature (dist/types.d.ts:211) is never read there",
	"system-one classify: no reasoning option exists (ClassifierOptions, pi-ai dist/types.d.ts:211-218)",
];

/** The pi-ai classify options carrying the §7 routing pin, injected via the `onPayload` hook. */
export function pinnedClassifyOptions(pin: BenchPin): { onPayload: (payload: unknown, model: unknown) => unknown } {
	return {
		onPayload: (payload) => {
			if (typeof payload !== "object" || payload === null || Array.isArray(payload)) return payload;
			return { ...(payload as Record<string, unknown>), provider: pin.routing };
		},
	};
}
