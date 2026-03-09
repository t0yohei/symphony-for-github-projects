# symphony-for-github-projects

- English README: `README.md`
- 日本語 README: [README-ja.md](./README-ja.md)

Symphony turns project work into isolated, autonomous implementation runs — allowing teams to
coordinate coding agents against GitHub Projects as a tracker. This project adapts the same
architecture for GitHub Projects.

## Why this exists

OpenAI's Symphony shows a clean orchestration pattern for agentic software delivery. This repo is an
experimental TypeScript/Node implementation of that pattern for GitHub Projects.

## Two ways to use this repository

### Option 1. Use the spec to build your own implementation

> Implement Symphony for GitHub Projects according to the following spec:
> https://github.com/t0yohei/symphony-for-github-projects/blob/main/SPEC.md

### Option 2. Use our experimental reference implementation

Check out this repository as an experimental reference implementation and start with:

```bash
git clone https://github.com/t0yohei/symphony-for-github-projects.git
cd symphony-for-github-projects
npm install
npm run build
npm start
```

You can also ask a coding agent to help with setup:

> Set up Symphony for GitHub Projects for my repository based on
> https://github.com/t0yohei/symphony-for-github-projects/blob/main/SPEC.md

You can use the included GitHub Actions workflow as a smoke-check baseline (`.github/workflows/ci.yml`).

## How It Works

```
GitHub Projects (issue tracker)
    ↓  polling (configurable interval)
Symphony Orchestrator
    ↓  per-issue workspace isolation
    ↓  launches coding agent (Codex app-server)
Coding Agent
    ↓  implements changes, creates PRs
GitHub Projects status updated
```

1. **Poll** — The orchestrator polls a GitHub Project board for items in active states (e.g. `Todo`, `In Progress`).
2. **Isolate** — Each work item gets a dedicated workspace directory, bootstrapped via configurable hooks.
3. **Dispatch** — A coding agent (Codex in app-server mode) is launched inside the workspace with a rendered prompt.
4. **Multi-turn** — The agent works through multiple turns (up to `max_turns`) until the task is complete.
5. **Reconcile** — On every tick the orchestrator checks tracker state; if an item moves to a terminal state, the agent is stopped and the workspace is cleaned up.

## Prerequisites

- **Node.js** ≥ 20
- **GitHub token** with access to the target repository and project board
- **Codex CLI** installed and available as `codex app-server` (or a custom command)
- A GitHub Project (classic or ProjectV2) with status columns

## Getting Started

### 1. Clone and install

```bash
git clone https://github.com/kouka-t0yohei/symphony-for-github-projects.git
cd symphony-for-github-projects
npm install
```

### 2. Set environment variables

Following this repo's [SPEC](./SPEC.md), configuration
values are resolved from runtime environment variables — not from `.env` files. Set them in your
shell before starting the service:

```bash
export GITHUB_TOKEN="ghp_xxxxxxxxxxxxxxxxxxxx"
```

The `WORKFLOW.md` front matter references these variables with `$VAR_NAME` syntax (e.g.
`tokenEnv: GITHUB_TOKEN`). The config resolver reads them from `process.env` at startup.

#### Recommended GitHub token permissions

If you use a fine-grained personal access token, scope it to the target repository (and the owning
user/org project, if applicable).

**Tracker-only mode** (read/update GitHub Projects state only):
- Projects: **Read and write**
- Metadata: **Read-only**
- Issues: **Read-only**

**Implementation mode** (same token also pushes code and opens PRs):
- Projects: **Read and write**
- Metadata: **Read-only**
- Issues: **Read and write**
- Contents: **Read and write**
- Pull requests: **Read and write**

If your workflow only reads issue metadata and never comments on issues, `Issues: Read-only` is
usually enough. If your hooks clone private repositories or your agent pushes branches / opens pull
requests, use the implementation-mode set above.

### 3. Create your WORKFLOW.md

Copy the example and customize it for your project:

```bash
cp examples/WORKFLOW.md ./WORKFLOW.md
```

By default, the repo ignores `WORKFLOW.md` in `.gitignore` so your local runtime configuration does
not get committed accidentally. If you do want to version-control your workflow file, remove the
`WORKFLOW.md` entry from `.gitignore` first.

A minimal `WORKFLOW.md`:

```yaml
---
tracker:
  kind: github_projects

runtime:
  poll_interval_ms: 30000
  max_concurrency: 2

workspace:
  root: ~/symphony-workspaces

hooks:
  after_create: |
    set -euo pipefail
    git clone git@github.com:your-org/your-repo.git .
    if [ -f yarn.lock ]; then
      yarn install --frozen-lockfile || yarn install
    elif [ -f pnpm-lock.yaml ]; then
      pnpm install --frozen-lockfile || pnpm install
    else
      npm install
    fi
  before_run: |
    set -euo pipefail
    test -d .git
    if ! git diff --quiet || ! git diff --cached --quiet || [ -n "$(git ls-files --others --exclude-standard)" ]; then
      git stash push -u -m "symphony-before-run-$(date +%s)" >/dev/null
    fi
    git fetch origin
    git checkout main
    git pull --ff-only origin main

agent:
  command: codex app-server
  max_turns: 20
  timeouts:
    hooks_timeout_ms: 120000

extensions:
  github_projects:
    owner: your-org
    project_number: 1
    token_env: GITHUB_TOKEN
---

You are working on GitHub Project item {{ issue.identifier }}.

Title: {{ issue.title }}
Description: {{ issue.description }}

Requirements:
- Prefer touching tracked source files only.
- If verification commands pick up generated output or cache directories, narrow checks to the relevant source files or directories and explain that choice.
- If a patch fails because file context drifted, reread the file and retry with a narrower patch.
- Before staging changes, inspect the actual changed file list (`git status --short` and/or `git diff --name-only`) and stage only files that currently exist.
- Do not guess file paths during `git add`; if a path is missing, re-check the worktree and use the exact existing paths.
- If a lockfile-aware install fails only because your intentional dependency edits require a lockfile update, explain that and fall back to the normal install flow instead of stopping immediately.
- For multi-surface features, it is acceptable to finish one coherent slice first (for example backend plus tests) instead of leaving a broad partial patch across backend and frontend.

Follow the repository's coding standards. Write tests for new functionality.
Create a pull request when the implementation is complete.
```

If SSH clone fails in a headless environment, switch the clone URL to HTTPS and inject a token with an environment variable. If your Codex environment cannot complete `git add` / `git commit` under the default sandbox, try `codex -s danger-full-access -a never app-server`.

The YAML front matter configures runtime behavior; the Markdown body is the prompt template
sent to the coding agent for each work item. Template variables use
[Liquid](https://liquidjs.com/) syntax.

### 4. Build and run

```bash
npm run build
npm start
# or
node dist/cli.js
```

### 5. Launch the local Web UI dashboard

This repo now includes a lightweight observability dashboard inspired by Symphony's Elixir dashboard.
It is served directly by the Node process and polls local runtime state every 5 seconds.

```bash
npm run dev:dashboard

# build + launch + open the dashboard in your default browser (macOS)
npm run dev:dashboard:open

# or run explicitly
npm run build
node dist/cli.js --workflow WORKFLOW.md --dashboard-port 4318
# optional: expose on a specific interface
node dist/cli.js --workflow WORKFLOW.md --dashboard-port 4318 --dashboard-host 0.0.0.0
```

Then open <http://127.0.0.1:4318>.

Current dashboard scope:
- summary metrics
- workflow metadata
- running session list
- retry queue
- latest rate-limit snapshot

`dev:dashboard:open` forwards `Ctrl+C` to the underlying CLI process and escalates shutdown in
stages (`SIGINT` → `SIGTERM` → `SIGKILL`) if the child refuses to exit, so the dashboard is much
less likely to leave the `node dist/cli.js` process behind.

## WORKFLOW.md Reference

The `WORKFLOW.md` file is the single source of truth for orchestrator behavior. It is designed
to be version-controlled alongside your code.

### Front Matter Keys

Core contract (canonical):

- `tracker.kind` — must be `github_projects`
- `runtime.poll_interval_ms` / `runtime.max_concurrency`
- `runtime.retry.{continuation_delay_ms,failure_base_delay_ms,failure_multiplier,failure_max_delay_ms}`
- `workspace.root`
- `agent.command`, `agent.args`, `agent.max_turns`
- `agent.timeouts.{turn_timeout_ms,read_timeout_ms,stall_timeout_ms,hooks_timeout_ms}`
- `hooks.{after_create,before_run,after_run,before_remove}`

Legacy note: older examples may show `hooks.timeout_ms`, but the supported location for hook timeout configuration is `agent.timeouts.hooks_timeout_ms`.

GitHub Projects extension namespace:

- `extensions.github_projects.owner`
- `extensions.github_projects.project_number`
- `extensions.github_projects.token_env`
- `extensions.github_projects.type`
- `extensions.github_projects.active_states` (optional, default: `todo`, `in_progress`, `blocked`)
- `extensions.github_projects.terminal_states` (optional, default: `done`)
- `extensions.github_projects.status_options.in_progress` (optional label text, default `In Progress`)
- `extensions.github_projects.status_options.done` (optional label text, default `Done`)
- `extensions.github_projects.mark_done_on_completion` (optional, default: `false`)

The orchestrator watches `WORKFLOW.md` for changes and re-applies configuration without restart.

## Repository Layout

```text
src/
├── agent/
│   └── codex-app-server.ts      # Codex app-server runtime worker
├── bootstrap.ts                 # Service bootstrapping and dependency wiring
├── cli.ts                       # CLI entrypoint
├── dashboard/
│   └── server.ts                # Local observability dashboard server
├── logging/
│   └── logger.ts                # Structured logger
├── orchestrator/
│   ├── reconciler.ts            # Runtime reconciliation helpers
│   └── runtime.ts               # Polling runtime + retry/state machine
├── tracker/
│   ├── github-projects-*.ts     # GitHub Projects read/write adapters
│   └── graphql-client.ts        # Minimal GraphQL client
├── workflow/
│   ├── contract.ts              # WORKFLOW.md contract + validation
│   ├── hot-reload.ts            # File watcher / hot reload support
│   └── loader.ts                # WORKFLOW.md parser (YAML front matter + prompt body)
└── workspace/
    └── manager.ts               # Per-item workspace lifecycle
```

## Notes

- This project is intentionally pragmatic and experimental.
- Prefer fine-grained PATs over broad classic tokens when possible.
- When using the dashboard, run the built JS from `dist/` after `npm run build` (or use the provided dashboard scripts).

## Comparison

| Aspect          | [openai/symphony](https://github.com/openai/symphony) | This project                     |
|----------------|--------------------------------------------------------|----------------------------------|
| Runtime        | Elixir / Phoenix                                       | TypeScript / Node                |
| Tracker        | Issue tracker abstractions                             | GitHub Projects                  |
| Dashboard      | Phoenix LiveView dashboard                             | Lightweight local Node dashboard |
| Worker         | Agent runtime abstraction                              | Codex app-server                 |
| Config         | Symphony workflow/spec                                 | `WORKFLOW.md` front matter       |
