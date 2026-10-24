# Working in this repository

Read by coding agents (OpenCode, Claude Code via CLAUDE.md, and others) before they change anything here.

## Keep README.md current

`README.md` is the main description of how this system works. **Any change to behaviour, configuration, environment
variables, gate checks or workflows updates `README.md` in the same change**, so the README always describes how the
system works today. That includes:

- a new, renamed or removed environment variable, or a changed default;
- a new or changed merge-gate check, workflow stage, or runner/orchestrator behaviour;
- new tools, routes or commands an owner would use.

The orchestrator enforces this: the reviewer treats a behaviour or config change without a matching README change as a
**major** finding, and a diff that changes how environment variables are read without touching `README.md` gets that
finding automatically (test and benchmark files under `scripts/`, `bench/`, `runner/test/` and `*.test.*` are ignored).

## Checks

- `npm run typecheck` (server and web)
- `npm run smoke` (the project's main test; part of the verify command)
- Focused suites: see the `test:*` scripts in `package.json`.
