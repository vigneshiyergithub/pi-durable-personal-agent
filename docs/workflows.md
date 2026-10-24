# Design: workflows as data (issue #8)

**Status:** proposal for the owner's review · 2026-10-19. Nothing is built until this is approved.

## Problem

The software factory is one hard-coded pipeline in `src/orchestra.ts`:

> plan → approve → code (attempts, proofs, foreman verdicts) → independent review → PR and gate → veto window → merge
> → observe (rollback on P0)

The agent can't shape its own process. A survey that should end in a report, a docs change that needs no container
verify, a new project's bootstrap, an experiment like the ELR benchmark: all of them either squeeze into this one
pipeline or get improvised with `schedule_job`, as the ELR milestone loop is today. Vision 2.7 asks for the agent to
create workflows like the factory itself, **without** being able to remove the checks that make self-merging safe.

## Design in one paragraph

A workflow is a **versioned list of stages**. Every stage is one of a small set of **built-in stage kinds** that the
orchestrator already knows how to run; a workflow never contains code. The current pipeline becomes the **default
workflow**, written as data. A goal pins the workflow id and version it was created with. The orchestrator becomes an
interpreter that runs the goal's current stage and moves on according to the stage's result. **Invariants live in
code, not in data:** whatever a workflow says, a change to the agent's own repo always gets an independent review,
the full gate (including protected paths) and an observation window. Workflows can add steps and tune numbers within
owner-set bounds; they can never remove the guards or grant credentials.

## Data model

```ts
type Workflow = {
  id: string;                 // "default", "survey", "docs", ...
  version: number;            // immutable once used; edits create a new version
  title: string;
  description: string;        // when to use it, for the agent choosing one
  stages: Stage[];
  status: "draft" | "approved" | "retired";
  approvedBy?: "owner" | "auto";   // auto only for tightening changes, see Safety
};

type Stage =
  | { kind: "plan" }                                         // foreman proposes tasks
  | { kind: "approve"; by: "owner" | "auto" }               // plan approval (auto = AUTO_APPROVE_PLANS semantics)
  | { kind: "code"; maxAttempts: number; verify: "project" | "none" } // containers, proofs, foreman verdicts
  | { kind: "review"; model?: string; maxRounds: number }   // independent reviewer
  | { kind: "gate"; checks: GateCheckName[] }               // the gate; required checks are added by code anyway
  | { kind: "veto"; minutes: number }                       // owner's window before merging
  | { kind: "merge"; mode: "agent" | "owner" }
  | { kind: "observe"; minutes: number }                    // production watch + automatic rollback
  | { kind: "report"; to: "owner" | "office" }              // write the outcome up (save_report / notify)
  | { kind: "wait"; until: "owner" | { minutes: number } }  // explicit pause point
```

Goals gain `workflow: { id, version }` and `stage: number`. The current statuses stay, mapped onto stages (planning =
plan, awaiting_approval = approve, active = code, ...), so the web app and the agent's tools keep working.

## The default workflow (today's behaviour, as data)

```json
{ "id": "default", "version": 1, "stages": [
  { "kind": "plan" },
  { "kind": "approve", "by": "auto" },
  { "kind": "code", "maxAttempts": 3, "verify": "project" },
  { "kind": "review", "maxRounds": 3 },
  { "kind": "gate", "checks": ["verify", "verified head", "proofs", "independent review", "protected paths", "mergeable"] },
  { "kind": "veto", "minutes": 5 },
  { "kind": "merge", "mode": "agent" },
  { "kind": "observe", "minutes": 5 }
]}
```

`approve.by`, `veto.minutes` and `observe.minutes` come from today's env (`AUTO_APPROVE_PLANS`,
`MERGE_VETO_MINUTES`, `OBSERVE_MINUTES`), so step (a) changes no behaviour.

## Examples the agent could define

| Workflow | Stages | Use |
|---|---|---|
| `survey` | plan → approve → code (`verify: "none"`, read-only task) → report | Investigate and write up; nothing merges |
| `docs` | plan → approve → code → review → gate → merge → observe | Docs-only changes; still reviewed, gated and observed (invariant) |
| `bootstrap` | plan → approve(owner) → code → review → gate → merge(agent) | A new project in the agent's org; no production to observe |
| `experiment` | plan → approve(owner) → code → report → wait(owner) | Benchmarks like ELR M6: run, report, stop for a decision |

## Safety: what data can and cannot do

**Enforced in code, whatever the workflow says** (in `src/orchestra.ts`, a protected path):
1. **The agent's own repo:** any workflow that merges must include `review`, `gate` (with every check
   available) and `observe` (5 minutes or more). The interpreter inserts any that are missing and logs that it did.
2. **Bounds** (owner-set, in config): `code.maxAttempts` ≤ 5; `review.maxRounds` ≤ 3; `veto.minutes` 0–60 (5 or
   more for the agent's own repo); `observe.minutes` 5–120; `review.model` only from an allowlist, `REVIEWER_MODELS`.
3. **No capabilities:** stages are built-in kinds only. No stage runs code on the agent's server, mints tokens, or
   changes tools or permissions. Containers keep their read-only tokens and capped keys.
4. **Protected paths** always need the owner's merge, even with `merge.mode: "agent"`.

**Approval:**
- A new workflow, or a new version that **loosens** anything, needs the owner's approval: a one-time code, like
  plans today.
  - Loosening means fewer stages, a shorter veto or observe, more attempts, or a different reviewer model.
- **Tightening** (an added stage, a longer window, fewer attempts) is approved automatically and noted in the daily
  report.
- Goals keep the version they started with; an approved change applies to new goals only.

## Agent tools

- `list_workflows`: id, version, title, description, stages.
- `propose_workflow(definition)`: validated against the bounds and invariants and saved as a draft; asks the owner
  if it loosens anything.
- `create_goal(..., workflow?)`: defaults to `default`. The foreman's plan prompt states the workflow's stages.

## Rollout (each step one change, mergeable on its own)

**(a) Interpreter, no behaviour change.**
- The default workflow lives in a durable `app.workflows` doc.
- Goals get `workflow` and `stage`; existing goals are migrated by mapping their status.
- `dispatch()` runs stage handlers; today's functions move into them unchanged.
- Acceptance:
  - every existing smoke test passes unchanged
  - a goal created before the migration finishes correctly after it
  - the web app shows no difference

**(b) Agent-defined workflows, owner-approved.**
- `list_workflows`, `propose_workflow`, bounds, the invariant insertion, and approval codes for loosening.
- Acceptance:
  - a proposed workflow without `observe` for the agent's own repo gets it inserted
  - one with `veto.minutes: 1` for the agent's repo is refused
  - one that only adds a `report` stage is auto-approved

**(c) Run them.**
- `create_goal(workflow)`, the stage kinds `report` and `wait`, and Goals UI showing the stage strip.
- Acceptance:
  - a `survey` goal ends with a saved report and no PR
  - an `experiment` goal stops at `wait(owner)` until resumed

**(d) Move the ELR loop onto a workflow.** Replaces the improvised `schedule_job` milestone loop.

## Decisions for the owner

| # | Decision | Recommendation |
|---|---|---|
| 1 | Invariants for the agent's own repo: review + full gate + observe ≥5 min, always | **Yes.** Without them, self-defined workflows could route around the guards |
| 2 | Loosening needs your approval code; tightening is automatic | **Yes** |
| 3 | Workflows for other projects (the agent's own repos) may skip `observe` (nothing in production yet) | **Yes**, bootstrap needs it |
| 4 | Build (a) now, then (b) and (c) after ELR's experiment ends | **Yes.** (a) is a refactor of the gate's home, so it is done by Claude (owner-reviewed), not by the agent itself |
