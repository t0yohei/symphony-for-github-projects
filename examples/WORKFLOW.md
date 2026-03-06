---
tracker:
  kind: github_projects
  github:
    owner: your-org
    type: org
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
  before_run: |
    git fetch origin
    git checkout main
    git pull origin main

agent:
  command: codex app-server
  maxTurns: 20
---

You are working on GitHub Project item {{ issue.identifier }}.

Title: {{ issue.title }}
Description: {{ issue.description }}

Follow the repository's coding standards. Write tests for new functionality.
Create a pull request when the implementation is complete.
