import { JsonConsoleLogger, type Logger } from "./logging/logger.js";
import { PollingRuntime, type OrchestratorRuntime } from "./orchestrator/runtime.js";
import { GitHubProjectsAdapterPlaceholder, type TrackerAdapter } from "./tracker/adapter.js";
import {
  NotImplementedWorkflowLoader,
  type WorkflowContract,
  type WorkflowLoader,
} from "./workflow/contract.js";

export interface BootstrapDependencies {
  workflowLoader?: WorkflowLoader;
  trackerAdapter?: TrackerAdapter;
  logger?: Logger;
}

export interface BootstrapResult {
  workflow: WorkflowContract;
  runtime: OrchestratorRuntime;
  logger: Logger;
}

export async function bootstrapFromWorkflow(
  workflowPath: string,
  deps: BootstrapDependencies = {},
): Promise<BootstrapResult> {
  const workflowLoader = deps.workflowLoader ?? new NotImplementedWorkflowLoader();
  const tracker = deps.trackerAdapter ?? new GitHubProjectsAdapterPlaceholder();
  const logger = deps.logger ?? new JsonConsoleLogger();

  const workflow = await workflowLoader.load(workflowPath);
  const runtime = new PollingRuntime(tracker, workflow, logger);

  logger.info("bootstrap.ready", {
    workflowPath,
    tracker: "github-projects",
    maxConcurrency: workflow.maxConcurrency,
    pollIntervalMs: workflow.pollIntervalMs,
  });

  return {
    workflow,
    runtime,
    logger,
  };
}
