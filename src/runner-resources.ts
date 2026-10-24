/** Numeric-only runner diagnostics. Treat these as worker observations, never billing or verification evidence. */
export const RESOURCE_PHASES = ["toolchain", "clone", "coding", "report-recovery", "verification", "proofs", "packaging"] as const;
export type ResourcePhase = (typeof RESOURCE_PHASES)[number];
export type RunnerPhaseResources = {
	name: ResourcePhase;
	startedMs: number;
	durationMs: number;
	samples: number;
	peakRunnerRssBytes: number;
	peakContainerMemoryBytes?: number;
	cpuMs?: number;
	outputBytes: number;
};
export type RunnerResources = {
	version: 1;
	intervalMs: number;
	elapsedMs: number;
	phase?: ResourcePhase;
	runnerRssBytes: number;
	peakRunnerRssBytes: number;
	containerMemoryBytes?: number;
	peakContainerMemoryBytes?: number;
	cpuMs?: number;
	outputBytes: number;
	bundleBytes?: number;
	phases: RunnerPhaseResources[];
};

/** Drop unknown keys, text and non-finite/negative values before persisting anything from a sandbox. */
export function readRunnerResources(input: unknown): RunnerResources | undefined {
	if (!input || typeof input !== "object") return;
	const value = input as Record<string, unknown>;
	if (value.version !== 1 || !Array.isArray(value.phases) || value.phases.length > RESOURCE_PHASES.length) return;
	const numeric = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v) && v >= 0 && v <= 1e15;
	const phaseName = (v: unknown): v is ResourcePhase => RESOURCE_PHASES.includes(v as ResourcePhase);
	const copyNumbers = (source: Record<string, unknown>, required: string[], optional: string[]) => {
		if (!required.every(k => numeric(source[k]))) return;
		const result: Record<string, number> = {};
		for (const key of [...required, ...optional]) if (numeric(source[key])) result[key] = source[key];
		return result;
	};
	const numbers = copyNumbers(value, ["intervalMs", "elapsedMs", "runnerRssBytes", "peakRunnerRssBytes", "outputBytes"], ["containerMemoryBytes", "peakContainerMemoryBytes", "cpuMs", "bundleBytes"]);
	if (!numbers) return;
	const phases: RunnerPhaseResources[] = [];
	for (const item of value.phases) {
		if (!item || typeof item !== "object" || !phaseName(item.name) || phases.some(p => p.name === item.name)) return;
		const fields = copyNumbers(item, ["startedMs", "durationMs", "samples", "peakRunnerRssBytes", "outputBytes"], ["peakContainerMemoryBytes", "cpuMs"]);
		if (!fields) return;
		phases.push({ name: item.name, ...fields } as RunnerPhaseResources);
	}
	return { version: 1, ...numbers, ...(phaseName(value.phase) ? { phase: value.phase } : {}), phases } as RunnerResources;
}
