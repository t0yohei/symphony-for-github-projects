import type { Logger } from "../logging/logger.js";
import type { TrackerAdapter } from "../tracker/adapter.js";
import type { WorkflowContract } from "../workflow/contract.js";

export interface OrchestratorRuntime {
  tick(): Promise<void>;
}

export class PollingRuntime implements OrchestratorRuntime {
  constructor(
    private readonly tracker: TrackerAdapter,
    private readonly workflow: WorkflowContract,
    private readonly logger: Logger,
  ) {}

  async tick(): Promise<void> {
    const items = await this.tracker.listEligibleItems();
    const maxConcurrency = this.workflow.polling.maxConcurrency ?? 1;
    const selected = items.slice(0, maxConcurrency);
    this.logger.info("runtime.tick", {
      eligibleCount: items.length,
      selectedCount: selected.length,
      maxConcurrency,
    });
  }
}
