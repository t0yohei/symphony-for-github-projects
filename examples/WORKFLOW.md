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
  timeout_ms: 120000
  after_create: |
    git clone git@github.com:your-org/your-repo.git .
    npm install
  before_run: |
    git fetch origin
    git checkout main
    git pull origin main

agent:
  command: codex app-server
  max_turns: 20
  timeouts:
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

Follow the repository's coding standards. Write tests for new functionality.
Create a pull request when the implementation is complete.
