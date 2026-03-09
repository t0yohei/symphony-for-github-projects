---
tracker:
  kind: github_projects

# Core Symphony contract (canonical)
runtime:
  poll_interval_ms: 30000
  max_concurrency: 2

workspace:
  root: ~/symphony-workspaces

hooks:
  after_create: |
    set -euo pipefail
    # Prefer HTTPS + token in headless environments if SSH keys are not available.
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
  # If workspace-write is too restrictive for git add/commit in your environment,
  # try: codex -s danger-full-access -a never app-server
  command: codex app-server
  max_turns: 20
  timeouts:
    hooks_timeout_ms: 120000
    turn_timeout_ms: 300000
    read_timeout_ms: 15000
    stall_timeout_ms: 120000

# Tracker-specific extension namespace
extensions:
  github_projects:
    owner: your-org
    type: org
    project_number: 1
    token_env: GITHUB_TOKEN
    # Optional completion behavior
    # - Mark item as Done automatically when worker exits completed
    # - Keep these in sync with your board field labels
    mark_done_on_completion: true
    status_options:
      in_progress: In Progress
      done: Done
    active_states:
      - todo
      - in_progress
      - blocked
    terminal_states:
      - done
---

You are working on GitHub Project item {{ issue.identifier }}.

Title: {{ issue.title }}
Description: {{ issue.description }}

Requirements:
- Prefer touching tracked source files only.
- If verification commands pick up generated output or cache directories, narrow checks to the relevant source files or directories and explain that choice.
- If a patch fails because file context drifted, reread the file and retry with a narrower patch.

Follow the repository's coding standards. Write tests for new functionality.
Create a pull request when the implementation is complete.
