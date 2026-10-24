// Starts the production HTTP server (src/http.ts) with a stub agent so the
// token-leak proof can exercise the real routing, logging and error-handling
// paths. Only /canvas and the malformed-URL / runner error paths are used;
// those never touch the agent, so a stub is enough and no credentials or
// network are needed.
//
// Reads DATA_DIR, PORT and CANVAS_ACCESS_TOKEN from the environment, exactly
// as the deployed agent does. Run by scripts/canvas-static-token-leak.ts.
import type { Agent } from "../src/agent.ts";
import { startHttp } from "../src/http.ts";

const agent = {
	orchestrator: {},
	// GET /api/messages calls history(), which reads agent.root.entries. Throwing
	// here forces the production server's own try/catch to run and log, so the
	// token-leak proof can check that error output never contains the token.
	root: {
		entries: () => {
			throw new Error("forced proof error");
		},
	},
	status: async () => ({}),
	recentActivity: async () => "",
	maybeReflect: async () => "",
	ask: async () => "",
	// src/http.ts defers the journal reconcile out of listen(): a benign no-op outcome.
	startReconcile: async () => ({ ok: true, conversations: 0, inserted: 0 }),
} as unknown as Agent;

startHttp(agent);
