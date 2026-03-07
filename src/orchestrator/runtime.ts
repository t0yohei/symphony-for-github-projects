import { spawnSync } from 'node:child_process';
import type { Logger } from '../logging/logger.js';
import { CodexAppServerClient, type CodexTurnResult } from '../agent/codex-app-server.js';
import type { NormalizedWorkItem, WorkItemState } from '../model/work-item.js';
import type { TrackerAdapter } from '../tracker/adapter.js';
import { renderPromptTemplate } from '../prompt/template.js';
import type { WorkflowContract } from '../workflow/contract.js';
import { WorkspaceManager } from '../workspace/manager.js';
export interface OrchestratorRuntime {
  tick(): Promise<void>;
}

export interface RuntimeUsageTotals {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
}

export interface RuntimeRateLimitSnapshot {
  code?: string;
  resetAt?: string;
  retryAfterMs?: number;
  message?: string;
  raw?: Record<string, unknown>;
}

export interface RuntimeObservationContext {
  sessionId?: string;
  usage?: Partial<RuntimeUsageTotals>;
  rateLimit?: RuntimeRateLimitSnapshot;
}

export interface RuntimeStateSnapshot {
  running: string[];
  claimed: string[];
  retryAttempts: Record<string, number>;
  completed: string[];
  runningDetails: Array<{ itemId: string; issueIdentifier: string; sessionId?: string }>;
  retryingDetails: Array<{ itemId: string; issueIdentifier: string; attempt: number; kind: 'continuation' | 'failure'; dueAt: string }>;
  usageTotals: RuntimeUsageTotals;
  aggregateRuntimeSeconds: number;
  latestRateLimit?: RuntimeRateLimitSnapshot;
}

interface RuntimeWorker {
  run(): Promise<CodexTurnResult>;
  cancel(): void;
}

interface RunningEntry {
  item: NormalizedWorkItem;
  startedAt: number;
  lastEventAt: number;
  workspacePath: string;
  worker?: RuntimeWorker;
  sessionId?: string;
}

interface RetryEntry {
  issueId: string;
  identifier: string;
  item: NormalizedWorkItem;
  attempt: number;
  dueAt: number;
  timer?: ReturnType<typeof setTimeout>;
  error?: string;
  kind: 'continuation' | 'failure';
}

export interface PollingRuntimeOptions {
  now?: () => number;
  stallTimeoutMs?: number;
  continuationRetryDelayMs?: number;
  failureRetryBaseDelayMs?: number;
  failureRetryMultiplier?: number;
  /** @deprecated Use maxRetryBackoffMs */
  failureRetryMaxDelayMs?: number;
  /** Maximum cap for failure retry delay in ms (spec: max_retry_backoff_ms). */
  maxRetryBackoffMs?: number;
  env?: Record<string, string | undefined>;
  commandExists?: (command: string) => boolean;
  /** Optional workspace manager override for tests or custom hook wiring. */
  workspaceManager?: WorkspaceManager;
  /** Optional worker factory override for deterministic tests. */
  workerFactory?: (context: {
    item: NormalizedWorkItem;
    workspacePath: string;
    attempt: number | null;
    workflow: WorkflowContract;
  }) => RuntimeWorker | Promise<RuntimeWorker>;
}

const DEFAULT_STALL_TIMEOUT_MS = 5 * 60 * 1000;
const DEFAULT_CONTINUATION_RETRY_DELAY_MS = 1_000;
/** Failure retry base delay per spec: min(10000 * 2^(attempt-1), max_retry_backoff_ms) */
const DEFAULT_FAILURE_RETRY_BASE_DELAY_MS = 10_000;
const DEFAULT_FAILURE_RETRY_MULTIPLIER = 2;
const DEFAULT_FAILURE_RETRY_MAX_DELAY_MS = 60_000;

/**
 * Error thrown when required workflow config fields are missing or invalid.
 * Includes a `failingKey` field identifying the config path that failed validation.
 */
export class PreflightValidationError extends Error {
  constructor(
    message: string,
    readonly failingKey: string,
  ) {
    super(message);
    this.name = 'PreflightValidationError';
  }
}

/**
 * Validates required workflow config fields (tracker, auth, agent command) without
 * checking command existence on PATH. Safe to call at startup.
 *
 * Throws `PreflightValidationError` with `failingKey` identifying the failing path.
 */
export function validateRequiredWorkflowFields(
  workflow: WorkflowContract,
  env: Record<string, string | undefined> = process.env,
): void {
  const github = workflow.tracker?.github;

  if (typeof github?.owner !== 'string' || github.owner.trim() === '') {
    throw new PreflightValidationError(
      'tracker.github.owner is required and must be a non-empty string',
      'tracker.github.owner',
    );
  }

  if (!Number.isInteger(github.projectNumber) || github.projectNumber <= 0) {
    throw new PreflightValidationError(
      'tracker.github.projectNumber is required and must be a positive integer',
      'tracker.github.projectNumber',
    );
  }

  const tokenEnv = github.tokenEnv;
  if (typeof tokenEnv !== 'string' || tokenEnv.trim() === '') {
    throw new PreflightValidationError(
      'tracker.github.tokenEnv is required and must be a non-empty string',
      'tracker.github.tokenEnv',
    );
  }

  const token = env[tokenEnv];
  if (!token || token.trim() === '') {
    throw new PreflightValidationError(
      `Environment variable ${tokenEnv} (tracker auth token) is not set`,
      `env.${tokenEnv}`,
    );
  }

  const command = workflow.agent?.command;
  if (typeof command !== 'string' || command.trim() === '') {
    throw new PreflightValidationError(
      'agent.command is required and must be a non-empty string',
      'agent.command',
    );
  }
}

export class PollingRuntime implements OrchestratorRuntime {
  private readonly running = new Map<string, RunningEntry>();
  private readonly claimed = new Set<string>();
  private readonly retry = new Map<string, RetryEntry>();
  private readonly completed = new Set<string>();
  private readonly usageTotals: RuntimeUsageTotals = { inputTokens: 0, outputTokens: 0, totalTokens: 0 };
  private aggregateRuntimeMs = 0;
  private latestRateLimit?: RuntimeRateLimitSnapshot;
  private readonly now: () => number;
  private readonly stallTimeoutMs: number;
  private readonly continuationRetryDelayMs: number;
  private readonly failureRetryBaseDelayMs: number;
  private readonly failureRetryMultiplier: number;
  private readonly failureRetryMaxDelayMs: number;
  private readonly env: Record<string, string | undefined>;
  private readonly commandExists: (command: string) => boolean;
  private readonly workspaceManager: WorkspaceManager;
  private readonly workerFactory: (context: {
    item: NormalizedWorkItem;
    workspacePath: string;
    attempt: number | null;
    workflow: WorkflowContract;
  }) => RuntimeWorker | Promise<RuntimeWorker>;
  private workflow: WorkflowContract;

  constructor(
    private readonly tracker: TrackerAdapter,
    workflow: WorkflowContract & { prompt_template?: string },
    private readonly logger: Logger,
    options: PollingRuntimeOptions = {},
  ) {
    this.workflow = workflow;
    this.now = options.now ?? (() => Date.now());
    this.stallTimeoutMs = options.stallTimeoutMs ?? DEFAULT_STALL_TIMEOUT_MS;
    this.continuationRetryDelayMs =
      options.continuationRetryDelayMs ?? DEFAULT_CONTINUATION_RETRY_DELAY_MS;
    this.failureRetryBaseDelayMs =
      options.failureRetryBaseDelayMs ?? DEFAULT_FAILURE_RETRY_BASE_DELAY_MS;
    this.failureRetryMultiplier = options.failureRetryMultiplier ?? DEFAULT_FAILURE_RETRY_MULTIPLIER;
    this.failureRetryMaxDelayMs =
      options.maxRetryBackoffMs ?? options.failureRetryMaxDelayMs ?? DEFAULT_FAILURE_RETRY_MAX_DELAY_MS;
    this.env = options.env ?? process.env;
    this.commandExists = options.commandExists ?? defaultCommandExists;
    const workspaceRoot = this.workflow.workspace?.baseDir ?? this.workflow.workspace?.root;
    if (!workspaceRoot) {
      throw new Error('workspace.root is required');
    }

    this.workspaceManager =
      options.workspaceManager ??
      new WorkspaceManager({
        workspaceRoot,
      });
    this.workerFactory = options.workerFactory ?? ((context) => Promise.resolve(this.buildDefaultWorker(context)));
  }

  async tick(): Promise<void> {
    await this.reconcile();
    await this.fireDueRetries();

    const preflight = this.runDispatchPreflight();
    if (!preflight.ok) {
      this.logger.warn('runtime.preflight.failed', preflight.context);
      return;
    }

    const maxConcurrency = this.resolveMaxConcurrency();
    if (maxConcurrency <= 0) {
      this.logger.warn('runtime.preflight.invalid_concurrency', {
        maxConcurrency: this.workflow.polling?.maxConcurrency ?? this.workflow.runtime?.maxConcurrency,
      });
      return;
    }

    const candidates = await this.tracker.listEligibleItems();
    const sorted = sortCandidates(candidates);
    const dispatchable = sorted.filter((item) => this.isDispatchable(item.id));
    const todoBlockedByNonTerminal = await this.findTodoItemsBlockedByNonTerminal(dispatchable);
    const maxConcurrencyByState = this.resolveMaxConcurrencyByState();

    let dispatched = 0;
    const capacity = Math.max(0, maxConcurrency - this.running.size);
    for (const item of dispatchable) {
      if (dispatched >= capacity) break;

      if (todoBlockedByNonTerminal.has(item.id)) {
        this.logger.info('runtime.dispatch.skipped.todo_blocked', {
          issue_id: item.id,
          issue_identifier: item.identifier,
          blocked_by: item.blocked_by ?? [],
        });
        continue;
      }

      if (!this.hasStateCapacity(item.state)) {
        this.logger.info('runtime.dispatch.skipped.state_capacity', {
          issue_id: item.id,
          issue_identifier: item.identifier,
          state: item.state,
          maxConcurrencyByState: maxConcurrencyByState[item.state],
        });
        continue;
      }

      const ok = await this.dispatch(item);
      if (ok) {
        dispatched += 1;
      }
    }

    this.logger.info('runtime.tick', {
      issue_id: undefined,
      issue_identifier: undefined,
      eligibleCount: candidates.length,
      dispatchableCount: dispatchable.length,
      dispatched,
      runningCount: this.running.size,
      claimedCount: this.claimed.size,
      retryCount: this.retry.size,
      completedCount: this.completed.size,
      maxConcurrency,
    });
  }

  markActivity(itemId: string): void {
    const running = this.running.get(itemId);
    if (!running) return;
    running.lastEventAt = this.now();
  }

  observeSession(itemId: string, context: RuntimeObservationContext): void {
    const running = this.running.get(itemId);
    if (!running) return;

    if (context.sessionId) {
      running.sessionId = context.sessionId;
    }

    if (context.rateLimit) {
      this.latestRateLimit = sanitizeRateLimit(context.rateLimit);
    }
  }

  private observeWorkerExit(entry: RunningEntry, context?: RuntimeObservationContext): void {
    const runtimeMs = Math.max(0, this.now() - entry.startedAt);
    this.aggregateRuntimeMs += runtimeMs;

    if (context?.sessionId) {
      entry.sessionId = context.sessionId;
    }

    if (context?.rateLimit) {
      this.latestRateLimit = sanitizeRateLimit(context.rateLimit);
    }

    const usage = context?.usage;
    if (!usage) {
      this.logger.info('runtime.transition.metrics', {
        issue_id: entry.item.id,
        issue_identifier: entry.item.identifier,
        session_id: entry.sessionId,
        runtime_seconds: Math.floor(runtimeMs / 1000),
        aggregate_runtime_seconds: Math.floor(this.aggregateRuntimeMs / 1000),
        usage_input_tokens: this.usageTotals.inputTokens,
        usage_output_tokens: this.usageTotals.outputTokens,
        usage_total_tokens: this.usageTotals.totalTokens,
      });
      return;
    }

    const inputTokens = toIntOrZero(usage.inputTokens);
    const outputTokens = toIntOrZero(usage.outputTokens);
    const reportedTotalTokens = toIntOrZero(usage.totalTokens);
    const resolvedTotalTokens = Math.max(reportedTotalTokens, inputTokens + outputTokens);

    this.usageTotals.inputTokens += inputTokens;
    this.usageTotals.outputTokens += outputTokens;
    this.usageTotals.totalTokens += resolvedTotalTokens;

    this.logger.info('runtime.transition.metrics', {
      issue_id: entry.item.id,
      issue_identifier: entry.item.identifier,
      session_id: entry.sessionId,
      runtime_seconds: Math.floor(runtimeMs / 1000),
      aggregate_runtime_seconds: Math.floor(this.aggregateRuntimeMs / 1000),
      usage_input_tokens: this.usageTotals.inputTokens,
      usage_output_tokens: this.usageTotals.outputTokens,
      usage_total_tokens: this.usageTotals.totalTokens,
      latest_rate_limit: this.latestRateLimit,
    });
  }

  async handleWorkerExit(
    itemId: string,
    result: 'completed' | 'failed',
    context?: RuntimeObservationContext,
  ): Promise<void> {
    const entry = this.running.get(itemId);
    if (!entry) return;

    this.observeWorkerExit(entry, context);
    this.running.delete(itemId);
    this.claimed.delete(itemId);

    if (result === 'completed') {
      const states = await this.tracker.getStatesByIds([itemId]);
      if (this.isTerminalState(states[itemId])) {
        this.completed.add(itemId);
        this.clearRetry(itemId);
        await this.cleanupWorkspaceForTerminalEntry(entry.workspacePath);
        this.logger.info('runtime.transition.completed', {
          issue_id: entry.item.id,
          issue_identifier: entry.item.identifier,
          session_id: entry.sessionId,
        });
        return;
      }

      if (!this.shouldMarkDoneOnCompletion()) {
        this.scheduleRetry(entry.item, 'continuation', 'worker_exit_completed');
        return;
      }

      try {
        await this.tracker.markDone(itemId);
        this.completed.add(itemId);
        this.clearRetry(itemId);
        await this.cleanupWorkspaceForTerminalEntry(entry.workspacePath);
        this.logger.info('runtime.transition.mark_done', {
          issue_id: entry.item.id,
          issue_identifier: entry.item.identifier,
          session_id: entry.sessionId,
        });
        this.logger.info('runtime.transition.completed', {
          issue_id: entry.item.id,
          issue_identifier: entry.item.identifier,
          session_id: entry.sessionId,
        });
        return;
      } catch (err) {
        this.scheduleRetry(entry.item, 'failure', 'mark_done_failed', err instanceof Error ? err.message : String(err));
        this.logger.warn('runtime.transition.mark_done_failed', {
          issue_id: entry.item.id,
          issue_identifier: entry.item.identifier,
          error: err instanceof Error ? err.message : String(err),
        });
        return;
      }
    }

    this.scheduleRetry(entry.item, 'failure', 'worker_exit_failed');
  }

  snapshot(): RuntimeStateSnapshot {
    const retryAttempts: Record<string, number> = {};
    for (const [id, entry] of this.retry.entries()) {
      retryAttempts[id] = entry.attempt;
    }

    return {
      running: [...this.running.keys()],
      claimed: [...this.claimed],
      retryAttempts,
      completed: [...this.completed],
      runningDetails: [...this.running.entries()].map(([itemId, entry]) => ({
        itemId,
        issueIdentifier: entry.item.identifier ?? `#${entry.item.number ?? itemId}`,
        sessionId: entry.sessionId,
      })),
      retryingDetails: [...this.retry.entries()].map(([itemId, entry]) => ({
        itemId,
        issueIdentifier: entry.identifier,
        attempt: entry.attempt,
        kind: entry.kind,
        dueAt: new Date(entry.dueAt).toISOString(),
      })),
      usageTotals: { ...this.usageTotals },
      aggregateRuntimeSeconds: Math.floor(this.aggregateRuntimeMs / 1000),
      latestRateLimit: this.latestRateLimit,
    };
  }

  applyWorkflow(nextWorkflow: WorkflowContract): void {
    this.workflow = nextWorkflow;
    this.logger.info('runtime.config.applied', {
      maxConcurrency: nextWorkflow.polling.maxConcurrency ?? 1,
      pollIntervalMs: nextWorkflow.polling.intervalMs,
    });
  }

  private runDispatchPreflight(): { ok: true } | { ok: false; context: Record<string, unknown> } {
    const github = this.workflow.tracker?.github;

    if (typeof github?.owner !== 'string' || github.owner.trim() === '') {
      return {
        ok: false,
        context: {
          reason: 'tracker_config_invalid',
          failing_key: 'tracker.github.owner',
          owner: github?.owner,
        },
      };
    }

    if (!Number.isInteger(github.projectNumber) || github.projectNumber <= 0) {
      return {
        ok: false,
        context: {
          reason: 'tracker_config_invalid',
          failing_key: 'tracker.github.projectNumber',
          projectNumber: github?.projectNumber,
        },
      };
    }

    const tokenEnv = github.tokenEnv;
    if (typeof tokenEnv !== 'string' || tokenEnv.trim() === '') {
      return {
        ok: false,
        context: { reason: 'tracker_auth_env_missing', failing_key: 'tracker.github.tokenEnv' },
      };
    }

    const token = this.env[tokenEnv];
    if (!token || token.trim() === '') {
      return {
        ok: false,
        context: {
          reason: 'tracker_auth_token_unset',
          failing_key: `env.${tokenEnv}`,
          tokenEnv,
        },
      };
    }

    const command = this.workflow.agent?.command;
    if (typeof command !== 'string' || command.trim() === '') {
      return {
        ok: false,
        context: { reason: 'agent_command_missing', failing_key: 'agent.command' },
      };
    }

    if (!this.commandExists(command)) {
      return {
        ok: false,
        context: { reason: 'agent_command_not_found', failing_key: 'agent.command', command },
      };
    }

    return { ok: true };
  }

  private async reconcile(): Promise<void> {
    const now = this.now();
    if (this.running.size === 0) {
      return;
    }

    if (this.stallTimeoutMs > 0) {
      for (const [itemId, entry] of this.running.entries()) {
        const lastActivityAt = entry.lastEventAt || entry.startedAt;
        if (now - lastActivityAt > this.stallTimeoutMs) {
          await this.killRunning(itemId, { reason: 'stalled' });
          this.scheduleRetry(entry.item, 'failure', 'stalled');
        }
      }
    }

    const activeIds = [...this.running.keys()];
    if (activeIds.length === 0) {
      return;
    }

    let trackerStates: Record<string, WorkItemState>;
    try {
      trackerStates = await this.tracker.getStatesByIds(activeIds);
    } catch (err) {
      this.logger.warn('runtime.transition.reconcile_state_refresh_failed', {
        issue_id: undefined,
        issue_identifier: undefined,
        error: err instanceof Error ? err.message : String(err),
      });
      return;
    }

    for (const itemId of activeIds) {
      const entry = this.running.get(itemId);
      if (!entry) continue;

      const state = trackerStates[itemId];
      if (!state) {
        await this.killRunning(itemId, { reason: 'state_missing' });
        this.scheduleRetry(entry.item, 'failure', 'state_missing');
        continue;
      }

      if (this.isTerminalState(state)) {
        await this.killRunning(itemId, { reason: 'terminal_state', clearRetry: true });
        this.completed.add(itemId);
        await this.cleanupWorkspaceForTerminalEntry(entry.workspacePath);
        this.logger.info('runtime.transition.reconcile_done', {
          issue_id: entry.item.id,
          issue_identifier: entry.item.identifier,
          session_id: entry.sessionId,
          state,
        });
        continue;
      }

      if (!this.isActiveState(state)) {
        await this.killRunning(itemId, { reason: 'non_active', clearRetry: true });
        this.logger.info('runtime.transition.reconcile_stopped_non_active', {
          issue_id: entry.item.id,
          issue_identifier: entry.item.identifier,
          session_id: entry.sessionId,
          state,
        });
      }
    }
  }

  private async fireDueRetries(): Promise<void> {
    const dueEntries = [...this.retry.values()]
      .filter((entry) => this.now() >= entry.dueAt)
      .sort((a, b) => a.dueAt - b.dueAt);

    for (const entry of dueEntries) {
      await this.onRetryFire(entry.issueId);
    }
  }

  private async onRetryFire(itemId: string): Promise<void> {
    const entry = this.retry.get(itemId);
    if (!entry) return;

    if (this.completed.has(itemId) || this.running.has(itemId)) {
      this.clearRetry(itemId);
      return;
    }

    const eligible = await this.findEligibleItem(itemId);
    if (!eligible) {
      this.claimed.delete(itemId);
      this.clearRetry(itemId);
      return;
    }

    const maxConcurrency = this.resolveMaxConcurrency();
    const capacity = Math.max(0, maxConcurrency - this.running.size);
    if (capacity <= 0) {
      this.claimed.delete(itemId);
      this.scheduleRetry(
        eligible,
        'continuation',
        'retry_fire_no_slot',
        `no dispatch slot available (running=${this.running.size}, max=${maxConcurrency})`,
      );
      return;
    }

    if (!(await this.isTodoBlockedByNonTerminal(eligible))) {
      if (!this.hasStateCapacity(eligible.state)) {
        this.claimed.delete(itemId);
        this.scheduleRetry(
          eligible,
          'continuation',
          'retry_fire_state_capacity',
          `per-state concurrency limit reached for state=${eligible.state}`,
        );
        return;
      }
      await this.dispatch(eligible);
      return;
    }

    this.claimed.delete(itemId);
    this.scheduleRetry(
      eligible,
      'continuation',
      'retry_fire_blocked_by_non_terminal',
      `item is blocked by a non-terminal dependency`,
    );
  }

  private async findEligibleItem(itemId: string): Promise<NormalizedWorkItem | undefined> {
    const candidates = await this.tracker.listEligibleItems();
    return candidates.find((item) => item.id === itemId);
  }

  private async dispatch(item: NormalizedWorkItem): Promise<boolean> {
    if (this.claimed.has(item.id) || this.running.has(item.id)) {
      return false;
    }

    this.claimed.add(item.id);
    this.logger.info('runtime.transition.claimed', {
      issue_id: item.id,
      issue_identifier: item.identifier,
    });

    const attempt = this.retry.get(item.id)?.attempt ?? null;

    try {
      await this.tracker.markInProgress(item.id);

      const workspace = await this.workspaceManager.prepareWorkspace(item.id);
      await this.workspaceManager.beforeRun(workspace.path);

      const now = this.now();
      const worker = await this.workerFactory({
        item,
        workspacePath: workspace.path,
        attempt,
        workflow: this.workflow,
      });

      this.running.set(item.id, {
        item,
        startedAt: now,
        lastEventAt: now,
        workspacePath: workspace.path,
        worker,
      });
      this.clearRetry(item.id);

      this.logger.info('runtime.transition.running', {
        issue_id: item.id,
        issue_identifier: item.identifier,
      });

      void this.runWorker(item.id);
      return true;
    } catch (err) {
      this.claimed.delete(item.id);
      this.scheduleRetry(item, 'failure', 'claim_failed', err instanceof Error ? err.message : String(err));
      this.logger.warn('runtime.transition.claim_failed', {
        issue_id: item.id,
        issue_identifier: item.identifier,
        error: err instanceof Error ? err.message : String(err),
      });
      return false;
    }
  }

  private async runWorker(itemId: string): Promise<void> {
    const entry = this.running.get(itemId);
    if (!entry) return;

    try {
      const result = await entry.worker?.run();
      const runtimeContext = this.toRuntimeObservationContext(result);
      if (runtimeContext?.sessionId) {
        entry.sessionId = runtimeContext.sessionId;
      }

      if (runtimeContext?.rateLimit) {
        this.latestRateLimit = runtimeContext.rateLimit;
      }

      await this.workspaceManager.afterRun(entry.workspacePath);

      if (!result) {
        await this.handleWorkerExit(entry.item.id, 'failed', runtimeContext);
        return;
      }

      if (result.status === 'completed') {
        await this.handleWorkerExit(entry.item.id, 'completed', runtimeContext);
        return;
      }

      await this.handleWorkerExit(entry.item.id, 'failed', runtimeContext);
    } catch (err) {
      await this.workspaceManager.afterRun(entry.workspacePath);
      this.logger.error('runtime.worker.crashed', {
        issue_id: entry.item.id,
        issue_identifier: entry.item.identifier,
        error: err instanceof Error ? err.message : String(err),
      });
      await this.handleWorkerExit(entry.item.id, 'failed', {
        sessionId: this.running.get(itemId)?.sessionId,
      });
    }
  }

  private getPromptTemplate(): string {
    return (this.workflow as { prompt_template?: string }).prompt_template ??
      'Solve the issue represented by {{ issue.title }} with context and report status.';
  }

  private toRuntimeObservationContext(result?: CodexTurnResult): RuntimeObservationContext {
    if (!result) {
      return {};
    }

    return {
      sessionId: result.state.sessionId,
      usage: {
        inputTokens: result.state.usage.inputTokens,
        outputTokens: result.state.usage.outputTokens,
        totalTokens: result.state.usage.totalTokens,
      },
      rateLimit:
        result.status === 'rate_limited'
          ? {
              code: 'rate_limited',
              message: result.errorMessage,
              resetAt: result.state.latestRateLimitAt
                ? new Date(result.state.latestRateLimitAt).toISOString()
                : undefined,
            }
          : undefined,
    };
  }

  private buildDefaultWorker(context: {
    item: NormalizedWorkItem;
    workspacePath: string;
    attempt: number | null;
    workflow: WorkflowContract;
  }): RuntimeWorker {
    const client = new CodexAppServerClient({
      cwd: context.workspacePath,
      command: context.workflow.agent?.command,
      args: context.workflow.agent?.args,
      maxTurns: context.workflow.agent?.maxTurns,
      turnTimeoutMs: context.workflow.agent?.timeouts?.turnTimeoutMs,
      readTimeoutMs: context.workflow.agent?.timeouts?.readTimeoutMs,
      stallTimeoutMs: context.workflow.agent?.timeouts?.stallTimeoutMs,
    });

    return {
      run: async () => {
        const prompt = await renderPromptTemplate(
          (context.workflow as { prompt_template?: string }).prompt_template ?? this.getPromptTemplate(),
          {
            issue: context.item,
            attempt: context.attempt,
          },
        );
        return client.run({
          renderedPrompt: prompt,
          identifier: context.item.identifier,
          title: context.item.title,
          continuationGuidance:
            context.attempt === null
              ? undefined
              : `Retry attempt ${context.attempt}. Continue from prior work and finish the task.`,
        });
      },
      cancel: () => client.cancelCurrentRun(),
    };
  }

  private async killRunning(itemId: string, options: { clearRetry?: boolean; reason?: string }): Promise<void> {
    const runningEntry = this.running.get(itemId);
    if (!runningEntry) return;

    const { worker, workspacePath } = runningEntry;
    worker?.cancel();

    this.running.delete(itemId);
    this.claimed.delete(itemId);

    if (options.clearRetry) {
      this.clearRetry(itemId);
    }

    this.logger.info('runtime.transition.worker_cancelled', {
      issue_id: itemId,
      issue_identifier: runningEntry.item.identifier,
      reason: options.reason,
      workspace_path: workspacePath,
    });
  }

  private async cleanupWorkspaceForTerminalEntry(workspacePath: string): Promise<void> {
    try {
      await this.workspaceManager.cleanupWorkspace(workspacePath);
    } catch {
      this.logger.warn('runtime.transition.workspace_cleanup_failed', {
        workspace_path: workspacePath,
      });
    }
  }

  private scheduleRetry(
    item: NormalizedWorkItem,
    kind: 'continuation' | 'failure',
    reason: string,
    error?: string,
  ): void {
    const itemId = item.id;
    const current = this.retry.get(itemId);
    if (current?.timer) {
      clearTimeout(current.timer);
    }

    const attempt = (current?.attempt ?? 0) + 1;
    // Failure retry formula: min(base * multiplier^(attempt-1), max_retry_backoff_ms)
    // Default base=10000, multiplier=2 → 10s, 20s, 40s, … capped at max_retry_backoff_ms.
    const delay =
      kind === 'continuation'
        ? this.continuationRetryDelayMs
        : Math.min(
            this.failureRetryMaxDelayMs,
            Math.floor(this.failureRetryBaseDelayMs * this.failureRetryMultiplier ** Math.max(0, attempt - 1)),
          );

    const dueAt = this.now() + delay;
    const timer = setTimeout(() => {
      void this.onRetryFire(item.id);
    }, delay);
    // Unref so pending retry timers do not prevent process exit (e.g. in tests).
    timer.unref();

    const next: RetryEntry = {
      issueId: item.id,
      identifier: item.identifier ?? `#${item.number ?? item.id}`,
      item,
      attempt,
      dueAt,
      timer,
      error,
      kind,
    };

    this.retry.set(itemId, next);
    this.logger.info('runtime.transition.retry', {
      issue_id: next.issueId,
      issue_identifier: next.identifier,
      reason,
      retry_attempt: next.attempt,
      due_at: new Date(next.dueAt).toISOString(),
      nextEligibleInMs: delay,
      kind,
      error,
    });
  }

  private clearRetry(itemId: string): void {
    const existing = this.retry.get(itemId);
    if (existing?.timer) {
      clearTimeout(existing.timer);
    }
    this.retry.delete(itemId);
  }

  private isDispatchable(itemId: string): boolean {
    if (this.completed.has(itemId)) return false;
    if (this.claimed.has(itemId)) return false;
    if (this.running.has(itemId)) return false;

    const retry = this.retry.get(itemId);
    if (!retry) return true;
    return this.now() >= retry.dueAt;
  }

  private resolveMaxConcurrency(): number {
    const configured = this.workflow.polling?.maxConcurrency ?? this.workflow.runtime?.maxConcurrency;
    if (typeof configured !== 'number' || !Number.isFinite(configured)) {
      return 1;
    }
    return Math.max(0, Math.floor(configured));
  }

  private resolveMaxConcurrencyByState(): Partial<Record<WorkItemState, number>> {
    const raw = (this.workflow.extensions?.github_projects as Record<string, unknown> | undefined)
      ?.max_concurrent_agents_by_state;
    if (!raw || typeof raw !== 'object') return {};

    const result: Partial<Record<WorkItemState, number>> = {};
    for (const state of ['todo', 'in_progress', 'blocked', 'done'] as const) {
      const value = (raw as Record<string, unknown>)[state];
      if (typeof value !== 'number' || !Number.isFinite(value)) continue;
      result[state] = Math.max(0, Math.floor(value));
    }
    return result;
  }

  private hasStateCapacity(state: WorkItemState): boolean {
    const limit = this.resolveMaxConcurrencyByState()[state];
    if (typeof limit !== 'number') return true;

    let runningInState = 0;
    for (const entry of this.running.values()) {
      if (entry.item.state === state) {
        runningInState += 1;
      }
    }

    return runningInState < limit;
  }

  private async findTodoItemsBlockedByNonTerminal(items: NormalizedWorkItem[]): Promise<Set<string>> {
    const withBlockers = items.filter((item) => item.state === 'todo' && (item.blocked_by?.length ?? 0) > 0);
    if (withBlockers.length === 0) return new Set();

    const blockerIds = [...new Set(withBlockers.flatMap((item) => item.blocked_by ?? []))];
    const states = await this.tracker.getStatesByIds(blockerIds);

    const blocked = new Set<string>();
    for (const item of withBlockers) {
      const hasNonTerminal = (item.blocked_by ?? []).some((id) => !this.isTerminalState(states[id]));
      if (hasNonTerminal) {
        blocked.add(item.id);
      }
    }

    return blocked;
  }

  private async isTodoBlockedByNonTerminal(item: NormalizedWorkItem): Promise<boolean> {
    if (item.state !== 'todo' || (item.blocked_by?.length ?? 0) === 0) {
      return false;
    }

    const states = await this.tracker.getStatesByIds(item.blocked_by ?? []);
    return (item.blocked_by ?? []).some((id) => !this.isTerminalState(states[id]));
  }

  private shouldMarkDoneOnCompletion(): boolean {
    const value = (this.workflow.extensions?.github_projects as Record<string, unknown> | undefined)
      ?.mark_done_on_completion;
    return value === true;
  }

  private isActiveState(state: WorkItemState | undefined): boolean {
    if (!state) return false;
    return this.resolveActiveStates().has(normalizeStateKey(state));
  }

  private isTerminalState(state: WorkItemState | undefined): boolean {
    if (!state) return false;
    return this.resolveTerminalStates().has(normalizeStateKey(state));
  }

  private resolveActiveStates(): Set<string> {
    const defaults = ['todo', 'in_progress', 'blocked'];
    return this.resolveConfiguredStates('active_states', defaults);
  }

  private resolveTerminalStates(): Set<string> {
    const defaults = ['done'];
    return this.resolveConfiguredStates('terminal_states', defaults);
  }

  private resolveConfiguredStates(key: 'active_states' | 'terminal_states', defaults: string[]): Set<string> {
    const raw = (this.workflow.extensions?.github_projects as Record<string, unknown> | undefined)?.[key];
    if (!Array.isArray(raw)) {
      return new Set(defaults);
    }

    const normalized = raw
      .filter((value): value is string => typeof value === 'string')
      .map((value) => normalizeStateKey(value))
      .filter((value) => value.length > 0);

    if (normalized.length === 0) {
      return new Set(defaults);
    }

    return new Set(normalized);
  }
}

function toIntOrZero(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) return 0;
  return Math.floor(value);
}

function sanitizeRateLimit(payload: RuntimeRateLimitSnapshot): RuntimeRateLimitSnapshot {
  return {
    code: typeof payload.code === 'string' && payload.code.trim() ? payload.code : undefined,
    resetAt: typeof payload.resetAt === 'string' && payload.resetAt.trim() ? payload.resetAt : undefined,
    retryAfterMs: toIntOrZero(payload.retryAfterMs),
    message: typeof payload.message === 'string' && payload.message.trim() ? payload.message : undefined,
    raw: payload.raw,
  };
}

function defaultCommandExists(command: string): boolean {
  const binary = command.trim().split(/\s+/)[0];
  if (!binary) return false;

  const result = spawnSync('sh', ['-lc', `command -v ${shellQuote(binary)} >/dev/null 2>&1`], {
    stdio: 'ignore',
  });
  return result.status === 0;
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function normalizeStateKey(state: string): string {
  return state.trim().toLowerCase();
}

function sortCandidates(items: NormalizedWorkItem[]): NormalizedWorkItem[] {
  return [...items].sort((a, b) => {
    const pa = a.priority ?? Number.MAX_SAFE_INTEGER;
    const pb = b.priority ?? Number.MAX_SAFE_INTEGER;
    if (pa !== pb) return pa - pb;

    const ca = Date.parse(a.created_at ?? '');
    const cb = Date.parse(b.created_at ?? '');
    const caSafe = Number.isNaN(ca) ? Number.MAX_SAFE_INTEGER : ca;
    const cbSafe = Number.isNaN(cb) ? Number.MAX_SAFE_INTEGER : cb;
    if (caSafe !== cbSafe) return caSafe - cbSafe;

    const ia = a.identifier ?? '';
    const ib = b.identifier ?? '';
    if (ia !== ib) return ia.localeCompare(ib);

    return 0;
  });
}
