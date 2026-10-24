# pi-durable personal agent

A personal agent that runs 24/7 on Railway, talks to you over Telegram and a web chat, and improves itself. Built on
[`@earendil-works/pi-durable`](https://github.com/earendil-works/pi/tree/main/packages/durable) (experimental, 1.3.0)
with cheap open models via OpenRouter.

> **Status: personal project, run at your own risk.** This agent runs shell commands, writes and installs its own code,
> and spends money on model calls on your behalf. It is built for one owner on their own infrastructure, not as a
> hosted or multi-user product. Read [Security model](#security-model) before deploying, and set `MAX_SPEND_USD`.

## Getting started

Set it up in three stages. Each one works without the next.

| Stage | You get | You need | Guide |
| --- | --- | --- | --- |
| 1. Local | Web chat, memory, self-written skills, jobs | Node 24, an [OpenRouter](https://openrouter.ai) API key | [Run locally](#run-locally) |
| 2. Hosted | The same, 24/7, plus Telegram | A [Railway](https://railway.com) account with a volume, a Telegram bot from @BotFather | [Deploy to Railway](#deploy-to-railway) |
| 3. Orchestrator | Goals planned by a foreman and coded by OpenCode in throwaway containers, reviewed PRs | A second Railway project, an OpenRouter management key, a GitHub org for the agent | [Setup (once)](#setup-once) |

Every variable is listed with a comment in [`.env.example`](.env.example). Only `OPENROUTER_API_KEY` and `AUTH_TOKEN`
are required for stage 1.

## How it works

```
Telegram ─┐                     ┌─ root conversation (you) ── DeepSeek V4.1 Flash
Web app  ─┼─► durable Harness ──┤
Scheduler ┘   (SQLite on /data) └─ reflector conversation ─── Qwen 3.7 Flash  (outer loop, every 12h)
                     │
         core extension (fixed)          skills/ (self-written, hot-loaded)
         memory · skill_save/rollback    skill-*.mjs → registry.install()
         schedule_job · notify           .history/ keeps every old version
         bash/read/write/edit
```

- **Durable.** Every message, model turn, and tool call is committed to SQLite before it shows. If Railway restarts
  the container mid-task, `harness.resume()` picks the work up again. Every trigger (Telegram update, job run,
  reflection) has a deterministic `requestId`, so nothing runs twice, and replies still pending are delivered after
  the restart.
- **Inner loop: it builds itself.** When the agent lacks a capability, it writes a skill. A skill is an ES module
  exporting `(kit) => kit.defineExtension({...})`. Each one is staged, test-imported and only then installed
  (`registry.install` replaces it in place, without a restart). The previous version is archived for `skill_rollback`.
  Every conversation picks up new skills immediately.
- **Outer loop: it improves itself.** On a schedule, a separate reflector conversation reads recent activity and
  looks for failures, friction and repeated manual work. It then fixes skills, curates `MEMORY.md` and schedules
  missed follow-ups, making at most 3 tested changes per pass, and messages you when something noticeable changed.
  It also reads the factory's `scorecards` (its only orchestration tool, read-only) and compares the last 7 days with
  30. When first-attempt acceptance or the proof pass rate drops 15 points, cost per accepted task rises 50% (and by at
  least $0.10), or goals need half a review round more, it sends you one message with the numbers and a suggested
  change. The same set of drops is announced at most once a week, though reflection runs every 12 hours. A 7-day
  window with fewer than 5 attempts per coder model, or fewer than 3 reviewed goals, doesn't count.
  This is advisory: it never changes models or configuration itself.
- **Memory.** `MEMORY.md` on the volume is rendered into the system prompt every turn.
- **Jobs.** `schedule_job` stores one-shot or recurring prompts in a durable doc. When a job fires, its answer goes to
  Telegram, unless the answer is `NO_REPLY`.
- **Guardrails.** Only `TELEGRAM_OWNER_ID` is answered, the web app and API need your passkey, and `MAX_SPEND_USD`
  caps total spend. The core (identity, skill system, scheduler) is not writable by the agent.

## Orchestrator: it runs projects, it doesn't code them

Tell the agent what you want built, either in the agent itself or in a new project it creates for you. It agrees the
goal and acceptance criteria with you, then a per-goal **foreman** plans small, checkable tasks. Once you approve the
plan, each task attempt runs **OpenCode in a throwaway container** in a separate Railway project, and the foreman
babysits the work until the goal is done. Nothing runs on your computer.

```
 agent project (Railway)                       agent-sandboxes project (Railway)
 ┌──────────────────────────────┐  create /    ┌────────────────────────────────────┐
 │ chat · foreman · durable state│─ delete ───► │ one container per attempt           │
 │ the only long-lived secrets   │              │ node:24 + pinned OpenCode, no volume │
 │ pushes to agent/* branches    │◄─ evidence ──│ lives minutes, then deleted          │
 └──────────────────────────────┘   + bundle   └────────────────────────────────────┘
```

**Blast radius, per attempt** (`runner/task-runner.mjs`, `src/sandbox.ts`):

| What a container gets | Scope | Lifetime | If a malicious dependency steals it |
|---|---|---|---|
| GitHub token from the GitHub App | **read-only**, one repo | 1 hour | it can read the repo it was working on |
| OpenRouter key | spend cap (`ATTEMPT_BUDGET_USD`, default $3) | deleted after the attempt | it burns ≤ $3 |
| Runner token | its own heartbeat + evidence | dies once it reports | it can fake its own report; the foreman still reads the real diff |

- **Containers can't write to GitHub.** Their commits come back as a git bundle; the agent pushes them, and only to the
  goal's `agent/...` branch. Default branches change only through PRs.
- **Untrusted code runs unprivileged.** OpenCode and your verify command run as uid 1000, so they can't read the
  runner's secrets (checked on Railway: reading `/proc/1/environ` is denied). Everything they left running is killed
  before the token is used again.
- **The sandbox token can't reach the agent.** It is scoped to the sandbox environment; on the agent's project it gets
  "Not Authorized".
- **The merge gate.** Nothing merges on the coder's word.
  - **Behavioural proofs:** for every acceptance criterion the coder writes a proof command (start the app and curl
    it, run the one test that covers it), tagged with the criterion's 0-based `criterionIndex`. The runner re-runs each
    proof itself, as uid 1000, and records the real output. It re-runs up to 8 proofs, or one per criterion when a task
    has more, always keeping the first proof of each criterion.
  - **Holdouts:** when a goal is created, a separate **examiner** conversation (`EXAMINER_MODEL`, default the reviewer's
    model; `EXAMINER_PROVIDER` likewise) writes hidden shell checks for each goal criterion from the criteria alone,
    before any code exists. Its only tool is `submit_holdouts`. A criterion it says no command can check is listed for
    you in the plan-approval message. Holdouts live only in the orchestrator's state: never in a task prompt, a coder
    container or the goal branch. Once every task is accepted, the orchestrator runs one holdout attempt: a fresh
    container on the branch head with no coder and no model credentials. The runner fetches the commands with its own
    attempt token (`POST /api/runner/holdouts`), runs the project's verify command to install dependencies, then runs
    each check as uid 1000. If any check fails, the foreman gets the criterion and a short output with the command blanked
    out, and adds fix tasks. The holdouts run again on every new head before review. The web app shows you the
    full checks and their results.
    - **A wrong check can't loop forever.** After 3 failed holdout runs the goal is blocked and you get the failing
      commands and their output in a direct message (never in the goal's question or events, which the foreman can
      read). If a check is wrong, waive it with `waive_holdout` (owner only): it stops running and counting at the
      gate, and a blocked goal moves on. Otherwise tell the foreman what to fix.
  - **Independent review:** once all tasks are accepted and the holdouts pass, a reviewer on a different vendor's model
    (`REVIEWER_MODEL`, default GLM 5.3; the coder is Kimi) reads the goal's whole diff. It runs in its own conversation whose only tool is
    `submit_review`, because diffs are untrusted input. Blocker or major findings go back to the foreman as new
    tasks. After 3 rounds the goal comes to you.
  - **README rule:** any change to behaviour, configuration, environment variables, gate checks or workflows updates
    `README.md` in the same change. The rule is in `AGENTS.md` (read by OpenCode, and by Claude Code via `CLAUDE.md`)
    and in the coder's task rules. For this repo the reviewer treats a behaviour or config change with no README change
    as a **major** finding. A diff that changes how an environment variable is read (`env("X")`, `process.env.X`)
    without touching `README.md` gets that finding from the orchestrator itself, whatever the reviewer decides. Test and
    benchmark files (`scripts/`, `bench/`, `runner/test/`, `*.test.*`) are ignored, since they set variables for themselves.
  - **Gate checks**, all required, recorded on the goal and the review posted on the PR:
    - verify passed for every task with commits
    - the last verified commit is exactly the PR head
    - every proof passed, and every acceptance criterion of every task has at least one passing proof (a proof with
      no `criterionIndex`, such as one from an older attempt, covers nothing)
    - every holdout passed on exactly the PR head (goals from before holdouts, and goals where the examiner found
      nothing checkable by a command, pass this check)
    - the approved review is of that head
    - GitHub reports the PR as mergeable
  - **Merging:**
    - Projects the agent created merge at once.
    - **This repo merges after a veto window** (`MERGE_VETO_MINUTES`, default 5). You're notified, and can reply
      `veto <goal>` or press **Veto merge**. Before merging, the agent re-checks that the head hasn't moved. Merges
      are squash merges pinned to the reviewed SHA.
    - Set `SELF_MERGE=owner` to merge this repo yourself.
- **Protected paths:** the agent never merges a change to its own guardrails (the gate, auth, credentials, confinement,
  the runner, the Dockerfile, `railway.json` and the rest of `PROTECTED_PATHS` in `src/orchestra.ts`). It opens the
  PR and asks you.
- **Observation and rollback:** after the agent merges into this repo, it watches production.
  - **Deploy:** the merge should go live within `DEPLOY_DEADLINE_MINUTES` (default 15); Railway's `/health`
    healthcheck keeps a broken build from taking traffic. A merge that misses the deadline is **not** reverted:
    production still runs the previous version, so the agent tells you once and keeps waiting; the watch starts when
    it goes live (a Railway build pause on 2026-10-21 otherwise reverted a good merge).
  - **Watch:** for `OBSERVE_MINUTES` (default 5) it probes `/health`, the auth state and the web app, and counts
    server errors and crash loops.
  - **P0** (on a live merge): about 2 minutes of failed probes, 20 or more errors, or 3 restarts. The agent
    reverts the merge at once, with no veto window, and opens a fix goal with the evidence. Every revert becomes a
    permanent regression test: the fix goal's criteria require a **committed** test that runs in the project's verify
    command (for this repo, for example, a case in `scripts/smoke.ts`), and the foreman rejects a fix that only adds a
    proof.
  - **Warnings** (smaller error bursts, probes that failed and then recovered) open an investigation goal instead.
  - Only the newest merge is watched, and follow-ups are one level deep.
- **Workflows** (`src/workflows.ts`, design in `docs/workflows.md`): every stage transition comes from the goal's
  workflow, a versioned list of built-in stages. The default workflow is the pipeline above. For this repo, review, the
  gate and observation are always inserted, whatever a workflow says.
- **Coding model:** with `CODER_PROVIDER=opencode-go`, coders use your OpenCode Go plan. Containers never get the key.
  They call the agent's proxy with a per-attempt LLM token, and the proxy forces the configured model and adds the key
  and OpenCode Go's session header. The default, `openrouter`, mints a capped key per attempt.
- **Egress:** everything a container sends the agent is gzipped, since it leaves the sandbox project over the public
  network and is billed. OpenCode's requests (the whole conversation, every turn) go through a relay on the container's
  localhost that compresses them; heartbeats and evidence are compressed by the runner. The agent accepts gzip on every
  runner route. OpenCode Go itself does not accept compressed requests, so the agent forwards them uncompressed.
- **Maintenance:** `PAUSE_ALL=true` pauses every goal (stopping running attempts uncounted), jobs and reflection.
  `false` resumes exactly what it paused, and their tasks restart on the current configuration. While it is on, the
  web app's header reads "Maintenance" with a banner. From your machine (Railway CLI logged in and linked, and
  `AGENT_URL` set to your agent's public address, e.g. `https://<service>.up.railway.app`):
  `npm run railway -- check` reports Railway's status page, the latest deployment, production's version and the
  sandbox token; `npm run railway -- pause` sets it and waits for the redeploy; `npm run railway -- resume` turns it
  off only when every check passes (`--force` skips the gate).
- **Autonomy mode:** with `AUTO_APPROVE_PLANS=true`, plans start without your approval code. You're still notified
  of every plan and merge, and can cancel a goal or veto a merge.
- **Evidence over claims.** The runner records commits, the diff and the project's `verify` command itself. The foreman
  judges those facts: accept, revise with feedback (the next attempt gets a fresh container), or escalate to you. After
  3 failed attempts it escalates on its own. A container that dies or overruns is reported with its last logs and torn
  down, and a sweep deletes anything left over. Stored evidence keeps what its readers use: the first 14,000 diff
  characters, the last 4,000 of verify output and the last 3,000 of each proof and holdout; older, larger evidence is
  trimmed once on boot.

### Setup (once)

1. **Railway sandbox project:** an empty project with an environment-scoped project token, set on the agent as
   `SANDBOX_RAILWAY_TOKEN`, `SANDBOX_PROJECT_ID` and `SANDBOX_ENVIRONMENT_ID`.
2. **OpenRouter:** create a management key and set `OPENROUTER_MANAGEMENT_KEY`. Management keys expire on the date you
   pick, so set a reminder to renew it.
3. **GitHub:** create a free GitHub org for the agent. In the web app's **Settings** page, enter the org name and click
   **Create GitHub App**. GitHub shows the permissions and creates the app, and its private key goes straight to the
   agent's volume. Then install the app on the org.
4. Optional, for "it builds itself": fork or copy this repo into that org; the agent registers it as a project on its
   own (merged after the veto window). Skip this if you only want it to work on other projects.

To avoid installing OpenCode on every attempt, the **Runner image** GitHub workflow publishes
`runner/Dockerfile` to `ghcr.io/<your-org>/pi-agent-runner:<commit-sha>` (the repo owner's name, lowercase). Make the package public
for Railway image pulls, then set the agent's `SANDBOX_IMAGE` to that immutable tag (or digest).
The image defaults to OpenCode 1.19.3; keep its build argument aligned with `OPENCODE_VERSION`.
The base image and workflow actions are pinned; update their digests/commit SHAs explicitly when
applying upstream security updates. Prefer an image digest in `SANDBOX_IMAGE` so a changed tag cannot
replace a running deployment's toolchain. Never put registry credentials in sandbox variables or images.
Private-registry pulls require Railway Pro; Hobby deployments require a public runner image.
The runner checks the actual installed version and installs the requested version only when missing
or different, so stock images and version overrides remain supported. Existing attempts are unaffected.

### It builds itself

Ask the agent for a change to itself and the same loop runs in containers. The verify command is typecheck + web
build + smoke test. The result is a reviewed PR that the agent merges once the veto window passes, unless you veto it.
Railway redeploys from `master`.

## Signing in: passkeys

The web app uses **passkeys** (Touch ID, Face ID or a security key), not a shared token (`src/auth.ts`).

- **First run:** open the app, enter the current `AUTH_TOKEN` once, and create a passkey. You get **8 one-time
  recovery codes**, shown once; keep them in a password manager. Then **remove `AUTH_TOKEN` from Railway** to turn
  bearer access off completely.
- **Sessions** last 24 hours in an HttpOnly, Secure, SameSite=Strict cookie. POSTs from other origins are refused, and
  guesses at recovery codes are rate-limited.
- **At rest:** passkeys are public keys; sessions and recovery codes are stored only as SHA-256 hashes, in
  `/data/secrets/owner.json` on the volume.
- **Agent → Security** in the app: add a passkey for another device, replace recovery codes, sign out everywhere.
- Passkeys belong to the app's domain. If you move to a custom domain, sign in there with a recovery code and add a
  new passkey.

## Web app

`web/` is a React app built with [shadcn AI Elements](https://ui.shadcn.com/docs/ai-elements) and
[CopilotKit](https://docs.copilotkit.ai). The server serves the built app at `/`.

- **CopilotKit ↔ AG-UI.** `POST /api/agui` speaks the [AG-UI](https://docs.ag-ui.com) protocol: it streams the
  conversation's live pi-durable events (text, reasoning, tool calls and results, live bash output) as SSE. The
  browser registers it with `<CopilotKitProvider selfManagedAgents={{ default: new HttpAgent(...) }}>`, so no separate
  CopilotKit runtime server is needed, and drives it with `useAgent()`. History comes from `GET /api/messages`, because
  the durable transcript is the source of truth; Telegram and job runs show up in the web app too.
- **AI Elements.** The thread uses Message Scroller, Message, Bubble, Trace (reasoning and tool steps), Code Block and
  Streamdown markdown. The agent's own tools are shown in plain language: "Learned a new skill: weather",
  "Remembered…", "Scheduled for Sun 9:00", with live terminal output for `bash`.
- **Layout.** A dark-first app with a top bar (**Board**, **Jobs**, **Memory**, **Artifacts**, **Insights**, **Settings**), a ⌘K
  palette to jump to any goal, job or page, and header chips for health (Healthy / Working / Maintenance), spend
  against the cap and the next job. The page lives in the URL hash (`#board/<goalId>`, `#jobs/<jobId>`,
  `#insights/cost`, …); old `#monitor/<view>` links open the matching Insights page.
- **Board.** Goals as cards in four columns: **Needs you** (waiting on approval, a question, a failed gate or a
  rollback), **Planning**, **Building** and **Shipped · 7d** (the newest 5, with Show more). A card opens a drawer with the goal's **Thread** (what
  you asked, the orchestrator's events for it, and the one decision it needs: approve the plan, pick holdouts to waive,
  review a PR the agent won't merge itself, or answer the foreman), its **Tasks** with every attempt's evidence, and
  **Evidence** (preflight, holdouts, review, gate, merge, production watch, and Pause / Resume / Retire / Cancel).
  Replies, waivers and **+ New goal** are sent as messages on the owner thread, tagged with the goal, and the agent acts
  on them with its own tools; consequential ones (waivers, plan changes) land in the composer for you to confirm.
  **General thread** opens the full chat in the same drawer.
- **Jobs, Memory, Insights, Settings.** Jobs lists every schedule with its last 5 runs (Show more for the rest), prompt and the run-on-change switch
  (plus archived schedules to restore). Memory shows MEMORY.md as searchable, filterable cards; Edit and Forget draft
  the change in the general thread. Insights holds the telemetry pages (Overview, Activity, Spend, Coding model, Models
  & tools, Reflector, Containers), Coders (scorecards), Reports (daily CEO reports, last 7 days, the team) and Lab.
  Settings has reflection with Reflect now, sandbox and repository setup, models, the spend cap, theme, skills, and
  passkeys and sessions.

```bash
npm run dev                # agent on :3000 (serves the last web build)
npm run dev:web            # Vite dev server on :5173 with hot reload, proxying /api to :3000
npm run build:web          # production build into web/dist
```

### Runner resources in Insights

Open **Insights → Containers**, then expand **Resources** on an attempt. New runners sample every
five seconds and at phase boundaries, sending live summaries with the existing 30-second heartbeat.
Final summaries survive container cleanup; older attempts have no resource history.

The phase table shows elapsed time, sampled peak container memory (including children and filesystem
cache), runner-only RSS, cumulative CPU time, and captured stdout/stderr byte counts. The final Git
bundle size is included when available. Container metrics use cgroup v2 and show as unavailable when
those counters cannot be read. These are diagnostic observations, not Railway billing measurements;
brief peaks between samples can be missed. Only fixed phase names and bounded numeric data are stored.

The runner source is gzip-compressed for transport to stay below Railway’s per-variable size limit.

Run `npm run test:runner-resources` for sampler and payload-validation checks. The smoke suite checks
heartbeat authentication, durable resource evidence, and the monitoring API projection.

### Artifacts: one list of everything the agent has made

The web app has an Artifacts section: one place where every artefact this agent produces (canvas,
blog, and future reports, repos, …) is linked for quick access. The list lives in
`DATA_DIR/artifacts.json` — add an artefact by **editing that file**, never code and never a
redeploy. The server reads it at each request, so no restart is needed.

The file holds one object with an `artifacts` array. Each entry:

| field | required | allowed values |
|---|---|---|
| `id` | yes | unique non-empty string; a duplicate `id` keeps only the first |
| `title` | yes | non-empty string, shown as the row title |
| `kind` | no | `canvas \| blog \| report \| repo \| other` — unknown values count as `other` |
| `url` | yes for plain entries | absolute `http://` or `https://` URL; with `auth` (see below) the entry needs no real URL: `canvas-token` takes a same-origin `/canvas/…` site path, and `blog-url` needs none at all — the address is resolved from the environment at request time |
| `description` | yes | any string, shown as the row's sub-text |
| `auth` | no | `"canvas-token"` or `"blog-url"` — the only accepted values; see below |
| `added` | no | ISO date string, e.g. `"2026-10-23"` |

```json
{ "artifacts": [
  { "id": "october-report", "title": "October report", "kind": "report",
    "url": "https://example.com/october", "description": "Monthly summary.",
    "added": "2026-10-23" }
] }
```

- `kind` is `canvas | blog | report | repo | other`; anything else counts as `other`.
- `auth: "canvas-token"` marks a link behind the canvas access token, and is accepted **only** on the
  genuine canvas: `kind` must be `canvas` and `url` must be a same-origin `/canvas/…` site path — a
  single leading slash, no backslash, no scheme or authority (so `//…`, `http(s)://…`,
  `/\…` and `javascript:` are refused), no query or fragment (the `?k=` token is appended by the
  server), and no dot segments even percent-encoded, so `/canvas/../`, `/canvas/%2e%2e/` and
  anything escaping the `/canvas/` prefix are refused. A refused entry is counted in `skipped` (the
  panel shows the count) with a reason — no token is ever attached to it. The server composes the
  final URL from the environment at request time and re-validates the composed path immediately
  before it is returned, so the token is never stored in the file, never logged, never served to
  anyone unauthenticated, and can never ride an off-origin path or host of any kind.
- `auth: "blog-url"` marks the blog's public address as coming **from the environment**: the server
  reads `BLOG_PUBLIC_URL` at request time (the same way `CANVAS_ACCESS_TOKEN` is read for the
  canvas), so the data file carries no address at all. An entry with this marker needs no `url`
  field; the address itself belongs in the environment (or in the real addresses below), never in
  `artifacts.json`.
- The resolved blog address is re-validated before anything is served: it must be an absolute
  `http://` or `https://` URL (`javascript:`, `data:`, `file:`, protocol-relative `//…`, relative
  paths and empty values are refused and counted). When `BLOG_PUBLIC_URL` is unset or invalid, the
  blog row is rendered as **unavailable** (`available: false`, `url: null` and a reason) — never a
  placeholder address and never a dead link.
- Entries without an `auth` marker must be absolute `http://` or `https://` URLs. Anything else
  (`javascript:`, `data:`, protocol-relative, relative paths, malformed) is skipped and counted,
  not rendered. Missing `id`/`title`/`url` or a non-string `description` skips the entry (except
  that a `blog-url` marked entry needs no `url`), and a duplicate `id` keeps only the first — a
  malformed entry never breaks the whole panel.
- When the file is missing, unreadable or misshapen, the canvas and the blog are shown from
  built-in defaults — no addresses are built in. The canvas resolves from `CANVAS_ACCESS_TOKEN`
  and the blog from `BLOG_PUBLIC_URL`, each at request time and each **unavailable with a reason**
  when nothing is configured. The real addresses (the token, the blog URL, and every future
  artefact's URL) belong in the environment and in `DATA_DIR/artifacts.json`. Nothing in the agent
  writes this file; the agent (or you) owns it.

In the web app the section is the **Artifacts** page in the top bar (also in the ⌘K palette, at
`#artifacts`). It fetches
`GET /api/artifacts` once when opened — the list is never public and never baked into the build —
renders one row per artefact (title, kind, description, a link that opens in a new tab, and the
plain URL as copyable text), shows a `Link unavailable` note for entries whose configured address is
missing or invalid (e.g. the canvas token or the blog URL is not set), and a plain error line with a Retry if the fetch fails; zero entries is a
"No artefacts yet." empty state. The panel only turns site-relative or `http(s)://` URLs into
links, so anything escaped past the server still cannot become a `javascript:` anchor.

Run `npm run test:artifacts` for the loader's validation checks (including the token-gated entry
refusals), `npm run test:artifacts-endpoint` for the
`GET /api/artifacts` proof (live server: 401/200, add/remove without restart, defaults, hostile URLs, hostile
token-gated entries with the exact token string absent from every response, the positive control, the end-to-end
`?k=` handshake, secret scan, token-unset),
`npm run test:artifacts-workflow-proof` for the documented add/remove workflow end to end (write the README example
into a throwaway `DATA_DIR`, see it served, delete the file, see the defaults — following only the documented steps),
and `node scripts/artifacts-web.ts render | error-state | nav-label | no-fixture-urls` for the section's own
proofs (fixture rows / empty state / unavailable note rendered headlessly without a browser, the failure path,
the nav label in the built assets, and no fixture URL baked into the built assets).

The section is served by **`GET /api/artifacts`** (passkey session only — the canvas link carries canvas access, so
there is no anonymous version; it sits behind the same `{ "error": "unauthorized" }` gate as every other `/api` route).
It returns `{ source, skipped, entries }`, where `entries` carry `id`, `title`, `kind`, `description`, an `available`
flag and the resolved `url` (`null` when unavailable or refused). `skipped` counts the entries the loader refused
plus any marked entry the endpoint refuses at link-resolution time. Marked entries are resolved here, at request
time: `canvas-token` entries get `CANVAS_ACCESS_TOKEN` spliced into the `?k=` link the owner follows (which the
canvas swaps for a cookie) — only when the entry is genuinely the canvas and its path re-validates as a same-origin
`/canvas/` path at the last moment (see the entry rules above, and `composeTokenLink` in `src/artifacts.ts`); if the
token is unset, the canvas entry comes back with `available: false`, `url: null` and an `unavailable` reason instead
of a link that cannot work. `blog-url` entries get their address from `BLOG_PUBLIC_URL` (re-validated, unavailable
with a reason when it is unset or invalid).

## Run locally

```bash
cp .env.example .env   # fill in OPENROUTER_API_KEY and AUTH_TOKEN at least
npm install && npm --prefix web install
npm run build:web
npm run smoke          # skills + restart checks; with a key, the model writes and uses its own skill
npm run dev            # http://localhost:3000
```

## Deploy to Railway

1. Push this repo to GitHub, then in Railway choose **New Project → Deploy from GitHub repo** (or, for an existing
   service, Settings → Source → Connect Repo, branch `master`). The service builds from the `Dockerfile`, and every
   push or merged PR on `master` redeploys it, so no `railway up` is needed.
2. **Add a Volume** to the service mounted at **`/data`**. This is required: it holds the SQLite DB, skills, memory
   and workspace.
3. Set the variables from `.env.example` (`OPENROUTER_API_KEY`, `AUTH_TOKEN`, `TELEGRAM_BOT_TOKEN`, `TZ`).
4. Message your bot. It replies with your Telegram id. Set `TELEGRAM_OWNER_ID` to it and redeploy.
5. Optional: **Settings → Networking → Generate Domain** for the web chat.

Keep **1 replica**: pi-durable allows one process per storage. `railway.json` pins this and sets the healthcheck.

## Telegram commands

`/status` · `/stop` (abort current work) · `/reset` (fresh context; memory and skills kept) · `/reflect` (run the outer
loop now)

## HTTP API (passkey session cookie)

`POST /api/agui` (AG-UI SSE) · `GET /api/messages` · `POST /api/stop` · `POST /api/chat {message}` · `GET /api/status` · `GET /api/artifacts` · `GET /api/transcript?limit=60` · `POST /api/reflect` · `GET /health`

## Security model

- **One owner.** Only `TELEGRAM_OWNER_ID` is answered on Telegram, and the web app and API need your passkey. There is
  no multi-user mode.
- **Spend is capped** by `MAX_SPEND_USD` (total) and `ATTEMPT_BUDGET_USD` (per coding attempt); each attempt gets its own
  capped OpenRouter key (with the default `CODER_PROVIDER=openrouter`).
- **Model-written code is confined** (details below): no access to API keys, passkeys or the database.
- **Coding runs elsewhere.** OpenCode runs in a separate Railway project in containers that live for minutes; they hold
  no long-lived secrets.
- **You keep a veto.** Merges wait `MERGE_VETO_MINUTES`, and changes to the guardrail files (`PROTECTED_PATHS` in
  `src/orchestra.ts`) are never merged by the agent itself.
- **Not covered:** what the agent does with tools you give it, the providers you route models through, and the security
  of your Railway, GitHub and Telegram accounts. Rotate keys if you suspect any of them leaked.

Report security issues privately to the repository owner (GitHub's "Report a vulnerability"), not in a public issue.

## Notes

- **Model-driven code can't reach the agent's secrets** (`src/confine.ts`). The GitHub App key, passkeys, the
  database and the API keys in the server's environment stay with the server (root):
  - **`bash`** runs as uid 1000 with a scrubbed environment (no API keys; `/proc/1/environ` is root-only).
  - **The file tools** only reach `/data/workspace` and the temp dir, checked after resolving symlinks.
  - **Skills** run in a child process as uid 1000, with an empty environment and Node's permission model: they can
    read the app and the skills, and nothing else; they can't write files or start processes. The process (~90 MB)
    stops after 2 idle minutes and restarts on the next call.
  - **`/data`** is locked down at boot: secrets and the database are root-only.
  - **Foremen**, which read untrusted diffs, only get their goal's tools; reviewers only `submit_review`.
- To switch models, change `AGENT_MODEL` / `REFLECT_MODEL` (any OpenRouter id) and redeploy. They are re-applied on boot.
- pi-durable is pre-1.0 and its API changes between releases, so versions are pinned exactly in `package.json`.

### Worker lifecycle and conversation threads

The web chat (Board → **General thread**) has two durable threads: **You & agent** for owner messages and **Jobs** for scheduled work and results. Existing scheduled turns are projected into Jobs without rewriting historical transcripts. Each thread has its own running state, stop action and session-scoped draft. The composer grows with what you type and offers message starters (plan a task, investigate, set a reminder). The chat sizes itself by its container, so it fits the Board's drawer at any window width: your messages are bubbles, replies are plain text, and the tool work behind a reply folds into one "Worked · N steps" chip. Thread identifiers accepted by the API are restricted to `owner` and `jobs`.

Recurring jobs can opt into **Only run when project state changes** on the Jobs page (or `runOnChange` in `schedule_job`). This compares goal/task/review state before invoking a model, and counts skipped checks. Leave it off for reminders, external-site monitoring and jobs whose trigger is time. Reflection also skips unchanged activity.

Cleanup runs independently every 10 seconds, evidence delivery every 5 seconds, and dispatch every 30 seconds. Reflection cannot hold the dispatch tick open. Executions retain monotonically increasing identities even when paused or unable to reach the model; those executions do not consume the implementation retry allowance. Workers awaiting successful container deletion still occupy the parallel limit. Container deletion and model-key revocation are tracked separately and retried. Three infrastructure failures on a task escalate it; provider/launch cooldowns survive coordinator restarts.

Evidence uploads are flushed to a private `/data/evidence` artifact before acknowledgement, with a checksum and durable attempt reference. The worker can exit immediately; the host retries GitHub delivery with backoff and does not rerun coding. The merge gate still requires independent review and verification of the pushed head. Cancelled goals do not push pending artifacts. Unreferenced admission artifacts older than a day are swept. The volume remains essential: these acknowledgements are durable on the attached volume, not a replicated backup.

Runner timeouts share one end-to-end deadline. Coding reserves up to five minutes (one quarter on short attempts) for verification and packaging; verifier subprocesses reserve the last 30 seconds for evidence. Process groups are killed on timeout. Diagnostic tails and incremental OpenCode parsing bound log memory. Git bundles exclude history already present at the cloned commit; the host fetches that prerequisite only from the configured GitHub repository before verifying the bundle. Legacy full-history bundles remain supported. Verification/proofs that change HEAD or tracked files invalidate the evidence. After coding starts, all repository Git operations run as the unprivileged coder user because local Git configuration can execute programs. Bundle reads refuse symlinks and require a regular file owned by that user.

Dependency and verification-result reuse remain deferred until phase measurements identify worthwhile candidates. Cross-task writable dependency caches or results keyed only by a command would weaken isolation or exact-commit verification; this change keeps fresh workers and full verification.

Validation: `npm run test:architecture`, `npm run typecheck`, `npm run smoke`, `npm run build:web`, the runner closed-pipe regressions, and the isolated Linux fixture in `runner/test/lifecycle-linux.mjs`.

Memory: the agent runs with a 768 MB heap ceiling (`--max-old-space-size=768`). **Insights → Overview → Memory** shows the container's total as Railway bills it (this process, its children and file cache) and the peak since boot.

## License

[MIT](LICENSE)
