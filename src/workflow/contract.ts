import { loadWorkflowFile, type WorkflowDocument } from './loader.js';


export type WorkflowValidationErrorCode =
  | 'tracker.kind.required'
  | 'tracker.kind.unsupported'
  | 'tracker.github.owner.required'
  | 'tracker.github.projectNumber.invalid'
  | 'tracker.auth.tokenEnv.required'
  | 'runtime.pollIntervalMs.invalid'
  | 'runtime.maxConcurrency.invalid'
  | 'workspace.root.required'
  | 'agent.command.required';

export interface WorkflowValidationError {
  code: WorkflowValidationErrorCode;
  path: string;
  message: string;
}

export interface WorkflowContract {
  tracker: {
    kind: 'github_projects';
    github: {
      owner: string;
      projectNumber: number;
      tokenEnv: string;
      type?: 'org' | 'user';
    };
  };
  runtime: {
    pollIntervalMs: number;
    maxConcurrency?: number;
    retry?: {
      continuationDelayMs?: number;
      failureBaseDelayMs?: number;
      failureMultiplier?: number;
      failureMaxDelayMs?: number;
    };
  };
  // legacy accessor kept for compatibility
  polling: {
    intervalMs: number;
    maxConcurrency?: number;
  };
  workspace: {
    root?: string;
    baseDir?: string;
  };
  agent: {
    command: string;
    args?: string[];
    maxTurns?: number;
    timeouts?: {
      turnTimeoutMs?: number;
      readTimeoutMs?: number;
      stallTimeoutMs?: number;
      hooksTimeoutMs?: number;
    };
  };
  hooks?: {
    after_create?: string;
    before_run?: string;
    after_run?: string;
    before_remove?: string;
    // legacy aliases
    onStart?: string;
    onSuccess?: string;
    onFailure?: string;
  };
  extensions?: {
    github_projects?: Record<string, unknown>;
  };
}

export interface LoadedWorkflowContract extends WorkflowContract {
  prompt_template: string;
}

export interface WorkflowLoader {
  load(path: string): Promise<LoadedWorkflowContract>;
}

export class WorkflowContractBuildError extends Error {
  constructor(
    message: string,
    public readonly validationErrors: WorkflowValidationError[],
  ) {
    super(message);
    this.name = 'WorkflowContractBuildError';
  }
}

export class FileWorkflowLoader implements WorkflowLoader {
  async load(path: string): Promise<LoadedWorkflowContract> {
    const doc = await loadWorkflowFile(path);
    return buildContract(doc);
  }
}

export class NotImplementedWorkflowLoader implements WorkflowLoader {
  async load(_path: string): Promise<LoadedWorkflowContract> {
    throw new Error('WORKFLOW.md loader not implemented yet');
  }
}

export function buildContract(doc: WorkflowDocument): LoadedWorkflowContract {
  const errors = validateWorkflowContract(doc.config);
  if (errors.length > 0) {
    const details = errors.map((error) => `${error.path}: ${error.message}`).join('; ');
    throw new WorkflowContractBuildError(`Invalid WORKFLOW.md front matter: ${details}`, errors);
  }

  const config = doc.config as Record<string, unknown>;

  const trackerKind = coerceString(readPath(config, ['tracker', 'kind'])) as 'github_projects';

  const owner =
    coerceString(readPath(config, ['tracker', 'github', 'owner'])) ??
    coerceString(readPath(config, ['extensions', 'github_projects', 'owner']))!;

  const projectNumber =
    coerceNumber(readPath(config, ['tracker', 'github', 'projectNumber'])) ??
    coerceNumber(readPath(config, ['extensions', 'github_projects', 'project_number']))!;

  const tokenEnv =
    coerceString(readPath(config, ['tracker', 'auth', 'tokenEnv'])) ??
    coerceString(readPath(config, ['tracker', 'github', 'tokenEnv'])) ??
    coerceString(readPath(config, ['extensions', 'github_projects', 'token_env']))!;

  const githubType =
    (coerceString(readPath(config, ['tracker', 'github', 'type'])) as 'org' | 'user' | undefined) ??
    (coerceString(readPath(config, ['extensions', 'github_projects', 'type'])) as
      | 'org'
      | 'user'
      | undefined);

  const pollIntervalMs =
    coerceNumber(readPath(config, ['runtime', 'pollIntervalMs'])) ??
    coerceNumber(readPath(config, ['runtime', 'poll_interval_ms'])) ??
    coerceNumber(readPath(config, ['polling', 'intervalMs']))!;

  const maxConcurrency =
    coerceNumber(readPath(config, ['runtime', 'maxConcurrency'])) ??
    coerceNumber(readPath(config, ['runtime', 'max_concurrency'])) ??
    coerceNumber(readPath(config, ['polling', 'maxConcurrency']));

  const workspaceRoot =
    coerceString(readPath(config, ['workspace', 'root'])) ??
    coerceString(readPath(config, ['workspace', 'baseDir']))!;
  const expandedWorkspaceRoot = expandPathWithEnvironment(workspaceRoot);

  const hooks = (readPath(config, ['hooks']) as Record<string, unknown> | undefined) ?? {};
  const extensions =
    (readPath(config, ['extensions']) as Record<string, unknown> | undefined) ?? undefined;

  const contract: LoadedWorkflowContract = {
    tracker: {
      kind: trackerKind,
      github: {
        owner,
        projectNumber,
        tokenEnv,
        type: githubType,
      },
    },
    runtime: {
      pollIntervalMs,
      maxConcurrency,
      retry: {
        continuationDelayMs:
          coerceNumber(readPath(config, ['runtime', 'retry', 'continuationDelayMs'])) ??
          coerceNumber(readPath(config, ['runtime', 'retry', 'continuation_delay_ms'])),
        failureBaseDelayMs:
          coerceNumber(readPath(config, ['runtime', 'retry', 'failureBaseDelayMs'])) ??
          coerceNumber(readPath(config, ['runtime', 'retry', 'failure_base_delay_ms'])),
        failureMultiplier:
          coerceNumber(readPath(config, ['runtime', 'retry', 'failureMultiplier'])) ??
          coerceNumber(readPath(config, ['runtime', 'retry', 'failure_multiplier'])),
        failureMaxDelayMs:
          coerceNumber(readPath(config, ['runtime', 'retry', 'failureMaxDelayMs'])) ??
          coerceNumber(readPath(config, ['runtime', 'retry', 'failure_max_delay_ms'])),
      },
    },
    workspace: {
      root: expandedWorkspaceRoot,
      baseDir: expandedWorkspaceRoot,
    },
    agent: {
      command: coerceString(readPath(config, ['agent', 'command']))!,
      args:
        (readPath(config, ['agent', 'args']) as unknown[] | undefined)?.every((v) => typeof v === 'string')
          ? ((readPath(config, ['agent', 'args']) as string[]) ?? undefined)
          : undefined,
      maxTurns:
        coerceNumber(readPath(config, ['agent', 'maxTurns'])) ??
        coerceNumber(readPath(config, ['agent', 'max_turns'])),
      timeouts: {
        turnTimeoutMs:
          coerceNumber(readPath(config, ['agent', 'timeouts', 'turnTimeoutMs'])) ??
          coerceNumber(readPath(config, ['agent', 'timeouts', 'turn_timeout_ms'])) ??
          coerceNumber(readPath(config, ['agent', 'turnTimeoutMs'])),
        readTimeoutMs:
          coerceNumber(readPath(config, ['agent', 'timeouts', 'readTimeoutMs'])) ??
          coerceNumber(readPath(config, ['agent', 'timeouts', 'read_timeout_ms'])) ??
          coerceNumber(readPath(config, ['agent', 'readTimeoutMs'])),
        stallTimeoutMs:
          coerceNumber(readPath(config, ['agent', 'timeouts', 'stallTimeoutMs'])) ??
          coerceNumber(readPath(config, ['agent', 'timeouts', 'stall_timeout_ms'])) ??
          coerceNumber(readPath(config, ['agent', 'stallTimeoutMs'])),
        hooksTimeoutMs:
          coerceNumber(readPath(config, ['agent', 'timeouts', 'hooksTimeoutMs'])) ??
          coerceNumber(readPath(config, ['agent', 'timeouts', 'hooks_timeout_ms'])) ??
          coerceNumber(readPath(config, ['hooks', 'timeoutMs'])) ??
          coerceNumber(readPath(config, ['hooks', 'timeout_ms'])),
      },
    },
    hooks:
      typeof hooks === 'object'
        ? {
            after_create: coerceString(hooks.after_create),
            before_run: coerceString(hooks.before_run),
            after_run: coerceString(hooks.after_run),
            before_remove: coerceString(hooks.before_remove),
            onStart: coerceString(hooks.onStart),
            onSuccess: coerceString(hooks.onSuccess),
            onFailure: coerceString(hooks.onFailure),
          }
        : undefined,
    extensions: {
      github_projects:
        typeof extensions?.github_projects === 'object'
          ? (extensions.github_projects as Record<string, unknown>)
          : undefined,
    },
    polling: {
      intervalMs: pollIntervalMs,
      maxConcurrency,
    },
    prompt_template: doc.prompt_template,
  };

  return contract;
}

export function validateWorkflowContract(input: unknown): WorkflowValidationError[] {
  const errors: WorkflowValidationError[] = [];

  if (typeof input !== 'object' || input === null) {
    return [
      {
        code: 'tracker.kind.required',
        path: 'tracker.kind',
        message: 'workflow front matter must be an object',
      },
    ];
  }

  const record = input as Record<string, unknown>;

  const trackerKind = coerceString(readPath(record, ['tracker', 'kind']));
  if (trackerKind === undefined) {
    errors.push({
      code: 'tracker.kind.required',
      path: 'tracker.kind',
      message: 'tracker.kind is required',
    });
  } else if (trackerKind !== 'github_projects') {
    errors.push({
      code: 'tracker.kind.unsupported',
      path: 'tracker.kind',
      message: "tracker.kind must be 'github_projects'",
    });
  }

  const owner =
    coerceString(readPath(record, ['tracker', 'github', 'owner'])) ??
    coerceString(readPath(record, ['extensions', 'github_projects', 'owner']));
  if (!owner) {
    errors.push({
      code: 'tracker.github.owner.required',
      path: 'tracker.github.owner',
      message: 'tracker.github.owner is required',
    });
  }

  const projectNumber =
    coerceNumber(readPath(record, ['tracker', 'github', 'projectNumber'])) ??
    coerceNumber(readPath(record, ['extensions', 'github_projects', 'project_number']));

  if (typeof projectNumber !== 'number' || !Number.isInteger(projectNumber) || projectNumber <= 0) {
    errors.push({
      code: 'tracker.github.projectNumber.invalid',
      path: 'tracker.github.projectNumber',
      message: 'tracker.github.projectNumber must be a positive integer',
    });
  }

  const tokenEnv =
    coerceString(readPath(record, ['tracker', 'auth', 'tokenEnv'])) ??
    coerceString(readPath(record, ['tracker', 'github', 'tokenEnv'])) ??
    coerceString(readPath(record, ['extensions', 'github_projects', 'token_env']));

  if (!tokenEnv) {
    errors.push({
      code: 'tracker.auth.tokenEnv.required',
      path: 'tracker.auth.tokenEnv',
      message: 'tracker auth token env var is required (e.g. GITHUB_TOKEN)',
    });
  }

  const pollIntervalMs =
    coerceNumber(readPath(record, ['runtime', 'pollIntervalMs'])) ??
    coerceNumber(readPath(record, ['runtime', 'poll_interval_ms'])) ??
    coerceNumber(readPath(record, ['polling', 'intervalMs']));

  if (
    typeof pollIntervalMs !== 'number' ||
    !Number.isFinite(pollIntervalMs) ||
    pollIntervalMs < 1000
  ) {
    errors.push({
      code: 'runtime.pollIntervalMs.invalid',
      path: 'runtime.pollIntervalMs',
      message: 'runtime.pollIntervalMs must be a number >= 1000',
    });
  }

  const maxConcurrency =
    coerceNumber(readPath(record, ['runtime', 'maxConcurrency'])) ??
    coerceNumber(readPath(record, ['runtime', 'max_concurrency'])) ??
    coerceNumber(readPath(record, ['polling', 'maxConcurrency']));

  if (
    maxConcurrency !== undefined &&
    (!Number.isFinite(maxConcurrency) || !Number.isInteger(maxConcurrency) || maxConcurrency < 1)
  ) {
    errors.push({
      code: 'runtime.maxConcurrency.invalid',
      path: 'runtime.maxConcurrency',
      message: 'runtime.maxConcurrency must be an integer >= 1',
    });
  }

  const workspaceRoot =
    coerceString(readPath(record, ['workspace', 'root'])) ??
    coerceString(readPath(record, ['workspace', 'baseDir']));
  if (!workspaceRoot) {
    errors.push({
      code: 'workspace.root.required',
      path: 'workspace.root',
      message: 'workspace.root is required',
    });
  }

  if (!coerceString(readPath(record, ['agent', 'command']))) {
    errors.push({
      code: 'agent.command.required',
      path: 'agent.command',
      message: 'agent.command is required',
    });
  }

  return errors;
}

function readPath(input: Record<string, unknown>, path: string[]): unknown {
  let cursor: unknown = input;
  for (const key of path) {
    if (typeof cursor !== 'object' || cursor === null || Array.isArray(cursor)) {
      return undefined;
    }
    cursor = (cursor as Record<string, unknown>)[key];
  }
  return cursor;
}

function coerceString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() !== '' ? value : undefined;
}



function expandPathWithEnvironment(raw: string): string {
  let expanded = raw;
  if (expanded.startsWith('~')) {
    const home = process.env.HOME;
    if (home) {
      expanded = `${home}${expanded.slice(1)}`;
    }
  }

  return expanded.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}|\$([A-Za-z_][A-Za-z0-9_]*)/g, (_match, braced, plain) => {
    const name = braced ?? plain;
    const value = process.env[name];
    return value ?? _match;
  });
}

function coerceNumber(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  return undefined;
}
