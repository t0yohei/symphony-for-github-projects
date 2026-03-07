import test from 'node:test';
import assert from 'node:assert/strict';

import { bootstrapFromWorkflow, BootstrapConfigurationError } from './bootstrap.js';
import type { Logger } from './logging/logger.js';
import type { LoadedWorkflowContract, WorkflowLoader } from './workflow/contract.js';

class StubWorkflowLoader implements WorkflowLoader {
  async load(_path: string): Promise<LoadedWorkflowContract> {
    return {
      tracker: {
        kind: 'github_projects',
        github: {
          owner: 'kouka-t0yohei',
          projectNumber: 1,
          tokenEnv: 'BOOTSTRAP_TEST_TOKEN',
        },
      },
      runtime: {
        pollIntervalMs: 60_000,
        maxConcurrency: 2,
      },
      polling: {
        intervalMs: 60_000,
        maxConcurrency: 2,
      },
      workspace: {
        root: './tmp/workspaces',
        baseDir: './tmp/workspaces',
      },
      agent: {
        command: 'codex',
      },
      prompt_template: 'Run the workflow',
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

test('bootstrapFromWorkflow wires runtime and emits bootstrap log', async () => {
  const logger = new CapturingLogger();
  process.env.BOOTSTRAP_TEST_TOKEN = 'test-token';

  const result = await bootstrapFromWorkflow('./WORKFLOW.md', {
    workflowLoader: new StubWorkflowLoader(),
    logger,
  });

  assert.equal(result.workflow.tracker.kind, 'github_projects');
  assert.equal(typeof result.runtime.tick, 'function');

  const bootstrapLog = logger.messages.find((entry) => entry.message === 'bootstrap.ready');
  assert.ok(bootstrapLog);
  assert.equal(bootstrapLog?.context?.maxConcurrency, 2);
});

test('bootstrapFromWorkflow fails fast when tracker auth env var is missing', async () => {
  delete process.env.BOOTSTRAP_TEST_TOKEN;

  await assert.rejects(
    bootstrapFromWorkflow('./WORKFLOW.md', {
      workflowLoader: new StubWorkflowLoader(),
      logger: new CapturingLogger(),
    }),
    (error: unknown) => {
      assert.ok(error instanceof BootstrapConfigurationError);
      assert.match((error as Error).message, /BOOTSTRAP_TEST_TOKEN/);
      return true;
    },
  );
});

class InvalidTrackerOwnerLoader implements WorkflowLoader {
  async load(_path: string): Promise<LoadedWorkflowContract> {
    return {
      tracker: {
        kind: 'github_projects',
        github: {
          owner: '',
          projectNumber: 1,
          tokenEnv: 'BOOTSTRAP_TEST_TOKEN',
        },
      },
      runtime: { pollIntervalMs: 60_000, maxConcurrency: 1 },
      polling: { intervalMs: 60_000, maxConcurrency: 1 },
      workspace: { root: './tmp/workspaces', baseDir: './tmp/workspaces' },
      agent: { command: 'codex' },
      prompt_template: 'Run the workflow',
    };
  }
}

class MissingAgentCommandLoader implements WorkflowLoader {
  async load(_path: string): Promise<LoadedWorkflowContract> {
    return {
      tracker: {
        kind: 'github_projects',
        github: {
          owner: 'kouka-t0yohei',
          projectNumber: 1,
          tokenEnv: 'BOOTSTRAP_TEST_TOKEN',
        },
      },
      runtime: { pollIntervalMs: 60_000, maxConcurrency: 1 },
      polling: { intervalMs: 60_000, maxConcurrency: 1 },
      workspace: { root: './tmp/workspaces', baseDir: './tmp/workspaces' },
      agent: { command: '' },
      prompt_template: 'Run the workflow',
    };
  }
}

test('bootstrapFromWorkflow fails fast when tracker.github.owner is missing', async () => {
  process.env.BOOTSTRAP_TEST_TOKEN = 'test-token';

  await assert.rejects(
    bootstrapFromWorkflow('./WORKFLOW.md', {
      workflowLoader: new InvalidTrackerOwnerLoader(),
      logger: new CapturingLogger(),
    }),
    (error: unknown) => {
      assert.ok(error instanceof BootstrapConfigurationError);
      assert.match((error as Error).message, /tracker\.github\.owner/);
      return true;
    },
  );
});

test('bootstrapFromWorkflow fails fast when agent.command is missing', async () => {
  process.env.BOOTSTRAP_TEST_TOKEN = 'test-token';

  await assert.rejects(
    bootstrapFromWorkflow('./WORKFLOW.md', {
      workflowLoader: new MissingAgentCommandLoader(),
      logger: new CapturingLogger(),
    }),
    (error: unknown) => {
      assert.ok(error instanceof BootstrapConfigurationError);
      assert.match((error as Error).message, /agent\.command/);
      return true;
    },
  );
});
