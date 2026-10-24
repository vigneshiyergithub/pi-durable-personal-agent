import { Agent } from "./agent.ts";
import { config } from "./config.ts";
import { startHttp } from "./http.ts";
import { Telegram } from "./telegram.ts";

if (process.env.OPENROUTER_API_KEY === undefined) {
	console.error("OPENROUTER_API_KEY is not set");
	process.exit(1);
}

const agent = await Agent.open();
console.log(`[agent] up: model=${config.model} reflect=${config.reflectModel} data=${config.dataDir}`);
console.log(`[agent] skills: ${agent.skills.list().map((s) => s.name).join(", ") || "none"}`);

let telegram: Telegram | undefined;
if (config.telegramToken !== undefined) {
	telegram = new Telegram(agent, config.telegramToken);
	agent.notifier = (message) => telegram!.notifyOwner(message);
	void telegram.run();
	console.log("[telegram] polling");
}

await agent.resumeDeliveries();
const server = startHttp(agent);
const safety = () => void agent.orchestrator.safetyTick().catch((error) => console.error("[safety]", error));
const evidence = () => void agent.orchestrator.processEvidence().catch((error) => console.error("[evidence]", error));
const safetyTimer = setInterval(safety, 10_000);
const evidenceTimer = setInterval(evidence, 5_000);
safety();
evidence();
const timer = setInterval(() => void agent.tick(), 30_000);
void agent.tick();

// Railway sends SIGTERM on redeploy. Close cleanly; anything unfinished resumes in the next process.
let stopping = false;
for (const signal of ["SIGTERM", "SIGINT"] as const) {
	process.on(signal, async () => {
		if (stopping) return;
		stopping = true;
		console.log(`[agent] ${signal}, shutting down`);
		clearInterval(timer);
		clearInterval(safetyTimer);
		clearInterval(evidenceTimer);
		telegram?.stop();
		server.close();
		await agent.close();
		process.exit(0);
	});
}
