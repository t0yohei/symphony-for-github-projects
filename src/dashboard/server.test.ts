import assert from 'node:assert/strict';
import test from 'node:test';

import { startDashboardServer } from './server.js';
import type { RuntimeStateSnapshot } from '../orchestrator/runtime.js';
import type { LoadedWorkflowContract } from '../workflow/contract.js';
import type { Logger } from '../logging/logger.js';

class CapturingLogger implements Logger {
  info(): void {}
  warn(): void {}
  error(): void {}
}

function makeWorkflow(): LoadedWorkflowContract {
  return {
    tracker: {
      kind: 'github_projects',
      github: { owner: 't0yohei', projectNumber: 42, tokenEnv: 'GITHUB_TOKEN' },
    },
    runtime: { pollIntervalMs: 30000, maxConcurrency: 2 },
    polling: { intervalMs: 30000, maxConcurrency: 2 },
    workspace: { root: '/tmp/workspaces', baseDir: '/tmp/workspaces' },
    agent: { command: 'codex' },
    prompt_template: 'Run',
  };
}

function makeSnapshot(): RuntimeStateSnapshot {
  return {
    running: ['item-1'],
    claimed: ['item-2'],
    retryAttempts: { 'item-3': 2 },
    completed: ['item-4'],
    runningDetails: [{ itemId: 'item-1', issueIdentifier: '#101', sessionId: 'session-1', runtimeSeconds: 12 }],
    retryingDetails: [
      {
        itemId: 'item-3',
        issueIdentifier: '#103',
        attempt: 2,
        kind: 'failure',
        dueAt: '2026-03-08T13:00:00.000Z',
      },
    ],
    usageTotals: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
    aggregateRuntimeSeconds: 90,
    liveAggregateRuntimeSeconds: 102,
    latestRateLimit: { retryAfterMs: 5000, message: 'slow down' },
  };
}

test('dashboard serves html and state json', async () => {
  const server = await startDashboardServer({
    port: 43123,
    host: '127.0.0.1',
    logger: new CapturingLogger(),
    getSnapshot: () => makeSnapshot(),
    getWorkflow: () => makeWorkflow(),
  });

  try {
    const htmlResponse = await fetch('http://127.0.0.1:43123/');
    assert.equal(htmlResponse.status, 200);
    const html = await htmlResponse.text();
    assert.match(html, /Operations Dashboard/);

    const apiResponse = await fetch('http://127.0.0.1:43123/api/state');
    assert.equal(apiResponse.status, 200);
    const payload = (await apiResponse.json()) as { summary: { running: number; totalTokens: number; liveAggregateRuntimeSeconds: number }; workflow: { owner: string }; running: Array<{ runtimeSeconds: number }> };
    assert.equal(payload.summary.running, 1);
    assert.equal(payload.summary.totalTokens, 15);
    assert.equal(payload.summary.liveAggregateRuntimeSeconds, 102);
    assert.equal(payload.running[0]?.runtimeSeconds, 12);
    assert.equal(payload.workflow.owner, 't0yohei');
  } finally {
    await server.stop();
  }
});
