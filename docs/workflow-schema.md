# WORKFLOW.md schema (GitHub Projects)

このドキュメントは `WORKFLOW.md` の front matter 契約を定義する。

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
  baseDir: /tmp/symphony-github-projects/workspaces   # required

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

`tokenEnv` に設定された環境変数は、実行環境で必ず解決できる必要がある。

## Validation expectations (explicit + testable)

`validateWorkflowContract` は以下のエラーコードを返す:

- `tracker.kind.required`
- `tracker.kind.unsupported`
- `tracker.github.owner.required`
- `tracker.github.projectNumber.invalid`
- `tracker.auth.tokenEnv.required`
- `polling.intervalMs.invalid`
- `workspace.baseDir.required`
- `agent.command.required`

バリデーションは失敗を集約し、最初の1件で止めずに全エラーを返す。
