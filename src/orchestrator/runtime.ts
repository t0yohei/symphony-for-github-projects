import type { Logger } from '../logging/logger.js';
import { spawnSync } from 'node:child_process';
import { renderPromptTemplate } from '../prompt/template.js';
import { HookRunner } from '../workspace/hooks.js';
import { WorkspaceManager } from '../workspace/manager.js';
import type { NormalizedWorkItem, WorkItemState } from '../model/work-item.js';
import type { TrackerAdapter } from '../tracker/adapter.js';
import type { WorkflowContract } from '../workflow/contract.js';
import { CodexAppServerClient } from '../agent/codex-app-server.js';

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
  error?: string;
}

export interface RuntimeStateSnapshot {
  running: string[];
  claimed: string[];
  retryAttempts: Record<string, number>;
  completed: string[];
  runningDetails: Array<{ itemId: string; issueIdentifier: string; sessionId?: string; workspacePath?: string }>;
  retryingDetails: Array<{ itemId: string; issueIdentifier: string; attempt: number; kind: 'continuation' | 'failure'; dueAt: string }>;
  usageTotals: RuntimeUsageTotals;
  aggregateRuntimeSeconds: number;
  latestRateLimit?: RuntimeRateLimitSnapshot;
}

interface RuntimeWorker {
  run(params: { renderedPrompt: string; continuationGuidance: string }): Promise<{
    status: 'completed' | 'error' | 'rate_limited' | 'timeout' | 'stalled';
    activeIssue: boolean;
    errorMessage?: string;
    state: {
      sessionId?: string;
      usage?: {
        inputTokens?: number;
        outputTokens?: number;
        totalTokens?: number;
      };
      threadId?: string;
      turnId?: string;
    };
  }>;
  cancel(): void;
}

interface WorkerFactoryContext {
  item: NormalizedWorkItem;
  workspacePath: string;
  attempt: number | null;
  onEvent: (event: Record<string, unknown>) => void;
}

interface RunningEntry {
  item: NormalizedWorkItem;
  startedAt: number;
  lastEventAt: number;
  sessionId?: string;
  worker?: RuntimeWorker;
  workspacePath?: string;
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
  failureRetryMaxDelayMs?: number;
  env?: Record<string, string | undefined>;
  commandExists?: (command: string) => boolean;
  workerFactory?: (ctx: WorkerFactoryContext) => RuntimeWorker;
}

const DEFAULT_STALL_TIMEOUT_MS = 5 * 60 * 1000;
const DEFAULT_CONTINUATION_RETRY_DELAY_MS = 1_000;
const DEFAULT_FAILURE_RETRY_BASE_DELAY_MS = 1_000;
const DEFAULT_FAILURE_RETRY_MULTIPLIER = 2;
const DEFAULT_FAILURE_RETRY_MAX_DELAY_MS = 60_000;

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
  private readonly workerFactory?: (ctx: WorkerFactoryContext) => RuntimeWorker;
  private workflow: WorkflowContract;
  private readonly workspaceManager: WorkspaceManager;

  constructor(
    private readonly tracker: TrackerAdapter,
    workflow: WorkflowContract,
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
    this.failureRetryMaxDelayMs = options.failureRetryMaxDelayMs ?? DEFAULT_FAILURE_RETRY_MAX_DELAY_MS;
    this.env = options.env ?? process.env;
    this.commandExists = options.commandExists ?? defaultCommandExists;
    this.workerFactory = options.workerFactory;
    this.workspaceManager = this.createWorkspaceManager(workflow);
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
    this.stopWorker(itemId);

    if (result === 'completed') {
      const states = await this.tracker.getStatesByIds([itemId]);
      if (this.isTerminalState(states[itemId])) {
        this.completed.add(itemId);
        this.clearRetry(itemId);
        await this.cleanupWorkspace(entry.workspacePath);
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
        await this.cleanupWorkspace(entry.workspacePath);
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
        this.scheduleRetry(
          entry.item,
          'failure',
          'mark_done_failed',
          err instanceof Error ? err.message : String(err),
        );
        this.logger.warn('runtime.transition.mark_done_failed', {
          issue_id: entry.item.id,
          issue_identifier: entry.item.identifier,
          error: err instanceof Error ? err.message : String(err),
        });
        return;
      }
    }

    this.scheduleRetry(entry.item, 'failure', context?.error ? 'worker_exit_failed' : 'worker_exit_failed');
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
        workspacePath: entry.workspacePath,
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
    if (!github?.owner || !Number.isInteger(github.projectNumber) || github.projectNumber <= 0) {
      return {
        ok: false,
        context: {
          reason: 'tracker_config_invalid',
          owner: github?.owner,
          projectNumber: github?.projectNumber,
        },
      };
    }

    const tokenEnv = github.tokenEnv;
    if (typeof tokenEnv !== 'string' || tokenEnv.trim() === '') {
      return { ok: false, context: { reason: 'tracker_auth_env_missing' } };
    }

    const token = this.env[tokenEnv];
    if (!token || token.trim() === '') {
      return { ok: false, context: { reason: 'tracker_auth_token_unset', tokenEnv } };
    }

    const { command } = this.resolveAgentInvocation();
    if (typeof command !== 'string' || command.trim() === '') {
      return { ok: false, context: { reason: 'agent_command_missing' } };
    }

    if (!this.commandExists(command)) {
      return { ok: false, context: { reason: 'agent_command_not_found', command } };
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
          this.stopWorker(itemId);
          this.running.delete(itemId);
          this.claimed.delete(itemId);
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
        this.stopWorker(itemId);
        this.running.delete(itemId);
        this.claimed.delete(itemId);
        this.scheduleRetry(entry.item, 'failure', 'state_missing');
        continue;
      }

      if (this.isTerminalState(state)) {
        this.stopWorker(itemId);
        this.running.delete(itemId);
        this.claimed.delete(itemId);
        this.completed.add(itemId);
        this.clearRetry(itemId);
        await this.cleanupWorkspace(entry.workspacePath);
        this.logger.info('runtime.transition.reconcile_done', {
          issue_id: entry.item.id,
          issue_identifier: entry.item.identifier,
          session_id: entry.sessionId,
          state,
        });
        continue;
      }

      if (!this.isActiveState(state)) {
        this.stopWorker(itemId);
        this.running.delete(itemId);
        this.claimed.delete(itemId);
        this.clearRetry(itemId);
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
      this.scheduleRetry(eligible, 'continuation', 'retry_fire_no_slot');
      return;
    }

    if (!(await this.isTodoBlockedByNonTerminal(eligible))) {
      if (!this.hasStateCapacity(eligible.state)) {
        this.claimed.delete(itemId);
        this.scheduleRetry(eligible, 'continuation', 'retry_fire_state_capacity');
        return;
      }
      await this.dispatch(eligible);
      return;
    }

    this.claimed.delete(itemId);
    this.scheduleRetry(eligible, 'continuation', 'retry_fire_blocked_by_non_terminal');
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

    try {
      await this.tracker.markInProgress(item.id);
      const now = this.now();
      const entry: RunningEntry = {
        item,
        startedAt: now,
        lastEventAt: now,
      };
      this.running.set(item.id, entry);
      this.clearRetry(item.id);
      this.logger.info('runtime.transition.running', {
        issue_id: item.id,
        issue_identifier: item.identifier,
        session_id: undefined,
      });

      void this.executeWork(entry).catch((err) => {
        this.logger.warn('runtime.transition.worker_error', {
          issue_id: item.id,
          issue_identifier: item.identifier,
          error: err instanceof Error ? err.message : String(err),
        });
      });
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

  private async executeWork(entry: RunningEntry): Promise<void> {
    const item = entry.item;
    try {
      const workspace = await this.workspaceManager.prepareWorkspace(item.id);
      entry.workspacePath = workspace.path;

      await this.workspaceManager.beforeRun(entry.workspacePath);

      const attempt = this.retry.get(item.id)?.attempt ?? 0;
      const attemptValue = attempt > 0 ? attempt : null;
      const promptTemplate =
        (this.workflow as { prompt_template?: string }).prompt_template ?? 'Run issue {{ issue.identifier }}';

      const renderedPrompt = await renderPromptTemplate(promptTemplate, {
        issue: item,
        attempt: attemptValue,
      });

      this.markActivity(item.id);

      const worker = this.createWorker({
        item,
        workspacePath: entry.workspacePath,
        attempt: attemptValue,
        onEvent: () => {
          // no-op; hook for custom worker factories only
        },
      });
      entry.worker = worker;

      const result = await worker.run({
        renderedPrompt,
        continuationGuidance: 'Continue from the active issue and finish the task.',
      });

      await this.workspaceManager.afterRun(entry.workspacePath).catch((error) => {
        this.logger.warn('runtime.transition.after_run_failed', {
          issue_id: item.id,
          issue_identifier: item.identifier,
          error: error instanceof Error ? error.message : String(error),
        });
      });

      await this.handleWorkerExit(item.id, result.status === 'completed' ? 'completed' : 'failed', {
        sessionId: result.state.sessionId,
        usage: {
          inputTokens: result.state.usage?.inputTokens,
          outputTokens: result.state.usage?.outputTokens,
          totalTokens: result.state.usage?.totalTokens,
        },
        rateLimit:
          result.status === 'rate_limited'
            ? {
                message: result.errorMessage,
                code: 'rate_limited',
              }
            : undefined,
        error: result.errorMessage,
      });
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      this.logger.warn('runtime.transition.worker_start_failed', {
        issue_id: item.id,
        issue_identifier: item.identifier,
        error: errorMessage,
      });

      await this.handleWorkerExit(item.id, 'failed', {
        error: errorMessage,
      });
    }
  }

  private createWorker(ctx: WorkerFactoryContext): RuntimeWorker {
    if (this.workerFactory) {
      return this.workerFactory(ctx);
    }

    const invocation = this.resolveAgentInvocation();
    const timeoutConfig = this.resolveAgentTimeouts();

    return new CodexAppServerClient({
      cwd: ctx.workspacePath,
      env: this.env,
      command: invocation.command,
      args: invocation.args,
      maxTurns: timeoutConfig.maxTurns,
      turnTimeoutMs: timeoutConfig.turnTimeoutMs,
      readTimeoutMs: timeoutConfig.readTimeoutMs,
      stallTimeoutMs: timeoutConfig.stallTimeoutMs,
      onEvent: (event) => {
        const sessionId =
          (readPath(event, ['params.session_id']) as string | undefined) ??
          (readPath(event, ['params.thread_id']) as string | undefined);
        const usage = {
          inputTokens: readNumber(event, [
            'params.usage.input_tokens',
            'params.tokens.input',
            'usage.input_tokens',
            'tokens.input',
          ]),
          outputTokens: readNumber(event, [
            'params.usage.output_tokens',
            'params.tokens.output',
            'usage.output_tokens',
            'tokens.output',
          ]),
          totalTokens: readNumber(event, [
            'params.usage.total_tokens',
            'params.tokens.total',
            'usage.total_tokens',
            'tokens.total',
          ]),
        };

        const rateLimit = readBoolean(event, [
          'params.rate_limited',
          'rate_limited',
          'error.rate_limited',
        ])
          ? {
              message: readString(event, ['params.error.message', 'error.message']) ?? 'Rate limit reached',
              code: 'rate_limited',
            }
          : undefined;

        this.markActivity(ctx.item.id);
        this.observeSession(ctx.item.id, {
          sessionId,
          usage: {
            inputTokens: usage.inputTokens,
            outputTokens: usage.outputTokens,
            totalTokens: usage.totalTokens,
          },
          rateLimit,
        });

        ctx.onEvent(event);
      },
    });
  }

  private resolveAgentInvocation(): { command: string; args: string[] } {
    const commandSpec = this.workflow.agent.command ?? '';
    const configuredArgs = this.workflow.agent.args;
    const parts = commandSpec
      .trim()
      .split(/\s+/)
      .map((part) => part.trim())
      .filter(Boolean);

    if (configuredArgs && configuredArgs.length > 0) {
      return {
        command: parts[0] || 'codex',
        args: configuredArgs,
      };
    }

    if (parts.length === 0) {
      return {
        command: 'codex',
        args: ['app-server'],
      };
    }

    return {
      command: parts[0],
      args: parts.slice(1).length > 0 ? parts.slice(1) : ['app-server'],
    };
  }

  private resolveAgentTimeouts(): {
    maxTurns?: number;
    turnTimeoutMs?: number;
    readTimeoutMs?: number;
    stallTimeoutMs?: number;
  } {
    return {
      maxTurns: this.workflow.agent?.maxTurns,
      turnTimeoutMs: this.workflow.agent?.timeouts?.turnTimeoutMs,
      readTimeoutMs: this.workflow.agent?.timeouts?.readTimeoutMs,
      stallTimeoutMs: this.workflow.agent?.timeouts?.stallTimeoutMs,
    };
  }

  private stopWorker(itemId: string): void {
    const entry = this.running.get(itemId);
    if (!entry?.worker) {
      return;
    }
    entry.worker.cancel();
    entry.worker = undefined;
  }

  private async cleanupWorkspace(workspacePath?: string): Promise<void> {
    if (!workspacePath) return;
    try {
      await this.workspaceManager.cleanupWorkspace(workspacePath);
    } catch (error) {
      this.logger.warn('runtime.workspace.cleanup_failed', {
        workspacePath,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  private createWorkspaceManager(workflow: WorkflowContract): WorkspaceManager {
    const workspaceRoot = workflow.workspace?.root ?? workflow.workspace?.baseDir;
    if (!workspaceRoot) {
      throw new Error('workflow.workspace.root is required');
    }

    const hooks = this.resolveWorkspaceHooks(workflow);
    return new WorkspaceManager({
      workspaceRoot,
      hooks: hooks ? new HookRunner({ hooks, logger: this.logger }) : undefined,
    });
  }

  private resolveWorkspaceHooks(workflow: WorkflowContract): {
    after_create?: string;
    before_run?: string;
    after_run?: string;
    before_remove?: string;
  } | undefined {
    if (!workflow.hooks) return undefined;

    const afterRun = [
      workflow.hooks.after_run,
      workflow.hooks.onSuccess,
      workflow.hooks.onFailure,
    ]
      .filter((value): value is string => typeof value === 'string' && value.trim().length > 0)
      .join('\n');

    return {
      after_create: workflow.hooks.after_create,
      before_run: workflow.hooks.before_run ?? workflow.hooks.onStart,
      after_run: afterRun.length > 0 ? afterRun : undefined,
      before_remove: workflow.hooks.before_remove,
    };
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
    const delay =
      kind === 'continuation'
        ? this.continuationRetryDelayMs
        : Math.min(
            this.failureRetryMaxDelayMs,
            Math.floor(this.failureRetryBaseDelayMs * this.failureRetryMultiplier ** Math.max(0, attempt - 1)),
          );

    const dueAt = this.now() + delay;
    const next: RetryEntry = {
      issueId: item.id,
      identifier: item.identifier ?? `#${item.number ?? item.id}`,
      item,
      attempt,
      dueAt,
      timer: setTimeout(() => {
        void this.onRetryFire(item.id);
      }, delay),
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
    return this.resolveConfiguredStates('active_states', ['todo', 'in_progress', 'blocked']).has(normalizeStateKey(state));
  }

  private isTerminalState(state: WorkItemState | undefined): boolean {
    if (!state) return false;
    return this.resolveConfiguredStates('terminal_states', ['done']).has(normalizeStateKey(state));
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

function readPath(event: Record<string, unknown>, path: string | string[]): unknown {
  const parts = Array.isArray(path) ? path : path.split('.');
  let current: unknown = event;
  for (const part of parts) {
    if (typeof current !== 'object' || current === null) {
      return undefined;
    }
    current = (current as Record<string, unknown>)[part];
  }
  return current;
}

function readString(event: Record<string, unknown>, paths: string[]): string | undefined {
  for (const path of paths) {
    const value = readPath(event, path);
    if (typeof value === 'string' && value.trim() !== '') {
      return value;
    }
  }
  return undefined;
}

function readNumber(event: Record<string, unknown>, paths: string[]): number | undefined {
  for (const path of paths) {
    const value = readPath(event, path);
    if (typeof value === 'number' && Number.isFinite(value)) {
      return value;
    }
  }
  return undefined;
}

function readBoolean(event: Record<string, unknown>, paths: string[]): boolean | undefined {
  for (const path of paths) {
    const value = readPath(event, path);
    if (typeof value === 'boolean') {
      return value;
    }
  }
  return undefined;
}
