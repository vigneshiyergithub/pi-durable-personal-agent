import { readFileSync } from "node:fs";

// What this process has seen go wrong since it started, for the post-merge observation window (src/orchestra.ts):
// server errors answered by the HTTP API and reports from the harness. In memory only: a new deploy starts at zero.
export const vitals = {
	startedAt: Date.now(),
	serverErrors: 0,
	harnessReports: 0,
	/** The commit this process runs, as Railway reports it. */
	version: process.env.RAILWAY_GIT_COMMIT_SHA,
	/** When Telegram's long poll last came back, and the last error since then (for the Monitor view). */
	telegramPolledAt: undefined as number | undefined,
	telegramError: undefined as string | undefined,
};

/**
 * Memory, as Railway bills it: the container's total (cgroup v2: this process, its children such as skills, git and
 * the bash tool, and file cache) where Linux exposes it, plus this process's own resident and heap sizes. Sampled every
 * 10 s so the peak since boot catches short spikes.
 */
const mb = (bytes: number) => Math.round(bytes / 2 ** 20);
const containerBytes = () => {
	try {
		return Number(readFileSync("/sys/fs/cgroup/memory.current", "utf8"));
	} catch {
		return undefined;
	}
};
const peak = { process: 0, container: 0 };
export function memory(): { processMb: number; heapMb: number; containerMb: number | null; peakProcessMb: number; peakContainerMb: number | null } {
	const { rss, heapUsed } = process.memoryUsage();
	const container = containerBytes();
	peak.process = Math.max(peak.process, rss);
	if (container !== undefined) peak.container = Math.max(peak.container, container);
	return { processMb: mb(rss), heapMb: mb(heapUsed), containerMb: container === undefined ? null : mb(container), peakProcessMb: mb(peak.process), peakContainerMb: container === undefined ? null : mb(peak.container) };
}
setInterval(memory, 10_000).unref();
