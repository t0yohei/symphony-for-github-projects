# symphony-github-projects

TypeScript scaffold for a Symphony-compatible orchestrator targeting GitHub Projects.

## Quickstart

```bash
npm install
cp .env.example .env
npm run lint
npm run test
npm run build
```

## Commands

```bash
npm run lint
npm run format
npm run format:check
npm run typecheck
npm run test
npm run build
```

## CI

GitHub Actions runs on PRs and `main` pushes with:

- `npm ci`
- `npm run lint`
- `npm run test`
- `npm run build`

Workflow file: `.github/workflows/ci.yml`

## Environment

Copy `.env.example` to `.env` and fill required values.

Key variables:

- `GITHUB_TOKEN`
- `GITHUB_PROJECT_OWNER`
- `GITHUB_PROJECT_NUMBER`
- `WORKFLOW_PATH`
- `LOG_LEVEL`

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
