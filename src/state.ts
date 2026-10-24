// Host state kept as durable documents on the root conversation, committed atomically with the agent's own work.
import { type ConversationId, defineDoc, type SubmissionId } from "@earendil-works/pi-durable";

export type Job = {
	id: string;
	/** What to tell the agent when the job fires. */
	prompt: string;
	/** ISO time of the next run. */
	nextRunAt: string;
	/** Repeat interval; absent for a one-shot job. */
	everyMinutes?: number;
	createdBy: "user" | "agent" | "reflector";
	/** Explicit report replacement or intentionally separate schedule. */
	purpose?: "general" | "daily-report";
	/** Opt-in state watch; time-based reminders keep their existing semantics. */
	runOnChange?: boolean;
	lastFingerprint?: string;
	skippedRuns?: number;
};

export type JobsState = { jobs: Job[]; reportSeeded?: boolean; archiveVersion?: number; archived?: Array<{ job: Job; at: string; reason: string }> };

export const Jobs = defineDoc<JobsState>({
	kind: "app.jobs",
	version: 1,
	scope: "conversation",
	history: "latest",
	fork: "current",
	initial: () => ({ jobs: [] }),
});

export const HostState = defineDoc<{
	reflectorId?: ConversationId;
	jobsId?: ConversationId;
	lastReflectFingerprint?: string;
	replyConversations?: Record<string, ConversationId>;
	replyJobs?: Record<string, string>;
	lastReflectAt?: string;
	telegramOffset?: number;
	telegramChatId?: number;
	/** Submissions whose answer still has to be sent to Telegram; re-attached after a restart. */
	pendingReplies?: SubmissionId[];
}>({
	kind: "app.host",
	version: 1,
	scope: "conversation",
	history: "latest",
	fork: "initial",
	initial: () => ({}),
});
