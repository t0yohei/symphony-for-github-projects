# WORKFLOW.md schema (GitHub Projects)

This document defines the `WORKFLOW.md` front matter contract.

## Top-level keys

- `tracker`
- `polling`
- `workspace`
- `agent`
- `hooks` (optional)

## Schema

```yaml
---
tracker:
  kind: github_projects
  github:
    owner: kouka-t0yohei          # required
    type: org                     # optional: org | user (default: org)
    projectNumber: 13             # required, positive integer
    tokenEnv: GITHUB_TOKEN        # required (or tracker.auth.tokenEnv)
  auth:
    tokenEnv: GITHUB_TOKEN        # optional alias of tracker.github.tokenEnv

polling:
  intervalMs: 300000              # required, >= 1000 (default recommendation: 300000)
  maxConcurrency: 2               # optional, >= 1 (default: 1)

workspace:
  baseDir: /tmp/symphony-for-github-projects/workspaces   # required

agent:
  command: codex                  # required
  args: ["--json"]               # optional

hooks:
  onStart: "echo start"          # optional
  onSuccess: "echo success"      # optional
  onFailure: "echo failure"      # optional
---
```

## Required auth/env variables

- `GITHUB_TOKEN` (or any variable name set in `tokenEnv`)

The environment variable configured in `tokenEnv` must always be resolvable in the runtime environment.

## Validation expectations (explicit + testable)

`validateWorkflowContract` returns the following error codes:

- `tracker.kind.required`
- `tracker.kind.unsupported`
- `tracker.github.owner.required`
- `tracker.github.projectNumber.invalid`
- `tracker.auth.tokenEnv.required`
- `polling.intervalMs.invalid`
- `workspace.baseDir.required`
- `agent.command.required`

Validation aggregates failures and returns all errors instead of stopping at the first one.
