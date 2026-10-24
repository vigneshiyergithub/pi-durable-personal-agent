// ELR M3 §7 comparability tests: provider pinning, fingerprint fields, target delivery
// (spec docs/elr-canvas-spec.md §2 D2, §3, §7). Run: node --test bench/pinning.test.ts
// Offline: the classify path runs through an injected fake "openrouter" provider that captures the
// request options it is handed; episodes use the reference driver. No key, no money.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { BACKGROUND_CONTEXT as CTX } from "@earendil-works/chord/context";
import type { ClassifierContext } from "@earendil-works/pi-ai";
import { createModels, createProvider, envApiKeyAuth, hasApi } from "@earendil-works/pi-ai";
import { openrouterProvider } from "@earendil-works/pi-ai/providers/openrouter";
import { createRegistry, type ToolExecutionApi } from "@earendil-works/pi-durable";
import { buildTaskSet } from "./tasks/generators.ts";
import { DEFAULT_BENCH_MODEL, runBenchmark } from "./runner.ts";
import { armExtensions } from "../src/elr/bench/arm.ts";
import { readResults } from "../src/elr/bench/results.ts";
import { createPiSystemOneClient } from "../src/elr/system-one.ts";
import { benchPinForModel, pinnedOpenRouterProvider, SYSTEM_ONE_UNPINNED } from "../src/elr/pinning.ts";
import type { ArmId } from "../src/elr/bench/types.ts";

const CHOICE_CONTEXT: ClassifierContext = {
	state: { goal: "paint a disc" },
	questions: { q1: { type: "choice", instructions: "Pick.", criteria: { progress: "goes forward", abstain: "not enough" } } },
};

test("the §7 pin names every setting and reaches the bench driver's chat model", () => {
	for (const modelId of ["deepseek/deepseek-v4.1-flash", "perplexity/pplx-decider-v1.1-27b"]) {
		const pin = benchPinForModel(modelId);
		assert.deepEqual(pin.routing, { order: [modelId.split("/")[0]], allow_fallbacks: false }, "default order: the model's vendor segment, fallbacks off");
		assert.equal(pin.temperature, 0);
		assert.equal(pin.reasoningEffort, "off");
	}
	assert.throws(() => benchPinForModel("m/x", { ELR_BENCH_TEMPERATURE: "cold" }), /ELR_BENCH_TEMPERATURE/);

	// The provider's registered chat model carries the pin on the fields pi-ai's adapter reads
	// (openai-completions.js:733-736 for compat.openRouterRouting, simple-options.js:8-15 for
	// samplingParams); the catalog itself stays unpinned. openBenchHarness registers this provider
	// for driver "model" (src/elr/bench/episode.ts, §7 comment).
	const provider = pinnedOpenRouterProvider(DEFAULT_BENCH_MODEL);
	const pinned = provider.getModels().find((model) => model.id === DEFAULT_BENCH_MODEL)!;
	assert.ok(hasApi(pinned, "openai-completions"));
	assert.deepEqual(pinned.compat?.openRouterRouting, { order: ["deepseek"], allow_fallbacks: false });
	assert.equal(pinned.samplingParams?.temperature, 0);
	const catalog = openrouterProvider().getModels().find((model) => model.id === DEFAULT_BENCH_MODEL)!;
	assert.ok(hasApi(catalog, "openai-completions"));
	assert.equal(catalog.compat?.openRouterRouting, undefined, "the catalog itself stays unpinned");
});

test("injected fake provider captures the request options handed to the pi-ai classify path, pin included", async () => {
	const captured: { options: Record<string, unknown> }[] = [];
	const store = createProvider({
		id: "openrouter",
		name: "OpenRouter (test fake)",
		baseUrl: "https://openrouter.ai/api/v1",
		auth: { apiKey: envApiKeyAuth("OpenRouter API key", ["OPENROUTER_API_KEY"]) },
		models: [
			{
				id: "perplexity/pplx-decider-v1.1-27b",
				name: "decider",
				type: "classifier" as const,
				api: "typesafe-system-one" as const,
				provider: "openrouter",
				baseUrl: "https://openrouter.ai/api/v1",
				input: ["text" as const],
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
				contextWindow: 128_000,
			},
		],
		classifiers: {
			"typesafe-system-one": {
				classify: async (model, _context, options) => {
					captured.push({ options: (options ?? {}) as Record<string, unknown> });
					return { api: model.api, provider: model.provider, model: model.id, answers: {}, stopReason: "stop" as const, timestamp: 0 };
				},
			},
		},
	});
	const keyBefore = process.env.OPENROUTER_API_KEY;
	process.env.OPENROUTER_API_KEY = "test-key";
	try {
		const models = createModels();
		models.setProvider(store);
		const client = createPiSystemOneClient({ models });
		const reply = await client.classify("perplexity/pplx-decider-v1.1-27b", CHOICE_CONTEXT);
		assert.equal(reply.stopReason, "stop", "the fake provider served the classify call");
		assert.equal(captured.length, 1);
		const { onPayload } = captured[0]!.options;
		assert.equal(typeof onPayload, "function", "the pinned classify options were handed to pi-ai");
		const body = { model: "perplexity/pplx-decider-v1.1-27b", state: {}, questions: {} };
		const sent = (onPayload as (payload: unknown) => unknown)(body) as Record<string, unknown>;
		assert.deepEqual(sent.provider, { order: ["perplexity"], allow_fallbacks: false }, "the body carries provider.order and allow_fallbacks:false (§7)");
		assert.deepEqual({ ...sent, provider: undefined }, { ...body, provider: undefined }, "nothing else in the body changed");
	} finally {
		if (keyBefore === undefined) delete process.env.OPENROUTER_API_KEY;
		else process.env.OPENROUTER_API_KEY = keyBefore;
	}
});

test("every §7 fingerprint field is recorded and non-empty: provider, model, responseId", async () => {
	const dir = mkdtempSync(join(tmpdir(), "elr-pin-fingerprint-"));
	try {
		for (const arm of ["A", "B1"] as readonly ArmId[]) {
			const resultsPath = join(dir, `${arm}.jsonl`);
			await runBenchmark({ arm, set: "smoke", seed: 1234, driver: "reference", maxUsd: 10, resultsPath, dataDir: join(dir, `data-${arm}`), log: () => {} });
			for (const record of await readResults(resultsPath)) {
				for (const field of ["provider", "model", "responseId"] as const) {
					assert.ok(record.providerFingerprint[field].length > 0, `${arm}/${record.taskId}: providerFingerprint.${field} empty`);
				}
				assert.ok(record.pinning.routing.order.length > 0, `${arm}/${record.taskId}: routing.order empty`);
				assert.equal(record.pinning.routing.allow_fallbacks, false, `${arm}/${record.taskId}: fallbacks must be off`);
				assert.equal(typeof record.pinning.temperature, "number");
				assert.equal(record.pinning.reasoningEffort, "off");
				if (arm === "B1") assert.deepEqual(record.pinning.unpinned, SYSTEM_ONE_UNPINNED, "the classify-path limitation is recorded, not hidden");
				else assert.deepEqual(record.pinning.unpinned, [], "no System One call, no classify limitation");
			}
		}
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("§3 target delivery: view_canvas returns canvas AND target images, in arm A too, adding no tool", async () => {
	const task = buildTaskSet("smoke", 1).tasks[0]!;
	const stubApi = { conversationId: "pin-test", snapshot: async () => undefined } as unknown as ToolExecutionApi;
	// Compose the wraps the way pi-durable's resolveAgent does: tools by name, then each extension's
	// wraps in install order.
	const extensions = armExtensions("A", { currentTask: () => task });
	const registry = createRegistry();
	for (const extension of extensions) registry.install(extension);
	const names = registry.snapshot().tools().map((entry) => entry.tool.name).sort();
	assert.deepEqual(names, ["done", "paint", "reset_canvas", "view_canvas"], "arm A: the tool set is exactly the canvas tools");
	let viewCanvas = registry.snapshot().tools().find((entry) => entry.tool.name === "view_canvas")!.tool;
	for (const extension of extensions) {
		for (const wrap of extension.wraps ?? []) {
			if ("tool" in wrap && wrap.tool === "view_canvas") viewCanvas = wrap.wrap(viewCanvas);
		}
	}
	const result = await viewCanvas.execute({}, stubApi, CTX);
	const images = (result.output ?? []).filter((item) => item.type === "image");
	assert.equal(images.length, 2, "arm A: view_canvas carries the canvas and the target (§3)");
	assert.equal(images[1]!.data, Buffer.from(task.targetPng).toString("base64"), "arm A: the second image is the task's target");
	assert.equal(images[1]!.mimeType, "image/png", "arm A: the target is an image (D2), never coordinates");
	assert.ok((result.output ?? []).some((item) => item.type === "text"), "arm A: the neutral text scorecard is still there");
});
