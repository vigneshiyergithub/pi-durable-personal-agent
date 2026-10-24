# Scheduling and plan cost controls

The Jobs panel shows state watches and unchanged checks skipped. Enable a watch only for work driven by this agent's project/goal/task state. Reminders, daily writing, external health checks and other clock-driven work must stay time-based. Deployment revision and review-budget changes also invalidate the watch fingerprint. A failed model submission clears its fingerprint so it can retry.

Daily CEO reports have one canonical schedule. At boot and after schedule mutations, legacy daily prompts containing `save_report` are reconciled; the latest custom schedule wins over the default seed. Its prompt and next-run time are preserved. Other candidates move to **Jobs → Archived schedules**, including their original prompt and time. **Restore separate schedule** explicitly opts the restored job out of deduplication and moves an overdue run to its next interval. Cancelling the seeded report never recreates it on restart.

New schedules can specify `purpose: "daily-report"` to replace the canonical report, or `purpose: "general"` to keep an intentionally separate report. Weekly reports and daily blog jobs are not implicitly report schedules.

New plans and appended tasks support:

- `key`: a unique local task reference.
- `dependsOn`: earlier task keys or existing task IDs. A prerequisite must be accepted before its dependent worker launches.
- `estimatedDiffChars`: estimated contribution to the whole-goal diff, including tests and documentation; use zero for a read-only survey.

Preflight rejects duplicate unfinished titles, empty task descriptions/criteria, invalid or missing dependencies, and declared scope above the review budget. Missing estimates and vague criteria are warnings. The Goals panel shows the result. Failed proposals stay in planning without an approval code; the foreman receives the errors and can revise them. Invalid appended tasks are rejected atomically. Admission rechecks the plan inside the durable worker claim before creating credentials or containers.

Legacy in-flight plans retain their launch behavior until a new plan or task addition establishes the preflight contract. Estimates do not replace the exact-head review, verification or merge gates, and cannot guarantee actual diff size. Semantic overlap between differently worded tasks still requires foreman review.

The initial archive release briefly removed the default without persisting its archive entry. The follow-up repairs that specific empty-archive state once using the bundled default template. Its original next-run timestamp cannot be recovered; the archive labels it as a template whose restoration schedules a new daily run. Custom report instructions and timing are preserved.
