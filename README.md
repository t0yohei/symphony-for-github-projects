# symphony-github-projects

TypeScript scaffold for a Symphony-compatible orchestrator targeting GitHub Projects.

## Setup

```bash
npm install
```

## Commands

```bash
npm run build
npm run typecheck
npm test
```

## WORKFLOW.md schema (Issue #2)

- Schema document: `docs/workflow-schema.md`
- Example file: `examples/WORKFLOW.md`
- Validation entrypoint: `validateWorkflowContract` in `src/workflow/contract.ts`

## Current modules

- `src/workflow/contract.ts` - WORKFLOW.md contract + validation + loader placeholder
- `src/model/work-item.ts` - normalized work-item model
- `src/tracker/adapter.ts` - GitHub Projects tracker adapter interface + placeholder
- `src/orchestrator/runtime.ts` - poll/tick runtime skeleton with bounded concurrency stub
- `src/config/runtime-config.ts` - canonical runtime config type
- `src/config/resolver.ts` - typed config getters + defaults/env resolution/validation
- `src/logging/logger.ts` - structured JSON logger baseline
- `src/bootstrap.ts` - initialization helper that wires loader/tracker/logger into runtime startup
- `src/workspace/manager.ts` - deterministic workspace lifecycle manager with hooks and terminal-state cleanup guardrails

## Runtime behavior (current)

- `PollingRuntime` keeps authoritative in-memory state for `claimed`, `running`, `retryAttempts`, and aggregate metrics.
- Each tick reconciles state against current eligible items and drops stale claims/running entries.
- Dispatch is bounded by `maxConcurrency` and prevents duplicate dispatch of already claimed/running items.

## Restart safety (no DB mode)

- Runtime state is process-local and is reset on process restart.
- After restart, the next tick reconstructs behavior from tracker eligibility and re-dispatches as needed.
- This is acceptable for MVP/no-DB mode, but durable checkpoints will be required for stronger exactly-once guarantees.

## Workspace manager behavior

- Workspace directories are deterministic per item id via key sanitization (`item id -> safe slug`).
- `ensureWorkspace` reuses the same directory across runs.
- Lifecycle hooks are optional (`before_run`, `after_success`, `after_failure`) and run as non-shell commands with timeout guardrails.
- Terminal-state cleanup is opt-in (`cleanup.enabled`) and guarded by allowed terminal states.
- Cleanup always verifies the target path is inside the configured workspace root before deleting.

## Notes

- Work-item normalization rules: `docs/work-item-model.md`

This repo follows the direction in Symphony SPEC:
<https://github.com/openai/symphony/blob/main/SPEC.md>
