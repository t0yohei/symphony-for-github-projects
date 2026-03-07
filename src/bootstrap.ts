import { JsonConsoleLogger, type Logger } from './logging/logger.js';
import {
  PollingRuntime,
  PreflightValidationError,
  validateRequiredWorkflowFields,
  type OrchestratorRuntime,
} from './orchestrator/runtime.js';
import { GitHubProjectsAdapter, type TrackerAdapter } from './tracker/adapter.js';
import { GraphQLClient } from './tracker/graphql-client.js';
import { GitHubProjectsGraphQLClient } from './tracker/github-projects-client.js';
import { GitHubProjectsWriter, type StatusOptionMapping } from './tracker/github-projects-writer.js';
import {
  FileWorkflowLoader,
  type LoadedWorkflowContract,
  type WorkflowLoader,
} from './workflow/contract.js';
import { WorkspaceManager } from './workspace/manager.js';
import { HookRunner } from './workspace/hooks.js';

export interface BootstrapDependencies {
  workflowLoader?: WorkflowLoader;
  trackerAdapter?: TrackerAdapter;
  logger?: Logger;
  /** Skip startup terminal-workspace cleanup pass (useful for tests). */
  skipStartupCleanup?: boolean;
}

export interface BootstrapResult {
  workflow: LoadedWorkflowContract;
  runtime: OrchestratorRuntime;
  logger: Logger;
}

export class BootstrapConfigurationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BootstrapConfigurationError';
  }
}

export interface StartupCleanupResult {
  cleaned: number;
  skipped: number;
  fetchFailed: boolean;
}

/**
 * Performs a terminal-workspace cleanup pass at startup.
 *
 * Fetches items in terminal states (done by default) from the tracker,
 * resolves each item's workspace path by its sanitized identifier, and
 * removes the directory safely within the workspace root.
 *
 * Fetch failures are non-fatal: they are logged as warnings and the
 * function returns without throwing.
 */
export async function performStartupTerminalCleanup(
  tracker: TrackerAdapter,
  workspaceRoot: string,
  logger: Logger,
  terminalStates: string[] = ['done'],
): Promise<StartupCleanupResult> {
  const manager = new WorkspaceManager({ workspaceRoot });

  let items;
  try {
    items = await tracker.listItemsByStates(terminalStates as import('./model/work-item.js').WorkItemState[]);
  } catch (err) {
    logger.warn('bootstrap.startup_cleanup.fetch_failed', {
      error: err instanceof Error ? err.message : String(err),
      workspaceRoot,
    });
    return { cleaned: 0, skipped: 0, fetchFailed: true };
  }

  let cleaned = 0;
  let skipped = 0;

  for (const item of items) {
    if (!item.identifier) {
      skipped += 1;
      continue;
    }
    let workspacePath: string;
    try {
      const key = manager.toWorkspaceKey(item.identifier);
      workspacePath = manager.resolveWorkspacePath(key);
    } catch {
      skipped += 1;
      continue;
    }

    try {
      await manager.cleanupWorkspace(workspacePath);
      cleaned += 1;
    } catch {
      skipped += 1;
    }
  }

  logger.info('bootstrap.startup_cleanup.done', {
    cleaned,
    skipped,
    terminalStates,
    workspaceRoot,
  });

  return { cleaned, skipped, fetchFailed: false };
}

export async function bootstrapFromWorkflow(
  workflowPath: string,
  deps: BootstrapDependencies = {},
): Promise<BootstrapResult> {
  const workflowLoader = deps.workflowLoader ?? new FileWorkflowLoader();
  const logger = deps.logger ?? new JsonConsoleLogger();

  const workflow = await workflowLoader.load(workflowPath);

  // Validate required config fields at startup; surface structured errors before any I/O.
  // Skip when a custom trackerAdapter is injected (test/override path).
  if (!deps.trackerAdapter) {
    try {
      validateRequiredWorkflowFields(workflow);
    } catch (err) {
      if (err instanceof PreflightValidationError) {
        throw new BootstrapConfigurationError(`${err.failingKey}: ${err.message}`);
      }
      throw err;
    }
  }

  const tracker = deps.trackerAdapter ?? createTrackerFromWorkflow(workflow);

  // Perform terminal-workspace cleanup before starting the scheduling loop.
  // Uses the workspace root from workflow config; skipped when root is unset or
  // explicitly opted out via deps.skipStartupCleanup.
  const workspaceRoot = workflow.workspace.root ?? workflow.workspace.baseDir;
  if (!workspaceRoot) {
    throw new BootstrapConfigurationError('workflow.workspace.root is required');
  }

  if (!deps.skipStartupCleanup) {
    await performStartupTerminalCleanup(tracker, workspaceRoot, logger);
  }

  const workspaceManager = new WorkspaceManager({
    workspaceRoot,
    hooks:
      workflow.hooks ||
      undefined
        ? new HookRunner({
            hooks: {
              after_create:
                workflow.hooks?.after_create ?? workflow.hooks?.onStart,
              before_run: workflow.hooks?.before_run,
              after_run: workflow.hooks?.after_run ?? workflow.hooks?.onSuccess,
              before_remove: workflow.hooks?.before_remove,
            },
            timeoutMs: workflow.agent.timeouts?.hooksTimeoutMs,
            logger,
          })
        : undefined,
  });

  const runtime = new PollingRuntime(tracker, workflow, logger, {
    workspaceManager,
    continuationRetryDelayMs: workflow.runtime.retry?.continuationDelayMs,
    failureRetryBaseDelayMs: workflow.runtime.retry?.failureBaseDelayMs,
    failureRetryMultiplier: workflow.runtime.retry?.failureMultiplier,
    maxRetryBackoffMs: workflow.runtime.retry?.failureMaxDelayMs,
  });

  logger.info('bootstrap.ready', {
    workflowPath,
    tracker: workflow.tracker.kind,
    maxConcurrency: workflow.polling.maxConcurrency ?? 1,
    pollIntervalMs: workflow.polling.intervalMs,
  });

  return {
    workflow,
    runtime,
    logger,
  };
}

function createTrackerFromWorkflow(workflow: LoadedWorkflowContract): TrackerAdapter {
  const { owner, projectNumber, tokenEnv } = workflow.tracker.github;
  const token = process.env[tokenEnv]?.trim();

  if (!token) {
    throw new BootstrapConfigurationError(
      `Missing tracker auth token environment variable: ${tokenEnv}`,
    );
  }

  const graphQLClient = new GraphQLClient({ token });
  const projectsClient = new GitHubProjectsGraphQLClient(graphQLClient);
  const statusOptions = resolveStatusOptions(workflow);

  const writer = new GitHubProjectsWriter({
    projectId: `owner:${owner}#${projectNumber}`,
    graphqlClient: {
      query: async <T>(queryString: string, variables?: Record<string, unknown>) => {
        if (queryString.includes('query($projectId: ID!)') && variables?.projectId === `owner:${owner}#${projectNumber}`) {
          const resolvedProjectId = await resolveProjectId(graphQLClient, owner, projectNumber);
          return graphQLClient.query<T>(queryString, {
            ...(variables ?? {}),
            projectId: resolvedProjectId,
          });
        }
        return graphQLClient.query<T>(queryString, variables);
      },
    },
    statusOptions,
  });

  return new GitHubProjectsAdapter({
    owner,
    projectNumber,
    client: projectsClient,
    writer,
    activeStates: resolveActiveStates(workflow),
  });
}

function resolveStatusOptions(workflow: LoadedWorkflowContract): Partial<StatusOptionMapping> | undefined {
  const raw = (workflow.extensions?.github_projects as Record<string, unknown> | undefined)?.status_options;
  if (!raw || typeof raw !== 'object') {
    return undefined;
  }

  const statusOptionsRecord = raw as Record<string, unknown>;
  const inProgress = typeof statusOptionsRecord.in_progress === 'string' ? statusOptionsRecord.in_progress : undefined;
  const done = typeof statusOptionsRecord.done === 'string' ? statusOptionsRecord.done : undefined;

  if (!inProgress && !done) {
    return undefined;
  }

  return {
    inProgress,
    done,
  };
}

function resolveActiveStates(workflow: LoadedWorkflowContract): string[] | undefined {
  const raw = (workflow.extensions?.github_projects as Record<string, unknown> | undefined)?.active_states;
  if (!Array.isArray(raw)) {
    return undefined;
  }

  const values = raw
    .filter((value): value is string => typeof value === 'string')
    .map((value) => value.trim().toLowerCase())
    .filter((value) => value.length > 0);

  return values.length > 0 ? values : undefined;
}

const projectIdCache = new Map<string, string>();

async function resolveProjectId(client: GraphQLClient, owner: string, projectNumber: number): Promise<string> {
  const key = `${owner}#${projectNumber}`;
  const cached = projectIdCache.get(key);
  if (cached) {
    return cached;
  }

  const data = await client.query<{
    user?: { projectV2?: { id?: string | null } | null } | null;
    organization?: { projectV2?: { id?: string | null } | null } | null;
  }>(
    `query($owner: String!, $number: Int!) {
      user(login: $owner) { projectV2(number: $number) { id } }
      organization(login: $owner) { projectV2(number: $number) { id } }
    }`,
    { owner, number: projectNumber },
  );

  const projectId = data.user?.projectV2?.id ?? data.organization?.projectV2?.id;
  if (!projectId) {
    throw new BootstrapConfigurationError(`GitHub Project not found: ${owner}#${projectNumber}`);
  }

  projectIdCache.set(key, projectId);
  return projectId;
}
