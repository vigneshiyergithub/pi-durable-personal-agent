// Shared seeding helpers for the ELR M2 hygiene boot harnesses (health-boot-reconcile,
// health-during-reconcile). They seed a throwaway pi-durable store with canvas transcript entries,
// the exact shape the boot reconciler reads. No network and no credentials: the provider is only
// registered, never called.
import { createServer, type Server } from "node:net";
import { join } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import { openrouterProvider } from "@earendil-works/pi-ai/providers/openrouter";
import { createRegistry, Harness } from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";

const SEED_BATCH = 250;

/** Seed `count` canvas actions (assistant toolCall + tool-result entries) into the pi-durable store. */
export async function seedCanvasTranscript(dir: string, count: number): Promise<void> {
	const models = createModels();
	models.setProvider(openrouterProvider());
	const harness = await Harness.open(
		await openNodeSqliteStorage(join(dir, "agent.sqlite")),
		{ models, registry: createRegistry(), onReport: () => {} },
		BACKGROUND_CONTEXT,
	);
	try {
		const conversation = await harness.root(BACKGROUND_CONTEXT);
		for (let start = 0; start < count; start += SEED_BATCH) {
			const end = Math.min(start + SEED_BATCH, count);
			await conversation.commit(async (tx) => {
				for (let i = start; i < end; i++) {
					const toolCallId = `health-seed-${i}`;
					await tx.appendEntry(conversation.id, {
						kind: "pi.assistant",
						model: [
							{
								role: "assistant",
								content: [{ type: "toolCall", id: toolCallId, name: "paint", arguments: { points: [[i % 256, 0], [0, i % 256]], width: 3 } }],
							},
						],
					} as never);
					await tx.appendEntry(conversation.id, {
						kind: "pi.tool-result",
						model: [
							{
								role: "toolResult",
								toolCallId,
								toolName: "paint",
								isError: false,
								timestamp: Date.now(),
								content: [{ type: "text", text: "painted" }],
								details: {
									namespace: "painting",
									version: 1,
									configHash: `seed-${i}`,
									tool: "paint",
									attempt: 0,
									opHash: `op-${i}`,
									beforeHash: `before-${i}`,
									afterHash: `after-${i}`,
								},
							},
						],
					} as never);
				}
			}, BACKGROUND_CONTEXT);
		}
	} finally {
		await harness.close(BACKGROUND_CONTEXT);
	}
}

/** A port nothing is listening on yet, so the caller's connect loop sees real ECONNREFUSED until the listener binds. */
export async function freePort(): Promise<number> {
	return await new Promise((resolve, reject) => {
		const probe: Server = createServer();
		probe.on("error", reject);
		probe.listen(0, "127.0.0.1", () => {
			const address = probe.address();
			const port = address !== null && typeof address === "object" ? address.port : 0;
			probe.close(() => resolve(port));
		});
	});
}
