import { EventEmitter } from 'node:events';
import type { ChildProcess } from 'node:child_process';
import { spawn as nodeSpawn } from 'node:child_process';

export interface CodexUsageCounters {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
}

export interface CodexSessionState {
  sessionId?: string;
  threadId?: string;
  turnId?: string;
  turnsStarted: number;
  turnsCompleted: number;
  usage: CodexUsageCounters;
  /** Elapsed wall-clock time in seconds from when run() was called to the most recent snapshot. */
  runtimeSeconds: number;
  /** Unix timestamp (ms) of the most recent rate-limit signal, or undefined if none was observed. */
  latestRateLimitAt?: number;
}

export interface CodexTurnResult {
  status: 'completed' | 'error' | 'rate_limited' | 'timeout' | 'stalled' | 'cancelled';
  activeIssue: boolean;
  state: CodexSessionState;
  errorMessage?: string;
}

export interface RunTurnParams {
  renderedPrompt: string;
  continuationGuidance?: string;
  /** Short identifier for the work item (e.g. "ISSUE-71"). Combined with title as "<identifier>: <title>". */
  identifier?: string;
  /** Human-readable title for the thread. Combined with identifier as "<identifier>: <title>". */
  title?: string;
}

export interface CodexAppServerClientOptions {
  cwd: string;
  env?: NodeJS.ProcessEnv;
  command?: string;
  args?: string[];
  maxTurns?: number;
  turnTimeoutMs?: number;
  readTimeoutMs?: number;
  stallTimeoutMs?: number;
  spawn?: SpawnLike;
}

interface JsonRpcEvent {
  [key: string]: unknown;
}

interface ChildProcessLike extends EventEmitter {
  stdin: {
    write(chunk: string | Buffer): boolean;
    end(): void;
  } | null;
  stdout: EventEmitter | null;
  stderr: EventEmitter | null;
  kill(signal?: NodeJS.Signals | number): boolean;
}

type SpawnLike = (
  command: string,
  args: string[],
  options: {
    cwd: string;
    env: NodeJS.ProcessEnv;
    stdio: ['pipe', 'pipe', 'pipe'];
  },
) => ChildProcessLike;

/**
 * Default maximum number of agent turns per run().
 * Aligns with Symphony SPEC multi-turn contract: agents may need up to 3 turns
 * for complex tasks while keeping per-issue resource usage bounded.
 */
const DEFAULT_MAX_TURNS = 3;

/**
 * Default per-turn wall-clock timeout (ms).
 * Matches the WORKFLOW.md hooks.timeout_ms recommendation (120 s).
 * Raise for exceptionally long-running code generation tasks.
 */
const DEFAULT_TURN_TIMEOUT_MS = 120_000;

/**
 * Default read (poll) interval for the completion-wait loop (ms).
 * Low enough to detect completion promptly; not so low as to busy-spin.
 */
const DEFAULT_READ_TIMEOUT_MS = 10_000;

/**
 * Default stall timeout (ms): time since the last stdout/stderr event before
 * the turn is considered hung. 30 s gives the agent headroom for slow model
 * responses while still bounding deadlock scenarios.
 */
const DEFAULT_STALL_TIMEOUT_MS = 30_000;

/** Format the thread title as "<identifier>: <title>" when both are provided. */
function formatThreadTitle(identifier?: string, title?: string): string | undefined {
  const parts = [identifier, title].filter((p): p is string => typeof p === 'string' && p.trim() !== '');
  return parts.length > 0 ? parts.join(': ') : undefined;
}

export class CodexAppServerClient {
  private activeProcess: ChildProcessLike | undefined;
  private readonly state: CodexSessionState = {
    sessionId: undefined,
    threadId: undefined,
    turnId: undefined,
    turnsStarted: 0,
    turnsCompleted: 0,
    usage: {
      inputTokens: 0,
      outputTokens: 0,
      totalTokens: 0,
    },
    runtimeSeconds: 0,
    latestRateLimitAt: undefined,
  };

  /** Timestamp (ms) when run() was invoked; set at the start of each run. */
  private runStartedAt: number | undefined;

  private readonly maxTurns: number;
  private readonly turnTimeoutMs: number;
  private readonly readTimeoutMs: number;
  private readonly stallTimeoutMs: number;
  private readonly command: string;
  private readonly args: string[];
  private readonly spawnProc: SpawnLike;

  constructor(private readonly options: CodexAppServerClientOptions) {
    this.maxTurns = options.maxTurns ?? DEFAULT_MAX_TURNS;
    this.turnTimeoutMs = options.turnTimeoutMs ?? DEFAULT_TURN_TIMEOUT_MS;
    this.readTimeoutMs = options.readTimeoutMs ?? DEFAULT_READ_TIMEOUT_MS;
    this.stallTimeoutMs = options.stallTimeoutMs ?? DEFAULT_STALL_TIMEOUT_MS;
    this.command = options.command ?? 'codex';
    this.args = options.args ?? ['app-server'];
    this.spawnProc =
      options.spawn ??
      ((command, args, spawnOptions) =>
        nodeSpawn(
          command,
          args,
          spawnOptions as unknown as Parameters<typeof nodeSpawn>[2],
        ) as ChildProcess);
  }

  async run(params: RunTurnParams): Promise<CodexTurnResult> {
    this.runStartedAt = Date.now();

    const child = this.spawnProc(this.command, this.args, {
      cwd: this.options.cwd,
      env: {
        ...process.env,
        ...(this.options.env ?? {}),
      },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    this.activeProcess = child;

    let lineBuffer = '';
    let latestEventAt = Date.now();
    let completed = false;
    let cancelled = false;
    let activeIssue = false;
    let errorMessage: string | undefined;
    let initialized = false;

    child.stdout?.on('data', (chunk: Buffer | string) => {
      latestEventAt = Date.now();
      lineBuffer += chunk.toString();
      let idx = lineBuffer.indexOf('\n');
      while (idx >= 0) {
        const line = lineBuffer.slice(0, idx).trim();
        lineBuffer = lineBuffer.slice(idx + 1);
        if (line !== '') {
          this.handleEventLine(line, (event) => {
            this.applyEvent(event);

            const initializedFlag = readBoolean(event, [
              'params.initialized',
              'initialized',
              'params.ready',
              'ready',
            ]);
            if (initializedFlag === true || this.isInitializedEvent(event)) {
              initialized = true;
            }

            const completedFlag = readBoolean(event, [
              'params.turn.completed',
              'params.completed',
              'turn.completed',
              'completed',
            ]);
            if (completedFlag) {
              completed = true;
              this.state.turnsCompleted += 1;
            }

            const cancelledFlag = readBoolean(event, [
              'params.turn.cancelled',
              'params.cancelled',
              'turn.cancelled',
              'cancelled',
            ]);
            if (cancelledFlag) {
              cancelled = true;
            }

            const activeIssueFlag = readBoolean(event, [
              'params.turn.active_issue',
              'params.active_issue',
              'turn.active_issue',
              'active_issue',
            ]);
            if (activeIssueFlag !== undefined) {
              activeIssue = activeIssueFlag;
            }
            const rateLimited = readBoolean(event, [
              'params.rate_limited',
              'rate_limited',
              'error.rate_limited',
            ]);
            if (rateLimited) {
              errorMessage =
                readString(event, ['params.error.message', 'error.message']) ?? 'rate limited';
            }
            const eventError = readString(event, ['params.error.message', 'error.message']);
            if (eventError) {
              errorMessage = eventError;
            }
          });
        }
        idx = lineBuffer.indexOf('\n');
      }
    });

    child.stderr?.on('data', (chunk: Buffer | string) => {
      const text = chunk.toString().trim();
      if (text !== '') {
        errorMessage = text;
      }
    });

    child.on('exit', () => {
      if (this.activeProcess === child) {
        this.activeProcess = undefined;
      }
    });

    if (!child.stdin) {
      throw new Error('codex app-server stdin is not available');
    }

    // Step 1: Send initialize with workspace cwd to establish the protocol session.
    const initializeParams: Record<string, unknown> = {
      cwd: this.options.cwd,
      clientInfo: {
        name: 'symphony-github-projects',
        version: '0.1.0',
      },
      capabilities: {},
    };
    child.stdin.write(`${JSON.stringify({ method: 'initialize', params: initializeParams })}\n`);

    const initOutcome = await waitForUntil({
      isDone: () => initialized,
      hasError: () => errorMessage,
      latestEventAt: () => latestEventAt,
      turnTimeoutMs: this.turnTimeoutMs,
      readTimeoutMs: this.readTimeoutMs,
      stallTimeoutMs: this.stallTimeoutMs,
    });

    if (initOutcome === 'stalled') {
      child.kill('SIGTERM');
      return { status: 'stalled', activeIssue: false, state: this.snapshotState() };
    }
    if (initOutcome === 'timeout') {
      child.kill('SIGTERM');
      return { status: 'timeout', activeIssue: false, state: this.snapshotState() };
    }
    if (errorMessage) {
      const status = /rate\s*limit/i.test(errorMessage) ? 'rate_limited' : 'error';
      child.kill('SIGTERM');
      return {
        status,
        activeIssue: false,
        state: this.snapshotState(),
        errorMessage,
      };
    }

    // Step 2: Send thread/start. Reuse an existing thread for continuation turns,
    // or start a new one. Always include cwd and title for protocol compatibility.
    const threadTitle = formatThreadTitle(params.identifier, params.title);
    const threadStartParams: Record<string, string> = {
      prompt: params.renderedPrompt,
      cwd: this.options.cwd,
    };
    if (threadTitle !== undefined) {
      threadStartParams.title = threadTitle;
    }
    if (this.state.threadId) {
      threadStartParams.thread_id = this.state.threadId;
    }

    child.stdin.write(`${JSON.stringify({ method: 'thread.start', params: threadStartParams })}\n`);

    // Step 3: Run turns within the thread.
    for (let turn = 1; turn <= this.maxTurns; turn += 1) {
      const message =
        turn === 1
          ? params.renderedPrompt
          : (params.continuationGuidance ?? 'Continue from the active issue and finish the task.');

      const turnParams: Record<string, string | number> = {
        message,
        turn,
      };
      if (this.state.threadId) {
        turnParams.thread_id = this.state.threadId;
      }

      const turnStartMessage = JSON.stringify({
        method: 'turn.start',
        params: turnParams,
      });
      this.state.turnsStarted += 1;
      child.stdin.write(`${turnStartMessage}\n`);

      const turnOutcome = await waitForUntil({
        isDone: () => completed || cancelled,
        hasError: () => errorMessage,
        latestEventAt: () => latestEventAt,
        turnTimeoutMs: this.turnTimeoutMs,
        readTimeoutMs: this.readTimeoutMs,
        stallTimeoutMs: this.stallTimeoutMs,
      });

      if (turnOutcome === 'stalled') {
        child.kill('SIGTERM');
        return { status: 'stalled', activeIssue: false, state: this.snapshotState() };
      }
      if (turnOutcome === 'timeout') {
        child.kill('SIGTERM');
        return { status: 'timeout', activeIssue: false, state: this.snapshotState() };
      }
      if (errorMessage) {
        const status = /rate\s*limit/i.test(errorMessage) ? 'rate_limited' : 'error';
        child.kill('SIGTERM');
        return {
          status,
          activeIssue: false,
          state: this.snapshotState(),
          errorMessage,
        };
      }

      // Explicit cancel: the server signalled the turn was cancelled.
      if (cancelled) {
        child.stdin?.end();
        child.kill('SIGTERM');
        return {
          status: 'cancelled',
          activeIssue: false,
          state: this.snapshotState(),
        };
      }

      completed = false;
      if (!activeIssue) {
        child.stdin?.end();
        child.kill('SIGTERM');
        return {
          status: 'completed',
          activeIssue: false,
          state: this.snapshotState(),
        };
      }
    }

    child.stdin?.end();
    child.kill('SIGTERM');
    return {
      status: 'completed',
      activeIssue: true,
      state: this.snapshotState(),
    };
  }

  private isInitializedEvent(event: JsonRpcEvent): boolean {
    const method = readString(event, ['method', 'event', 'type']);
    return method === 'initialized' || method === 'initialize.done';
  }

  private handleEventLine(line: string, onEvent: (event: JsonRpcEvent) => void): void {
    try {
      const parsed = JSON.parse(line) as JsonRpcEvent;
      onEvent(parsed);
    } catch {
      // Ignore non-JSON log lines.
    }
  }

  private applyEvent(event: JsonRpcEvent): void {
    this.state.sessionId =
      readString(event, ['params.session_id', 'session_id']) ?? this.state.sessionId;
    this.state.threadId =
      readString(event, ['params.thread_id', 'thread_id']) ?? this.state.threadId;
    this.state.turnId = readString(event, ['params.turn_id', 'turn_id']) ?? this.state.turnId;

    if (!this.state.sessionId && this.state.threadId) {
      this.state.sessionId = `thread:${this.state.threadId}`;
    }

    const inputTokens = readNumber(event, [
      'params.usage.input_tokens',
      'params.tokens.input',
      'usage.input_tokens',
      'tokens.input',
    ]);
    const outputTokens = readNumber(event, [
      'params.usage.output_tokens',
      'params.tokens.output',
      'usage.output_tokens',
      'tokens.output',
    ]);
    const totalTokens = readNumber(event, [
      'params.usage.total_tokens',
      'params.tokens.total',
      'usage.total_tokens',
      'tokens.total',
    ]);

    if (inputTokens !== undefined) {
      this.state.usage.inputTokens = Math.max(this.state.usage.inputTokens, inputTokens);
    }
    if (outputTokens !== undefined) {
      this.state.usage.outputTokens = Math.max(this.state.usage.outputTokens, outputTokens);
    }
    if (totalTokens !== undefined) {
      this.state.usage.totalTokens = Math.max(this.state.usage.totalTokens, totalTokens);
    } else {
      this.state.usage.totalTokens = this.state.usage.inputTokens + this.state.usage.outputTokens;
    }

    // Track the most recent rate-limit signal for reporting/backoff consumers.
    const rateLimited = readBoolean(event, [
      'params.rate_limited',
      'rate_limited',
      'error.rate_limited',
    ]);
    if (rateLimited) {
      this.state.latestRateLimitAt = Date.now();
    }
  }

  cancelCurrentRun(): boolean {
    const processRef = this.activeProcess;
    if (!processRef) {
      return false;
    }

    processRef.kill('SIGTERM');
    return true;
  }

  private snapshotState(): CodexSessionState {
    const runtimeSeconds =
      this.runStartedAt !== undefined
        ? (Date.now() - this.runStartedAt) / 1000
        : 0;

    return {
      sessionId: this.state.sessionId,
      threadId: this.state.threadId,
      turnId: this.state.turnId,
      turnsStarted: this.state.turnsStarted,
      turnsCompleted: this.state.turnsCompleted,
      usage: {
        inputTokens: this.state.usage.inputTokens,
        outputTokens: this.state.usage.outputTokens,
        totalTokens: this.state.usage.totalTokens,
      },
      runtimeSeconds,
      latestRateLimitAt: this.state.latestRateLimitAt,
    };
  }
}

async function waitForUntil(params: {
  isDone: () => boolean;
  hasError: () => string | undefined;
  latestEventAt: () => number;
  turnTimeoutMs: number;
  readTimeoutMs: number;
  stallTimeoutMs: number;
}): Promise<'completed' | 'timeout' | 'stalled' | 'error'> {
  const startedAt = Date.now();
  while (true) {
    if (params.hasError()) {
      return 'error';
    }
    if (params.isDone()) {
      return 'completed';
    }

    const now = Date.now();
    if (now - startedAt > params.turnTimeoutMs) {
      return 'timeout';
    }
    if (now - params.latestEventAt() > params.stallTimeoutMs) {
      return 'stalled';
    }

    await sleep(Math.min(params.readTimeoutMs, 250));
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function readString(event: JsonRpcEvent, paths: string[]): string | undefined {
  for (const path of paths) {
    const value = readPath(event, path);
    if (typeof value === 'string' && value.trim() !== '') {
      return value;
    }
  }
  return undefined;
}

function readNumber(event: JsonRpcEvent, paths: string[]): number | undefined {
  for (const path of paths) {
    const value = readPath(event, path);
    if (typeof value === 'number' && Number.isFinite(value)) {
      return value;
    }
  }
  return undefined;
}

function readBoolean(event: JsonRpcEvent, paths: string[]): boolean | undefined {
  for (const path of paths) {
    const value = readPath(event, path);
    if (typeof value === 'boolean') {
      return value;
    }
  }
  return undefined;
}

function readPath(event: JsonRpcEvent, path: string): unknown {
  const parts = path.split('.');
  let current: unknown = event;
  for (const part of parts) {
    if (typeof current !== 'object' || current === null) {
      return undefined;
    }
    current = (current as Record<string, unknown>)[part];
  }
  return current;
}
