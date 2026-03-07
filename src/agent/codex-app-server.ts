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
}

export interface CodexTurnResult {
  status: 'completed' | 'error' | 'rate_limited' | 'timeout' | 'stalled';
  activeIssue: boolean;
  state: CodexSessionState;
  errorMessage?: string;
}

export interface RunTurnParams {
  renderedPrompt: string;
  continuationGuidance?: string;
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
  onEvent?: (event: Record<string, unknown>) => void;
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

const DEFAULT_MAX_TURNS = 3;
const DEFAULT_TURN_TIMEOUT_MS = 120_000;
const DEFAULT_READ_TIMEOUT_MS = 10_000;
const DEFAULT_STALL_TIMEOUT_MS = 30_000;

export class CodexAppServerClient {
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
  };

  private readonly maxTurns: number;
  private readonly turnTimeoutMs: number;
  private readonly readTimeoutMs: number;
  private readonly stallTimeoutMs: number;
  private readonly command: string;
  private readonly args: string[];
  private readonly spawnProc: SpawnLike;
  private readonly onEvent?: (event: Record<string, unknown>) => void;
  private activeProcess?: ChildProcessLike;

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
    this.onEvent = options.onEvent;
  }

  run(params: RunTurnParams): Promise<CodexTurnResult> {
    let child: ChildProcessLike;
    let lineBuffer = '';
    let latestEventAt = Date.now();
    let completed = false;
    let activeIssue = false;
    let errorMessage: string | undefined;
    let initialized = false;

    this.activeProcess = undefined;

    const emitEvent = (event: JsonRpcEvent): void => {
      try {
        this.applyEvent(event);
      } catch {
        // no-op
      }

      if (this.onEvent) {
        this.onEvent(event);
      }
    };


    const handleMessage = (line: string): void => {
      const trimmed = line.trim();
      if (trimmed === '') return;
      try {
        const parsed = JSON.parse(trimmed) as JsonRpcEvent;
        emitEvent(parsed);

        const initializedFlag = readBoolean(parsed, [
          'params.initialized',
          'initialized',
          'params.ready',
          'ready',
        ]);
        if (initializedFlag === true || this.isInitializedEvent(parsed)) {
          initialized = true;
        }

        const completedFlag = readBoolean(parsed, [
          'params.turn.completed',
          'params.completed',
          'turn.completed',
          'completed',
        ]);
        if (completedFlag) {
          completed = true;
          this.state.turnsCompleted += 1;
        }

        const activeIssueFlag = readBoolean(parsed, [
          'params.turn.active_issue',
          'params.active_issue',
          'turn.active_issue',
          'active_issue',
        ]);
        if (activeIssueFlag !== undefined) {
          activeIssue = activeIssueFlag;
        }

        const rateLimited = readBoolean(parsed, [
          'params.rate_limited',
          'rate_limited',
          'error.rate_limited',
        ]);
        if (rateLimited) {
          errorMessage =
            readString(parsed, ['params.error.message', 'error.message']) ?? 'rate limited';
        }

        const eventError = readString(parsed, ['params.error.message', 'error.message']);
        if (eventError) {
          errorMessage = eventError;
        }
      } catch {
        // Ignore non-JSON log lines.
      }
    };

    const processLine = (chunk: Buffer | string): void => {
      latestEventAt = Date.now();
      lineBuffer += chunk.toString();
      let idx = lineBuffer.indexOf('\n');
      while (idx >= 0) {
        const line = lineBuffer.slice(0, idx);
        lineBuffer = lineBuffer.slice(idx + 1);
        handleMessage(line);
        idx = lineBuffer.indexOf('\n');
      }
    };

    const runLoop = async (): Promise<CodexTurnResult> => {
      child = this.spawnProc(this.command, this.args, {
        cwd: this.options.cwd,
        env: {
          ...process.env,
          ...(this.options.env ?? {}),
        },
        stdio: ['pipe', 'pipe', 'pipe'],
      });

      this.activeProcess = child;

      child.stdout?.on('data', processLine);
      child.stderr?.on('data', (chunk: Buffer | string) => {
        latestEventAt = Date.now();
        const text = chunk.toString().trim();
        if (text !== '') {
          errorMessage = text;
        }
      });

      if (!child.stdin) {
        throw new Error('codex app-server stdin is not available');
      }

      child.stdin.write(`${JSON.stringify({ method: 'initialize', params: {} })}\n`);

      const initOutcome = await waitForUntil({
        isDone: () => initialized,
        hasError: () => errorMessage,
        latestEventAt: () => latestEventAt,
        turnTimeoutMs: this.turnTimeoutMs,
        readTimeoutMs: this.readTimeoutMs,
        stallTimeoutMs: this.stallTimeoutMs,
      });

      if (initOutcome === 'stalled') {
        this.terminate(child, 'stalled');
        return { status: 'stalled', activeIssue: false, state: this.snapshotState(), errorMessage: 'startup stalled' };
      }
      if (initOutcome === 'timeout') {
        this.terminate(child, 'timeout');
        return { status: 'timeout', activeIssue: false, state: this.snapshotState(), errorMessage: 'startup timeout' };
      }
      if (errorMessage) {
        const status = /rate\s*limit/i.test(errorMessage) ? 'rate_limited' : 'error';
        this.terminate(child, 'initialization error');
        return {
          status,
          activeIssue: false,
          state: this.snapshotState(),
          errorMessage,
        };
      }

      const threadStartParams: Record<string, string> = {
        prompt: params.renderedPrompt,
      };
      if (this.state.threadId) {
        threadStartParams.thread_id = this.state.threadId;
      }

      child.stdin.write(`${JSON.stringify({ method: 'thread.start', params: threadStartParams })}\n`);

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
          isDone: () => completed,
          hasError: () => errorMessage,
          latestEventAt: () => latestEventAt,
          turnTimeoutMs: this.turnTimeoutMs,
          readTimeoutMs: this.readTimeoutMs,
          stallTimeoutMs: this.stallTimeoutMs,
        });

        if (turnOutcome === 'stalled') {
          this.terminate(child, 'turn stalled');
          return { status: 'stalled', activeIssue: false, state: this.snapshotState() };
        }
        if (turnOutcome === 'timeout') {
          this.terminate(child, 'turn timeout');
          return { status: 'timeout', activeIssue: false, state: this.snapshotState() };
        }
        if (errorMessage) {
          const status = /rate\s*limit/i.test(errorMessage) ? 'rate_limited' : 'error';
          this.terminate(child, 'turn error');
          return {
            status,
            activeIssue: false,
            state: this.snapshotState(),
            errorMessage,
          };
        }

        completed = false;
        if (!activeIssue) {
          child.stdin?.end();
          this.terminate(child, 'completed');
          return {
            status: 'completed',
            activeIssue: false,
            state: this.snapshotState(),
          };
        }
      }

      child.stdin?.end();
      this.terminate(child, 'completed-need-more-turns');
      return {
        status: 'completed',
        activeIssue: true,
        state: this.snapshotState(),
      };
    };

    return runLoop().finally(() => {
      this.activeProcess = undefined;
    });
  }

  cancel(): void {
    if (this.activeProcess) {
      this.activeProcess.kill('SIGTERM');
      this.activeProcess = undefined;
    }
  }

  snapshotState(): CodexSessionState {
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
    };
  }

  private isInitializedEvent(event: JsonRpcEvent): boolean {
    const method = readString(event, ['method', 'event', 'type']);
    return method === 'initialized' || method === 'initialize.done';
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
  }

  private terminate(child: ChildProcessLike, reason: string): void {
    void reason;
    child.kill('SIGTERM');
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

