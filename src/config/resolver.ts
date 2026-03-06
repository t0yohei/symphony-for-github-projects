import type { RawWorkflowConfig, RuntimeConfig } from "./runtime-config.js";

const DEFAULTS = {
  pollIntervalMs: 30_000,
  maxConcurrency: 1,
  workspaceRoot: ".symphony/workspaces",
  trackerType: "github-projects" as const,
  agentTimeoutMs: 900_000,
};

export class ConfigResolutionError extends Error {
  constructor(message: string, readonly path: string) {
    super(`${path}: ${message}`);
    this.name = "ConfigResolutionError";
  }
}

export class WorkflowConfigResolver {
  constructor(
    private readonly raw: RawWorkflowConfig,
    private readonly env: Record<string, string | undefined> = process.env,
  ) {}

  resolve(): RuntimeConfig {
    return {
      pollIntervalMs: this.getPollingIntervalMs(),
      maxConcurrency: this.getMaxConcurrency(),
      workspaceRoot: this.getWorkspaceRoot(),
      tracker: {
        type: this.getTrackerType(),
        owner: this.getRequiredString(this.raw.tracker?.owner, "tracker.owner"),
        repo: this.getRequiredString(this.raw.tracker?.repo, "tracker.repo"),
        projectNumber: this.getRequiredInt(this.raw.tracker?.projectNumber, "tracker.projectNumber", 1),
      },
      agent: {
        command: this.getRequiredString(this.raw.agent?.command, "agent.command"),
        args: this.getStringArray(this.raw.agent?.args, "agent.args", []),
        timeoutMs: this.getInt(this.raw.agent?.timeoutMs, "agent.timeoutMs", DEFAULTS.agentTimeoutMs, 1_000),
      },
    };
  }

  getPollingIntervalMs(): number {
    return this.getInt(this.raw.pollIntervalMs, "pollIntervalMs", DEFAULTS.pollIntervalMs, 1_000);
  }

  getMaxConcurrency(): number {
    return this.getInt(this.raw.maxConcurrency, "maxConcurrency", DEFAULTS.maxConcurrency, 1);
  }

  getWorkspaceRoot(): string {
    return this.getString(this.raw.workspaceRoot, "workspaceRoot", DEFAULTS.workspaceRoot);
  }

  getTrackerType(): "github-projects" {
    const value = this.raw.tracker?.type;
    if (value == null) {
      return DEFAULTS.trackerType;
    }

    const resolved = this.resolveScalar(value, "tracker.type");
    if (resolved !== "github-projects") {
      throw new ConfigResolutionError("must be 'github-projects'", "tracker.type");
    }

    return "github-projects";
  }

  getAgentCommand(): string {
    return this.getRequiredString(this.raw.agent?.command, "agent.command");
  }

  private resolveScalar(value: unknown, path: string): unknown {
    if (typeof value === "string" && value.startsWith("$")) {
      const key = value.slice(1);
      if (!key) {
        throw new ConfigResolutionError("empty env var reference", path);
      }

      const envValue = this.env[key];
      if (envValue == null || envValue.length === 0) {
        throw new ConfigResolutionError(`env var ${key} is not set`, path);
      }

      return envValue;
    }

    return value;
  }

  private getInt(value: unknown, path: string, fallback: number, min: number): number {
    if (value == null) {
      return fallback;
    }

    const resolved = this.resolveScalar(value, path);
    const parsed = typeof resolved === "number" ? resolved : Number(resolved);
    if (!Number.isInteger(parsed)) {
      throw new ConfigResolutionError("must be an integer", path);
    }

    if (parsed < min) {
      throw new ConfigResolutionError(`must be >= ${min}`, path);
    }

    return parsed;
  }

  private getRequiredInt(value: unknown, path: string, min: number): number {
    if (value == null) {
      throw new ConfigResolutionError("is required", path);
    }

    return this.getInt(value, path, 0, min);
  }

  private getString(value: unknown, path: string, fallback: string): string {
    if (value == null) {
      return fallback;
    }

    const resolved = this.resolveScalar(value, path);
    if (typeof resolved !== "string" || resolved.length === 0) {
      throw new ConfigResolutionError("must be a non-empty string", path);
    }

    return resolved;
  }

  private getRequiredString(value: unknown, path: string): string {
    if (value == null) {
      throw new ConfigResolutionError("is required", path);
    }

    return this.getString(value, path, "");
  }

  private getStringArray(value: unknown, path: string, fallback: string[]): string[] {
    if (value == null) {
      return fallback;
    }

    const resolved = this.resolveScalar(value, path);
    if (!Array.isArray(resolved)) {
      throw new ConfigResolutionError("must be an array of strings", path);
    }

    const invalid = resolved.find((entry) => typeof entry !== "string");
    if (invalid !== undefined) {
      throw new ConfigResolutionError("must be an array of strings", path);
    }

    return [...resolved];
  }
}
