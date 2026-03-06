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

## Current modules (skeleton)

- `src/workflow/contract.ts` - WORKFLOW.md contract interface + loader placeholder
- `src/model/work-item.ts` - normalized work-item model
- `src/tracker/adapter.ts` - GitHub Projects tracker adapter interface + placeholder
- `src/orchestrator/runtime.ts` - poll/tick runtime skeleton with bounded concurrency stub
- `src/logging/logger.ts` - structured JSON logger baseline
- `src/bootstrap.ts` - loader/tracker/logger を束ねて runtime を生成する初期化ヘルパー

## Notes

This repo follows the direction in Symphony SPEC:
<https://github.com/openai/symphony/blob/main/SPEC.md>
