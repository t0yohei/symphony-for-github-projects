import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { Logger } from '../logging/logger.js';
import type { NormalizedWorkItem, WorkItemState } from '../model/work-item.js';
import { PollingRuntime } from './runtime.js';

class FakeLogger implements Logger {
  info(): void {}
  warn(): void {}
  error(): void {}
}

class FakeTracker {
  public items: NormalizedWorkItem[] = [];
  public states: Record<string, WorkItemState> = {};
  public markInProgressCalls: string[] = [];
  public markDoneCalls: string[] = [];
  public failMarkInProgressFor = new Set<string>();

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
  polling: { intervalMs: 1000, maxConcurrency: 1 },
  workspace: { baseDir: '/tmp' },
  agent: { command: 'codex' },
};

describe('PollingRuntime state machine', () => {
  it('prevents duplicate dispatch across ticks for already running item', async () => {
    const tracker = new FakeTracker();
    tracker.items = [item('A', 101)];
    tracker.states.A = 'in_progress';

    const runtime = new PollingRuntime(tracker, workflow, new FakeLogger());

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
});
