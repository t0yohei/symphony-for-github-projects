import test from 'node:test';
import assert from 'node:assert/strict';

import { PollingRuntime } from './runtime.js';
import type { WorkItemState, NormalizedWorkItem } from '../model/work-item.js';
import type { WorkflowContract } from '../workflow/contract.js';
import type { Logger } from '../logging/logger.js';
import type { TrackerAdapter } from '../tracker/adapter.js';

class FakeLogger implements Logger {
  info(): void {}
  warn(): void {}
  error(): void {}
}

class FakeTracker implements TrackerAdapter {
  items: NormalizedWorkItem[] = [];
  states: Record<string, WorkItemState> = {};

  async listEligibleItems(): Promise<NormalizedWorkItem[]> {
    return this.items;
  }
  async listCandidateItems(): Promise<NormalizedWorkItem[]> {
    return this.items;
  }
  async listItemsByStates(): Promise<NormalizedWorkItem[]> {
    return this.items;
  }
  async getStatesByIds(ids: string[]): Promise<Record<string, WorkItemState>> {
    return Object.fromEntries(ids.map((id) => [id, this.states[id] ?? 'todo']));
  }
  async markInProgress(): Promise<void> {}
  async markDone(): Promise<void> {}
}

function item(id: string, number: number): NormalizedWorkItem {
  return {
    id,
    number,
    identifier: `#${number}`,
    title: `Issue ${number}`,
    body: '',
    state: 'in_progress',
    labels: [],
    url: `https://example.com/${number}`,
    priority: null,
    assignees: [],
    blocked_by: [],
    created_at: '2026-03-08T13:00:00.000Z',
    updated_at: '2026-03-08T13:00:00.000Z',
  };
}

const workflow: WorkflowContract = {
  tracker: {
    kind: 'github_projects',
    github: { owner: 't0yohei', projectNumber: 1, tokenEnv: 'GITHUB_TOKEN' },
  },
  runtime: { pollIntervalMs: 30000, maxConcurrency: 2 },
  polling: { intervalMs: 30000, maxConcurrency: 2 },
  workspace: { root: '/tmp/workspaces', baseDir: '/tmp/workspaces' },
  agent: { command: 'codex' },
};

test('snapshot exposes live runtime for running entries', () => {
  const now = 20_000;
  const tracker = new FakeTracker();
  const runtime = new PollingRuntime(tracker, workflow, new FakeLogger(), {
    now: () => now,
  });

  (runtime as unknown as {
    running: Map<string, { item: NormalizedWorkItem; startedAt: number; lastEventAt: number; workspacePath: string; sessionId?: string }>;
    aggregateRuntimeMs: number;
  }).running.set('A', {
    item: item('A', 101),
    startedAt: 5_000,
    lastEventAt: 19_000,
    workspacePath: '/tmp/A',
    sessionId: 'sess-a',
  });
  (runtime as unknown as { aggregateRuntimeMs: number }).aggregateRuntimeMs = 4_000;

  const snapshot = runtime.snapshot();
  assert.equal(snapshot.aggregateRuntimeSeconds, 4);
  assert.equal(snapshot.liveAggregateRuntimeSeconds, 19);
  assert.equal(snapshot.runningDetails[0]?.runtimeSeconds, 15);
});
