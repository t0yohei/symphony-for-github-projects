#!/usr/bin/env node
import { JsonConsoleLogger } from './logging/logger.js';
import { bootstrapFromWorkflow, type BootstrapResult } from './bootstrap.js';
import { PollingRuntime } from './orchestrator/runtime.js';
import { FileWorkflowLoader, type LoadedWorkflowContract } from './workflow/contract.js';
import { WorkflowHotReloader } from './workflow/hot-reload.js';
import type { WorkflowLoader } from './workflow/contract.js';
import type { Logger } from './logging/logger.js';
import { startDashboardServer, type DashboardServerHandle } from './dashboard/server.js';

interface ServiceConfig {
  workflowPath: string;
  dashboardPort?: number;
  dashboardHost?: string;
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
  let dashboardPort: number | undefined;
  let dashboardHost: string | undefined;

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];

    if (arg === '--help' || arg === '-h') {
      printUsage();
      process.exit(0);
    }

    if ((arg === '--workflow' || arg === '-w') && i + 1 < argv.length) {
      workflowPath = argv[i + 1];
      i += 1;
      continue;
    }

    if (arg === '--dashboard-port' && i + 1 < argv.length) {
      const value = Number(argv[i + 1]);
      if (!Number.isInteger(value) || value <= 0) {
        throw new Error(`Invalid --dashboard-port value: ${argv[i + 1]}`);
      }
      dashboardPort = value;
      i += 1;
      continue;
    }

    if (arg === '--dashboard-host' && i + 1 < argv.length) {
      dashboardHost = argv[i + 1];
      i += 1;
    }
  }

  return { workflowPath, dashboardPort, dashboardHost };
}

function printUsage(): void {
  // eslint-disable-next-line no-console
  console.log(
    `Usage: node dist/cli.js [--workflow path | -w path] [--dashboard-port <port>] [--dashboard-host <host>]\n` +
      'Starts Symphony-GitHub-Projects runtime loop using the specified WORKFLOW.md.\n' +
      'Use --dashboard-port to serve the local observability dashboard.',
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
  let currentWorkflow = bootstrapResult.workflow;
  let currentPollIntervalMs = bootstrapResult.workflow.polling.intervalMs;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let inFlightTick = false;
  let stopping = false;
  let dashboard: DashboardServerHandle | null = null;

  const tick = async (): Promise<void> => {
    if (stopping) return;
    if (inFlightTick) {
      logger.warn('runtime.tick.skip_in_progress');
      return;
    }

    inFlightTick = true;
    try {
      await runtime.tick();
    } catch (error) {
      logger.error('runtime.tick.failed', {
        error: error instanceof Error ? error.message : String(error),
      });
    } finally {
      inFlightTick = false;
      if (!stopping) {
        scheduleNextTick(currentPollIntervalMs);
      }
    }
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

  const applyWorkflow = (contract: LoadedWorkflowContract): void => {
    try {
      runtime.applyWorkflow(contract);
      currentWorkflow = contract;
      currentPollIntervalMs = Math.max(1_000, contract.polling.intervalMs);
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
    if (dashboard) {
      void dashboard.stop();
      dashboard = null;
    }
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

  if (config.dashboardPort) {
    dashboard = await startDashboardServer({
      host: config.dashboardHost,
      port: config.dashboardPort,
      logger,
      getSnapshot: () => runtime.snapshot(),
      getWorkflow: () => currentWorkflow,
    });
  }

  logger.info('service.started', {
    workflowPath,
    pollIntervalMs: currentPollIntervalMs,
    maxConcurrency: bootstrapResult.workflow.polling.maxConcurrency,
    runtimeKind: bootstrapResult.workflow.tracker.kind,
    dashboardPort: config.dashboardPort,
    dashboardHost: config.dashboardHost,
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
