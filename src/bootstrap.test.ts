import test from "node:test";
import assert from "node:assert/strict";

import { bootstrapFromWorkflow } from "./bootstrap.js";
import type { Logger } from "./logging/logger.js";
import type { WorkflowContract, WorkflowLoader } from "./workflow/contract.js";

class StubWorkflowLoader implements WorkflowLoader {
  async load(_path: string): Promise<WorkflowContract> {
    return {
      tracker: {
        kind: 'github_projects',
        github: {
          owner: 'kouka-t0yohei',
          projectNumber: 1,
          tokenEnv: 'GITHUB_TOKEN',
        },
      },
      polling: {
        intervalMs: 60_000,
        maxConcurrency: 2,
      },
      workspace: {
        baseDir: './tmp/workspaces',
      },
      agent: {
        command: 'codex',
      },
    };
  }
}

class CapturingLogger implements Logger {
  public readonly messages: Array<{ message: string; context?: Record<string, unknown> }> = [];

  info(message: string, context?: Record<string, unknown>): void {
    this.messages.push({ message, context });
  }

  warn(_message: string, _context?: Record<string, unknown>): void {}

  error(_message: string, _context?: Record<string, unknown>): void {}
}

test("bootstrapFromWorkflow wires runtime and emits bootstrap log", async () => {
  const logger = new CapturingLogger();

  const result = await bootstrapFromWorkflow("./WORKFLOW.md", {
    workflowLoader: new StubWorkflowLoader(),
    logger,
  });

  assert.equal(result.workflow.tracker.kind, 'github_projects');
  assert.equal(typeof result.runtime.tick, "function");

  const bootstrapLog = logger.messages.find((entry) => entry.message === "bootstrap.ready");
  assert.ok(bootstrapLog);
  assert.equal(bootstrapLog?.context?.maxConcurrency, 2);
});
