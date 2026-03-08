# Symphony for GitHub Projects SPEC (Adapted)

This document is a practical, implementation-oriented adaptation of
[OpenAI Symphony SPEC](https://github.com/openai/symphony/blob/main/SPEC.md) for this
TypeScript repository.

The goal is to keep the same orchestration contract while replacing the upstream Linear
tracker with GitHub Projects (ProjectV2/classic) as the source of truth for work items.

---

## 0. Purpose

- Maintain deterministic, isolated work-item automation.
- Poll the configured tracker, schedule work on available runtime slots, and reconcile with tracker state.
- Apply hooks for workspace lifecycle and optionally send status updates back to the source system.
- Keep behavior predictable for CI and GitHub Actions smoke checks.

## 1. Core architecture

- **Tracker**: `github_projects`
- **Runtime**: single loop with bounded concurrency
- **Agent**: external coding agent process (default `codex app-server`)
- **Workspace**: one dedicated directory per item under `workspace.root`
- **Hooks**: `after_create`, `before_run`, `after_run`, `before_remove`
- **State contract**: item normalized into canonical fields for prompts and runtime reconciliation

## 2. Required configuration contract

Configuration is loaded from `WORKFLOW.md` front matter.

### Required top-level keys

- `tracker`
  - `kind: github_projects`
- `polling`
  - `intervalMs` (legacy alias accepted for compatibility) / `poll_interval_ms`
  - `maxConcurrency` (legacy alias accepted) / `runtime.max_concurrency`
- `workspace`
  - `baseDir` (legacy alias accepted) / `workspace.root`
- `agent`
  - `command` and optional `args`
- `extensions.github_projects`
  - `owner`
  - `projectNumber`
  - `tokenEnv`

### Compatibility aliases supported

This implementation accepts both canonical snake_case and legacy camelCase front-matter keys where documented:
- `polling.intervalMs` ↔ `poll_interval_ms`
- `polling.maxConcurrency` ↔ `runtime.max_concurrency`
- `workspace.baseDir` ↔ `workspace.root`
- `agent.maxTurns` ↔ `agent.max_turns`
- `agent.read_timeout_ms` / `agent.readTimeoutMs` etc.

Unknown keys are rejected by strict validation.

## 3. Work-item model

Canonical item fields made available to the prompt:

- `id`, `identifier`, `title`, `description`, `state`, `labels`
- `created_at`, `updated_at`
- `blocked_by` for dependency awareness

The implementation may provide adapters that normalize GitHub Project item fields into this model.

## 4. Runtime behavior (required)

1. **tick() loop**:
   - `reconcile` active runs with tracker state
   - `preflight` / `validation`
   - `fetch` active items
   - `sort` by priority/date/id semantics equivalent to the spec intent
   - `dispatch` up to remaining capacity
2. **Lifecycle control**:
   - claimed/running state tracking
   - retry queue with bounded exponential backoff
   - terminal state transitions cleanup
   - continuation/retry semantics via `attempt`
3. **Reconciliation**:
   - Active run states must refresh against tracker and stop/release/continue as required.

## 5. Workspace safety invariants

- Workspace root is resolved per configured path (`workspace.root` / `workspace.baseDir`).
- Path values are expanded for `~`, `$VAR`, and `${VAR}`.
- `created_issue_dir` paths must be subdirectories of root.
- Workspace identifier sanitization should avoid directory traversal and unsupported filename chars.
- Cleanup should be robust for terminal states.

## 6. Agent protocol expectations

Default launch command is `codex app-server` with equivalent args when configured.
Agent invocation should support
- turn timeouts
- read timeouts
- stall timeouts
- hard failure mapping for unsupported tool calls

Use this repository’s `src/agent/codex-app-server.ts` as the current concrete integration.

## 7. Observability

- Structured logs per tick and per item event.
- Minimal run metrics (attempt count, completion state, failures/retries).
- Snapshot/reload logs for workflow hot-reload.

## 8. Failure and retry policy

Retry delay values are derived from workflow config:
- `retry.continuationDelayMs`
- `retry.failureBaseDelayMs`
- `retry.failureMultiplier`
- `retry.failureMaxDelayMs`

Defaults should follow the intended spec behavior and be documented in `WORKFLOW.md` examples.

## 9. GitHub Actions profile (this repository)

For CI in this repository, use a minimal smoke profile:

```yaml
name: Symphony for GitHub Projects CI

on:
  pull_request:
  push:
    branches: [main]

jobs:
  quality:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 20
          cache: npm
      - run: npm ci
      - run: npm run lint
      - run: npm run test
      - run: npm run build
```

Run this service via containerized job only with secrets injected for `GITHUB_TOKEN`, and never
store secrets in workflow files or `WORKFLOW.md`.

## 10. Reference files

- `SPEC.md` in this repo (this document)
- `WORKFLOW.md` contract and examples
- `examples/WORKFLOW.md`
- `src/workflow/` and `src/orchestrator/` implementation for the adapted spec path

## 11. Notes for custom implementations

If you are implementing your own version (Option 1), keep this contract stable:
- same canonical item model,
- same polling/reconcile/dispatch ordering,
- equivalent workspace and retry semantics,
- and compatible configuration behavior.

That keeps migration and comparison between custom and reference implementations straightforward.