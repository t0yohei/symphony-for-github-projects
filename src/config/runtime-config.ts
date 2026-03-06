export interface TrackerRuntimeConfig {
  type: "github-projects";
  owner: string;
  repo: string;
  projectNumber: number;
}

export interface AgentRuntimeConfig {
  command: string;
  args: string[];
  timeoutMs: number;
}

/**
 * RuntimeConfig is the canonical typed configuration used by runtime modules.
 */
export interface RuntimeConfig {
  pollIntervalMs: number;
  maxConcurrency: number;
  workspaceRoot: string;
  tracker: TrackerRuntimeConfig;
  agent: AgentRuntimeConfig;
}

export interface RawWorkflowConfig {
  pollIntervalMs?: unknown;
  maxConcurrency?: unknown;
  workspaceRoot?: unknown;
  tracker?: {
    type?: unknown;
    owner?: unknown;
    repo?: unknown;
    projectNumber?: unknown;
  };
  agent?: {
    command?: unknown;
    args?: unknown;
    timeoutMs?: unknown;
  };
}
