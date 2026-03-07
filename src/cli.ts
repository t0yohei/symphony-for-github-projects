#!/usr/bin/env node
import { JsonConsoleLogger } from './logging/logger.js';
import { bootstrapFromWorkflow, type BootstrapResult } from './bootstrap.js';
import { PollingRuntime } from './orchestrator/runtime.js';
import { FileWorkflowLoader, type LoadedWorkflowContract } from './workflow/contract.js';
import { WorkflowHotReloader } from './workflow/hot-reload.js';
import type { WorkflowLoader } from './workflow/contract.js';
import type { Logger } from './logging/logger.js';

interface ServiceConfig {
  workflowPath: string;
}

interface ReloaderLike {
  start(initialContract: LoadedWorkflowContract): void;
  stop(): void;
}

interface ServiceDependencies {
  workflowLoader?: WorkflowLoader;
  bootstrap?: (
    workflowPath: string,
    deps: {
      workflowLoader: WorkflowLoader;
      logger: Logger;
    },
  ) => Promise<BootstrapResult>;
  reloaderFactory?: (options: {
    workflowPath: string;
    loader: WorkflowLoader;
    logger: Logger;
    onReload: (contract: LoadedWorkflowContract) => void;
  }) => ReloaderLike;
  logger?: Logger;
  setTimeoutFn?: typeof setTimeout;
  clearTimeoutFn?: typeof clearTimeout;
  installSignalHandlers?: boolean;
}

export interface ServiceHandle {
  stop: () => void;
}

const DEFAULT_WORKFLOW_PATH = 'WORKFLOW.md';

export function parseArgs(argv: string[]): ServiceConfig {
  let workflowPath = process.env.WORKFLOW_PATH ?? DEFAULT_WORKFLOW_PATH;

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];

    if (arg === '--help' || arg === '-h') {
      printUsage();
      process.exit(0);
    }

    if ((arg === '--workflow' || arg === '-w') && i + 1 < argv.length) {
      workflowPath = argv[i + 1];
      i += 1;
    }
  }

  return { workflowPath };
}

function printUsage(): void {
  // eslint-disable-next-line no-console
  console.log(
    `Usage: node dist/cli.js [--workflow path | -w path]\n` +
      'Starts Symphony-GitHub-Projects runtime loop using the specified WORKFLOW.md.',
  );
}

export async function startService(config: ServiceConfig, deps: ServiceDependencies = {}): Promise<ServiceHandle> {
  const logger = deps.logger ?? new JsonConsoleLogger();
  const workflowPath = config.workflowPath;
  const workflowLoader = deps.workflowLoader ?? new FileWorkflowLoader();

  const bootstrap = deps.bootstrap ?? bootstrapFromWorkflow;
  const reloaderFactory =
    deps.reloaderFactory ??
    ((options) => new WorkflowHotReloader(options) as unknown as ReloaderLike);

  const setTimeoutFn = deps.setTimeoutFn ?? setTimeout;
  const clearTimeoutFn = deps.clearTimeoutFn ?? clearTimeout;

  const bootstrapResult = await bootstrap(workflowPath, {
    workflowLoader,
    logger,
  });

  const runtime = bootstrapResult.runtime as PollingRuntime;
  let currentPollIntervalMs = bootstrapResult.workflow.polling.intervalMs;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let stopping = false;

  const tick = (): void => {
    if (stopping) return;
    scheduleNextTick(currentPollIntervalMs);

    void runtime.tick().catch((error) => {
      logger.error('runtime.tick.failed', {
        error: error instanceof Error ? error.message : String(error),
      });
    });
  };

  const scheduleNextTick = (delayMs: number): void => {
    if (stopping) return;

    if (timer !== null) {
      clearTimeoutFn(timer);
      timer = null;
    }

    timer = setTimeoutFn(() => {
      void tick();
    }, Math.max(0, delayMs));
  };

  let bootstrapContractApplied = false;
  const applyWorkflow = (contract: LoadedWorkflowContract): void => {
    try {
      if (!bootstrapContractApplied && contract === bootstrapResult.workflow) {
        bootstrapContractApplied = true;
        return;
      }

      bootstrapContractApplied = true;
      runtime.applyWorkflow(contract);
      const nextPollIntervalMs = Math.max(1_000, contract.polling.intervalMs);
      currentPollIntervalMs = nextPollIntervalMs;
      logger.info('runtime.config.reloaded', {
        pollIntervalMs: currentPollIntervalMs,
        maxConcurrency: contract.polling.maxConcurrency,
        maxConcurrencyRuntime: contract.runtime.maxConcurrency,
      });
      if (!stopping) {
        scheduleNextTick(currentPollIntervalMs);
      }
    } catch (error) {
      logger.error('runtime.config.reload_failed', {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  };

  const reloader = reloaderFactory({
    workflowPath,
    loader: workflowLoader,
    logger,
    onReload: applyWorkflow,
  });

  const stop = (): void => {
    if (stopping) return;
    stopping = true;

    if (timer !== null) {
      clearTimeoutFn(timer);
      timer = null;
    }
    reloader.stop();
    logger.info('service.shutdown_requested');
  };

  const handleShutdown = (): void => {
    stop();
  };

  if (deps.installSignalHandlers !== false) {
    process.on('SIGINT', handleShutdown);
    process.on('SIGTERM', handleShutdown);
  }

  reloader.start(bootstrapResult.workflow);
  logger.info('service.started', {
    workflowPath,
    pollIntervalMs: currentPollIntervalMs,
    maxConcurrency: bootstrapResult.workflow.polling.maxConcurrency,
    runtimeKind: bootstrapResult.workflow.tracker.kind,
  });

  scheduleNextTick(0);

  return { stop };
}

if (process.argv[1]?.endsWith('dist/cli.js')) {
  const config = parseArgs(process.argv.slice(2));
  void startService(config).catch((error) => {
    // eslint-disable-next-line no-console
    console.error(
      JSON.stringify({
        ts: new Date().toISOString(),
        level: 'error',
        message: 'service.bootstrap_failed',
        error: error instanceof Error ? error.message : String(error),
      }),
    );
    process.exitCode = 1;
  });
}

export type { PollingRuntime } from './orchestrator/runtime.js';
