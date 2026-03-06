import type { Logger } from '../logging/logger.js';
import type { NormalizedWorkItem } from '../model/work-item.js';
import type { TrackerAdapter } from '../tracker/adapter.js';
import type { WorkflowContract } from '../workflow/contract.js';

export interface OrchestratorRuntime {
  tick(): Promise<void>;
}

export interface RuntimeStateSnapshot {
  running: string[];
  claimed: string[];
  retryAttempts: Record<string, number>;
  completed: string[];
}

interface RunningEntry {
  item: NormalizedWorkItem;
  startedAt: number;
  lastEventAt: number;
}

interface RetryEntry {
  issueId: string;
  identifier: string;
  item: NormalizedWorkItem;
  attempt: number;
  dueAt: number;
  timer?: ReturnType<typeof setTimeout>;
  error?: string;
  kind: 'continuation' | 'failure';
}

export interface PollingRuntimeOptions {
  now?: () => number;
  stallTimeoutMs?: number;
  continuationRetryDelayMs?: number;
  failureRetryBaseDelayMs?: number;
  failureRetryMultiplier?: number;
  failureRetryMaxDelayMs?: number;
}

const DEFAULT_STALL_TIMEOUT_MS = 5 * 60 * 1000;
const DEFAULT_CONTINUATION_RETRY_DELAY_MS = 1_000;
const DEFAULT_FAILURE_RETRY_BASE_DELAY_MS = 1_000;
const DEFAULT_FAILURE_RETRY_MULTIPLIER = 2;
const DEFAULT_FAILURE_RETRY_MAX_DELAY_MS = 60_000;

export class PollingRuntime implements OrchestratorRuntime {
  private readonly running = new Map<string, RunningEntry>();
  private readonly claimed = new Set<string>();
  private readonly retry = new Map<string, RetryEntry>();
  private readonly completed = new Set<string>();
  private readonly now: () => number;
  private readonly stallTimeoutMs: number;
  private readonly continuationRetryDelayMs: number;
  private readonly failureRetryBaseDelayMs: number;
  private readonly failureRetryMultiplier: number;
  private readonly failureRetryMaxDelayMs: number;

  constructor(
    private readonly tracker: TrackerAdapter,
    private readonly workflow: WorkflowContract,
    private readonly logger: Logger,
    options: PollingRuntimeOptions = {},
  ) {
    this.now = options.now ?? (() => Date.now());
    this.stallTimeoutMs = options.stallTimeoutMs ?? DEFAULT_STALL_TIMEOUT_MS;
    this.continuationRetryDelayMs =
      options.continuationRetryDelayMs ?? DEFAULT_CONTINUATION_RETRY_DELAY_MS;
    this.failureRetryBaseDelayMs =
      options.failureRetryBaseDelayMs ?? DEFAULT_FAILURE_RETRY_BASE_DELAY_MS;
    this.failureRetryMultiplier = options.failureRetryMultiplier ?? DEFAULT_FAILURE_RETRY_MULTIPLIER;
    this.failureRetryMaxDelayMs = options.failureRetryMaxDelayMs ?? DEFAULT_FAILURE_RETRY_MAX_DELAY_MS;
  }

  async tick(): Promise<void> {
    await this.reconcile();
    await this.fireDueRetries();

    const maxConcurrency = this.resolveMaxConcurrency();
    if (maxConcurrency <= 0) {
      this.logger.warn('runtime.preflight.invalid_concurrency', {
        maxConcurrency: this.workflow.polling.maxConcurrency,
      });
      return;
    }

    const candidates = await this.tracker.listEligibleItems();
    const sorted = sortCandidates(candidates);
    const dispatchable = sorted.filter((item) => this.isDispatchable(item.id));

    let dispatched = 0;
    const capacity = Math.max(0, maxConcurrency - this.running.size);
    for (const item of dispatchable.slice(0, capacity)) {
      const ok = await this.dispatch(item);
      if (ok) {
        dispatched += 1;
      }
    }

    this.logger.info('runtime.tick', {
      issue_id: undefined,
      issue_identifier: undefined,
      eligibleCount: candidates.length,
      dispatchableCount: dispatchable.length,
      dispatched,
      runningCount: this.running.size,
      claimedCount: this.claimed.size,
      retryCount: this.retry.size,
      completedCount: this.completed.size,
      maxConcurrency,
    });
  }

  markActivity(itemId: string): void {
    const running = this.running.get(itemId);
    if (!running) return;
    running.lastEventAt = this.now();
  }

  async handleWorkerExit(itemId: string, result: 'completed' | 'failed'): Promise<void> {
    const entry = this.running.get(itemId);
    if (!entry) return;

    this.running.delete(itemId);
    this.claimed.delete(itemId);

    if (result === 'completed') {
      const states = await this.tracker.getStatesByIds([itemId]);
      if (states[itemId] === 'done') {
        this.completed.add(itemId);
        this.clearRetry(itemId);
        this.logger.info('runtime.transition.completed', {
          issue_id: entry.item.id,
          issue_identifier: entry.item.identifier,
        });
        return;
      }

      this.scheduleRetry(entry.item, 'continuation', 'worker_exit_completed');
      return;
    }

    this.scheduleRetry(entry.item, 'failure', 'worker_exit_failed');
  }

  snapshot(): RuntimeStateSnapshot {
    const retryAttempts: Record<string, number> = {};
    for (const [id, entry] of this.retry.entries()) {
      retryAttempts[id] = entry.attempt;
    }

    return {
      running: [...this.running.keys()],
      claimed: [...this.claimed],
      retryAttempts,
      completed: [...this.completed],
    };
  }

  private async reconcile(): Promise<void> {
    const now = this.now();
    const runningIds = [...this.running.keys()];
    if (runningIds.length === 0) {
      return;
    }

    for (const [itemId, entry] of this.running.entries()) {
      if (now - entry.lastEventAt > this.stallTimeoutMs) {
        this.running.delete(itemId);
        this.claimed.delete(itemId);
        this.scheduleRetry(entry.item, 'failure', 'stalled');
      }
    }

    const activeIds = [...this.running.keys()];
    if (activeIds.length === 0) {
      return;
    }

    const trackerStates = await this.tracker.getStatesByIds(activeIds);
    for (const itemId of activeIds) {
      const entry = this.running.get(itemId);
      if (!entry) continue;

      const state = trackerStates[itemId];
      if (!state) {
        this.running.delete(itemId);
        this.claimed.delete(itemId);
        this.scheduleRetry(entry.item, 'failure', 'state_missing');
        continue;
      }

      if (state === 'done') {
        this.running.delete(itemId);
        this.claimed.delete(itemId);
        this.completed.add(itemId);
        this.clearRetry(itemId);
        this.logger.info('runtime.transition.reconcile_done', {
          issue_id: entry.item.id,
          issue_identifier: entry.item.identifier,
        });
        continue;
      }

      if (state !== 'in_progress') {
        this.running.delete(itemId);
        this.claimed.delete(itemId);
        this.scheduleRetry(entry.item, 'failure', `state_${state}`);
      }
    }
  }

  private async fireDueRetries(): Promise<void> {
    const dueEntries = [...this.retry.values()]
      .filter((entry) => this.now() >= entry.dueAt)
      .sort((a, b) => a.dueAt - b.dueAt);

    for (const entry of dueEntries) {
      await this.onRetryFire(entry.issueId);
    }
  }

  private async onRetryFire(itemId: string): Promise<void> {
    const entry = this.retry.get(itemId);
    if (!entry) return;

    if (this.completed.has(itemId) || this.running.has(itemId)) {
      this.clearRetry(itemId);
      return;
    }

    const eligible = await this.findEligibleItem(itemId);
    if (!eligible) {
      this.claimed.delete(itemId);
      this.clearRetry(itemId);
      return;
    }

    const maxConcurrency = this.resolveMaxConcurrency();
    const capacity = Math.max(0, maxConcurrency - this.running.size);
    if (capacity <= 0) {
      this.claimed.delete(itemId);
      this.scheduleRetry(eligible, 'continuation', 'retry_fire_no_slot');
      return;
    }

    await this.dispatch(eligible);
  }

  private async findEligibleItem(itemId: string): Promise<NormalizedWorkItem | undefined> {
    const candidates = await this.tracker.listEligibleItems();
    return candidates.find((item) => item.id === itemId);
  }

  private async dispatch(item: NormalizedWorkItem): Promise<boolean> {
    if (this.claimed.has(item.id) || this.running.has(item.id)) {
      return false;
    }

    this.claimed.add(item.id);
    this.logger.info('runtime.transition.claimed', {
      issue_id: item.id,
      issue_identifier: item.identifier,
    });

    try {
      await this.tracker.markInProgress(item.id);
      const now = this.now();
      this.running.set(item.id, {
        item,
        startedAt: now,
        lastEventAt: now,
      });
      this.clearRetry(item.id);
      this.logger.info('runtime.transition.running', {
        issue_id: item.id,
        issue_identifier: item.identifier,
      });
      return true;
    } catch (err) {
      this.claimed.delete(item.id);
      this.scheduleRetry(item, 'failure', 'claim_failed', err instanceof Error ? err.message : String(err));
      this.logger.warn('runtime.transition.claim_failed', {
        issue_id: item.id,
        issue_identifier: item.identifier,
        error: err instanceof Error ? err.message : String(err),
      });
      return false;
    }
  }

  private scheduleRetry(
    item: NormalizedWorkItem,
    kind: 'continuation' | 'failure',
    reason: string,
    error?: string,
  ): void {
    const itemId = item.id;
    const current = this.retry.get(itemId);
    if (current?.timer) {
      clearTimeout(current.timer);
    }

    const attempt = (current?.attempt ?? 0) + 1;
    const delay =
      kind === 'continuation'
        ? this.continuationRetryDelayMs
        : Math.min(
            this.failureRetryMaxDelayMs,
            Math.floor(this.failureRetryBaseDelayMs * this.failureRetryMultiplier ** Math.max(0, attempt - 1)),
          );

    const dueAt = this.now() + delay;
    const next: RetryEntry = {
      issueId: item.id,
      identifier: item.identifier ?? `#${item.number ?? item.id}`,
      item,
      attempt,
      dueAt,
      timer: setTimeout(() => {
        void this.onRetryFire(item.id);
      }, delay),
      error,
      kind,
    };

    this.retry.set(itemId, next);
    this.logger.info('runtime.transition.retry', {
      issue_id: next.issueId,
      issue_identifier: next.identifier,
      reason,
      retry_attempt: next.attempt,
      due_at: new Date(next.dueAt).toISOString(),
      nextEligibleInMs: delay,
      kind,
      error,
    });
  }

  private clearRetry(itemId: string): void {
    const existing = this.retry.get(itemId);
    if (existing?.timer) {
      clearTimeout(existing.timer);
    }
    this.retry.delete(itemId);
  }

  private isDispatchable(itemId: string): boolean {
    if (this.completed.has(itemId)) return false;
    if (this.claimed.has(itemId)) return false;
    if (this.running.has(itemId)) return false;

    const retry = this.retry.get(itemId);
    if (!retry) return true;
    return this.now() >= retry.dueAt;
  }

  private resolveMaxConcurrency(): number {
    const configured = this.workflow.polling.maxConcurrency;
    if (typeof configured !== 'number' || !Number.isFinite(configured)) {
      return 1;
    }
    return Math.max(0, Math.floor(configured));
  }
}

function sortCandidates(items: NormalizedWorkItem[]): NormalizedWorkItem[] {
  return [...items].sort((a, b) => {
    const pa = a.priority ?? Number.MAX_SAFE_INTEGER;
    const pb = b.priority ?? Number.MAX_SAFE_INTEGER;
    if (pa !== pb) return pa - pb;

    const ua = Date.parse(a.updated_at ?? a.updatedAt ?? '');
    const ub = Date.parse(b.updated_at ?? b.updatedAt ?? '');
    const uaSafe = Number.isNaN(ua) ? Number.MAX_SAFE_INTEGER : ua;
    const ubSafe = Number.isNaN(ub) ? Number.MAX_SAFE_INTEGER : ub;
    if (uaSafe !== ubSafe) return uaSafe - ubSafe;

    return (a.number ?? Number.MAX_SAFE_INTEGER) - (b.number ?? Number.MAX_SAFE_INTEGER);
  });
}
