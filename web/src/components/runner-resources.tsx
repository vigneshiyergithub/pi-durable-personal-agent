import { clock, duration, type RunnerResources, type ResourcePhase } from "@/lib/telemetry"

const PHASE_LABEL: Record<ResourcePhase, string> = {
  toolchain: "Tool setup", clone: "Clone", coding: "Coding", "report-recovery": "Report recovery",
  verification: "Verification", proofs: "Proofs", packaging: "Packaging",
}
const bytes = (value: number | undefined) => value === undefined ? "Unavailable" : value < 1024 ? `${Math.round(value)} B` : value < 1024 ** 2 ? `${(value / 1024).toFixed(1)} KiB` : value >= 1024 ** 3 ? `${(value / 1024 ** 3).toFixed(2)} GiB` : `${(value / 1024 ** 2).toFixed(1)} MiB`
const cpu = (ms: number | undefined) => ms === undefined ? "Unavailable" : `${(ms / 1_000).toFixed(1)} CPU-s`

export function RunnerResourceDetails({ resources: r, running, reportedAt }: { resources?: RunnerResources; running: boolean; reportedAt: string }) {
  if (!r) return <p className="px-4 pb-2 text-xs text-muted-foreground">{running ? "Resource readings appear after the first runner heartbeat." : "Resource data was not collected for this attempt."}</p>
  return (
    <details className="border-t bg-muted/20 text-xs">
      <summary className="cursor-pointer px-4 py-2">
        <span className="font-medium">Resources{running && r.phase ? ` · ${PHASE_LABEL[r.phase]}` : ""}</span>
        <span className="ml-3 text-muted-foreground">Peak container {bytes(r.peakContainerMemoryBytes)} · runner {bytes(r.peakRunnerRssBytes)} · {cpu(r.cpuMs)}</span>
      </summary>
      <div className="space-y-3 px-4 pb-3">
        <div className="flex flex-wrap gap-x-5 gap-y-1 tabular-nums">
          {running && <span>Last container sample: {bytes(r.containerMemoryBytes)}</span>}
          <span>Captured output: {bytes(r.outputBytes)}</span>
          {r.bundleBytes !== undefined && <span>Git bundle: {bytes(r.bundleBytes)}</span>}
          <span>Reported: {clock(reportedAt)}</span>
          <span>Observed runtime: {duration(r.elapsedMs)}</span>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-left tabular-nums" aria-label="Runner resources by phase">
            <thead><tr className="text-muted-foreground"><th className="py-1 pr-4">Phase</th><th className="pr-4">Time</th><th className="pr-4">Container peak</th><th className="pr-4">Runner peak</th><th className="pr-4">CPU</th><th>Output</th></tr></thead>
            <tbody>{r.phases.map(p => <tr key={p.name} className="border-t"><th className="py-2 pr-4 font-normal">{PHASE_LABEL[p.name]}</th><td className="pr-4 whitespace-nowrap">{duration(p.durationMs)}</td><td className="pr-4 whitespace-nowrap">{bytes(p.peakContainerMemoryBytes)}</td><td className="pr-4 whitespace-nowrap">{bytes(p.peakRunnerRssBytes)}</td><td className="pr-4 whitespace-nowrap">{cpu(p.cpuMs)}</td><td className="whitespace-nowrap">{bytes(p.outputBytes)}</td></tr>)}</tbody>
          </table>
        </div>
        <p className="text-muted-foreground">Sampled every {r.intervalMs / 1_000}s and at phase boundaries; live readings arrive with the 30s heartbeat. Container memory includes child processes and filesystem cache; runner memory is this process only. CPU is cumulative processor time, not wall time. Missing cgroup metrics show as unavailable. These observations are not Railway billing measurements.</p>
      </div>
    </details>
  )
}
