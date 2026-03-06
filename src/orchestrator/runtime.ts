import type { Logger } from "../logging/logger.js";
import type { NormalizedWorkItem } from "../model/work-item.js";
import type { TrackerAdapter } from "../tracker/adapter.js";
import type { WorkflowContract } from "../workflow/contract.js";

export interface OrchestratorRuntime {
  tick(): Promise<void>;
}

export interface RuntimeMetrics {
  ticks: number;
  dispatched: number;
  dispatchFailures: number;
  reconciledDroppedClaims: number;
  reconciledDroppedRunning: number;
}

export interface RuntimeStateSnapshot {
  claimed: string[];
  running: string[];
  retryAttempts: Record<string, number>;
  metrics: RuntimeMetrics;
}

type RuntimeItemState = "idle" | "claimed" | "running";
type RuntimeEvent =
  | "claim"
  | "dispatchSucceeded"
  | "dispatchFailed"
  | "reconcileLostEligibility";

export class PollingRuntime implements OrchestratorRuntime {
  private readonly itemStates = new Map<string, RuntimeItemState>();
  private readonly claimed = new Set<string>();
  private readonly running = new Set<string>();
  private readonly retryAttempts = new Map<string, number>();
  private readonly metrics: RuntimeMetrics = {
    ticks: 0,
    dispatched: 0,
    dispatchFailures: 0,
    reconciledDroppedClaims: 0,
    reconciledDroppedRunning: 0,
  };

  constructor(
    private readonly tracker: TrackerAdapter,
    private readonly workflow: WorkflowContract,
    private readonly logger: Logger,
  ) {}

  async tick(): Promise<void> {
    this.metrics.ticks += 1;

    const eligible = await this.tracker.listEligibleItems();
    this.reconcile(eligible);

    const maxConcurrency = this.workflow.polling.maxConcurrency ?? 1;
    const slots = Math.max(0, maxConcurrency - this.running.size);
    const candidates = eligible.filter(
      (item) => !this.running.has(item.id) && !this.claimed.has(item.id),
    );
    const selected = candidates.slice(0, slots);

    for (const item of selected) {
      await this.dispatch(item);
    }

    this.logger.info("runtime.tick", {
      eligibleCount: eligible.length,
      claimedCount: this.claimed.size,
      runningCount: this.running.size,
      selectedCount: selected.length,
      slots,
      maxConcurrency,
      metrics: this.metrics,
    });
  }

  getStateSnapshot(): RuntimeStateSnapshot {
    return {
      claimed: [...this.claimed],
      running: [...this.running],
      retryAttempts: Object.fromEntries(this.retryAttempts.entries()),
      metrics: { ...this.metrics },
    };
  }

  private reconcile(eligible: NormalizedWorkItem[]): void {
    const eligibleIds = new Set(eligible.map((item) => item.id));

    for (const itemId of [...this.claimed]) {
      if (!eligibleIds.has(itemId)) {
        this.transition(itemId, "reconcileLostEligibility");
        this.metrics.reconciledDroppedClaims += 1;
      }
    }

    for (const itemId of [...this.running]) {
      if (!eligibleIds.has(itemId)) {
        this.transition(itemId, "reconcileLostEligibility");
        this.metrics.reconciledDroppedRunning += 1;
      }
    }
  }

  private async dispatch(item: NormalizedWorkItem): Promise<void> {
    this.transition(item.id, "claim");

    try {
      await this.tracker.markInProgress(item.id);
      this.transition(item.id, "dispatchSucceeded");
      this.metrics.dispatched += 1;
    } catch (error) {
      this.transition(item.id, "dispatchFailed");
      this.retryAttempts.set(item.id, (this.retryAttempts.get(item.id) ?? 0) + 1);
      this.metrics.dispatchFailures += 1;
      this.logger.error("runtime.dispatch_failed", {
        itemId: item.id,
        error: error instanceof Error ? error.message : String(error),
        retryAttempts: this.retryAttempts.get(item.id),
      });
    }
  }

  private transition(itemId: string, event: RuntimeEvent): void {
    const current = this.itemStates.get(itemId) ?? "idle";

    if (event === "claim") {
      if (current !== "idle") {
        return;
      }
      this.itemStates.set(itemId, "claimed");
      this.claimed.add(itemId);
      return;
    }

    if (event === "dispatchSucceeded") {
      if (current !== "claimed") {
        return;
      }
      this.itemStates.set(itemId, "running");
      this.claimed.delete(itemId);
      this.running.add(itemId);
      return;
    }

    if (event === "dispatchFailed") {
      if (current !== "claimed") {
        return;
      }
      this.itemStates.set(itemId, "idle");
      this.claimed.delete(itemId);
      this.running.delete(itemId);
      return;
    }

    if (event === "reconcileLostEligibility") {
      this.itemStates.set(itemId, "idle");
      this.claimed.delete(itemId);
      this.running.delete(itemId);
    }
  }
}
