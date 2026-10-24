import assert from "node:assert/strict";
import { it } from "node:test";
// @ts-expect-error The single-file JavaScript runner intentionally ships without TypeScript declarations.
import { createResourceMonitor } from "../runner/task-runner.mjs";
import { readRunnerResources } from "../src/runner-resources.ts";

it("attributes child-inclusive CPU, sampled memory and output to the phase that did the work", async () => {
 let at = 0, cpu = 1000, memory = 10, runnerRss = 5;
 const monitor = createResourceMonitor({ now: () => at, rss: () => runnerRss, read: async (path: string) => path.endsWith("cpu.stat") ? `usage_usec ${cpu}\n` : String(memory) });
 await monitor.phase("coding");
 monitor.output(12);
 at = 10; cpu = 4000; memory = 20; runnerRss = 8;
 await monitor.phase("verification");
 monitor.output(6);
 monitor.bundle(99);
 at = 30; cpu = 9000; memory = 30; runnerRss = 7;
 const result = await monitor.finish();
 assert.equal(result.elapsedMs, 30);
 assert.equal(result.cpuMs, 8);
 assert.equal(result.peakContainerMemoryBytes, 30);
 assert.equal(result.peakRunnerRssBytes, 8);
 assert.equal(result.outputBytes, 18);
 assert.equal(result.bundleBytes, 99);
 assert.deepEqual(result.phases.map((p: any) => [p.name, p.durationMs, p.cpuMs, p.outputBytes]), [["coding",10,3,12],["verification",20,5,6]]);
 assert.ok(readRunnerResources(result), "the real sampler emits a valid protocol payload");
 at = 1000; cpu = 900000;
 assert.deepEqual(await monitor.finish(), result, "finalizing again must not add reporting time or CPU");
});

it("missing cgroups never become zero memory or host metrics, and do not stop the task", async () => {
 const monitor = createResourceMonitor({ read: async () => { throw new Error("unavailable"); } });
 await monitor.phase("clone");
 const result = await monitor.finish();
 assert.equal(result.containerMemoryBytes, undefined);
 assert.equal(result.cpuMs, undefined);
 assert.ok(result.runnerRssBytes > 0);
 assert.ok(readRunnerResources(result));
});

it("serializes slow sampling across a phase transition", async () => {
 let active = 0, peak = 0;
 const monitor = createResourceMonitor({ read: async (path: string) => {
  active++; peak = Math.max(peak, active);
  await new Promise(resolve => setTimeout(resolve, 2)); active--;
  return path.endsWith("cpu.stat") ? "usage_usec 1000\n" : "100";
 }, intervalMs: 1 });
 await monitor.phase("coding");
 await monitor.phase("verification");
 await monitor.finish();
 assert.equal(peak, 1);
});

const valid = {version:1,intervalMs:5000,elapsedMs:100,phase:"coding",runnerRssBytes:10,peakRunnerRssBytes:20,outputBytes:30,phases:[{name:"coding",startedMs:0,durationMs:100,samples:1,peakRunnerRssBytes:20,outputBytes:30}]};
it("persists only allowlisted numbers and phase names from untrusted diagnostics", () => {
 const result = readRunnerResources({...valid, token:"secret", env:{key:"secret"}, cpuMs:Infinity, phases:[{...valid.phases[0],command:"secret"}]});
 assert.ok(result);
 assert.equal(JSON.stringify(result).includes("secret"), false);
 assert.equal(result.cpuMs, undefined);
 for (const bad of [null, {}, {...valid,version:2}, {...valid,elapsedMs:-1}, {...valid,outputBytes:NaN}, {...valid,runnerRssBytes:1e20}, {...valid,phases:Array(8).fill(valid.phases[0])}, {...valid,phases:[{...valid.phases[0],name:"secret"}]}, {...valid,phases:[valid.phases[0],valid.phases[0]]}]) assert.equal(readRunnerResources(bad), undefined);
});
