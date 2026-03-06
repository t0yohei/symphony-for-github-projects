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
- `src/bootstrap.ts` - initialization helper that wires loader/tracker/logger and constructs the runtime

## Notes

This repo follows the direction in Symphony SPEC:
<https://github.com/openai/symphony/blob/main/SPEC.md>
