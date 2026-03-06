import { watch, type FSWatcher } from 'node:fs';
import type { Logger } from '../logging/logger.js';
import type { LoadedWorkflowContract, WorkflowLoader } from './contract.js';

export interface HotReloadOptions {
  workflowPath: string;
  loader: WorkflowLoader;
  logger: Logger;
  debounceMs?: number;
  onReload: (contract: LoadedWorkflowContract) => void;
  watch?: WatchFn;
}

type WatchFn = (path: string, callback: (eventType: string) => void) => { close: () => void };

const DEFAULT_DEBOUNCE_MS = 500;

export class WorkflowHotReloader {
  private readonly workflowPath: string;
  private readonly loader: WorkflowLoader;
  private readonly logger: Logger;
  private readonly debounceMs: number;
  private readonly onReload: (contract: LoadedWorkflowContract) => void;
  private readonly watchFn: WatchFn;

  private watcher: { close: () => void } | null = null;
  private debounceTimer: ReturnType<typeof setTimeout> | null = null;
  private lastGoodContract: LoadedWorkflowContract | null = null;

  constructor(options: HotReloadOptions) {
    this.workflowPath = options.workflowPath;
    this.loader = options.loader;
    this.logger = options.logger;
    this.debounceMs = options.debounceMs ?? DEFAULT_DEBOUNCE_MS;
    this.onReload = options.onReload;
    this.watchFn =
      options.watch ??
      ((path, cb) => {
        const w: FSWatcher = watch(path, (eventType) => cb(eventType));
        return { close: () => w.close() };
      });
  }

  start(initialContract: LoadedWorkflowContract): void {
    this.lastGoodContract = initialContract;

    this.watcher = this.watchFn(this.workflowPath, (_eventType) => {
      this.scheduleReload();
    });

    this.logger.info('hot-reload.watching', { path: this.workflowPath });
  }

  stop(): void {
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
      this.debounceTimer = null;
    }
    if (this.watcher) {
      this.watcher.close();
      this.watcher = null;
    }
    this.logger.info('hot-reload.stopped');
  }

  private scheduleReload(): void {
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
    }
    this.debounceTimer = setTimeout(() => {
      void this.reload();
    }, this.debounceMs);
  }

  private async reload(): Promise<void> {
    this.logger.info('hot-reload.reloading', { path: this.workflowPath });

    try {
      const contract = await this.loader.load(this.workflowPath);
      this.lastGoodContract = contract;
      this.onReload(contract);
      this.logger.info('hot-reload.applied', {
        intervalMs: contract.polling.intervalMs,
        maxConcurrency: contract.polling.maxConcurrency,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.logger.error('hot-reload.invalid', {
        error: message,
        keepingPrevious: true,
      });
    }
  }

  getLastGoodContract(): LoadedWorkflowContract | null {
    return this.lastGoodContract;
  }
}
