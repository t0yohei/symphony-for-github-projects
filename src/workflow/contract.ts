export type WorkflowValidationErrorCode =
  | "tracker.kind.required"
  | "tracker.kind.unsupported"
  | "tracker.github.owner.required"
  | "tracker.github.projectNumber.invalid"
  | "tracker.auth.tokenEnv.required"
  | "polling.intervalMs.invalid"
  | "workspace.baseDir.required"
  | "agent.command.required";

export interface WorkflowValidationError {
  code: WorkflowValidationErrorCode;
  path: string;
  message: string;
}

export interface WorkflowContract {
  tracker: {
    kind: "github_projects";
    github: {
      owner: string;
      projectNumber: number;
      tokenEnv: string;
      type?: "org" | "user";
    };
  };
  polling: {
    intervalMs: number;
    maxConcurrency?: number;
  };
  workspace: {
    baseDir: string;
  };
  agent: {
    command: string;
    args?: string[];
  };
  hooks?: {
    onStart?: string;
    onSuccess?: string;
    onFailure?: string;
  };
}

export interface WorkflowLoader {
  load(path: string): Promise<WorkflowContract>;
}

export class NotImplementedWorkflowLoader implements WorkflowLoader {
  async load(_path: string): Promise<WorkflowContract> {
    throw new Error("WORKFLOW.md loader not implemented yet");
  }
}

export function validateWorkflowContract(input: unknown): WorkflowValidationError[] {
  const errors: WorkflowValidationError[] = [];

  if (typeof input !== "object" || input === null) {
    return [
      {
        code: "tracker.kind.required",
        path: "tracker.kind",
        message: "workflow front matter must be an object",
      },
    ];
  }

  const record = input as Record<string, unknown>;
  const tracker = (record.tracker ?? {}) as Record<string, unknown>;
  const github = (tracker.github ?? {}) as Record<string, unknown>;
  const auth = (tracker.auth ?? {}) as Record<string, unknown>;
  const polling = (record.polling ?? {}) as Record<string, unknown>;
  const workspace = (record.workspace ?? {}) as Record<string, unknown>;
  const agent = (record.agent ?? {}) as Record<string, unknown>;

  if (tracker.kind === undefined) {
    errors.push({
      code: "tracker.kind.required",
      path: "tracker.kind",
      message: "tracker.kind is required",
    });
  } else if (tracker.kind !== "github_projects") {
    errors.push({
      code: "tracker.kind.unsupported",
      path: "tracker.kind",
      message: "tracker.kind must be 'github_projects'",
    });
  }

  if (typeof github.owner !== "string" || github.owner.trim() === "") {
    errors.push({
      code: "tracker.github.owner.required",
      path: "tracker.github.owner",
      message: "tracker.github.owner is required",
    });
  }

  if (
    typeof github.projectNumber !== "number" ||
    !Number.isInteger(github.projectNumber) ||
    github.projectNumber <= 0
  ) {
    errors.push({
      code: "tracker.github.projectNumber.invalid",
      path: "tracker.github.projectNumber",
      message: "tracker.github.projectNumber must be a positive integer",
    });
  }

  const tokenEnv =
    typeof auth.tokenEnv === "string" && auth.tokenEnv.trim() !== ""
      ? auth.tokenEnv
      : typeof github.tokenEnv === "string" && github.tokenEnv.trim() !== ""
      ? github.tokenEnv
      : undefined;

  if (!tokenEnv) {
    errors.push({
      code: "tracker.auth.tokenEnv.required",
      path: "tracker.auth.tokenEnv",
      message: "tracker auth token env var is required (e.g. GITHUB_TOKEN)",
    });
  }

  if (
    typeof polling.intervalMs !== "number" ||
    !Number.isFinite(polling.intervalMs) ||
    polling.intervalMs < 1000
  ) {
    errors.push({
      code: "polling.intervalMs.invalid",
      path: "polling.intervalMs",
      message: "polling.intervalMs must be a number >= 1000",
    });
  }

  if (typeof workspace.baseDir !== "string" || workspace.baseDir.trim() === "") {
    errors.push({
      code: "workspace.baseDir.required",
      path: "workspace.baseDir",
      message: "workspace.baseDir is required",
    });
  }

  if (typeof agent.command !== "string" || agent.command.trim() === "") {
    errors.push({
      code: "agent.command.required",
      path: "agent.command",
      message: "agent.command is required",
    });
  }

  return errors;
}
