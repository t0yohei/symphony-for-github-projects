# Symphony for GitHub Projects

A TypeScript implementation of [Symphony](https://github.com/openai/symphony) targeting
**GitHub Projects** as the issue tracker, based on the
[Symphony SPEC](https://github.com/openai/symphony/blob/main/SPEC.md).

Symphony turns project work into isolated, autonomous implementation runs — allowing teams to
manage work instead of supervising coding agents. The upstream reference implementation uses Linear
as its tracker; this project adapts the same architecture for GitHub Projects.

> **Status:** Engineering preview. Suitable for evaluation in trusted environments.

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
git clone https://github.com/kouka-t0yohei/symphony-github-projects.git
cd symphony-github-projects
npm install
```

### 2. Set environment variables

Following the [Symphony SPEC](https://github.com/openai/symphony/blob/main/SPEC.md), configuration
values are resolved from runtime environment variables — not from `.env` files. Set them in your
shell before starting the service:

```bash
export GITHUB_TOKEN="ghp_xxxxxxxxxxxxxxxxxxxx"
```

The `WORKFLOW.md` front matter references these variables with `$VAR_NAME` syntax (e.g.
`tokenEnv: GITHUB_TOKEN`). The config resolver reads them from `process.env` at startup.

### 3. Create your WORKFLOW.md

Copy the example and customize it for your project:

```bash
cp examples/WORKFLOW.md ./WORKFLOW.md
```

A minimal `WORKFLOW.md`:

```yaml
---
tracker:
  kind: github_projects
  github:
    owner: your-org
    projectNumber: 1
    tokenEnv: GITHUB_TOKEN

polling:
  intervalMs: 30000
  maxConcurrency: 2

workspace:
  baseDir: ~/symphony-workspaces

hooks:
  after_create: |
    git clone git@github.com:your-org/your-repo.git .
    npm install

agent:
  command: codex app-server
  maxTurns: 20
---

You are working on GitHub Project item {{ issue.identifier }}.

Title: {{ issue.title }}
Description: {{ issue.description }}

Follow the repository's coding standards. Write tests for new functionality.
Create a pull request when the implementation is complete.
```

The YAML front matter configures runtime behavior; the Markdown body is the prompt template
sent to the coding agent for each work item. Template variables use
[Liquid](https://liquidjs.com/) syntax.

### 4. Build and run

```bash
npm run build
node dist/index.js
```

## WORKFLOW.md Reference

The `WORKFLOW.md` file is the single source of truth for orchestrator behavior. It is designed
to be version-controlled alongside your code.

### Front Matter Keys

| Key                      | Type     | Default                    | Description                                       |
| ------------------------ | -------- | -------------------------- | ------------------------------------------------- |
| `tracker.kind`           | string   | —                          | Must be `github_projects`                         |
| `tracker.github.owner`   | string   | —                          | GitHub user or org                                |
| `tracker.github.projectNumber` | integer | —                     | Project board number                              |
| `tracker.github.tokenEnv`| string  | `GITHUB_TOKEN`             | Environment variable holding the auth token       |
| `tracker.github.type`    | string   | `org`                      | `org` or `user`                                   |
| `polling.intervalMs`     | integer  | `30000`                    | Polling interval in milliseconds (≥ 1000)         |
| `polling.maxConcurrency` | integer  | `1`                        | Max concurrent agent sessions                     |
| `workspace.baseDir`      | string   | —                          | Root directory for per-item workspaces            |
| `agent.command`          | string   | —                          | Command to launch the coding agent                |
| `agent.args`             | string[] | `[]`                       | Additional arguments                              |
| `agent.maxTurns`         | integer  | `20`                       | Max back-to-back turns per agent session          |
| `agent.timeoutMs`        | integer  | `900000`                   | Per-turn timeout                                  |
| `hooks.after_create`     | string   | —                          | Shell script run after workspace creation         |
| `hooks.before_run`       | string   | —                          | Shell script run before each agent attempt        |
| `hooks.after_run`        | string   | —                          | Shell script run after each agent attempt         |
| `hooks.before_remove`    | string   | —                          | Shell script run before workspace deletion        |

### Prompt Template

The Markdown body supports [Liquid](https://liquidjs.com/) template variables:

- `{{ issue.identifier }}` — Work item identifier
- `{{ issue.title }}` — Title
- `{{ issue.description }}` — Description/body
- `{{ issue.state }}` — Current state
- `{{ issue.labels }}` — Labels array
- `{{ attempt }}` — `null` on first run, integer on retries

Unknown variables and filters raise errors (strict mode).

### Hot Reload

The orchestrator watches `WORKFLOW.md` for changes and re-applies configuration without restart.
Invalid changes keep the last known good config and log an error.

## Architecture

```
src/
├── agent/
│   └── codex-app-server.ts    # Codex app-server subprocess integration
├── bootstrap.ts               # Wires loader → tracker → logger → runtime
├── config/
│   ├── resolver.ts            # Typed config getters with defaults + env resolution
│   └── runtime-config.ts      # Canonical runtime config types
├── logging/
│   └── logger.ts              # Structured JSON logger
├── model/
│   └── work-item.ts           # Normalized work-item model
├── orchestrator/
│   ├── reconciler.ts          # Tracker state sync + stall detection
│   └── runtime.ts             # Poll/tick loop with bounded concurrency
├── prompt/
│   └── template.ts            # Liquid prompt renderer
├── tracker/
│   ├── adapter.ts             # Tracker adapter interface
│   ├── github-projects-writer.ts  # GitHub Projects write path (status updates)
│   └── graphql-client.ts      # GitHub GraphQL client
├── workflow/
│   ├── contract.ts            # WORKFLOW.md contract + validation
│   ├── hot-reload.ts          # File watcher + dynamic config reload
│   └── loader.ts              # WORKFLOW.md parser (YAML front matter + prompt body)
└── workspace/
    └── hooks.ts               # Workspace lifecycle hooks (after_create, before_run, etc.)
```

## Development

```bash
npm run lint          # ESLint
npm run format        # Prettier (write)
npm run format:check  # Prettier (check only)
npm run typecheck     # TypeScript type check
npm run build         # Compile to dist/
npm run test          # Build + run tests
```

### CI

GitHub Actions runs on PRs and `main` pushes:

- `npm ci` → `npm run lint` → `npm run test` → `npm run build`

Workflow file: `.github/workflows/ci.yml`

## Differences from Upstream Symphony

| Aspect          | [openai/symphony](https://github.com/openai/symphony) | This project                     |
| --------------- | ------------------------------------------------------ | -------------------------------- |
| Tracker         | Linear                                                 | GitHub Projects (ProjectV2 API)  |
| Language        | Elixir/OTP (reference)                                 | TypeScript / Node.js             |
| State tracking  | Linear issue states                                    | GitHub Project board columns     |
| SPEC compliance | Reference implementation                               | Follows SPEC direction           |

## License

[Apache License 2.0](LICENSE)
