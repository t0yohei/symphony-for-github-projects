import test from 'node:test';
import assert from 'node:assert/strict';
import type { LoadedWorkflowContract } from './workflow/contract.js';
import type { Logger } from './logging/logger.js';
import { startService, parseArgs } from './cli.js';

function baseWorkflow(intervalMs: number, maxConcurrency = 2): LoadedWorkflowContract {
  return {
    tracker: {
      kind: 'github_projects',
      github: {
        owner: 'example-org',
        projectNumber: 1,
        tokenEnv: 'TEST_GITHUB_TOKEN',
      },
    },
    runtime: {
      pollIntervalMs: intervalMs,
      maxConcurrency,
    },
    polling: {
      intervalMs,
      maxConcurrency,
    },
    workspace: {
      root: './tmp/workspaces',
      baseDir: './tmp/workspaces',
    },
    agent: {
      command: 'codex',
    },
    prompt_template: 'Run issue {{ issue.identifier }}',
  };
}

interface PollingRuntimeLike {
  tick(): Promise<void>;
  applyWorkflow(contract: LoadedWorkflowContract): void;
}

class FakeRuntime implements PollingRuntimeLike {
  public tickCalls = 0;
  public applyCalls = 0;
  public lastAppliedContract: LoadedWorkflowContract | null = null;
  public readonly onTick?: () => void | Promise<void>;

  constructor(onTick?: () => void | Promise<void>) {
    this.onTick = onTick;
  }

  async tick(): Promise<void> {
    this.tickCalls += 1;
    if (this.onTick) {
      await this.onTick();
    }
  }

  applyWorkflow(contract: LoadedWorkflowContract): void {
    this.applyCalls += 1;
    this.lastAppliedContract = contract;
  }
}

interface WorkflowLoader {
  load(path: string): Promise<LoadedWorkflowContract>;
}

class FakeWorkflowLoader implements WorkflowLoader {
  public readonly loadCalls: string[] = [];
  private readonly contract: LoadedWorkflowContract;

  constructor(contract: LoadedWorkflowContract) {
    this.contract = contract;
  }

  async load(path: string): Promise<LoadedWorkflowContract> {
    this.loadCalls.push(path);
    return this.contract;
  }
}

interface ReloaderLike {
  start(contract: LoadedWorkflowContract): void;
  stop(): void;
}

class FakeReloader implements ReloaderLike {
  private readonly onReload: (contract: LoadedWorkflowContract) => void;

  public startCalls = 0;
  public stopCalls = 0;
  public lastContract: LoadedWorkflowContract | null = null;

  constructor(_workflowPath: string, onReload: (contract: LoadedWorkflowContract) => void) {
    this.onReload = onReload;
  }

  start(initialContract: LoadedWorkflowContract): void {
    this.startCalls += 1;
    this.onReload(initialContract);
  }

  stop(): void {
    this.stopCalls += 1;
  }

  triggerReload(contract: LoadedWorkflowContract): void {
    this.lastContract = contract;
    this.onReload(contract);
  }
}

class FakeClock {
  private current = 0;
  private nextHandle = 1;
  private active = new Map<number, { when: number; fn: () => void }>();
  public readonly delays: number[] = [];

  setTimeout = (fn: () => void, timeout: number): ReturnType<typeof setTimeout> => {
    const handle = this.nextHandle;
    this.nextHandle += 1;
    this.active.set(handle, { when: this.current + Math.max(0, timeout), fn });
    this.delays.push(timeout);
    return handle as unknown as ReturnType<typeof setTimeout>;
  };

  clearTimeout = (handle: ReturnType<typeof setTimeout>): void => {
    this.active.delete(handle as unknown as number);
  };

  runNext(): boolean {
    let nextHandle: number | undefined;
    let nextWhen = Number.POSITIVE_INFINITY;

    for (const [handle, entry] of this.active) {
      if (entry.when < nextWhen) {
        nextWhen = entry.when;
        nextHandle = handle;
      }
    }

    if (nextHandle === undefined) {
      return false;
    }

    const entry = this.active.get(nextHandle);
    if (!entry) {
      return false;
    }

    this.active.delete(nextHandle);
    this.current = entry.when;
    entry.fn();
    return true;
  }

  runAll(): void {
    while (this.runNext()) {
      // run until queue drains
    }
  }

  get nextTimeoutMs(): number | null {
    let next: number | null = null;

    for (const entry of this.active.values()) {
      const delay = entry.when - this.current;
      if (next === null || delay < next) {
        next = delay;
      }
    }

    return next;
  }

  get now(): number {
    return this.current;
  }
}

class CapturingLogger implements Logger {
  public readonly messages: Array<{ message: string; context?: Record<string, unknown> }> = [];

  info(message: string, context?: Record<string, unknown>): void {
    this.messages.push({ message, context });
  }

  warn(message: string, context?: Record<string, unknown>): void {
    this.messages.push({ message, context });
  }

  error(message: string, context?: Record<string, unknown>): void {
    this.messages.push({ message, context });
  }

  getMessagesFor(message: string): Array<{ message: string; context?: Record<string, unknown> }> {
    return this.messages.filter((entry) => entry.message === message);
  }
}

test('parseArgs uses WORKFLOW_PATH environment variable', () => {
  const previous = process.env.WORKFLOW_PATH;
  process.env.WORKFLOW_PATH = '/env/WORKFLOW.md';

  try {
    const result = parseArgs([]);
    assert.equal(result.workflowPath, '/env/WORKFLOW.md');
  } finally {
    if (previous === undefined) {
      delete process.env.WORKFLOW_PATH;
    } else {
      process.env.WORKFLOW_PATH = previous;
    }
  }
});

test('parseArgs accepts --workflow option', () => {
  const result = parseArgs(['--workflow', 'custom/WORKFLOW.md']);
  assert.equal(result.workflowPath, 'custom/WORKFLOW.md');
});

test('parseArgs accepts dashboard host and port', () => {
  const result = parseArgs(['--workflow', 'custom/WORKFLOW.md', '--dashboard-port', '4318', '--dashboard-host', '0.0.0.0']);
  assert.equal(result.workflowPath, 'custom/WORKFLOW.md');
  assert.equal(result.dashboardPort, 4318);
  assert.equal(result.dashboardHost, '0.0.0.0');
});
test('parseArgs supports -w alias', () => {
  const result = parseArgs(['-w', 'another/workflow.md']);
  assert.equal(result.workflowPath, 'another/workflow.md');
});

test('parseArgs prints usage and exits on -h', () => {
  const oldExit = process.exit;
  const oldLog = console.log;
  const printed: string[] = [];

  process.exit = ((code?: number): never => {
    throw new Error(`process.exit:${code ?? ''}`);
  }) as typeof process.exit;
  console.log = (...args: unknown[]) => {
    printed.push(args.map(String).join(' '));
  };

  try {
    assert.throws(() => parseArgs(['-h']), /process.exit:0/);
    assert.equal(printed.length, 1);
    assert.match(printed[0], /Usage: node dist\/cli\.js/);
  } finally {
    process.exit = oldExit;
    console.log = oldLog;
  }
});

test('startService starts tick loop and can stop', async () => {
  const workflow = baseWorkflow(8);
  const runtime = new FakeRuntime();
  const logger = new CapturingLogger();
  const loader = new FakeWorkflowLoader(workflow);
  const clock = new FakeClock();

  const handle = await startService({ workflowPath: 'WORKFLOW.md' }, {
    workflowLoader: loader,
    logger,
    bootstrap: async () => ({
      workflow,
      runtime,
      logger,
    }),
    reloaderFactory: ({ onReload, workflowPath }) => {
      assert.equal(workflowPath, 'WORKFLOW.md');
      return {
        start: (initialContract: LoadedWorkflowContract) => onReload(initialContract),
        stop: () => undefined,
      };
    },
    setTimeoutFn: clock.setTimeout as unknown as typeof setTimeout,
    clearTimeoutFn: clock.clearTimeout as unknown as typeof clearTimeout,
    installSignalHandlers: false,
  });

  for (let i = 0; i < 3; i += 1) {
    clock.runNext();
  }

  assert.equal(runtime.tickCalls, 3);
  assert.equal(clock.delays.includes(8), true);

  handle.stop();
  const beforeStop = runtime.tickCalls;

  clock.runNext();
  assert.equal(runtime.tickCalls, beforeStop);
});

test('startService applies new workflow config on hot reload', async () => {
  const runtime = new FakeRuntime();
  const logger = new CapturingLogger();
  const initial = baseWorkflow(20);
  const reloaded = baseWorkflow(5);
  const loader = new FakeWorkflowLoader(initial);
  const clock = new FakeClock();

  let reloader: FakeReloader | undefined;

  const handle = await startService({ workflowPath: 'WORKFLOW.md' }, {
    workflowLoader: loader,
    logger,
    bootstrap: async () => ({
      workflow: initial,
      runtime,
      logger,
    }),
    reloaderFactory: (options) => {
      reloader = new FakeReloader(options.workflowPath, options.onReload);
      return reloader;
    },
    setTimeoutFn: clock.setTimeout as unknown as typeof setTimeout,
    clearTimeoutFn: clock.clearTimeout as unknown as typeof clearTimeout,
    installSignalHandlers: false,
  });

  clock.runNext();
  assert.equal(runtime.applyCalls, 0);

  reloader!.triggerReload(reloaded);
  assert.equal(runtime.applyCalls, 1);
  assert.ok(runtime.lastAppliedContract);
  assert.equal(runtime.lastAppliedContract?.polling.intervalMs, 5);

  handle.stop();
});

test('runtime.tick errors are logged and service keeps ticking', async () => {
  let failOnce = true;
  const runtime = new FakeRuntime(async () => {
    if (failOnce) {
      failOnce = false;
      throw new Error('boom');
    }
  });
  const logger = new CapturingLogger();
  const workflow = baseWorkflow(5);
  const clock = new FakeClock();

  const handle = await startService({ workflowPath: 'WORKFLOW.md' }, {
    logger,
    bootstrap: async () => ({
      workflow,
      runtime,
      logger,
    }),
    reloaderFactory: ({ onReload }) => ({
      start: () => onReload(workflow),
      stop: () => undefined,
    }),
    setTimeoutFn: clock.setTimeout as unknown as typeof setTimeout,
    clearTimeoutFn: clock.clearTimeout as unknown as typeof clearTimeout,
    installSignalHandlers: false,
  });

  clock.runNext();
  clock.runNext();

  assert.equal(runtime.tickCalls, 2);
  assert.equal(logger.getMessagesFor('runtime.tick.failed').length, 1);

  handle.stop();
});

test('reload interval is clamped to at least 1000ms', async () => {
  const runtime = new FakeRuntime();
  const logger = new CapturingLogger();
  const initial = baseWorkflow(10);
  const reloader = new FakeReloader('WORKFLOW.md', () => undefined);
  const clock = new FakeClock();

  const handle = await startService({ workflowPath: 'WORKFLOW.md' }, {
    logger,
    bootstrap: async () => ({
      workflow: initial,
      runtime,
      logger,
    }),
    reloaderFactory: (options) => {
      return {
        start: (initialContract: LoadedWorkflowContract) => options.onReload(initialContract),
        stop: () => reloader.stop(),
      } as ReloaderLike;
    },
    setTimeoutFn: clock.setTimeout as unknown as typeof setTimeout,
    clearTimeoutFn: clock.clearTimeout as unknown as typeof clearTimeout,
    installSignalHandlers: false,
  });

  // first tick runs at t=0
  clock.runNext();

  // then reload to an interval below the safe minimum
  reloader.triggerReload(baseWorkflow(250));
  assert.equal(clock.nextTimeoutMs, 1000);

  clock.runNext();
  assert.equal(clock.now, 1000);

  handle.stop();
});

test('stop cancels service and invokes reloader stop', async () => {
  const runtime = new FakeRuntime();
  const logger = new CapturingLogger();
  const reloader = new FakeReloader('WORKFLOW.md', () => undefined);
  const clock = new FakeClock();
  const workflow = baseWorkflow(1);

  const handle = await startService({ workflowPath: 'WORKFLOW.md' }, {
    logger,
    bootstrap: async () => ({
      workflow,
      runtime,
      logger,
    }),
    reloaderFactory: () => reloader,
    setTimeoutFn: clock.setTimeout as unknown as typeof setTimeout,
    clearTimeoutFn: clock.clearTimeout as unknown as typeof clearTimeout,
    installSignalHandlers: false,
  });

  const stopMessage = logger.getMessagesFor('service.shutdown_requested');
  assert.equal(stopMessage.length, 0);

  handle.stop();
  assert.equal(reloader.stopCalls, 1);
  assert.equal(stopMessage.length, 1);

  const callsAfterStop = runtime.tickCalls;
  clock.runAll();
  assert.equal(runtime.tickCalls, callsAfterStop);
});
