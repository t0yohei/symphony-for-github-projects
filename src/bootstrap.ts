import { JsonConsoleLogger, type Logger } from './logging/logger.js';
import { PollingRuntime, type OrchestratorRuntime } from './orchestrator/runtime.js';
import { GitHubProjectsAdapter, type TrackerAdapter } from './tracker/adapter.js';
import { GraphQLClient } from './tracker/graphql-client.js';
import { GitHubProjectsGraphQLClient } from './tracker/github-projects-client.js';
import { GitHubProjectsWriter, type StatusOptionMapping } from './tracker/github-projects-writer.js';
import {
  FileWorkflowLoader,
  type LoadedWorkflowContract,
  type WorkflowLoader,
} from './workflow/contract.js';

export interface BootstrapDependencies {
  workflowLoader?: WorkflowLoader;
  trackerAdapter?: TrackerAdapter;
  logger?: Logger;
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

export async function bootstrapFromWorkflow(
  workflowPath: string,
  deps: BootstrapDependencies = {},
): Promise<BootstrapResult> {
  const workflowLoader = deps.workflowLoader ?? new FileWorkflowLoader();
  const logger = deps.logger ?? new JsonConsoleLogger();

  const workflow = await workflowLoader.load(workflowPath);
  const tracker = deps.trackerAdapter ?? createTrackerFromWorkflow(workflow);
  const runtime = new PollingRuntime(tracker, workflow, logger);

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
