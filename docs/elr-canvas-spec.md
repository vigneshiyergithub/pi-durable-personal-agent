# Spec: Experiential Learning Runtime, canvas painting first

**Status:** accepted for build · 2026-10-18 · tracked in the GitHub issue "ELR: experiential learning for canvas painting"
**Background and evidence:** [elr-canvas-proposal.md](elr-canvas-proposal.md) (experiments, measurements, rejected options).
This spec is the requirement; where they differ, this file wins.

## 1. Goal

The agent gets measurably better at painting on a canvas from its own experience, with no change to model weights,
and we can prove *why*. Specifically, test the falsifiable hypothesis:

> Abstract, evidence-backed knowledge improves adaptation to an unfamiliar tool more than storing tool-specific
> successful action sequences alone.

**Done** means milestone M6's report shows the decision rule's outcome either way: a rejected hypothesis with clean
evidence is a valid result.

## 2. Decisions (fixed for this build)

| # | Decision |
|---|---|
| D1 | **Painting only** until M6 passes. No ELR hooks on other tools. |
| D2 | **Targets are shown only as images**, and tools have **hidden quirks**, with a no-quirk control set (X0). Plain shape-by-coordinates tasks hit the ceiling for a memoryless agent and test nothing. |
| D3 | **Second tool: a heading-based `pen`** (relative forward/turn/arc), not Bézier paths. Bézier circles are pretraining knowledge, so they would measure recall, not transfer. |
| D4 | **The verifier is deterministic:** boundary F-score at 4 px against the target mask, plus element checks (closure, connected components, budgets). It is the only reward. |
| D5 | **The agent sees its own canvas:** `view_canvas` returns a PNG as `ImageContent` to `deepseek/deepseek-v4.1-flash`, which accepts images. There is no vision critic in the MVP. |
| D6 | **System One evaluators through OpenRouter** (pi-ai `classify()`, API `typesafe-system-one`). Primary: `perplexity/pplx-decider-v1.1-27b`; second opinion: `inception/mercury-decide`. **Text input only** in the MVP: pi-ai 1.3.0 rejects images for System One. They label and triage; **they are never the reward** (§6). |
| D7 | **Storage:** canvas state goes in durable docs (replay-safe, atomic with the tool call). The evidence journal and knowledge go in a separate `/data/elr.sqlite` (`node:sqlite`, FTS5). MEMORY.md and skills are unchanged. |
| D8 | **Learned procedures** are pure `params → ops[]` functions run in `quickjs-wasi` (already installed). They are never skills, have no I/O, and every op counts against the episode's budget. |
| D9 | **The referee is protected.** Verifier, task generators and quirk configs are owner-merge-only paths, enforced by the merge gate (M0). |
| D10 | **Budget:** `BENCH_MAX_USD=10`, separate from `MAX_SPEND_USD`. |

## 3. Architecture

```
src/elr/
  canvas.ts          the "canvas" extension: paint, view_canvas, reset_canvas, done, (M5) pen, run_procedure
  raster.ts          dependency-free rasterizer: discs along polylines, arcs flattened; PNG via node:zlib
  journal.ts         /data/elr.sqlite: schema migrations, append-only events, boot reconciler
  system-one.ts      OpenRouter decision models via pi-ai classify(); typed questions; abstain handling
  reflect.ts         attempt / session / meta loops in an "elr-reflector" conversation (only tool: submit_knowledge)
  knowledge.ts       nodes, relations, retrievals, status rules, advisory rendering (FTS5, token cap)
  procedures.ts      QuickJS runner and promotion rules
  verifier/          PROTECTED: boundary-F (linear-time distance transform), element checks, success rule
bench/
  tasks/             PROTECTED: seeded generators for sets T, H, X, X0, smoke; quirk configs with configHash
  run.ts             npm run bench: arms, episodes, results JSONL, BENCH_MAX_USD
web/src/             CanvasStep (replays ops as SVG in chat), Lab panel (runs, curves, knowledge by status)
```

- **Episodes** run in ownerless conversations configured with `extensions: ["canvas"]`, plus the advisory section in
  arms C and D. They never see orchestrator, bash or skill tools.
- **Canvas state** is an ordered op list (`{tool, args}`) in a durable doc keyed by canvas id. The raster is a pure
  function of the ops, so both the server PNG and the web SVG come from the same ops.
- **Tool identity** is `{namespace: "painting", name, version, configHash}`. `configHash` covers the quirk config, so
  knowledge records which variant it was learned on.

### Tool contracts

| Tool | Args | Result |
|---|---|---|
| `paint` | `{points: [x,y][], width}`, one stroke through absolute points | Ack plus, in arms ≥ B, a micro scorecard (§5) |
| `view_canvas` | `{}` | `image` content (canvas, and the target when the task has one) plus a text scorecard |
| `reset_canvas` | `{}` | Clears the canvas; closes the current attempt |
| `done` | `{}` | Ends the episode; the verifier runs; returns the verified outcome |
| `pen` (M5) | `{start: [x,y], heading, moves: ({forward}\|{turn}\|{arc})[]}` | Same as `paint` |
| `run_procedure` (M5, arm D, validated only) | `{name, params}` | Ops are applied through the same path as `paint` and `pen`, budget-counted |

**Quirks** (per task config, hidden from the model):
- Brush: at most 6 points per stroke, Chaikin smoothing, at most 10 strokes.
- Pen: y axis pointing up, degrees vs radians, arc direction convention.

Violations return typed errors (e.g. `stroke has 9 points, max 6`). That is part of the learning signal.

## 4. Data contracts (`/data/elr.sqlite`)

Tables follow ELR §4: `sessions`, `attempts`, `events`, `evaluations`, `knowledge_nodes`, `knowledge_relations`,
`procedures`, `transfer_records`, `experiments`, `retrievals`.

- **Events are immutable** and keyed by `toolCallId` (`INSERT OR IGNORE`). They store references, not payloads:
  `conversationId`, `toolCallId`, op hash, and before/after raster hashes. The pi-durable transcript is the source of
  truth, and a boot reconciler re-derives missing events from it.
- **Evaluations** carry `source: deterministic | system-one | task-verifier | human`, optional scores, `abstain`,
  calibrated probability, and `evidenceRefs`. Interpretations live in their own rows and never edit events.
- **Knowledge nodes** carry `kind`, `statement`, `origin.tools`, `applicability.{verifiedTools, hypothesizedTools,
  excludedTools}`, `supportingEvidence`, `contradictingEvidence`, `status` and `updatedAt`. `origin.tools` and
  `verifiedTools` are separate fields and are never merged.
- **Retrievals** record which nodes were in context for which session. They drive deprecation.

## 5. Learning loops

| Loop | Trigger | Who | Output |
|---|---|---|---|
| Micro | Every canvas action | Deterministic scorecard in the tool result (ΔF, coverage, error class); System One label stored async | Provisional evaluation |
| Attempt | `reset_canvas`, budget exhausted, or `done` | System One triage ("worth reflecting?"), then qwen3.7-flash in `elr-reflector` | Tactic hypotheses |
| Session | `done`, after the verifier | `elr-reflector` | Strategies; micro credit reconciled with the outcome |
| Meta | Every 10 sessions, or a new tool appears | `elr-reflector` | Principles, transfer hypotheses, experiments |

- The reflector's **only tool is `submit_knowledge`**, the same pattern as the merge gate's reviewer. It rejects nodes
  whose evidence ids are not in the journal.
- Reflection is async and never blocks an episode.

**Status rules** (enforced in code; no model can skip a step):
- **hypothesis → candidate:** cites at least one verified session outcome.
- **candidate → validated:** an A/B experiment run by the system, with the node in context vs not, on at least 6
  held-out episodes. Mean boundary-F must improve by at least 0.05, with a bootstrap 95% CI above 0.
- **validated → deprecated:** contradicting rate above 30% over the last 10 retrievals, or a `configHash` change
  (then "needs revalidation").
- Candidates with no new support expire after 30 days.

The **advisory section** is FTS5-ranked, filtered to matching domain and tools, capped at **1,500 tokens** (same cap in
arms C and D), and frozen during evaluation sets.

## 6. System One evaluators (OpenRouter)

Called through pi-ai `classify()` with `OPENROUTER_API_KEY`, which already exists. Models are set by
`ELR_SYSTEM_ONE_MODEL` (default `perplexity/pplx-decider-v1.1-27b`) and `ELR_SYSTEM_ONE_SECOND`
(default `inception/mercury-decide`).

| Question | Type | State given | Used for |
|---|---|---|---|
| `action_effect` | choice: progress / redundant / regress | goal, op, before/after scorecard text | micro label, credit attribution |
| `error_class` | choice: tool / arguments / environment / timing / strategy / none | op, tool error, scorecard | failure-mode stats |
| `worth_reflecting` | yes/no | attempt summary (ops, ΔF curve, outcome) | gate expensive attempt reflection |
| `evidence_vs_node` | choice: supports / contradicts / unrelated | node statement, session outcome summary | deprecation input (then confirmed by status rules) |
| `node_applies` | yes/no | node, goal, tool identity | advisory re-ranking |

Rules:
- **Never the reward.** Labels never enter success, boundary-F or validation decisions.
- **Abstain is respected.** Low probability or an explicit abstain stores `abstain=1`, and the label is not used.
- **Calibration before use (arm B′).** On M3's smoke and T sets, both models label every action. Their agreement with
  the verifier-derived label (ΔF sign, with a threshold) is reported as accuracy and expected calibration error.
- **A label type is used for triage only if** it reaches **accuracy ≥ 0.75 and ECE ≤ 0.10** on held-out labels.
  Otherwise the loop falls back to deterministic signals, and the report says so.
- **Cost:** about $0.02 per million input tokens; a full replicate is about 2.3M tokens, about $0.05. Counted in
  `BENCH_MAX_USD`.

## 7. Benchmark

| Set | Tool | Size | Learning during set |
|---|---|---|---|
| T (train) | brush | 24: primitives (circle, ellipse, square, triangle, star, spiral), then 2–3 element compositions | yes (C, D) |
| H (held-out) | brush | 12 × 3 seeds: unseen compositions (house+sun, face, target rings, flower) | no (frozen) |
| X (transfer) | pen, quirks | 12 × 3 replicates | yes, online |
| X0 (control) | pen, no quirks | 6 | no |

| Arm | Gets |
|---|---|
| A | Tools and `view_canvas` only |
| B | A + micro scorecards |
| B′ | B + System One labels (calibration arm; labels are not shown to the agent) |
| C | B + episodic memory: tool-bound tactics and sequences, advisory |
| D | C + principles, transfer experiments, validated procedures |
| C-placebo (optional) | C with 1,500 tokens of irrelevant painting text |

**Comparability:**
- Same model and pinned provider (`provider.order`, `allow_fallbacks: false`), with fixed temperature and reasoning
  effort.
- Same prompt template, budgets (14 calls, 10 strokes), and seeds and order in every arm.
- Each arm has its own knowledge store, copied from the post-T snapshot.
- Model and provider fingerprints are recorded per episode.

**Metrics:**
- **Success:** boundary-F@4 ≥ 0.85 and every element check passes.
- **Primary:** mean final boundary-F on X, and episodes until 3 consecutive successes on `pen`.
- **Also reported:** calls, strokes, errors, correction cost, evaluator overhead (ms, $), H success, failed transfers
  and retired nodes.

**Decision rule (pre-registered):** D − C on X mean boundary-F ≥ 0.05, with a bootstrap 95% CI above 0, across 3
replicates.

## 8. Safety and constraints

- **The referee is protected (D9).** Paths under `src/elr/verifier/**`, `bench/tasks/**` and the gate's own
  protected-path list are **owner-merge only**, even with `SELF_MERGE=veto` (M0).
- **Untrusted text.** Journals, reflections and critiques are data. The reflector and the reviewer can only submit.
  Procedures can only return ops.
- **Anti-hacking.**
  - Knowledge nodes and procedures that embed a specific task's coordinates are rejected by lint.
  - Task parameters are randomised per seed.
  - Procedure ops are budget-counted.
- **Resources.** Raster plus score p95 under 20 ms at 256². No native image dependencies (no `canvas`, `skia-canvas`
  or `sharp`). Respect the existing heap caps.
- **Spend.** `BENCH_MAX_USD` stops a run before it overspends. The benchmark never draws on chat or coding budgets
  beyond its cap.

## 9. Milestones

Each milestone is one goal for the agent's orchestrator, in order. Each acceptance criterion must be shown by a proof
command; the runner re-runs proofs.

### M0: Protected paths in the merge gate (before anything else)

Adds a `protected paths` gate check in `src/orchestra.ts`. A goal whose diff (base...head) touches a protected path
is never merged by the agent; it waits for the owner whatever the project's merge mode. The list is a constant in
`src/orchestra.ts`, and it protects itself: `src/orchestra.ts`, `src/auth.ts`, `src/sandbox.ts`, `runner/**`,
`src/elr/verifier/**`, `bench/tasks/**`.

- Smoke test: a goal on a `veto` project whose files include `src/elr/verifier/x.ts` ends with merge status "blocked"
  and a question naming the path. A goal touching only `docs/` still merges after the window.
- The gate's check list shows `protected paths` with the matched files.
- The PR for M0 itself is merged by the owner, since it touches `src/orchestra.ts`.

### M1: Canvas sandbox and live view

Adds `canvas.ts` (paint, view_canvas, reset_canvas, done), `raster.ts`, the durable canvas doc, `CanvasStep` in the
web app, and `GET /api/elr/canvas/:id.png` (session-authenticated).

- The same ops render byte-identical PNGs in two runs (hash compared). `npm ls canvas skia-canvas sharp` finds none.
- A test calling `view_canvas` through the registry gets an `image` content item.
- Paint, restart the harness, `view_canvas`: same PNG hash.
- The PNG endpoint gives 200 `image/png` with a session and 401 without. Typecheck, web build and smoke pass.

### M2: Verifier, tasks and journal (protected paths: owner merge)

Adds `verifier/` (boundary-F, linear-time distance transform, element checks), `bench/tasks/` (seeded generators,
quirks, `configHash`), `journal.ts` with migrations and the reconciler, and journal writes from the canvas tools.

- Scorer fixtures:
  - a Bézier circle and 8 short strokes score ≥ 0.9
  - a 40 px fat ring and an all-inked canvas score < 0.5
  - a blank canvas scores 0
  - p95 is under 20 ms at 256²
- The same seed gives byte-identical targets.
- A scripted 6-action episode gives 6 action events with correct attempt and parent links and before/after hashes.
  Killing the process after action 3 and resuming gives no duplicates.
- An FTS5 query works under the production image (Node 24).

### M3: Benchmark harness, arms A, B, B′ and the Lab panel

Adds `npm run bench -- --arm A|B|B1 --set T|H|X|X0|smoke --seed N`, `system-one.ts`, the results JSONL,
`BENCH_MAX_USD`, and the Lab panel.

- The smoke set (3 tasks) runs for A, B and B′. Each episode records boundary-F, calls, strokes, cost, model and
  provider.
- With `BENCH_MAX_USD=0.001`, the run stops before the second episode with a clear message.
- Arm A tool results contain no scorecard; arm B results do (test).
- B′ writes System One evaluations with abstain flags and prints accuracy and ECE per label type against the
  verifier.

### M4: Session learning (arm C)

Adds `reflect.ts` (attempt and session loops, `elr-reflector` with only `submit_knowledge`), `knowledge.ts` (nodes,
relations, retrievals, advisory section), the freeze flag, and System One triage (only for label types that passed
calibration).

- On a fixture journal every node cites existing event ids. A node with an unknown id is rejected (test).
- The advisory block is at most 1,500 tokens (counted) and only matches domain and tools.
- A frozen H run writes 0 nodes. Each arm C episode has `retrievals` rows.

### M5: Abstraction, transfer and procedures (arm D; touches protected tasks: owner merge)

Adds `pen` and its quirks, the meta loop, principle nodes, `TransferRecord`s and experiments, and `procedures.ts` with
`run_procedure` and promotion.

- Introducing `pen` creates at least one TransferRecord that goes untested → testing → validated or rejected, with
  experiment ids pointing at real episodes.
- A principle keeps `origin.tools = [brush]`; `verifiedTools` gains `pen` only after a passing experiment.
- Procedure safety tests:
  - `require`, `process` and `fetch` are undefined
  - an infinite loop stops within 250 ms
  - a memory bomb fails
  - 12 strokes against a 10-stroke budget are refused
- A procedure is callable only when validated with at least 5 verifier trials.

### M6: Ablation run and report

Runs A, B, B′, C, D (C-placebo optional) × 3 replicates within `BENCH_MAX_USD`.

- The report (markdown in `docs/`, plus Lab panel charts) contains:
  - per-arm tables for T, H, X and X0
  - X learning curves and bootstrap CIs
  - System One calibration per label type
  - the decision rule's outcome
  - cost against the cap
  - rejected transfers and deprecated nodes
- Re-running one replicate's episode list reproduces targets and configs by hash.

## 10. Non-goals

- Weight fine-tuning.
- RL training.
- Self-hosting Laya or VegaML. Possible later: a fine-tuned Laya trained on the verifier's labels.
- Image input to System One models.
- ELR for non-painting tools before M6.
- Vision critics as reward.
