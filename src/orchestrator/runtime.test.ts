import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { Logger } from '../logging/logger.js';
import type { NormalizedWorkItem, WorkItemState } from '../model/work-item.js';
import { PollingRuntime } from './runtime.js';

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

const baseRuntimeOptions = {
  env: { GITHUB_TOKEN: 'token' },
  commandExists: () => true,
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

  it('uses continuation retry after normal worker exit when item is not done', async () => {
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
    await runtime.handleWorkerExit('A', 'completed');

    assert.equal(runtime.snapshot().running.length, 0);
    assert.equal(runtime.snapshot().retryAttempts.A, 1);

    await runtime.tick();
    assert.equal(tracker.markInProgressCalls.length, 1);

    now += 101;
    await runtime.tick();
    assert.equal(tracker.markInProgressCalls.length, 2);
    assert.deepEqual(runtime.snapshot().running, ['A']);
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
