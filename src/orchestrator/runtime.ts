import type { Logger } from "../logging/logger.js";
import type { NormalizedWorkItem } from "../model/work-item.js";
import type { TrackerAdapter } from "../tracker/adapter.js";
import type { WorkflowContract } from "../workflow/contract.js";

export interface OrchestratorRuntime {
  tick(): Promise<void>;
}

type ActiveStatus = "claimed" | "running";

interface ItemRuntimeState {
  item: NormalizedWorkItem;
  status: ActiveStatus | "waiting_retry";
  attempts: number;
  nextAttemptAt?: number;
  lastError?: string;
}

export interface PollingRuntimeOptions {
  maxRetryAttempts?: number;
  baseRetryDelayMs?: number;
  now?: () => number;
}

export class PollingRuntime implements OrchestratorRuntime {
  private readonly states = new Map<string, ItemRuntimeState>();
  private readonly maxRetryAttempts: number;
  private readonly baseRetryDelayMs: number;
  private readonly now: () => number;

  constructor(
    private readonly tracker: TrackerAdapter,
    private readonly workflow: WorkflowContract,
    private readonly logger: Logger,
    options: PollingRuntimeOptions = {},
  ) {
    this.maxRetryAttempts = options.maxRetryAttempts ?? 3;
    this.baseRetryDelayMs = options.baseRetryDelayMs ?? 1000;
    this.now = options.now ?? (() => Date.now());
  }

  async tick(): Promise<void> {
    const items = await this.tracker.listEligibleItems();
    const eligibleById = new Map(items.map((item) => [item.id, item]));

    this.releaseIneligibleItems(eligibleById);

    const maxConcurrency = this.workflow.polling.maxConcurrency ?? 1;
    const activeCount = this.countActive();
    const freeSlots = Math.max(maxConcurrency - activeCount, 0);

    const selected = items
      .filter((item) => this.canAttempt(item.id))
      .slice(0, freeSlots);

    for (const item of selected) {
      await this.claimItem(item);
    }

    this.logger.info("runtime.tick", {
      eligibleCount: items.length,
      activeCount,
      selectedCount: selected.length,
      freeSlots,
      maxConcurrency,
    });
  }

  markRunning(itemId: string): void {
    const state = this.states.get(itemId);
    if (!state) {
      return;
    }

    state.status = "running";
    state.nextAttemptAt = undefined;
    this.states.set(itemId, state);
  }

  async markDone(itemId: string): Promise<void> {
    const state = this.states.get(itemId);
    if (!state) {
      return;
    }

    await this.tracker.markDone(itemId);
    this.states.delete(itemId);
    this.logger.info("runtime.item.done", { itemId });
  }

  failActiveItem(itemId: string, reason: string): void {
    const state = this.states.get(itemId);
    if (!state) {
      return;
    }

    this.scheduleRetry(state, reason);
  }

  // test/diagnostic helper
  getItemState(itemId: string): Readonly<ItemRuntimeState> | undefined {
    const state = this.states.get(itemId);
    return state ? { ...state } : undefined;
  }

  private releaseIneligibleItems(eligibleById: Map<string, NormalizedWorkItem>): void {
    for (const [itemId, state] of this.states.entries()) {
      if (eligibleById.has(itemId)) {
        continue;
      }

      this.states.delete(itemId);
      this.logger.warn("runtime.item.stopped_ineligible", {
        itemId,
        previousStatus: state.status,
      });
    }
  }

  private countActive(): number {
    let count = 0;
    for (const state of this.states.values()) {
      if (state.status === "claimed" || state.status === "running") {
        count += 1;
      }
    }
    return count;
  }

  private canAttempt(itemId: string): boolean {
    const state = this.states.get(itemId);
    if (!state) {
      return true;
    }

    if (state.status === "claimed" || state.status === "running") {
      return false;
    }

    if (state.attempts >= this.maxRetryAttempts) {
      return false;
    }

    return this.now() >= (state.nextAttemptAt ?? 0);
  }

  private async claimItem(item: NormalizedWorkItem): Promise<void> {
    const previous = this.states.get(item.id);
    this.states.set(item.id, {
      item,
      status: "claimed",
      attempts: previous?.attempts ?? 0,
    });

    try {
      await this.tracker.markInProgress(item.id);
      this.logger.info("runtime.item.claimed", {
        itemId: item.id,
        attempts: previous?.attempts ?? 0,
      });
    } catch (error) {
      const state = this.states.get(item.id);
      if (!state) {
        return;
      }
      this.scheduleRetry(state, this.errorMessage(error));
    }
  }

  private scheduleRetry(state: ItemRuntimeState, reason: string): void {
    const attempts = state.attempts + 1;

    if (attempts >= this.maxRetryAttempts) {
      this.states.delete(state.item.id);
      this.logger.error("runtime.item.retry_exhausted", {
        itemId: state.item.id,
        attempts,
        reason,
      });
      return;
    }

    const delayMs = this.backoffDelayMs(attempts);
    const nextAttemptAt = this.now() + delayMs;

    this.states.set(state.item.id, {
      ...state,
      attempts,
      status: "waiting_retry",
      nextAttemptAt,
      lastError: reason,
    });

    this.logger.warn("runtime.item.retry_scheduled", {
      itemId: state.item.id,
      attempts,
      nextAttemptAt: new Date(nextAttemptAt).toISOString(),
      delayMs,
      reason,
    });
  }

  private backoffDelayMs(attemptNumber: number): number {
    return this.baseRetryDelayMs * 2 ** (attemptNumber - 1);
  }

  private errorMessage(error: unknown): string {
    if (error instanceof Error) {
      return error.message;
    }
    return String(error);
  }
}
