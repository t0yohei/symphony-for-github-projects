import test from "node:test";
import assert from "node:assert/strict";

import { ConfigResolutionError, WorkflowConfigResolver } from "./resolver.js";

test("applies defaults", () => {
  const resolver = new WorkflowConfigResolver({
    tracker: { owner: "kouka", repo: "repo", projectNumber: 13 },
    agent: { command: "codex" },
  });

  const config = resolver.resolve();

  assert.equal(config.pollIntervalMs, 30_000);
  assert.equal(config.maxConcurrency, 1);
  assert.equal(config.workspaceRoot, ".symphony/workspaces");
  assert.equal(config.agent.timeoutMs, 900_000);
  assert.deepEqual(config.agent.args, []);
});

test("resolves env references", () => {
  const resolver = new WorkflowConfigResolver(
    {
      pollIntervalMs: "$POLL_INTERVAL",
      maxConcurrency: "$MAX_CONCURRENCY",
      workspaceRoot: "$WORKSPACE_ROOT",
      tracker: {
        owner: "$GH_OWNER",
        repo: "$GH_REPO",
        projectNumber: "$PROJECT_NUMBER",
      },
      agent: {
        command: "$AGENT_COMMAND",
        args: ["run", "--model", "sonnet"],
        timeoutMs: "$TIMEOUT_MS",
      },
    },
    {
      POLL_INTERVAL: "45000",
      MAX_CONCURRENCY: "2",
      WORKSPACE_ROOT: "/tmp/w",
      GH_OWNER: "kouka-t0yohei",
      GH_REPO: "symphony-github-projects",
      PROJECT_NUMBER: "7",
      AGENT_COMMAND: "codex",
      TIMEOUT_MS: "120000",
    },
  );

  const config = resolver.resolve();

  assert.equal(config.pollIntervalMs, 45_000);
  assert.equal(config.maxConcurrency, 2);
  assert.equal(config.workspaceRoot, "/tmp/w");
  assert.equal(config.tracker.owner, "kouka-t0yohei");
  assert.equal(config.tracker.projectNumber, 7);
  assert.equal(config.agent.command, "codex");
  assert.equal(config.agent.timeoutMs, 120_000);
});

test("throws actionable errors for invalid config", () => {
  const resolver = new WorkflowConfigResolver({
    pollIntervalMs: 100,
    tracker: { owner: "kouka", repo: "repo", projectNumber: 13 },
    agent: { command: "codex" },
  });

  assert.throws(() => resolver.getPollingIntervalMs(), (error: unknown) => {
    assert.ok(error instanceof ConfigResolutionError);
    assert.equal(error.message, "pollIntervalMs: must be >= 1000");
    return true;
  });
});

test("throws when env var is missing", () => {
  const resolver = new WorkflowConfigResolver(
    {
      tracker: { owner: "$GH_OWNER", repo: "repo", projectNumber: 13 },
      agent: { command: "codex" },
    },
    {},
  );

  assert.throws(() => resolver.resolve(), (error: unknown) => {
    assert.ok(error instanceof ConfigResolutionError);
    assert.equal(error.message, "tracker.owner: env var GH_OWNER is not set");
    return true;
  });
});
