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
    const child = this.spawnProc(this.command, this.args, {
      cwd: this.options.cwd,
      env: {
        ...process.env,
        ...(this.options.env ?? {}),
      },
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    let lineBuffer = '';
    let latestEventAt = Date.now();
    let completed = false;
    let activeIssue = false;
    let errorMessage: string | undefined;

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

    if (!child.stdin) {
      throw new Error('codex app-server stdin is not available');
    }

    const threadStartMessage = JSON.stringify({
      method: 'thread.start',
      params: {
        prompt: params.renderedPrompt,
      },
    });
    child.stdin.write(`${threadStartMessage}\n`);

    for (let turn = 1; turn <= this.maxTurns; turn += 1) {
      const message =
        turn === 1
          ? params.renderedPrompt
          : (params.continuationGuidance ?? 'Continue from the active issue and finish the task.');

      const turnStartMessage = JSON.stringify({
        method: 'turn.start',
        params: {
          message,
          turn,
        },
      });
      this.state.turnsStarted += 1;
      child.stdin.write(`${turnStartMessage}\n`);

      const turnOutcome = await waitForTurnOutcome({
        isCompleted: () => completed,
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

  private snapshotState(): CodexSessionState {
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
}

async function waitForTurnOutcome(params: {
  isCompleted: () => boolean;
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
    if (params.isCompleted()) {
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
