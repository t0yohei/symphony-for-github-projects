import assert from 'node:assert/strict';
import test from 'node:test';

import { WorkflowHotReloader } from './hot-reload.js';
import type { LoadedWorkflowContract, WorkflowLoader } from './contract.js';
import type { Logger } from '../logging/logger.js';

type WatchCallback = (eventType: string) => void;

class CapturingLogger implements Logger {
  public readonly messages: Array<{ message: string; context?: Record<string, unknown> }> = [];
  info(message: string, context?: Record<string, unknown>): void {
    this.messages.push({ message, context });
  }
  warn(_m: string, _c?: Record<string, unknown>): void {}
  error(message: string, context?: Record<string, unknown>): void {
    this.messages.push({ message, context });
  }
}

function makeContract(overrides: Partial<LoadedWorkflowContract> = {}): LoadedWorkflowContract {
  return {
    tracker: {
      kind: 'github_projects',
      github: { owner: 'test', projectNumber: 1, tokenEnv: 'TOKEN' },
    },
    polling: { intervalMs: 60000, maxConcurrency: 1 },
    workspace: { baseDir: '/tmp' },
    agent: { command: 'codex' },
    prompt_template: 'do work',
    ...overrides,
  };
}

test('triggers onReload when file change is detected', async () => {
  const logger = new CapturingLogger();
  let watchCallback: WatchCallback | undefined;
  const reloaded: LoadedWorkflowContract[] = [];

  const newContract = makeContract({
    polling: { intervalMs: 30000, maxConcurrency: 4 },
  });

  const loader: WorkflowLoader = {
    async load() {
      return newContract;
    },
  };

  const reloader = new WorkflowHotReloader({
    workflowPath: '/fake/WORKFLOW.md',
    loader,
    logger,
    debounceMs: 5,
    onReload: (c) => reloaded.push(c),
    watch: (_path, cb) => {
      watchCallback = cb;
      return { close: () => {} };
    },
  });

  reloader.start(makeContract());

  // Simulate file change
  assert.ok(watchCallback, 'watchCallback should be set');
  watchCallback!('change');

  // Wait for debounce + async reload
  await new Promise((r) => setTimeout(r, 50));

  assert.equal(reloaded.length, 1);
  assert.equal(reloaded[0]!.polling.intervalMs, 30000);
  assert.equal(reloaded[0]!.polling.maxConcurrency, 4);
  assert.ok(logger.messages.some((m) => m.message === 'hot-reload.applied'));

  reloader.stop();
});

test('keeps last good config when reload fails', async () => {
  const logger = new CapturingLogger();
  let watchCallback: WatchCallback | undefined;
  const reloaded: LoadedWorkflowContract[] = [];

  const loader: WorkflowLoader = {
    async load() {
      throw new Error('invalid YAML');
    },
  };

  const initialContract = makeContract();

  const reloader = new WorkflowHotReloader({
    workflowPath: '/fake/WORKFLOW.md',
    loader,
    logger,
    debounceMs: 5,
    onReload: (c) => reloaded.push(c),
    watch: (_path, cb) => {
      watchCallback = cb;
      return { close: () => {} };
    },
  });

  reloader.start(initialContract);
  watchCallback!('change');

  await new Promise((r) => setTimeout(r, 50));

  assert.equal(reloaded.length, 0);
  assert.ok(logger.messages.some((m) => m.message === 'hot-reload.invalid'));
  assert.equal(reloader.getLastGoodContract(), initialContract);

  reloader.stop();
});

test('debounces rapid file changes', async () => {
  const logger = new CapturingLogger();
  let watchCallback: WatchCallback | undefined;
  let loadCount = 0;

  const loader: WorkflowLoader = {
    async load() {
      loadCount += 1;
      return makeContract();
    },
  };

  const reloader = new WorkflowHotReloader({
    workflowPath: '/fake/WORKFLOW.md',
    loader,
    logger,
    debounceMs: 30,
    onReload: () => {},
    watch: (_path, cb) => {
      watchCallback = cb;
      return { close: () => {} };
    },
  });

  reloader.start(makeContract());

  // Fire 5 rapid changes
  for (let i = 0; i < 5; i++) {
    watchCallback!('change');
  }

  await new Promise((r) => setTimeout(r, 100));

  // Should only load once due to debounce
  assert.equal(loadCount, 1);

  reloader.stop();
});

test('stop cancels pending debounce', async () => {
  const logger = new CapturingLogger();
  let watchCallback: WatchCallback | undefined;
  let loadCount = 0;

  const loader: WorkflowLoader = {
    async load() {
      loadCount += 1;
      return makeContract();
    },
  };

  const reloader = new WorkflowHotReloader({
    workflowPath: '/fake/WORKFLOW.md',
    loader,
    logger,
    debounceMs: 100,
    onReload: () => {},
    watch: (_path, cb) => {
      watchCallback = cb;
      return { close: () => {} };
    },
  });

  reloader.start(makeContract());
  watchCallback!('change');
  reloader.stop();

  await new Promise((r) => setTimeout(r, 150));
  assert.equal(loadCount, 0);
});
