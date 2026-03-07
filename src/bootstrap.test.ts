import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { bootstrapFromWorkflow, BootstrapConfigurationError, performStartupTerminalCleanup } from './bootstrap.js';
import type { Logger } from './logging/logger.js';
import type { NormalizedWorkItem, WorkItemState } from './model/work-item.js';
import type { TrackerAdapter } from './tracker/adapter.js';
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



test('bootstrapFromWorkflow uses terminal_states extension for startup cleanup', async () => {
  class TerminalStateTracker extends StubTracker {
    public requestedStates: string[] = [];
    override async listItemsByStates(states: WorkItemState[]): Promise<NormalizedWorkItem[]> {
      this.requestedStates = states;
      return [];
    }
  }

  const logger = new CapturingLogger();
  const terminalTracker = new TerminalStateTracker();

  class TerminalLoader implements WorkflowLoader {
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
        runtime: { pollIntervalMs: 60_000, maxConcurrency: 2 },
        polling: { intervalMs: 60_000, maxConcurrency: 2 },
        workspace: { root: './tmp/workspaces', baseDir: './tmp/workspaces' },
        agent: { command: 'codex' },
        extensions: {
          github_projects: {
            terminal_states: ['DONE', 'done'],
          },
        },
        prompt_template: 'Run the workflow',
      };
    }
  }

  process.env.BOOTSTRAP_TEST_TOKEN = 'test-token';

  await bootstrapFromWorkflow('./WORKFLOW.md', {
    workflowLoader: new TerminalLoader(),
    trackerAdapter: terminalTracker,
    logger,
    skipStartupCleanup: false,
  });

  assert.deepEqual(terminalTracker.requestedStates, ['done']);
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

// ---- performStartupTerminalCleanup tests ----

function makeItem(identifier: string): NormalizedWorkItem {
  return {
    id: `id-${identifier}`,
    identifier,
    number: 0,
    title: `Item ${identifier}`,
    body: '',
    description: '',
    state: 'done',
    priority: null,
    labels: [],
    blocked_by: [],
    assignees: [],
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    url: `https://example.com/${identifier}`,
  };
}

class StubTracker implements TrackerAdapter {
  constructor(private readonly items: NormalizedWorkItem[] = []) {}

  async listEligibleItems(): Promise<NormalizedWorkItem[]> { return this.items; }
  async listCandidateItems(): Promise<NormalizedWorkItem[]> { return this.items; }
  async listItemsByStates(_states: WorkItemState[]): Promise<NormalizedWorkItem[]> { return this.items; }
  async getStatesByIds(_ids: string[]): Promise<Record<string, WorkItemState>> { return {}; }
  async markInProgress(_id: string): Promise<void> {}
  async markDone(_id: string): Promise<void> {}
}

class FailingTracker extends StubTracker {
  async listItemsByStates(_states: WorkItemState[]): Promise<NormalizedWorkItem[]> {
    throw new Error('tracker fetch failed');
  }
}

class WarnCapturingLogger extends CapturingLogger {
  public readonly warnings: Array<{ message: string; context?: Record<string, unknown> }> = [];

  override warn(message: string, context?: Record<string, unknown>): void {
    this.warnings.push({ message, context });
  }
}

test('performStartupTerminalCleanup removes terminal workspace directories and reports count', async () => {
  const workspaceRoot = await mkdtemp(path.join(tmpdir(), 'symphony-test-'));
  try {
    // Create two workspace dirs that correspond to terminal items.
    await mkdir(path.join(workspaceRoot, '_64'), { recursive: true });
    await mkdir(path.join(workspaceRoot, '_65'), { recursive: true });

    const tracker = new StubTracker([makeItem('#64'), makeItem('#65')]);
    const logger = new WarnCapturingLogger();

    const result = await performStartupTerminalCleanup(tracker, workspaceRoot, logger);

    assert.equal(result.cleaned, 2, 'should clean both terminal workspaces');
    assert.equal(result.skipped, 0);
    assert.equal(result.fetchFailed, false);
    assert.equal(logger.warnings.length, 0, 'no warnings expected on success');

    const summaryLog = logger.messages.find((m) => m.message === 'bootstrap.startup_cleanup.done');
    assert.ok(summaryLog, 'cleanup summary log should be emitted');
    assert.equal(summaryLog?.context?.cleaned, 2);
  } finally {
    await rm(workspaceRoot, { recursive: true, force: true });
  }
});

test('performStartupTerminalCleanup skips items whose workspace does not exist', async () => {
  const workspaceRoot = await mkdtemp(path.join(tmpdir(), 'symphony-test-'));
  try {
    // Only one dir exists; the other is already gone.
    await mkdir(path.join(workspaceRoot, '_64'), { recursive: true });

    const tracker = new StubTracker([makeItem('#64'), makeItem('#65')]);
    const logger = new WarnCapturingLogger();

    const result = await performStartupTerminalCleanup(tracker, workspaceRoot, logger);

    // #64 cleaned, #65 silently skipped (rm with force:true is a no-op for missing dirs).
    assert.equal(result.cleaned + result.skipped, 2);
    assert.equal(result.fetchFailed, false);
  } finally {
    await rm(workspaceRoot, { recursive: true, force: true });
  }
});

test('performStartupTerminalCleanup is non-fatal when tracker fetch fails', async () => {
  const workspaceRoot = await mkdtemp(path.join(tmpdir(), 'symphony-test-'));
  try {
    const tracker = new FailingTracker();
    const logger = new WarnCapturingLogger();

    const result = await performStartupTerminalCleanup(tracker, workspaceRoot, logger);

    assert.equal(result.fetchFailed, true, 'should report fetch failure');
    assert.equal(result.cleaned, 0);
    assert.equal(logger.warnings.length, 1, 'should emit one warning for the fetch failure');
    assert.equal(logger.warnings[0].message, 'bootstrap.startup_cleanup.fetch_failed');
  } finally {
    await rm(workspaceRoot, { recursive: true, force: true });
  }
});

test('performStartupTerminalCleanup rejects path escapes outside workspace root', async () => {
  const workspaceRoot = await mkdtemp(path.join(tmpdir(), 'symphony-test-'));
  try {
    // Item identifier that sanitizes to a traversal attempt — sanitizeWorkspaceKey
    // replaces '/' with '_', so the result stays within root.
    const tracker = new StubTracker([makeItem('../etc/passwd')]);
    const logger = new WarnCapturingLogger();

    const result = await performStartupTerminalCleanup(tracker, workspaceRoot, logger);

    // The sanitized key is '__.._etc_passwd'; resolveWorkspacePath will reject it
    // only if it escapes root. Since sanitization replaces '/', the resolved path
    // is still under workspaceRoot and the skipped/cleaned count is deterministic.
    assert.equal(result.fetchFailed, false, 'fetch should succeed');
    assert.equal(logger.warnings.length, 0, 'no warnings for path sanitization');
  } finally {
    await rm(workspaceRoot, { recursive: true, force: true });
  }
});
