# ELR in this agent: canvas painting first

**Status:** proposal for the owner to decide on · 2026-10-18
**Scope:** how the Experiential Learning Runtime (ELR) design should land in this repo, with canvas painting as the
first domain. Decisions and evidence only; the ELR doc itself is not restated.
**Evidence:** six throwaway experiments (total model spend **$0.015**). Their code and outputs were kept outside the
repo.

## TL;DR

1. **The agent model can already see.** OpenRouter's live `/models` lists `deepseek/deepseek-v4.1-flash` (and
   `qwen/qwen3.7-flash`) with `text+image` input. A real call returned geometry within about 5 px. pi-durable tool
   results can carry `ImageContent`. So `view_canvas` returns a PNG straight to the agent, and no separate vision model is
   needed in the MVP.
2. **Plain shape tasks leave nothing to learn.** Given "circle at (128,128), r=80", arm A (no memory) draws it
   perfectly in one call with either tool (boundary-F 1.0, $0.0003–$0.0015). The benchmark gets headroom from **targets
   shown only as images** plus **tools with undisclosed mechanics**. Arm A then scores boundary-F 0.16–0.69, with
   tool-limit errors in every episode.
3. **Scoring is deterministic and outcome-anchored:** boundary F-score against the target mask, plus geometry checks.
   Raw pixel IoU is too brittle for line art. Vision models are good *critics* (what to fix) but poor *scorers*.
4. **Learned procedures should run in QuickJS, not as skills.** A procedure is a pure function `params → ops[]`, run
   in `quickjs-wasi`, which is already installed. In the test it blocked fs, network, infinite loops and memory
   blow-ups. Skills keep full Node access, which is the wrong place for automatically promoted behaviour.
5. **Storage:** canvas state goes in durable docs, so it is replay-safe and atomic with the tool call. The evidence
   journal and knowledge graph go in a separate `/data/elr.sqlite` on `node:sqlite` with FTS5. MEMORY.md and skills stay
   for what they do today.
6. **A full 4-arm ablation costs about $1.3 per replicate (about $4 for three)** with the current models. The cost is
   wall-clock time (about 2.5 h per replicate at 4 in parallel), not money.

## 1. Painting sandbox

### Tools

| Tool | Mechanics | Notes |
|---|---|---|
| `paint({points, width})` | Pixel brush: one stroke through absolute points, round tip | Hidden mechanics per task config (below) |
| `view_canvas()` | Returns the canvas PNG (and the target PNG when the task has one) as `ImageContent`, plus a text scorecard | The agent's only way to "see" |
| `reset_canvas()` | Clears the canvas; marks an **attempt boundary** | |
| `pen({start, heading, moves})` | Second tool, **introduced later** for transfer: turtle-style, relative `forward`/`turn`/`arc` | Meaningfully different mechanics (see below) |
| `done()` | Ends the episode; triggers the verifier | |

**The second tool should be a heading-based pen, not an absolute Bézier `path`.** Bézier circles are pretraining
knowledge (the 0.5523·r control-point trick). In experiment 5 the model used it at once and scored 1.0, so a Bézier
tool would measure recall rather than transfer. A relative, heading-based pen shares the *geometry* with the brush but
not the *parameters*. That is exactly the doc's §6 case: reuse the principle, not old tool arguments.

**Hidden mechanics ("quirks") create the headroom.** They are the stand-in for undocumented behaviour of real tools,
like the doc's truck braking. Each task file sets them, and the tool's identity carries a `configHash` so knowledge
records which variant it was learned on. Brush quirks tested: at most 6 points per stroke, Chaikin smoothing (cuts
corners, shrinks curves), and at most 10 strokes. Candidate pen quirks: y axis pointing up, degrees vs radians, and an
arc direction convention. A no-quirk control subset checks that we measure painting, not just quirk discovery.

### Where they run: a fixed core extension, `src/elr/canvas.ts`

- **Not a skill.** The environment and its verifier must sit outside what the agent can rewrite. Skills are written
  by the agent, and a self-written scorer is the cheapest reward hack there is.
- **Not a separate service.** Rendering costs about 1 ms and needs no isolation; a service adds a network hop and a
  second deploy.
- Benchmark episodes run in **ownerless conversations configured with `extensions: ["canvas"]`**. pi-durable's
  `configure` supports selecting extensions. Episodes then don't see orchestrator, bash or skill tools, so prompts are
  small and every arm gets the same environment.

### Representation and headless rendering on Railway (`node:24-slim`)

- **State = ordered op list** (`{tool, args}`) in a durable doc family keyed by canvas id. The raster is a pure
  function of the ops, so a restart replays the ops, and the web app renders the same ops.
- **Rasterizer: about 150 lines of dependency-free JS.** It stamps discs along polylines, flattens Béziers and pen arcs
  to polylines, and encodes PNG with `node:zlib`. Tested: a 256×256 PNG is about 1–2 KB.

| Option | Native deps | Verdict |
|---|---|---|
| Hand-written JS rasterizer + `node:zlib` PNG | none | **Use.** Deterministic across machines, one rasterizer for every tool, so scoring is comparable |
| `@resvg/resvg-wasm` (SVG→PNG) | none (WASM) | Fallback if anti-aliased fills or text are needed later; not tested |
| Photon (`@silvia-odwyer/photon`, already installed via pi-durable) | none (WASM) | An image processor, not a drawing API; at most useful for resizing |
| `canvas` / `skia-canvas` | yes (Cairo/Skia) | Avoid: Dockerfile changes, platform builds |

### Watching live in the web app

Nothing new is needed on the transport side. `src/agui.ts` already streams `TOOL_CALL_ARGS` for every tool, and the
args *are* the ops.

- Add a `CanvasStep` case in `web/src/components/chat/steps.tsx` that replays the episode's ops as inline SVG. Note
  that `resultText()` in `agui.ts` drops image content, which is why the web app should render from ops, not from the
  result image.
- `GET /api/elr/canvas/:id.png` serves the server raster (the exact pixels the model saw) for history and galleries.
- A **Lab** panel lists benchmark runs, per-arm learning curves, and knowledge nodes by status.

## 2. Seeing and scoring

### Deterministic scorers (experiment 1)

The task is a circle outline at c=(128,128), r=80. Each candidate is scored against the target mask.

| Candidate | calls | pixel IoU | **boundary-F@4px** | precision | recall | radial CV | angular coverage |
|---|---|---|---|---|---|---|---|
| Bézier circle | 1 | 1.00 | **1.00** | 1.00 | 1.00 | 0.014 | 1.00 |
| 8 short brush strokes | 8 | 0.64 | **1.00** | 1.00 | 1.00 | 0.019 | 1.00 |
| 24-pt polygon, ±6 px jitter | 1 | 0.28 | **0.93** | 0.94 | 0.92 | 0.040 | 1.00 |
| open arc (270°) | 1 | 0.69 | **0.87** | 1.00 | 0.77 | 0.181 | 0.83 |
| hexagon | 1 | 0.06 | **0.36** | 0.36 | 0.35 | 0.047 | 1.00 |
| right shape, wrong place (r60, offset) | 1 | 0.05 | **0.27** | 0.33 | 0.23 | 0.019 | 1.00 |
| HACK: 40 px fat ring | 1 | 0.10 | **0.45** | 0.29 | 1.00 | 0.140 | 1.00 |
| HACK: ink the whole canvas | 32 | 0.03 | **0.16** | 0.09 | 1.00 | 0.372 | 1.00 |

- **Raw IoU is unusable for line art:** a visually perfect 8-stroke circle scores 0.64.
- **Boundary-F** (ink near the target outline, and the target outline near the ink) is robust and **resists both
  hacks**: precision collapses when you add ink, and recall collapses when you omit it. It is mildly lenient on gaps
  (open arc 0.87). The task verifier therefore adds element-level checks: closure via angular coverage, connected
  components per element, and the stroke and call budget.
- **Speed:** 2–100 ms per score with a brute-force distance transform (328 ms on a fully inked canvas). M2 replaces it
  with a linear-time distance transform; the target is p95 under 20 ms.
- SSIM was not tested. For thin line art, boundary-F is more interpretable, so SSIM isn't needed for the MVP.

### Vision models (experiment 2: same 5 images, JSON score 0–10 plus estimated centre and radius)

| Image (boundary-F) | DeepSeek V4.1 Flash | GLM 5.3 Flash |
|---|---|---|
| Bézier circle (1.00) | 10, c=(128,128) r=80 | 9, c=(128,128) r=80 |
| jittered polygon (0.93) | 4, "irregular polygon" | 4 |
| hexagon (0.36) | 0 | 2 |
| open arc (0.87) | 6, "close upper-right gap" (correct) | 7, correct gap location |
| offset r60 (0.27; truth c=(150,140) r=60) | 4, c=(148,145) r=58 | 4, c=(150,140) r=55 |
| **cost / latency per call** | **$0.00036 / ~7 s** | **$0.00007 / ~1.2 s** |

- Both models localise well and give **actionable critiques**. Their 0–10 scores disagree with outcome on what matters:
  the jittered polygon is a 0.93 match but gets a 4, and the open arc fails closure but gets a 6–7. **Use vision for
  critique, never as the reward.**
- `qwen/qwen3.7-flash` returned an empty answer at `max_tokens: 1200`, because reasoning used the whole budget. It
  needs a larger cap if it is ever used as a critic.
- **System One classifiers** (`~typesafe/jev-latest`, `inception/mercury-decide`, served through pi-ai's `classify()`):
  the catalog lists image input, but pi-ai 1.3.0's System One API rejects images ("does not support image input").
  Text-only on before/after metrics (experiment 3), they classified progress, redundant and regress correctly in about
  0.5 s for about $0.00002 per call. For painting they only repeat a deterministic delta, so they're **not in the
  MVP**. They are the right hook later for domains without a verifier.

Live prices (USD per million tokens, OpenRouter `/models`, 2026-10-18):

| Model | Input | Output | Image in |
|---|---|---|---|
| deepseek/deepseek-v4.1-flash (agent) | 0.040 | 0.144 | yes |
| qwen/qwen3.7-flash (reflector) | 0.030 | 0.130 | yes |
| z-ai/glm-5.3-flash | 0.048 | 0.200 | yes |
| openai/gpt-5-nano | 0.050 | 0.400 | yes |
| anthropic/claude-haiku-5.5 | 0.100 | 0.500 | yes |
| google/gemini-2.5-flash-lite | 0.100 | 0.400 | yes |
| z-ai/glm-5.3 (reviewer) | 0.079 | 2.500 | no |

The System One classifiers are priced per input token, at 0.02–0.15 per million (pi-ai catalog).

### Which signals are outcome-anchored (principle 8)

| Signal | Anchored? | Use |
|---|---|---|
| Final boundary-F against the target and the task's element checks, at `done` | **Yes: the verified outcome** | Reward, success threshold, benchmark metric |
| Budget used (calls, strokes) at success | Yes, as a cost, conditional on success | Efficiency metric |
| Per-action boundary-F delta | Provisional | Micro scorecard; reconciled at session end. A probe stroke then `reset` can be progress |
| Vision critique text | No | Advice in the transcript only |
| Vision 0–10 score, classifier "progress" | No | Never stored as reward |
| Number of `view_canvas` calls, strokes or reflections | No | Never rewarded (activity) |

## 3. Mapping ELR onto what exists

### Event journal: separate `/data/elr.sqlite`, not a durable doc

- **Durable docs suit small, mutable state** that commits atomically with a tool call: Jobs, Orchestra, and here the
  canvas op list. An append-only log of thousands of events that needs indexes (session, attempt, tool, status) and
  full-text retrieval is a SQL table.
- pi-durable already stores every tool call in the transcript. The journal stores **references**:
  `conversationId`, `toolCallId`, op hash, and before/after raster hashes. It doesn't copy payloads (principle 9).
- **Crash consistency:** events are keyed by `toolCallId` with `INSERT OR IGNORE`. On boot, a reconciler re-derives
  missing events from the transcript, which stays the source of truth. A crash can delay an event but never duplicate
  or invent one.
- **A separate file, not the harness DB:** pi-durable owns its schema and migrations, so a second file avoids coupling
  and can be deleted or retained on its own policy.
- Tables follow the ELR doc §4: `sessions`, `attempts`, `events`, `evaluations`, `knowledge_nodes`,
  `knowledge_relations`, `procedures`, `transfer_records`, `experiments`, plus `retrievals` (which nodes were in
  context for which session). `retrievals` is the key to retiring knowledge.
- FTS5 works in `node:sqlite` (verified on Node 26.12 locally; Node 24 is an acceptance check in M2).

### Loops versus the existing reflector

| ELR loop | Here | Model | Cost/latency |
|---|---|---|---|
| Micro | Inside the canvas tools: deterministic scorecard (delta boundary-F, coverage, error class such as "stroke has 9 points, max 6") returned in the tool result | none | 2–20 ms |
| Attempt | On `reset_canvas`, budget exhaustion or `done`: reads the attempt's events and proposes tactic hypotheses | qwen3.7-flash | ~$0.0005, async |
| Session | On `done`, after the verifier: reconciles micro credit with the outcome and proposes strategies | qwen3.7-flash | ~$0.001, async |
| Meta | Every N=10 sessions, or when a new tool appears: abstracts principles, writes transfer hypotheses, schedules experiments | qwen3.7-flash (or deepseek) | ~$0.005 per run |

- ELR reflections run in their own ownerless **`elr-reflector` conversation whose only tool is `submit_knowledge`**,
  the same pattern as the reviewer's `submit_review`, because journals contain model-written text.
- `submit_knowledge` **rejects any node whose evidence ids do not exist in the journal.**
- The existing 12-hour reflector stays the general outer loop. Later it can read ELR nodes instead of raw transcripts.

### Knowledge: what to keep and what to replace

| Store | Keeps | Changes |
|---|---|---|
| `MEMORY.md` | Owner facts and preferences (not experiential, not evidence-backed) | Nothing. Painting knowledge must not leak into it |
| Skills (`src/skills.ts`) | Capabilities: API integrations, tools the agent writes for itself | Nothing. Learned *procedures* do not become skills (below) |
| `knowledge_nodes` (new) | Observations, tactics, strategies, principles, adaptations, with `origin.tools` separate from `applicability.verifiedTools` / `hypothesizedTools` | Rendered as an **advisory section** for episodes in the matching domain and tools: FTS5 ranking, **hard cap of 1,500 tokens**, the same cap in arms C and D |

**Status rules** (no model can skip a step):

| From → to | Requires |
|---|---|
| hypothesis → candidate | Cites at least one verified session outcome |
| candidate → validated | An A/B experiment the system runs: the node in context vs not, on at least 6 held-out episodes, mean boundary-F improves by at least 0.05, bootstrap CI above 0 |
| validated → deprecated | Contradicting evidence rate above 30% over the last 10 retrievals, or a tool `configHash` change (then "needs revalidation") |

### From validated knowledge to procedures, safely

A **procedure** is a pure function `(params) → ops[]` stored in `procedures` and run in `quickjs-wasi`. The package is
already installed via `@earendil-works/pi-codemode`.

Experiment 4 tested it. A brush-circle procedure ran in 23 ms and produced 8 ops; inside the VM, `require`, `process`,
`fetch` and `os` are all `undefined`. An infinite loop stopped at the 200 ms interrupt, and a memory bomb hit the 16 MB
limit.

The rules:

- **No I/O by construction.** A procedure only *returns ops*. The canvas extension validates and applies them through
  the same code path as `paint` and `pen`.
- **No free actions.** Each op counts against the episode's stroke and call budget, so a procedure cannot get around
  limits.
- **Promotion only via the verifier:**
  - candidate procedure → at least 5 verifier trials on randomised task parameters (position, scale) → validated
  - exposed as `run_procedure(name, params)` only in arm D and only when validated
  - versioned, with rollback, and retired when its `configHash` no longer matches
- **Why not skills:** skills run in a worker thread that limits memory and time but still has `node:fs` and network
  (README: "Skills run in-process with full access"). That's fine for owner-requested capabilities. It's wrong for
  behaviour the system promotes automatically from model-written text (ELR §4 data hygiene).
- **Protect the referee.** The verifier, task files and quirk configs live in `src/elr/verifier/` and
  `bench/tasks/`. The merge gate should treat those paths as **owner-merge only**, even under `SELF_MERGE=veto`.
  Otherwise the agent's own orchestrator could "improve" its score by editing the scorer.

## 4. Smallest MVP that tests the hypothesis

**Hypothesis (doc §10):** abstract, evidence-backed knowledge improves adaptation to an unfamiliar tool more than
stored tool-specific successful action sequences do.

### Task sets (generated from seeds; targets drawn by the same rasterizer and shown only as images)

| Set | Tool | Size | Content | Learning during set |
|---|---|---|---|---|
| **T** (train) | brush | 24 | Primitives (circle, ellipse, square, triangle, star, spiral) at random position and scale, then 2–3 element compositions | Yes (arms C, D) |
| **H** (held-out) | brush | 12 × 3 seeds | **Unseen compositions:** house+sun, face, target rings, flower, with new primitive combinations | **No:** knowledge frozen |
| **X** (transfer) | pen | 12 × 3 replicates | Same shape families as T plus new compositions; pen quirks hidden | Yes, online: measures adaptation speed |
| **X0** (control) | pen, no quirks | 6 | Sanity check: is the gain from painting or from quirk discovery? | No |

### Arms

| Arm | Gets |
|---|---|
| **A** | Tools + `view_canvas` image; nothing persists across episodes |
| **B** | A + micro scorecards in tool results (deterministic deltas, error classes) |
| **C** | B + **episodic memory**: attempt and session reflection store tool-specific tactics and successful action sequences (`kind: observation \| skill`, tool-bound); advisory retrieval |
| **D** | C + meta abstraction (principles with origin vs applicability), transfer hypotheses and experiments for `pen`, and validated procedures via `run_procedure` |

The **critical comparison is D vs C on X** (learning curve and area under it over the 12 X tasks). D vs C on H
measures within-tool generalisation, and B vs A measures what scorecards alone are worth.

### Comparability

- **Same model and route:** `deepseek/deepseek-v4.1-flash`, OpenRouter `provider.order` pinned and
  `allow_fallbacks: false`, fixed temperature, fixed reasoning effort.
- **Same environment:** same system prompt template, same extensions (`["canvas"]` plus the advisory section in C/D),
  same budgets (14 tool calls, 10 strokes), and the same task seeds and order in every arm.
- **Same context size:** an equal advisory token cap in C and D. An optional **C-placebo** arm, with 1,500 tokens of
  irrelevant painting text, separates "more context" from "better knowledge".
- **Clean evaluation:** H runs on a frozen knowledge snapshot and evaluation episodes write nothing. Each arm's
  knowledge store is its own SQLite file, copied from the post-T snapshot.
- **Replicates:** three independent learning runs per arm. Experiment 6 showed boundary-F spread of about 0.2 per
  episode, so 36 paired X episodes give a paired-difference SE of about 0.05, and 108 give about 0.027.

### Metrics

| Metric | Detail |
|---|---|
| Primary | Mean final boundary-F on X, and episodes until 3 consecutive successes on `pen` (adaptation speed) |
| Success | Boundary-F@4 ≥ 0.85 **and** every element check passes |
| Also tracked | Tool calls, strokes, error count, correction cost (strokes after the first `view_canvas`), evaluator overhead (ms, $), held-out H success |
| Also tracked | Failed transfers and retired nodes, counted as carefully as successes |

**Pre-registered decision rule:** D − C on X mean boundary-F ≥ 0.05 with a bootstrap 95% CI above 0, across 3
replicates. Otherwise the hypothesis is rejected for this domain, and D's extra machinery has to justify itself
elsewhere.

### Cost of one benchmark replicate

Per episode, measured in experiment 6 (13–17 calls, 1–3 views, images included): **$0.0019–$0.0032**.

| Item | Episodes / runs | Unit | Total |
|---|---|---|---|
| Episodes, 4 arms × (24 T + 36 H + 36 X) | 384 | ~$0.003 | ~$1.15 |
| Attempt + session reflection (C, D on T and X) | ~120 | ~$0.0015 | ~$0.18 |
| Meta abstraction + transfer experiment design (D) | ~8 | ~$0.005 | ~$0.04 |
| Transfer and validation experiments (extra D episodes) | ~30 | ~$0.003 | ~$0.09 |
| **One replicate** | | | **~$1.5** |
| **Three replicates** (decision-grade) | | | **~$4.5** |

Wall clock: about 7 s per model turn × about 10 turns gives about 70 s per episode. That's about 7.5 h sequential per
replicate, or about 2 h at 4 in parallel (OpenRouter rate limits permitting). The benchmark should have its own
`BENCH_MAX_USD` (suggest $10), so it can't exhaust `MAX_SPEND_USD`, which also funds chat and coding.

## 5. Risks

| Risk | Where it bites | Mitigation |
|---|---|---|
| **Reward hacking the scorer** | Over-inking, partial drawings, editing the scorer via self-modification, procedures that memorise target coordinates | Boundary-F penalises over- and under-inking (experiment 1). Verifier and tasks are owner-merge-only paths. Task parameters are randomised per seed, and H is unseen. Lint rejects knowledge nodes and procedures that embed a specific task's coordinates. Budgets apply to procedure ops |
| **Benchmark measures quirk discovery, not painting** | Quirks dominate the gains | X0 no-quirk control; report quirk-related errors separately from geometry errors |
| **Evaluator overhead** | A slow distance transform; LLM reflection per attempt | Linear-time DT (p95 under 20 ms); reflection is async and never blocks an episode; overhead is reported as a metric |
| **Knowledge rot** | Tool version changes; nodes that sounded right but don't help | `configHash` in tool identity invalidates nodes; `retrievals` correlates each node with outcomes; automatic deprecation; hard advisory cap; candidate nodes expire after 30 days without support |
| **Context confound** | C/D win because they have more tokens | Equal caps; C-placebo arm |
| **Model drift** | Provider changes the weights mid-study | Pinned provider; all arms of one replicate run interleaved on the same day; model fingerprint (response `model` and `provider`) recorded per episode |
| **Untrusted text in the journal** | Reflections or critiques that inject instructions | Reflector's only tool is `submit_knowledge`; evidence ids validated; procedures can only return ops |
| **Scope creep into the general agent** | ELR hooks on every tool before painting proves anything | Painting-only until the M6 decision rule passes |

## 6. Open decisions for the owner

| # | Decision | Recommendation |
|---|---|---|
| 1 | **Benchmark realism:** hidden tool quirks and image-only targets, or plain documented tools with harder compositions only | **Hidden quirks plus image targets, with an X0 no-quirk control.** Experiments 5 and 6 show plain tasks hit the ceiling for arm A, which would make the hypothesis untestable |
| 2 | **Where learned procedures live:** QuickJS pure `params → ops` procedures, or skills | **QuickJS procedures.** Already installed, no I/O by construction, budget-counted. Skills keep full Node access, which is wrong for automatically promoted code |
| 3 | **Protect the referee:** owner-merge-only paths for verifier, tasks and quirk configs (a new merge-gate check) | **Yes.** It's the one reward hack the scorer can't catch |
| 4 | **Journal storage:** separate `elr.sqlite`, or durable docs | **Separate SQLite** for the journal and knowledge; **durable docs** for canvas state |
| 5 | **Second tool:** heading-based `pen`, or Bézier `path` (the doc's example) | **`pen`.** Bézier circles are pretraining knowledge, so `path` measures recall, not transfer |
| 6 | **Vision critic in the loop** (GLM 5.3 Flash, about $0.00007 per view) | **Not in the MVP.** The agent sees its own canvas; add a critic as arm B′ only if B/C plateau |
| 7 | **Budget:** separate `BENCH_MAX_USD` | **$10**, separate from `MAX_SPEND_USD` |
| 8 | **Scope:** painting-only until the decision rule passes | **Yes.** Generalise the hooks to other tools only after M6 |

## 7. Implementation plan (goals for the agent's own orchestrator)

Each milestone is one goal with proof-checkable acceptance criteria. The order is strict, because each one depends on
the previous. All of them change this repo, so they go through the veto window, and M2 and M5 touch protected paths.

### M1: Canvas sandbox and live view

Adds `src/elr/canvas.ts` (the `canvas` extension: `paint`, `view_canvas`, `reset_canvas`, `done`), the rasterizer and
PNG encoder, a durable canvas op doc, `CanvasStep` in the web app, and `GET /api/elr/canvas/:id.png`.

- A unit test renders a reference circle and a 9-point brush polygon. PNG bytes are deterministic (same hash in two
  runs), and there are no new native dependencies (proof: `npm ls` shows no `canvas`/`skia-canvas`/`sharp`).
- The `view_canvas` result contains an `image` content item, as shown by a test that calls the tool through the
  registry.
- Restart safety: a smoke test paints, restarts the harness, calls `view_canvas`, and gets the same PNG hash.
- The PNG endpoint returns 200 `image/png` when authenticated and 401 without auth. `npm run typecheck` and
  `npm run build:web` pass.

### M2: Verifier, task files and journal (protected paths)

Adds `src/elr/verifier/` (boundary-F with a linear-time distance transform, element checks, closure), `bench/tasks/`
(seeded generators, quirk configs, `configHash`), `/data/elr.sqlite` with schema migrations, journal writes in the
canvas tools, and a boot reconciler.

- The scorer test reproduces experiment 1: good candidates ≥ 0.9, both hacks < 0.5, blank = 0. Scoring p95 is under
  20 ms at 256².
- The same seed produces byte-identical targets.
- A scripted 6-action episode yields 6 `action` events with correct `attemptId`, `parentEventId` and before/after
  hashes. Killing the process after action 3 and resuming yields no duplicate events.
- FTS5 query test passes under the `node:24-slim` image (proof run in CI or a container).
- Merge gate: a diff touching `src/elr/verifier/**` or `bench/tasks/**` is reported as "owner merge required", with a
  unit test on the gate check.

### M3: Benchmark harness, arms A and B, Lab panel

Adds `npm run bench -- --arm A|B --set T|H|X|smoke --seed N`: ownerless episode conversations with
`extensions: ["canvas"]`, a pinned model and provider, budgets, a results JSONL, `BENCH_MAX_USD`, and a Lab panel
showing runs and curves.

- The `smoke` set (3 tasks) runs for arms A and B and writes per-episode boundary-F, calls, strokes, cost, model and
  provider.
- With the cap set to $0.001, the run stops before the second episode with a clear message.
- In arm A the tool results contain no scorecard; in arm B they do (asserted in a test).

### M4: Session learning (arm C)

Adds the attempt and session loops in an `elr-reflector` conversation with only `submit_knowledge`; tables for
`knowledge_nodes`, `knowledge_relations` and `retrievals`; and an advisory section with a 1,500-token cap and a freeze
flag.

- On a fixture journal, every produced node cites existing event ids. A node citing an unknown id is rejected by the
  tool (test).
- The advisory block is at most 1,500 tokens (counted) and only includes nodes whose tools and domain match.
- A frozen run of H writes 0 nodes. `retrievals` rows exist for each episode in C.

### M5: Abstraction, transfer and procedures (arm D; `pen` touches protected task paths)

Adds the `pen` tool and quirks, the meta loop, principle nodes with origin vs applicability, `TransferRecord`s and
transfer experiments, and the QuickJS procedure runner with `run_procedure` and promotion rules.

- Introducing `pen` creates at least one `TransferRecord` that goes from `untested` to `testing` to
  `validated`/`rejected`, with experiment ids that point to real episodes.
- A principle node keeps `origin.tools = [brush]` while `verifiedTools` gains `pen` only after a passing experiment
  (test on fixtures).
- Procedure safety tests: `require`/`process`/`fetch` are undefined; an infinite loop is stopped within 250 ms; a
  memory bomb fails; a procedure emitting 12 strokes against a 10-stroke budget is refused.
- A procedure is exposed only when its status is `validated` with at least 5 verifier trials.

### M6: Ablation run and report

Runs A, B, C, D (plus the optional C-placebo) × 3 replicates.

- The report artifact contains per-arm tables for T, H, X and X0, learning curves on X, bootstrap CIs, the decision
  rule's outcome, total cost against `BENCH_MAX_USD`, and lists of rejected transfers and deprecated nodes.
- Everything is reproducible: re-running one replicate's episode list with the same seeds yields the same targets and
  configs (verified by hash).
