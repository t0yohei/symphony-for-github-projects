---
tracker:
  kind: github_projects
  github:
    owner: kouka-t0yohei
    type: org
    projectNumber: 13
    tokenEnv: GITHUB_TOKEN

polling:
  intervalMs: 300000
  maxConcurrency: 1

workspace:
  baseDir: /tmp/symphony-github-projects/workspaces

agent:
  command: codex
  args: ["--json"]

hooks:
  onStart: "echo orchestration started"
  onSuccess: "echo orchestration succeeded"
  onFailure: "echo orchestration failed"
---

# Symphony GitHub Projects Workflow

This file is consumed by the workflow loader (Issue #3).
