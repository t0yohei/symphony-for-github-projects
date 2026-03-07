import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test from 'node:test';

import { CodexAppServerClient } from './codex-app-server.js';

class FakeChildProcess extends EventEmitter {
  public readonly stdout = new EventEmitter();
  public readonly stderr = new EventEmitter();
  public readonly writes: string[] = [];
  public killed = false;

  public readonly stdin = {
    write: (chunk: string): boolean => {
      this.writes.push(chunk);
      return true;
    },
    end: (): void => {
      // no-op for tests
    },
  };

  kill(): boolean {
    this.killed = true;
    return true;
  }

  emitStdoutJson(payload: unknown): void {
    this.stdout.emit('data', `${JSON.stringify(payload)}\n`);
  }

  emitStderr(text: string): void {
    this.stderr.emit('data', text);
  }
}

test('spawns codex app-server with deterministic initialize -> thread/turn order', async () => {
  const fake = new FakeChildProcess();
  const spawnCalls: Array<{ command: string; args: string[]; cwd: string }> = [];

  const client = new CodexAppServerClient({
    cwd: '/tmp/workspace',
    readTimeoutMs: 10,
    stallTimeoutMs: 500,
    spawn: (command, args, options) => {
      spawnCalls.push({ command, args, cwd: options.cwd });
      queueMicrotask(() => {
        fake.emitStdoutJson({ method: 'initialized' });
        fake.emitStdoutJson({
          params: {
            session_id: 's1',
            thread_id: 't1',
            turn_id: 'turn-1',
            usage: { input_tokens: 10, output_tokens: 3, total_tokens: 13 },
            turn: { completed: true, active_issue: false },
          },
        });
      });
      return fake;
    },
  });

  const result = await client.run({ renderedPrompt: 'hello codex' });

  assert.equal(spawnCalls.length, 1);
  assert.deepEqual(spawnCalls[0], {
    command: 'codex',
    args: ['app-server'],
    cwd: '/tmp/workspace',
  });

  assert.equal(result.status, 'completed');
  assert.equal(result.activeIssue, false);
  assert.equal(result.state.sessionId, 's1');
  assert.equal(result.state.threadId, 't1');
  assert.equal(result.state.turnId, 'turn-1');
  assert.equal(result.state.usage.totalTokens, 13);

  const writes = fake.writes.map((w) => JSON.parse(w.trim()));
  assert.equal(writes[0].method, 'initialize');
  assert.equal(writes[1].method, 'thread.start');
  assert.equal(writes[2].method, 'turn.start');
  assert.equal(writes[2].params.message, 'hello codex');
});

test('initialize sends cwd, clientInfo, and capabilities for protocol compatibility', async () => {
  const fake = new FakeChildProcess();

  const client = new CodexAppServerClient({
    cwd: '/home/user/project',
    readTimeoutMs: 10,
    stallTimeoutMs: 500,
    spawn: () => {
      queueMicrotask(() => {
        fake.emitStdoutJson({ method: 'initialized' });
        fake.emitStdoutJson({
          params: { turn: { completed: true, active_issue: false } },
        });
      });
      return fake;
    },
  });

  await client.run({ renderedPrompt: 'test cwd' });

  const writes = fake.writes.map((w) => JSON.parse(w.trim()));
  const initMsg = writes.find((w) => w.method === 'initialize');
  assert.ok(initMsg, 'initialize message must be sent');
  assert.equal(initMsg.params.cwd, '/home/user/project');
  assert.equal(initMsg.params.clientInfo.name, 'symphony-github-projects');
  assert.equal(initMsg.params.clientInfo.version, '0.1.0');
  assert.deepEqual(initMsg.params.capabilities, {});
});

test('thread.start includes formatted title and cwd when identifier and title are provided', async () => {
  const fake = new FakeChildProcess();

  const client = new CodexAppServerClient({
    cwd: '/tmp/workspace',
    readTimeoutMs: 10,
    stallTimeoutMs: 500,
    spawn: () => {
      queueMicrotask(() => {
        fake.emitStdoutJson({ method: 'initialized' });
        fake.emitStdoutJson({
          params: { turn: { completed: true, active_issue: false } },
        });
      });
      return fake;
    },
  });

  await client.run({
    renderedPrompt: 'implement the feature',
    identifier: 'ISSUE-71',
    title: 'make Codex app-server handshake protocol-compatible',
  });

  const writes = fake.writes.map((w) => JSON.parse(w.trim()));
  const threadStart = writes.find((w) => w.method === 'thread.start');
  assert.ok(threadStart, 'thread.start must be sent');
  assert.equal(threadStart.params.title, 'ISSUE-71: make Codex app-server handshake protocol-compatible');
  assert.equal(threadStart.params.cwd, '/tmp/workspace');
  assert.equal(threadStart.params.prompt, 'implement the feature');
});

test('thread.start includes cwd without title when identifier/title are omitted', async () => {
  const fake = new FakeChildProcess();

  const client = new CodexAppServerClient({
    cwd: '/tmp/workspace',
    readTimeoutMs: 10,
    stallTimeoutMs: 500,
    spawn: () => {
      queueMicrotask(() => {
        fake.emitStdoutJson({ method: 'initialized' });
        fake.emitStdoutJson({
          params: { turn: { completed: true, active_issue: false } },
        });
      });
      return fake;
    },
  });

  await client.run({ renderedPrompt: 'no title run' });

  const writes = fake.writes.map((w) => JSON.parse(w.trim()));
  const threadStart = writes.find((w) => w.method === 'thread.start');
  assert.ok(threadStart, 'thread.start must be sent');
  assert.equal(threadStart.params.cwd, '/tmp/workspace');
  assert.equal(threadStart.params.title, undefined);
});

test('detects cancelled turn and returns cancelled status', async () => {
  const fake = new FakeChildProcess();

  const client = new CodexAppServerClient({
    cwd: '/tmp/workspace',
    readTimeoutMs: 10,
    stallTimeoutMs: 500,
    spawn: () => {
      queueMicrotask(() => {
        fake.emitStdoutJson({ method: 'initialized' });
        fake.emitStdoutJson({
          params: { turn: { cancelled: true } },
        });
      });
      return fake;
    },
  });

  const result = await client.run({ renderedPrompt: 'will be cancelled' });

  assert.equal(result.status, 'cancelled');
  assert.equal(result.activeIssue, false);
  assert.equal(fake.killed, true);
});

test('continues multi-turn on same thread and uses continuation guidance', async () => {
  const fake = new FakeChildProcess();
  let initializedSent = false;
  let firstTurnEventSent = false;
  let secondTurnEventSent = false;

  const client = new CodexAppServerClient({
    cwd: '/tmp/workspace',
    maxTurns: 3,
    readTimeoutMs: 10,
    stallTimeoutMs: 500,
    spawn: () => {
      const timer = setInterval(() => {
        const payload = fake.writes.join('');
        if (!initializedSent && payload.includes('"method":"initialize"')) {
          initializedSent = true;
          fake.emitStdoutJson({ method: 'initialized' });
          fake.emitStdoutJson({ params: { thread_id: 'shared-thread' } });
        }
        if (!firstTurnEventSent && payload.includes('"turn":1')) {
          firstTurnEventSent = true;
          fake.emitStdoutJson({ params: { turn: { completed: true, active_issue: true } } });
        }
        if (!secondTurnEventSent && payload.includes('"turn":2')) {
          secondTurnEventSent = true;
          fake.emitStdoutJson({ params: { turn_id: 'turn-2', turn: { completed: true, active_issue: false } } });
          clearInterval(timer);
        }
      }, 1);
      return fake;
    },
  });

  const result = await client.run({
    renderedPrompt: 'first prompt',
    continuationGuidance: 'continue please',
  });

  assert.equal(result.status, 'completed');
  assert.equal(result.activeIssue, false);
  assert.ok(result.state.turnsStarted >= 2);
  assert.ok(result.state.turnsCompleted >= 2);

  const writes = fake.writes.map((w) => JSON.parse(w.trim()));
  const turnMessages = writes.filter((w) => w.method === 'turn.start').map((w) => w.params.message);
  assert.deepEqual(turnMessages.slice(0, 2), ['first prompt', 'continue please']);

  const threadStart = writes.find((w) => w.method === 'thread.start');
  assert.equal(threadStart?.params.prompt, 'first prompt');

  const secondTurn = writes.find((w) => w.method === 'turn.start' && w.params.turn === 2);
  assert.equal(secondTurn?.params.thread_id, 'shared-thread');
  assert.equal(initializedSent, true);
  assert.equal(firstTurnEventSent, true);
  assert.equal(secondTurnEventSent, true);
});

test('derives session id from thread id when session_id is absent', async () => {
  const fake = new FakeChildProcess();
  const client = new CodexAppServerClient({
    cwd: '/tmp/workspace',
    readTimeoutMs: 10,
    stallTimeoutMs: 500,
    spawn: () => {
      queueMicrotask(() => {
        fake.emitStdoutJson({ method: 'initialized' });
        fake.emitStdoutJson({
          params: {
            thread_id: 't-derived',
            turn_id: 'turn-1',
            turn: { completed: true, active_issue: false },
          },
        });
      });
      return fake;
    },
  });

  const result = await client.run({ renderedPrompt: 'hello' });
  assert.equal(result.status, 'completed');
  assert.equal(result.state.sessionId, 'thread:t-derived');
  assert.equal(result.state.threadId, 't-derived');
});

test('detects stall and terminates the subprocess', async () => {
  const fake = new FakeChildProcess();
  const client = new CodexAppServerClient({
    cwd: '/tmp/workspace',
    readTimeoutMs: 5,
    stallTimeoutMs: 20,
    turnTimeoutMs: 500,
    spawn: () => fake,
  });

  const result = await client.run({ renderedPrompt: 'will stall' });

  assert.equal(result.status, 'stalled');
  assert.equal(fake.killed, true);
});

test('classifies rate limit errors from stderr', async () => {
  const fake = new FakeChildProcess();
  const client = new CodexAppServerClient({
    cwd: '/tmp/workspace',
    readTimeoutMs: 5,
    stallTimeoutMs: 1000,
    turnTimeoutMs: 1000,
    spawn: () => {
      queueMicrotask(() => {
        fake.emitStderr('Rate limit exceeded');
      });
      return fake;
    },
  });

  const result = await client.run({ renderedPrompt: 'hello' });

  assert.equal(result.status, 'rate_limited');
  assert.match(result.errorMessage ?? '', /rate limit/i);
});

test('snapshot includes runtimeSeconds greater than zero after run completes', async () => {
  const fake = new FakeChildProcess();
  const client = new CodexAppServerClient({
    cwd: '/tmp/workspace',
    readTimeoutMs: 10,
    stallTimeoutMs: 500,
    spawn: () => {
      queueMicrotask(() => {
        fake.emitStdoutJson({ method: 'initialized' });
        fake.emitStdoutJson({
          params: { turn: { completed: true, active_issue: false } },
        });
      });
      return fake;
    },
  });

  const result = await client.run({ renderedPrompt: 'runtime test' });

  assert.equal(result.status, 'completed');
  assert.ok(
    typeof result.state.runtimeSeconds === 'number' && result.state.runtimeSeconds >= 0,
    `runtimeSeconds should be a non-negative number, got ${result.state.runtimeSeconds}`,
  );
});

test('snapshot runtimeSeconds reflects elapsed time on stall', async () => {
  const fake = new FakeChildProcess();
  const client = new CodexAppServerClient({
    cwd: '/tmp/workspace',
    readTimeoutMs: 5,
    stallTimeoutMs: 30,
    turnTimeoutMs: 500,
    spawn: () => fake,
  });

  const before = Date.now();
  const result = await client.run({ renderedPrompt: 'will stall for timing' });
  const after = Date.now();

  assert.equal(result.status, 'stalled');
  // runtimeSeconds should be between 0 and the total elapsed wall time.
  const elapsedSeconds = (after - before) / 1000;
  assert.ok(
    result.state.runtimeSeconds >= 0 && result.state.runtimeSeconds <= elapsedSeconds + 0.1,
    `runtimeSeconds (${result.state.runtimeSeconds}) out of expected range [0, ${elapsedSeconds + 0.1}]`,
  );
});

test('snapshot runtimeSeconds reflects elapsed time on turn timeout', async () => {
  const fake = new FakeChildProcess();
  const client = new CodexAppServerClient({
    cwd: '/tmp/workspace',
    readTimeoutMs: 5,
    stallTimeoutMs: 60_000,
    turnTimeoutMs: 40,
    spawn: () => {
      // Emit initialized but no turn completion — triggers turn timeout.
      queueMicrotask(() => {
        fake.emitStdoutJson({ method: 'initialized' });
        // Emit periodic events to keep stall timer alive, but never complete.
        const interval = setInterval(() => {
          fake.emitStdoutJson({ method: 'ping' });
        }, 5);
        setTimeout(() => clearInterval(interval), 200);
      });
      return fake;
    },
  });

  const before = Date.now();
  const result = await client.run({ renderedPrompt: 'will timeout' });
  const after = Date.now();

  assert.equal(result.status, 'timeout');
  const elapsedSeconds = (after - before) / 1000;
  assert.ok(
    result.state.runtimeSeconds >= 0 && result.state.runtimeSeconds <= elapsedSeconds + 0.1,
    `runtimeSeconds (${result.state.runtimeSeconds}) out of expected range [0, ${elapsedSeconds + 0.1}]`,
  );
});

test('snapshot records latestRateLimitAt when rate_limited event is observed', async () => {
  const fake = new FakeChildProcess();
  const beforeRun = Date.now();

  const client = new CodexAppServerClient({
    cwd: '/tmp/workspace',
    readTimeoutMs: 10,
    stallTimeoutMs: 1000,
    turnTimeoutMs: 1000,
    spawn: () => {
      queueMicrotask(() => {
        fake.emitStdoutJson({ method: 'initialized' });
        fake.emitStdoutJson({ params: { rate_limited: true, error: { message: 'rate limited' } } });
      });
      return fake;
    },
  });

  const result = await client.run({ renderedPrompt: 'rate limit tracking' });

  assert.equal(result.status, 'rate_limited');
  assert.ok(
    typeof result.state.latestRateLimitAt === 'number',
    'latestRateLimitAt should be set when rate_limited event is received',
  );
  assert.ok(
    (result.state.latestRateLimitAt ?? 0) >= beforeRun,
    'latestRateLimitAt should be >= the time before the run started',
  );
});

test('snapshot latestRateLimitAt is undefined when no rate limit occurred', async () => {
  const fake = new FakeChildProcess();
  const client = new CodexAppServerClient({
    cwd: '/tmp/workspace',
    readTimeoutMs: 10,
    stallTimeoutMs: 500,
    spawn: () => {
      queueMicrotask(() => {
        fake.emitStdoutJson({ method: 'initialized' });
        fake.emitStdoutJson({
          params: { turn: { completed: true, active_issue: false } },
        });
      });
      return fake;
    },
  });

  const result = await client.run({ renderedPrompt: 'no rate limit' });

  assert.equal(result.status, 'completed');
  assert.equal(result.state.latestRateLimitAt, undefined);
});
