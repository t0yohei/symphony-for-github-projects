import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { spawn } from "node:child_process";

import type { NormalizedWorkItem } from "../model/work-item.js";

export type WorkspaceLifecycleHook = "before_run" | "after_success" | "after_failure";

export interface HookCommand {
  command: string;
  args?: string[];
  timeoutMs?: number;
  env?: Record<string, string>;
}

export interface WorkspaceCleanupConfig {
  enabled?: boolean;
  terminalStates?: ReadonlyArray<NormalizedWorkItem["state"]>;
  command?: HookCommand;
}

export interface WorkspaceManagerOptions {
  rootDir: string;
  maxKeyLength?: number;
  hooks?: Partial<Record<WorkspaceLifecycleHook, HookCommand>>;
  cleanup?: WorkspaceCleanupConfig;
}

export interface HookExecutionResult {
  hook: WorkspaceLifecycleHook;
  executed: boolean;
  exitCode?: number;
  timedOut?: boolean;
}

const DEFAULT_MAX_KEY_LENGTH = 80;
const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_TERMINAL_STATES: ReadonlyArray<NormalizedWorkItem["state"]> = ["done"];

export class WorkspaceManager {
  private readonly rootDir: string;
  private readonly maxKeyLength: number;
  private readonly hooks: Partial<Record<WorkspaceLifecycleHook, HookCommand>>;
  private readonly cleanup: WorkspaceCleanupConfig;

  constructor(options: WorkspaceManagerOptions) {
    this.rootDir = resolve(options.rootDir);
    this.maxKeyLength = options.maxKeyLength ?? DEFAULT_MAX_KEY_LENGTH;
    this.hooks = options.hooks ?? {};
    this.cleanup = options.cleanup ?? {};
  }

  static sanitizeWorkspaceKey(itemIdentifier: string, maxLength = DEFAULT_MAX_KEY_LENGTH): string {
    const trimmed = itemIdentifier.trim().toLowerCase();
    if (!trimmed) {
      throw new Error("Item identifier must not be empty");
    }

    const sanitized = trimmed
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+/, "")
      .replace(/-+$/, "")
      .replace(/-+/g, "-");

    if (!sanitized) {
      throw new Error("Item identifier did not contain any usable characters");
    }

    if (maxLength <= 8) {
      throw new Error("maxLength must be greater than 8");
    }

    if (sanitized.length <= maxLength) {
      return sanitized;
    }

    const hash = createStableHashHex(sanitized).slice(0, 8);
    return `${sanitized.slice(0, maxLength - 9)}-${hash}`;
  }

  workspacePathFor(itemIdentifier: string): string {
    const key = WorkspaceManager.sanitizeWorkspaceKey(itemIdentifier, this.maxKeyLength);
    return join(this.rootDir, key);
  }

  async ensureWorkspace(itemIdentifier: string): Promise<string> {
    const workspacePath = this.workspacePathFor(itemIdentifier);
    await mkdir(workspacePath, { recursive: true });
    return workspacePath;
  }

  async runHook(hook: WorkspaceLifecycleHook, item: NormalizedWorkItem): Promise<HookExecutionResult> {
    const command = this.hooks[hook];
    if (!command) {
      return { hook, executed: false };
    }

    const workspacePath = await this.ensureWorkspace(item.id);
    const exit = await runCommand(command, {
      WORKSPACE_ITEM_ID: item.id,
      WORKSPACE_ITEM_STATE: item.state,
      WORKSPACE_ITEM_NUMBER: String(item.number ?? ""),
      WORKSPACE_PATH: workspacePath,
    });

    return {
      hook,
      executed: true,
      exitCode: exit.exitCode,
      timedOut: exit.timedOut,
    };
  }

  async cleanupTerminalItemWorkspace(item: NormalizedWorkItem): Promise<boolean> {
    if (!this.cleanup.enabled) {
      return false;
    }

    const terminalStates = this.cleanup.terminalStates ?? DEFAULT_TERMINAL_STATES;
    if (!terminalStates.includes(item.state)) {
      return false;
    }

    const workspacePath = this.workspacePathFor(item.id);
    ensurePathUnderRoot(this.rootDir, workspacePath);

    if (this.cleanup.command) {
      await runCommand(this.cleanup.command, {
        WORKSPACE_ITEM_ID: item.id,
        WORKSPACE_ITEM_STATE: item.state,
        WORKSPACE_ITEM_NUMBER: String(item.number ?? ""),
        WORKSPACE_PATH: workspacePath,
      });
    }

    await rm(workspacePath, { recursive: true, force: true });
    return true;
  }
}

interface CommandResult {
  exitCode: number;
  timedOut: boolean;
}

async function runCommand(command: HookCommand, extraEnv: Record<string, string>): Promise<CommandResult> {
  if (!command.command || basename(command.command) !== command.command) {
    throw new Error("Hook command must be a bare executable name without path separators");
  }

  return await new Promise<CommandResult>((resolvePromise, reject) => {
    const timeoutMs = command.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const child = spawn(command.command, command.args ?? [], {
      stdio: "ignore",
      shell: false,
      env: {
        PATH: process.env.PATH ?? "",
        ...command.env,
        ...extraEnv,
      },
    });

    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
    }, timeoutMs);

    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });

    child.on("close", (code) => {
      clearTimeout(timer);
      resolvePromise({
        exitCode: code ?? 1,
        timedOut,
      });
    });
  });
}

function ensurePathUnderRoot(rootDir: string, candidatePath: string): void {
  const root = resolve(rootDir);
  const candidate = resolve(candidatePath);
  if (candidate !== root && !candidate.startsWith(`${root}/`)) {
    throw new Error(`Refusing to operate outside root directory: ${candidate}`);
  }
}

function createStableHashHex(input: string): string {
  let hash = 2166136261;
  for (let i = 0; i < input.length; i += 1) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }

  return (hash >>> 0).toString(16).padStart(8, "0");
}

// test helpers
export async function createTempWorkspaceRoot(prefix = "workspace-manager-"): Promise<string> {
  return await mkdtemp(join(tmpdir(), prefix));
}

export async function readTextFile(path: string): Promise<string> {
  return await readFile(path, "utf8");
}

export async function writeTextFile(path: string, content: string): Promise<void> {
  await writeFile(path, content, "utf8");
}
