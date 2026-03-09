import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { Logger } from '../logging/logger.js';
import type { NormalizedWorkItem, WorkItemState } from '../model/work-item.js';
import type { CodexTurnResult } from '../agent/codex-app-server.js';
import type { WorkspaceManager } from '../workspace/manager.js';
import { PollingRuntime, PreflightValidationError, validateRequiredWorkflowFields } from './runtime.js';

class FakeLogger implements Logger {
  public readonly infoLogs: Array<{ message: string; data?: Record<string, unknown> }> = [];
  public readonly warnLogs: Array<{ message: string; data?: Record<string, unknown> }> = [];

  info(message: string, data?: Record<string, unknown>): void {
    this.infoLogs.push({ message, data });
  }

  warn(message: string, data?: Record<string, unknown>): void {
    this.warnLogs.push({ message, data });
  }

  error(): void {}
}

class FakeTracker {
  public items: NormalizedWorkItem[] = [];
  public states: Record<string, WorkItemState> = {};
  public markInProgressCalls: string[] = [];
  public markDoneCalls: string[] = [];
  public failMarkInProgressFor = new Set<string>();
  public failGetStatesByIds = false;
  public getStatesByIdsCalls = 0;

  async listEligibleItems(): Promise<NormalizedWorkItem[]> {
    return this.items;
  }

  async listCandidateItems(): Promise<NormalizedWorkItem[]> {
    return this.items;
  }

  async listItemsByStates(): Promise<NormalizedWorkItem[]> {
    return this.items;
  }

  async getStatesByIds(itemIds: string[]): Promise<Record<string, WorkItemState>> {
    this.getStatesByIdsCalls += 1;
    if (this.failGetStatesByIds) {
      throw new Error('state refresh failed');
    }

    const result: Record<string, WorkItemState> = {};
    for (const id of itemIds) {
      const state = this.states[id];
      if (state) {
        result[id] = state;
      }
    }
    return result;
  }

  async markInProgress(itemId: string): Promise<void> {
    this.markInProgressCalls.push(itemId);
    if (this.failMarkInProgressFor.has(itemId)) {
      throw new Error('failed to claim');
    }
  }

  async markDone(itemId: string): Promise<void> {
    this.markDoneCalls.push(itemId);
  }
}

function item(id: string, number: number): NormalizedWorkItem {
  return {
    id,
    identifier: `#${number}`,
    number,
    title: `Issue ${number}`,
    state: 'todo',
    labels: [],
    assignees: [],
  };
}

const workflow = {
  tracker: {
    kind: 'github_projects' as const,
    github: { owner: 'o', projectNumber: 1, tokenEnv: 'GITHUB_TOKEN' },
  },
  runtime: { pollIntervalMs: 1000, maxConcurrency: 1 },
  polling: { intervalMs: 1000, maxConcurrency: 1 },
  workspace: { root: '/tmp', baseDir: '/tmp' },
  agent: { command: 'codex' },
};

const neverFinishWorker = {
  run: async (): Promise<CodexTurnResult> => {
    return new Promise<CodexTurnResult>(() => {});
  },
  cancel: () => {},
};

const baseRuntimeOptions = {
  env: { GITHUB_TOKEN: 'token' },
  commandExists: () => true,
  workerFactory: () => neverFinishWorker,
};

describe('PollingRuntime state machine', () => {
  it('prevents duplicate dispatch across ticks for already running item', async () => {
    const tracker = new FakeTracker();
    tracker.items = [item('A', 101)];
    tracker.states.A = 'in_progress';

    const runtime = new PollingRuntime(tracker, workflow, new FakeLogger(), baseRuntimeOptions);

    await runtime.tick();
    await runtime.tick();

    assert.equal(tracker.markInProgressCalls.length, 1);
    assert.deepEqual(runtime.snapshot().running, ['A']);
  });

  it('releases claimed slot after transition to running', async () => {
    const tracker = new FakeTracker();
    tracker.items = [item('A', 101)];
    tracker.states.A = 'in_progress';

    const runtime = new PollingRuntime(tracker, workflow, new FakeLogger(), baseRuntimeOptions);

    await runtime.tick();

    const snapshot = runtime.snapshot();
    assert.deepEqual(snapshot.running, ['A']);
    assert.deepEqual(snapshot.claimed, []);
  });

  it('schedules failure retry with exponential backoff and cap', async () => {
    let now = 1_000;
    const tracker = new FakeTracker();
    tracker.items = [item('A', 101)];
    tracker.failMarkInProgressFor.add('A');

    const runtime = new PollingRuntime(tracker, workflow, new FakeLogger(), {
      ...baseRuntimeOptions,
      now: () => now,
      continuationRetryDelayMs: 50,
      failureRetryBaseDelayMs: 100,
      failureRetryMultiplier: 2,
      failureRetryMaxDelayMs: 250,
    });

    await runtime.tick();
    assert.equal(runtime.snapshot().retryAttempts.A, 1);

    now += 100;
    await runtime.tick();
    assert.equal(runtime.snapshot().retryAttempts.A, 2);

    now += 200;
    await runtime.tick();
    assert.equal(runtime.snapshot().retryAttempts.A, 3);

    now += 249;
    await runtime.tick();
    assert.equal(tracker.markInProgressCalls.length, 3);

    now += 1;
    tracker.failMarkInProgressFor.delete('A');
    await runtime.tick();
    assert.equal(tracker.markInProgressCalls.length, 4);
    assert.deepEqual(runtime.snapshot().running, ['A']);
  });


  it('reads runtime.retry from workflow contract when options are not provided', async () => {
    const tracker = new FakeTracker();
    tracker.items = [item('A', 101)];
    tracker.failMarkInProgressFor.add('A');

    const workflowWithRetry = {
      ...workflow,
      runtime: {
        ...workflow.runtime,
        retry: {
          continuationDelayMs: 333,
          failureBaseDelayMs: 111,
          failureMultiplier: 3,
          failureMaxDelayMs: 222,
        },
      },
    };

    const now = 10_000;

    const runtime = new PollingRuntime(
      tracker,
      workflowWithRetry,
      new FakeLogger(),
      {
        ...baseRuntimeOptions,
        now: () => now,
      },
    );

    await runtime.tick();
    const retry1 = (runtime as unknown as { retry: Map<string, { dueAt: number; attempt: number }> }).retry.get(
      tracker.items[0].id,
    );
    assert.ok(retry1);
    assert.equal(retry1?.attempt, 1);
    const actualDelay = retry1!.dueAt - now;
    assert.equal(actualDelay, 111);
  });

  it('failure retry formula: min(base * 2^(attempt-1), max_retry_backoff_ms)', async () => {
    // Spec: min(10000 * 2^(attempt-1), max_retry_backoff_ms)
    // attempts: 1→10000, 2→20000, 3→40000, capped at maxRetryBackoffMs
    let now = 0;
    const tracker = new FakeTracker();
    tracker.items = [item('A', 101)];
    tracker.failMarkInProgressFor.add('A');

    const runtime = new PollingRuntime(tracker, workflow, new FakeLogger(), {
      ...baseRuntimeOptions,
      now: () => now,
      continuationRetryDelayMs: 500,
      failureRetryBaseDelayMs: 10_000,
      failureRetryMultiplier: 2,
      maxRetryBackoffMs: 30_000,
    });

    // attempt 1 → delay = min(10000 * 2^0, 30000) = 10000
    await runtime.tick();
    assert.equal(runtime.snapshot().retryAttempts.A, 1);

    now += 9_999;
    await runtime.tick();
    assert.equal(runtime.snapshot().retryAttempts.A, 1); // not due yet

    now += 1;
    await runtime.tick();
    assert.equal(runtime.snapshot().retryAttempts.A, 2); // attempt 2 → delay = min(20000, 30000) = 20000

    now += 20_000;
    await runtime.tick();
    assert.equal(runtime.snapshot().retryAttempts.A, 3); // attempt 3 → delay = min(40000, 30000) = 30000

    now += 29_999;
    await runtime.tick();
    assert.equal(runtime.snapshot().retryAttempts.A, 3); // cap not reached

    now += 1;
    tracker.failMarkInProgressFor.delete('A');
    await runtime.tick();
    assert.deepEqual(runtime.snapshot().running, ['A']); // dispatched after cap delay
  });

  it('maxRetryBackoffMs option is honored as alias for failureRetryMaxDelayMs', async () => {
    let now = 0;
    const tracker = new FakeTracker();
    tracker.items = [item('A', 101)];
    tracker.failMarkInProgressFor.add('A');

    const runtime = new PollingRuntime(tracker, workflow, new FakeLogger(), {
      ...baseRuntimeOptions,
      now: () => now,
      continuationRetryDelayMs: 500,
      failureRetryBaseDelayMs: 100,
      failureRetryMultiplier: 2,
      maxRetryBackoffMs: 150, // cap at 150ms
    });

    // attempt 1 → delay = min(100, 150) = 100
    await runtime.tick();
    assert.equal(runtime.snapshot().retryAttempts.A, 1);

    now += 100;
    await runtime.tick();
    // attempt 2 → delay = min(200, 150) = 150  (cap applied)
    assert.equal(runtime.snapshot().retryAttempts.A, 2);

    now += 149;
    await runtime.tick();
    assert.equal(runtime.snapshot().retryAttempts.A, 2); // cap in effect

    now += 1;
    await runtime.tick();
    assert.equal(runtime.snapshot().retryAttempts.A, 3);
  });

  it('defaults maxRetryBackoffMs to 300000ms', async () => {
    let now = 0;
    const tracker = new FakeTracker();
    tracker.items = [item('A', 101)];
    tracker.failMarkInProgressFor.add('A');

    const runtime = new PollingRuntime(tracker, workflow, new FakeLogger(), {
      ...baseRuntimeOptions,
      now: () => now,
      failureRetryBaseDelayMs: 10_000,
      failureRetryMultiplier: 2,
    });

    await runtime.tick();
    assert.equal(runtime.snapshot().retryAttempts.A, 1);

    now += 9_999;
    await runtime.tick();
    assert.equal(runtime.snapshot().retryAttempts.A, 1);

    now += 1;
    await runtime.tick();
    assert.equal(runtime.snapshot().retryAttempts.A, 2); // delay=20_000

    now += 19_999;
    await runtime.tick();
    assert.equal(runtime.snapshot().retryAttempts.A, 2);

    now += 1;
    await runtime.tick();
    assert.equal(runtime.snapshot().retryAttempts.A, 3); // delay=40_000

    now += 39_999;
    await runtime.tick();
    assert.equal(runtime.snapshot().retryAttempts.A, 3);

    now += 1;
    await runtime.tick();
    assert.equal(runtime.snapshot().retryAttempts.A, 4);

    now += 40_000;
    await runtime.tick();
    assert.equal(runtime.snapshot().retryAttempts.A, 4); // delay=80_000 at attempt 3, no 30_000 cap in effect
  });
  it('uses continuation retry after normal worker exit when active issue remains', async () => {
    let now = 2_000;
    const tracker = new FakeTracker();
    tracker.items = [item('A', 101)];
    tracker.states.A = 'in_progress';

    const runtime = new PollingRuntime(tracker, workflow, new FakeLogger(), {
      ...baseRuntimeOptions,
      now: () => now,
      continuationRetryDelayMs: 100,
      failureRetryBaseDelayMs: 1000,
    });

    await runtime.tick();
    await runtime.handleWorkerExit('A', 'completed', { activeIssue: true });

    assert.equal(runtime.snapshot().running.length, 0);
    assert.equal(runtime.snapshot().retryAttempts.A, 1);

    await runtime.tick();
    assert.equal(tracker.markInProgressCalls.length, 1);

    now += 101;
    await runtime.tick();
    assert.equal(tracker.markInProgressCalls.length, 2);
    assert.deepEqual(runtime.snapshot().running, ['A']);
  });

  it('does not schedule continuation retry after normal worker exit when active issue is false', async () => {
    const tracker = new FakeTracker();
    tracker.items = [item('A', 101)];
    tracker.states.A = 'in_progress';

    const logger = new FakeLogger();
    const runtime = new PollingRuntime(tracker, workflow, logger, {
      ...baseRuntimeOptions,
      continuationRetryDelayMs: 100,
      failureRetryBaseDelayMs: 1000,
    });

    await runtime.tick();
    await runtime.handleWorkerExit('A', 'completed', { activeIssue: false });

    assert.equal(runtime.snapshot().running.length, 0);
    assert.equal(runtime.snapshot().retryAttempts.A ?? 0, 0);
    assert.ok(logger.infoLogs.some((log) => log.message === 'runtime.transition.completed_without_continuation'));
  });

  it('backs off continuation retry when no dispatch slot is available', async () => {
    let now = 5_000;
    const tracker = new FakeTracker();
    tracker.items = [item('A', 101), item('B', 102)];
    tracker.states.A = 'in_progress';
    tracker.states.B = 'in_progress';

    const runtime = new PollingRuntime(
      tracker,
      {
        ...workflow,
        runtime: {
          ...workflow.runtime,
          maxConcurrency: 1,
        },
        polling: {
          ...workflow.polling,
          maxConcurrency: 1,
        },
      },
      new FakeLogger(),
      {
        ...baseRuntimeOptions,
        now: () => now,
        continuationRetryDelayMs: 100,
        failureRetryBaseDelayMs: 1000,
      },
    );

    await runtime.tick();
    await runtime.handleWorkerExit('A', 'completed', { activeIssue: true });
    assert.equal(runtime.snapshot().retryAttempts.A, 1);

    (runtime as unknown as {
      running: Map<string, { item: NormalizedWorkItem; startedAt: number; lastEventAt: number; workspacePath: string; worker?: { run: () => Promise<unknown>; cancel?: () => void } }>;
    }).running.set('B', {
      item: item('B', 102),
      startedAt: now,
      lastEventAt: now,
      workspacePath: '/tmp/B',
      worker: { run: async () => ({ status: 'completed', state: { usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 } } }) },
    });

    now += 101;
    await runtime.tick();

    const retry = (runtime as unknown as { retry: Map<string, { dueAt: number; attempt: number; kind: 'continuation' | 'failure' }> }).retry.get('A');
    assert.ok(retry);
    assert.equal(retry?.attempt, 2);
    assert.equal(retry?.kind, 'continuation');
    assert.equal(retry?.dueAt, now + 5_000);
    assert.equal(tracker.markInProgressCalls.length, 1);
  });

  it('reserves capacity for pending failure retries before dispatching new work', async () => {
    const now = 7_000;
    const tracker = new FakeTracker();
    tracker.items = [item('A', 101), item('B', 102), item('C', 103)];
    tracker.states.A = 'in_progress';
    tracker.states.B = 'in_progress';
    tracker.states.C = 'todo';

    const runtime = new PollingRuntime(
      tracker,
      {
        ...workflow,
        runtime: {
          ...workflow.runtime,
          maxConcurrency: 2,
        },
        polling: {
          ...workflow.polling,
          maxConcurrency: 2,
        },
      },
      new FakeLogger(),
      {
        ...baseRuntimeOptions,
        now: () => now,
        continuationRetryDelayMs: 100,
        failureRetryBaseDelayMs: 1000,
      },
    );

    await runtime.tick();
    await runtime.handleWorkerExit('A', 'failed');
    assert.equal(runtime.snapshot().retryAttempts.A, 1);

    (runtime as unknown as {
      running: Map<string, { item: NormalizedWorkItem; startedAt: number; lastEventAt: number; workspacePath: string; worker?: { run: () => Promise<unknown>; cancel?: () => void } }>;
    }).running.set('B', {
      item: item('B', 102),
      startedAt: now,
      lastEventAt: now,
      workspacePath: '/tmp/B',
      worker: { run: async () => ({ status: 'completed', state: { usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 } } }) },
    });

    await runtime.tick();

    assert.equal(runtime.snapshot().running.includes('C'), false);
    assert.equal(tracker.markInProgressCalls.includes('C'), false);
  });

  it('ignores retry fire when the item is already claimed', async () => {
    const tracker = new FakeTracker();
    tracker.items = [item('A', 101)];
    tracker.states.A = 'in_progress';

    const logger = new FakeLogger();
    const runtime = new PollingRuntime(tracker, workflow, logger, {
      ...baseRuntimeOptions,
      continuationRetryDelayMs: 100,
      failureRetryBaseDelayMs: 1000,
    });

    await runtime.tick();
    await runtime.handleWorkerExit('A', 'failed');

    (runtime as unknown as { claimed: Set<string> }).claimed.add('A');
    await (runtime as unknown as { onRetryFire: (itemId: string) => Promise<void> }).onRetryFire('A');

    assert.equal((runtime as unknown as { retry: Map<string, unknown> }).retry.has('A'), false);
    assert.ok(logger.infoLogs.some((log) => log.message === 'runtime.transition.retry_fire_ignored_claimed'));
  });

  it('preserves failure retry kind when no dispatch slot is available', async () => {
    let now = 6_000;
    const tracker = new FakeTracker();
    tracker.items = [item('A', 101), item('B', 102)];
    tracker.states.A = 'in_progress';
    tracker.states.B = 'in_progress';

    const runtime = new PollingRuntime(
      tracker,
      {
        ...workflow,
        runtime: {
          ...workflow.runtime,
          maxConcurrency: 1,
        },
        polling: {
          ...workflow.polling,
          maxConcurrency: 1,
        },
      },
      new FakeLogger(),
      {
        ...baseRuntimeOptions,
        now: () => now,
        continuationRetryDelayMs: 100,
        failureRetryBaseDelayMs: 1000,
      },
    );

    await runtime.tick();
    await runtime.handleWorkerExit('A', 'failed');
    assert.equal(runtime.snapshot().retryAttempts.A, 1);

    (runtime as unknown as {
      running: Map<string, { item: NormalizedWorkItem; startedAt: number; lastEventAt: number; workspacePath: string; worker?: { run: () => Promise<unknown>; cancel?: () => void } }>;
    }).running.set('B', {
      item: item('B', 102),
      startedAt: now,
      lastEventAt: now,
      workspacePath: '/tmp/B',
      worker: { run: async () => ({ status: 'completed', state: { usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 } } }) },
    });

    now += 1_001;
    await runtime.tick();

    const retry = (runtime as unknown as { retry: Map<string, { dueAt: number; attempt: number; kind: 'continuation' | 'failure' }> }).retry.get('A');
    assert.ok(retry);
    assert.equal(retry?.attempt, 2);
    assert.equal(retry?.kind, 'failure');
    assert.equal(retry?.dueAt, now + 5_000);
  });

  it('resets continuation attempt counter after failure retry context', async () => {
    const now = 3_000;
    const tracker = new FakeTracker();
    tracker.items = [item('A', 101)];
    tracker.states.A = 'in_progress';

    const runtime = new PollingRuntime(tracker, workflow, new FakeLogger(), {
      ...baseRuntimeOptions,
      now: () => now,
      continuationRetryDelayMs: 100,
      failureRetryBaseDelayMs: 1000,
    });

    await runtime.tick();

    (runtime as unknown as { retry: Map<string, { issueId: string; identifier: string; item: NormalizedWorkItem; attempt: number; dueAt: number; kind: 'continuation' | 'failure'; }>; }).retry.set('A', {
      issueId: 'A',
      identifier: '#101',
      item: item('A', 101),
      attempt: 3,
      dueAt: Number.MAX_SAFE_INTEGER,
      kind: 'failure',
    });

    await runtime.handleWorkerExit('A', 'completed', { activeIssue: true });
    assert.equal(runtime.snapshot().retryAttempts.A, 1);
  });


  it('marks item done on worker completion when workflow requires done transition', async () => {
    const tracker = new FakeTracker();
    tracker.items = [item('A', 101)];
    tracker.states.A = 'in_progress';

    const runtime = new PollingRuntime(
      tracker,
      {
        ...workflow,
        extensions: {
          github_projects: {
            mark_done_on_completion: true,
          },
        },
      },
      new FakeLogger(),
      baseRuntimeOptions,
    );

    await runtime.tick();
    await runtime.handleWorkerExit('A', 'completed');

    assert.equal(tracker.markDoneCalls.length, 1);
    assert.deepEqual(runtime.snapshot().completed, ['A']);
  });

  it('schedules retry when markDone fails in required done transition path', async () => {
    const now = 3_000;
    class FailingDoneTracker extends FakeTracker {
      override async markDone(itemId: string): Promise<void> {
        this.markDoneCalls.push(itemId);
        throw new Error('mutation failed');
      }
    }

    const tracker = new FailingDoneTracker();
    tracker.items = [item('A', 101)];
    tracker.states.A = 'in_progress';

    const logger = new FakeLogger();
    const runtime = new PollingRuntime(
      tracker,
      {
        ...workflow,
        extensions: {
          github_projects: {
            mark_done_on_completion: true,
          },
        },
      },
      logger,
      {
        ...baseRuntimeOptions,
        now: () => now,
        failureRetryBaseDelayMs: 100,
      },
    );

    await runtime.tick();
    await runtime.handleWorkerExit('A', 'completed');

    assert.equal(tracker.markDoneCalls.length, 1);
    assert.equal(runtime.snapshot().retryAttempts.A, 1);
    assert.ok(logger.warnLogs.some((log) => log.message === 'runtime.transition.mark_done_failed'));
  });

  it('does not crash tick when state refresh fails and retries on next tick', async () => {
    const tracker = new FakeTracker();
    tracker.items = [item('A', 101)];
    tracker.states.A = 'in_progress';
    const logger = new FakeLogger();

    const runtime = new PollingRuntime(tracker, workflow, logger, baseRuntimeOptions);

    await runtime.tick();
    tracker.failGetStatesByIds = true;
    await runtime.tick();

    assert.equal(runtime.snapshot().running.length, 1);
    assert.ok(
      logger.warnLogs.some((log) => log.message === 'runtime.transition.reconcile_state_refresh_failed'),
    );

    tracker.failGetStatesByIds = false;
    await runtime.tick();
    assert.equal(runtime.snapshot().running.length, 1);
  });

  it('refreshes running entry snapshot when active state persists', async () => {
    const tracker = new FakeTracker();
    tracker.items = [
      {
        ...item('A', 101),
        priority: 10,
        state: 'todo',
      },
    ];
    tracker.states.A = 'todo';

    const runtime = new PollingRuntime(tracker, workflow, new FakeLogger(), {
      ...baseRuntimeOptions,
      now: () => 1_000,
      workerFactory: () => neverFinishWorker,
    });

    await runtime.tick();
    assert.equal(
      (runtime as unknown as { running: Map<string, { item: { priority?: number } }> }).running.get('A')?.item.priority,
      10,
    );

    tracker.states.A = 'in_progress';
    tracker.items = [
      {
        ...item('A', 101),
        priority: 1,
        state: 'in_progress',
      },
    ];

    await runtime.tick();

    assert.equal(
      (runtime as unknown as { running: Map<string, { item: { priority?: number; state?: string } }> }).running.get('A')?.item.priority,
      1,
    );
    assert.equal(
      (runtime as unknown as { running: Map<string, { item: { priority?: number; state?: string } }> }).running.get('A')?.item.state,
      'in_progress',
    );
  });

  it('disables stall detection when stallTimeoutMs is zero or less', async () => {
    let now = 10_000;
    const tracker = new FakeTracker();
    tracker.items = [item('A', 101)];
    tracker.states.A = 'in_progress';

    const runtime = new PollingRuntime(tracker, workflow, new FakeLogger(), {
      ...baseRuntimeOptions,
      now: () => now,
      stallTimeoutMs: 0,
    });

    await runtime.tick();
    now += 60 * 60 * 1000;
    await runtime.tick();

    assert.deepEqual(runtime.snapshot().running, ['A']);
    assert.equal(runtime.snapshot().retryAttempts.A, undefined);
  });

  it('stops non-active running item without scheduling retry', async () => {
    const tracker = new FakeTracker();
    tracker.items = [item('A', 101)];
    tracker.states.A = 'in_progress';
    const logger = new FakeLogger();

    const runtime = new PollingRuntime(tracker, workflow, logger, baseRuntimeOptions);

    await runtime.tick();
    tracker.states.A = 'review';
    tracker.items = [];
    await runtime.tick();

    assert.equal(runtime.snapshot().running.length, 0);
    assert.equal(runtime.snapshot().retryAttempts.A, undefined);
    assert.ok(
      logger.infoLogs.some((log) => log.message === 'runtime.transition.reconcile_stopped_non_active'),
    );
  });

  it('treats configured terminal state as completion during reconcile', async () => {
    const tracker = new FakeTracker();
    tracker.items = [item('A', 101)];
    tracker.states.A = 'in_progress';

    const runtime = new PollingRuntime(
      tracker,
      {
        ...workflow,
        extensions: {
          github_projects: {
            terminal_states: ['Done', 'Closed', 'Cancelled', 'Canceled', 'Duplicate'],
          },
        },
      },
      new FakeLogger(),
      baseRuntimeOptions,
    );

    await runtime.tick();
    tracker.states.A = 'duplicate';
    tracker.items = [];
    await runtime.tick();

    assert.equal(runtime.snapshot().running.length, 0);
    assert.deepEqual(runtime.snapshot().completed, ['A']);
  });

  it('stops unknown state without cleanup when not active and not terminal', async () => {
    const tracker = new FakeTracker();
    tracker.items = [item('A', 101)];
    tracker.states.A = 'in_progress';
    const logger = new FakeLogger();

    const runtime = new PollingRuntime(
      tracker,
      {
        ...workflow,
        extensions: {
          github_projects: {
            active_states: ['todo', 'in_progress'],
            terminal_states: ['done', 'closed'],
          },
        },
      },
      logger,
      baseRuntimeOptions,
    );

    await runtime.tick();
    tracker.states.A = 'triaged';
    tracker.items = [];
    await runtime.tick();

    assert.equal(runtime.snapshot().running.length, 0);
    assert.deepEqual(runtime.snapshot().completed, []);
    assert.ok(
      logger.infoLogs.some(
        (log) =>
          log.message === 'runtime.transition.reconcile_stopped_non_active' &&
          log.data?.state === 'triaged',
      ),
    );
  });

  it('skips dispatch on preflight failure without skipping reconciliation', async () => {
    const tracker = new FakeTracker();
    tracker.items = [item('A', 101), item('B', 102)];
    tracker.states.A = 'in_progress';

    const logger = new FakeLogger();
    const runtime = new PollingRuntime(tracker, workflow, logger, baseRuntimeOptions);

    await runtime.tick();

    runtime.applyWorkflow({
      ...workflow,
      tracker: {
        ...workflow.tracker,
        github: { ...workflow.tracker.github, tokenEnv: 'MISSING_TOKEN' },
      },
    });

    await runtime.tick();

    assert.equal(tracker.markInProgressCalls.length, 1);
    assert.ok(tracker.getStatesByIdsCalls >= 1);
    assert.ok(logger.warnLogs.some((log) => log.message === 'runtime.preflight.failed'));
  });

  it('applies workflow update dynamically and uses updated maxConcurrency', async () => {
    const tracker = new FakeTracker();
    tracker.items = [item('A', 101), item('B', 102)];

    const logger = new FakeLogger();
    const runtime = new PollingRuntime(tracker, workflow, logger, baseRuntimeOptions);

    await runtime.tick();
    assert.equal(tracker.markInProgressCalls.length, 1);

    runtime.applyWorkflow({
      ...workflow,
      polling: {
        ...workflow.polling,
        maxConcurrency: 2,
      },
    });

    await runtime.tick();
    assert.equal(tracker.markInProgressCalls.length, 2);
    assert.ok(logger.infoLogs.some((log) => log.message === 'runtime.config.applied'));
  });

  it('enforces max_concurrent_agents_by_state alongside global maxConcurrency', async () => {
    const tracker = new FakeTracker();
    tracker.items = [
      { ...item('A', 101), state: 'todo' },
      { ...item('B', 102), state: 'todo' },
      { ...item('C', 103), state: 'in_progress' },
    ];

    const runtime = new PollingRuntime(
      tracker,
      {
        ...workflow,
        polling: { ...workflow.polling, maxConcurrency: 3 },
        runtime: { ...workflow.runtime, maxConcurrency: 3 },
        extensions: {
          github_projects: {
            max_concurrent_agents_by_state: {
              todo: 1,
              in_progress: 1,
            },
          },
        },
      },
      new FakeLogger(),
      baseRuntimeOptions,
    );

    await runtime.tick();

    assert.deepEqual(tracker.markInProgressCalls, ['A', 'C']);
  });

  it('dispatches candidates by priority, then created_at, then identifier', async () => {
    const tracker = new FakeTracker();
    tracker.items = [
      {
        ...item('A', 120),
        priority: 2,
        created_at: '2026-01-04T00:00:00Z',
      },
      {
        ...item('B', 121),
        priority: 1,
        created_at: '2026-01-03T00:00:00Z',
      },
      {
        ...item('C', 122),
        priority: 1,
        created_at: '2026-01-02T00:00:00Z',
      },
      {
        ...item('D', 110),
        identifier: '#100',
        priority: 1,
        created_at: '2026-01-02T00:00:00Z',
      },
    ];

    const runtime = new PollingRuntime(
      tracker,
      {
        ...workflow,
        polling: { ...workflow.polling, maxConcurrency: 4 },
        runtime: { ...workflow.runtime, maxConcurrency: 4 },
      },
      new FakeLogger(),
      baseRuntimeOptions,
    );

    await runtime.tick();

    assert.deepEqual(tracker.markInProgressCalls, ['D', 'C', 'B', 'A']);
  });

  it('places null priority and missing created_at last while keeping stable ties', async () => {
    const tracker = new FakeTracker();
    tracker.items = [
      {
        ...item('A', 201),
        identifier: '#200',
        priority: null,
      },
      {
        ...item('B', 202),
        identifier: '#300',
        priority: null,
      },
      {
        ...item('C', 203),
        identifier: '#050',
        priority: 1,
        created_at: 'not-a-date',
      },
      {
        ...item('D', 204),
        identifier: '#060',
        priority: 1,
        created_at: 'not-a-date',
      },
    ];

    const runtime = new PollingRuntime(
      tracker,
      {
        ...workflow,
        polling: { ...workflow.polling, maxConcurrency: 4 },
        runtime: { ...workflow.runtime, maxConcurrency: 4 },
      },
      new FakeLogger(),
      baseRuntimeOptions,
    );

    await runtime.tick();

    assert.deepEqual(tracker.markInProgressCalls, ['C', 'D', 'A', 'B']);
  });

  it('skips todo dispatch when blocked_by contains non-terminal items', async () => {
    const tracker = new FakeTracker();
    tracker.items = [
      {
        ...item('A', 101),
        blocked_by: ['B'],
      },
      item('C', 103),
    ];
    tracker.states.B = 'in_progress';

    const runtime = new PollingRuntime(
      tracker,
      {
        ...workflow,
        polling: { ...workflow.polling, maxConcurrency: 2 },
      },
      new FakeLogger(),
      baseRuntimeOptions,
    );

    await runtime.tick();

    assert.deepEqual(tracker.markInProgressCalls, ['C']);
  });

  it('allows todo dispatch when all blockers are terminal', async () => {
    const tracker = new FakeTracker();
    tracker.items = [
      {
        ...item('A', 101),
        blocked_by: ['B'],
      },
    ];
    tracker.states.B = 'done';

    const runtime = new PollingRuntime(tracker, workflow, new FakeLogger(), baseRuntimeOptions);

    await runtime.tick();

    assert.deepEqual(tracker.markInProgressCalls, ['A']);
  });

  it('preflight failure includes failing_key in warn log context', async () => {
    const tracker = new FakeTracker();
    tracker.items = [item('A', 101)];

    const logger = new FakeLogger();
    const runtime = new PollingRuntime(
      tracker,
      {
        ...workflow,
        tracker: {
          ...workflow.tracker,
          github: { ...workflow.tracker.github, tokenEnv: 'MISSING_ENV_KEY' },
        },
      },
      logger,
      { ...baseRuntimeOptions, env: {} },
    );

    await runtime.tick();

    const preflightWarn = logger.warnLogs.find((log) => log.message === 'runtime.preflight.failed');
    assert.ok(preflightWarn, 'expected runtime.preflight.failed warn log');
    assert.equal(preflightWarn?.data?.failing_key, 'env.MISSING_ENV_KEY');
    assert.equal(preflightWarn?.data?.reason, 'tracker_auth_token_unset');
    assert.equal(tracker.markInProgressCalls.length, 0);
  });

  it('preflight failure for missing agent.command includes failing_key', async () => {
    const tracker = new FakeTracker();
    tracker.items = [item('A', 101)];

    const logger = new FakeLogger();
    const runtime = new PollingRuntime(
      tracker,
      { ...workflow, agent: { command: '' } },
      logger,
      baseRuntimeOptions,
    );

    await runtime.tick();

    const preflightWarn = logger.warnLogs.find((log) => log.message === 'runtime.preflight.failed');
    assert.ok(preflightWarn, 'expected runtime.preflight.failed warn log');
    assert.equal(preflightWarn?.data?.failing_key, 'agent.command');
    assert.equal(preflightWarn?.data?.reason, 'agent_command_missing');
    assert.equal(tracker.markInProgressCalls.length, 0);
  });

  it('preflight failure for missing tracker owner includes failing_key', async () => {
    const tracker = new FakeTracker();
    tracker.items = [item('A', 101)];

    const logger = new FakeLogger();
    const runtime = new PollingRuntime(
      tracker,
      {
        ...workflow,
        tracker: {
          ...workflow.tracker,
          github: { ...workflow.tracker.github, owner: '' },
        },
      },
      logger,
      baseRuntimeOptions,
    );

    await runtime.tick();

    const preflightWarn = logger.warnLogs.find((log) => log.message === 'runtime.preflight.failed');
    assert.ok(preflightWarn);
    assert.equal(preflightWarn?.data?.failing_key, 'tracker.github.owner');
  });

  it('aggregates usage/runtime metrics and exposes detailed snapshot state', async () => {
    let now = 5_000;
    const tracker = new FakeTracker();
    tracker.items = [item('A', 101), item('B', 102)];
    tracker.states.A = 'in_progress';
    tracker.states.B = 'in_progress';

    const logger = new FakeLogger();
    const runtime = new PollingRuntime(
      tracker,
      {
        ...workflow,
        polling: { ...workflow.polling, maxConcurrency: 2 },
      },
      logger,
      {
        ...baseRuntimeOptions,
        now: () => now,
        continuationRetryDelayMs: 100,
      },
    );

    await runtime.tick();
    runtime.observeSession('A', {
      sessionId: 'sess-a',
      rateLimit: { code: 'rate_limited', retryAfterMs: 1200, message: 'slow down' },
    });

    now += 4_000;
    await runtime.handleWorkerExit('A', 'completed', {
      sessionId: 'sess-a',
      usage: { inputTokens: 10, outputTokens: 2, totalTokens: 12 },
    });

    now += 2_000;
    await runtime.tick();
    await runtime.handleWorkerExit('B', 'failed', {
      sessionId: 'sess-b',
      usage: { inputTokens: 3, outputTokens: 1, totalTokens: 4 },
      rateLimit: { code: 'rate_limited', retryAfterMs: 900, message: 'retry later' },
    });

    const snapshot = runtime.snapshot();
    assert.deepEqual(snapshot.usageTotals, {
      inputTokens: 13,
      outputTokens: 3,
      totalTokens: 16,
    });
    assert.equal(snapshot.aggregateRuntimeSeconds, 10);
    assert.equal(snapshot.liveAggregateRuntimeSeconds, 10);
    assert.equal(snapshot.latestRateLimit?.code, 'rate_limited');
    assert.equal(snapshot.latestRateLimit?.retryAfterMs, 900);
    assert.ok(snapshot.retryingDetails.some((entry) => entry.itemId === 'B' && entry.kind === 'failure'));
    assert.ok(snapshot.runningDetails.every((entry) => typeof entry.issueIdentifier === 'string'));
    assert.ok(
      logger.infoLogs.some(
        (log) => log.message === 'runtime.transition.metrics' && log.data?.session_id === 'sess-b',
      ),
    );
  });
});

describe('PollingRuntime hot-reload behavior', () => {
  it('re-applies active states during hot-reload', async () => {
    class ActiveAwareTracker extends FakeTracker {
      async listCandidateItems(options?: { pageSize?: number; activeStates?: string[] }): Promise<NormalizedWorkItem[]> {
        if (!options?.activeStates) {
          return this.items;
        }
        return this.items.filter((candidate) => options.activeStates!.includes(candidate.state));
      }
    }

    const tracker = new ActiveAwareTracker();
    tracker.items = [{ ...item('A', 101), state: 'blocked_custom' as WorkItemState }];
    tracker.states.A = 'blocked_custom' as WorkItemState;

    const runtime = new PollingRuntime(
      tracker,
      {
        ...workflow,
        extensions: {
          github_projects: {
            active_states: ['todo'],
          },
        },
      },
      new FakeLogger(),
      baseRuntimeOptions,
    );

    await runtime.tick();
    assert.equal(tracker.markInProgressCalls.length, 0, 'item should not dispatch with initial active states');

    runtime.applyWorkflow({
      ...workflow,
      extensions: {
        github_projects: {
          active_states: ['blocked_custom'],
        },
      },
    });

    await runtime.tick();
    assert.equal(tracker.markInProgressCalls.length, 1, 'item should dispatch after active_states changed');
  });

  it('rebuilds workspace manager when workspace root changes on hot-reload', async () => {
    const tracker = new FakeTracker();
    const fakeWorkspaceManager = {
      prepareWorkspace: async () => ({ path: '/tmp/old-workspace' }),
      beforeRun: async () => {},
      afterRun: async () => {},
      beforeRemove: async () => {},
      resolveWorkspacePath: () => '/tmp/old-workspace',
      toWorkspaceKey: () => '_old',
      cleanupWorkspace: async () => {},
      toWorkspaceKeyOrThrow: () => '_old',
      workspaceRoot: '/tmp/first',
    } as unknown as WorkspaceManager;


    const runtime = new PollingRuntime(
      tracker,
      {
        ...workflow,
        workspace: { root: '/tmp/first', baseDir: '/tmp/first' },
      },
      new FakeLogger(),
      {
        ...baseRuntimeOptions,
        workspaceManager: fakeWorkspaceManager,
      },
    );

    const runtimeInternals = runtime as unknown as { workspaceManager: { [key: string]: unknown } };
    assert.equal(runtimeInternals.workspaceManager, fakeWorkspaceManager);

    runtime.applyWorkflow({
      ...workflow,
      workspace: { root: '/tmp/second', baseDir: '/tmp/second' },
    });

    assert.notEqual(runtimeInternals.workspaceManager, fakeWorkspaceManager);
    const workspacePath = runtimeInternals.workspaceManager.resolveWorkspacePath('_old');
    assert.equal(workspacePath.startsWith('/tmp/second/'), true);

  });
});

describe('validateRequiredWorkflowFields', () => {
  const validWorkflow = {
    tracker: {
      kind: 'github_projects' as const,
      github: { owner: 'owner', projectNumber: 1, tokenEnv: 'MY_TOKEN' },
    },
    runtime: { pollIntervalMs: 1000, maxConcurrency: 1 },
    polling: { intervalMs: 1000, maxConcurrency: 1 },
    workspace: { root: '/tmp', baseDir: '/tmp' },
    agent: { command: 'codex' },
  };
  const validEnv = { MY_TOKEN: 'tok' };

  it('passes for a fully valid config', () => {
    assert.doesNotThrow(() => validateRequiredWorkflowFields(validWorkflow, validEnv));
  });

  it('throws PreflightValidationError with failingKey for missing owner', () => {
    const w = { ...validWorkflow, tracker: { ...validWorkflow.tracker, github: { ...validWorkflow.tracker.github, owner: '' } } };
    assert.throws(
      () => validateRequiredWorkflowFields(w, validEnv),
      (err: unknown) => {
        assert.ok(err instanceof PreflightValidationError);
        assert.equal(err.failingKey, 'tracker.github.owner');
        return true;
      },
    );
  });

  it('throws PreflightValidationError with failingKey for invalid projectNumber', () => {
    const w = { ...validWorkflow, tracker: { ...validWorkflow.tracker, github: { ...validWorkflow.tracker.github, projectNumber: 0 } } };
    assert.throws(
      () => validateRequiredWorkflowFields(w, validEnv),
      (err: unknown) => {
        assert.ok(err instanceof PreflightValidationError);
        assert.equal(err.failingKey, 'tracker.github.projectNumber');
        return true;
      },
    );
  });

  it('throws PreflightValidationError with failingKey for unset token env var', () => {
    assert.throws(
      () => validateRequiredWorkflowFields(validWorkflow, {}),
      (err: unknown) => {
        assert.ok(err instanceof PreflightValidationError);
        assert.equal(err.failingKey, 'env.MY_TOKEN');
        return true;
      },
    );
  });

  it('throws PreflightValidationError with failingKey for missing agent command', () => {
    const w = { ...validWorkflow, agent: { command: '' } };
    assert.throws(
      () => validateRequiredWorkflowFields(w, validEnv),
      (err: unknown) => {
        assert.ok(err instanceof PreflightValidationError);
        assert.equal(err.failingKey, 'agent.command');
        return true;
      },
    );
  });
});
