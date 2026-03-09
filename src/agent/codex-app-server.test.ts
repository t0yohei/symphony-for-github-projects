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

test('spawns codex with default app-server argv when command is single token', async () => {
  const fake = new FakeChildProcess();
  const spawnCalls: Array<{ command: string; args: string[]; cwd: string }> = [];

  const client = new CodexAppServerClient({
    cwd: '/tmp/workspace',
    readTimeoutMs: 10,
    stallTimeoutMs: 500,
    command: 'codex',
    spawn: (command, args, options) => {
      spawnCalls.push({ command, args, cwd: options.cwd });
      const timer = setInterval(() => {
        const writes = fake.writes.map((w) => JSON.parse(w.trim()));
        if (!writes.some((w) => w.method === 'initialize')) {
          return;
        }
        if (!writes.some((w) => w.method === 'initialized')) {
          fake.emitStdoutJson({ id: 1, result: { userAgent: 'diag/0.110.0' } });
          return;
        }
        if (!writes.some((w) => w.method === 'thread/start')) {
          return;
        }
        if (!writes.some((w) => w.method === 'turn/start')) {
          fake.emitStdoutJson({ id: 2, result: { thread: { id: 't1' } } });
          return;
        }
        fake.emitStdoutJson({ id: 3, result: { turn: { id: 'turn-1' } } });
        fake.emitStdoutJson({
          method: 'turn/completed',
          params: { threadId: 't1', turn: { id: 'turn-1' } },
        });
        clearInterval(timer);
      }, 1);
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
  assert.equal(result.state.threadId, 't1');
  assert.equal(result.state.turnId, 'turn-1');

  const writes = fake.writes.map((w) => JSON.parse(w.trim()));
  assert.equal(writes[0].jsonrpc, '2.0');
  assert.equal(writes[0].method, 'initialize');
  assert.equal(writes[1].method, 'initialized');
  assert.equal(writes[2].method, 'thread/start');
  assert.equal(writes[3].method, 'turn/start');
  assert.equal(writes[3].params.threadId, 't1');
  assert.equal(writes[3].params.input[0].text, 'hello codex');
  assert.deepEqual(writes[3].params.input[0].text_elements, []);
});

test('initialize sends cwd, clientInfo, and capabilities for protocol compatibility', async () => {
  const fake = new FakeChildProcess();

  const client = new CodexAppServerClient({
    cwd: '/home/user/project',
    readTimeoutMs: 10,
    stallTimeoutMs: 500,
    spawn: () => {
      queueMicrotask(() => {
        fake.emitStdoutJson({ id: 1, result: { userAgent: 'diag/0.110.0' } });
        fake.emitStdoutJson({ id: 2, result: { thread: { id: 't1' } } });
        fake.emitStdoutJson({ id: 3, result: { turn: { id: 'turn-1' } } });
        fake.emitStdoutJson({
          method: 'turn/completed',
          params: { threadId: 't1', turn: { id: 'turn-1' } },
        });
      });
      return fake;
    },
  });

  await client.run({ renderedPrompt: 'test cwd' });

  const writes = fake.writes.map((w) => JSON.parse(w.trim()));
  const initMsg = writes.find((w) => w.method === 'initialize');
  assert.ok(initMsg, 'initialize message must be sent');
  assert.equal(initMsg.jsonrpc, '2.0');
  assert.equal(initMsg.id, 1);
  assert.equal(initMsg.params.cwd, '/home/user/project');
  assert.equal(initMsg.params.clientInfo.name, 'symphony-for-github-projects');
  assert.equal(initMsg.params.clientInfo.version, '0.1.0');
  assert.deepEqual(initMsg.params.capabilities, {});
});

test('thread/start includes formatted title and cwd for a new thread', async () => {
  const fake = new FakeChildProcess();

  const client = new CodexAppServerClient({
    cwd: '/tmp/workspace',
    readTimeoutMs: 10,
    stallTimeoutMs: 500,
    spawn: () => {
      const timer = setInterval(() => {
        const writes = fake.writes.map((w) => JSON.parse(w.trim()));
        if (!writes.some((w) => w.method === 'initialize')) {
          return;
        }
        if (!writes.some((w) => w.method === 'initialized')) {
          fake.emitStdoutJson({ id: 1, result: { userAgent: 'diag/0.110.0' } });
          return;
        }
        if (!writes.some((w) => w.method === 'thread/start')) {
          return;
        }
        if (!writes.some((w) => w.method === 'turn/start')) {
          fake.emitStdoutJson({ id: 2, result: { thread: { id: 't1' } } });
          return;
        }
        fake.emitStdoutJson({ id: 3, result: { turn: { id: 'turn-1' } } });
        fake.emitStdoutJson({
          method: 'turn/completed',
          params: { threadId: 't1', turn: { id: 'turn-1' } },
        });
        clearInterval(timer);
      }, 1);
      return fake;
    },
  });

  await client.run({
    renderedPrompt: 'implement the feature',
    identifier: 'ISSUE-71',
    title: 'make Codex app-server handshake protocol-compatible',
  });

  const writes = fake.writes.map((w) => JSON.parse(w.trim()));
  const threadStart = writes.find((w) => w.method === 'thread/start');
  assert.ok(threadStart, 'thread/start must be sent');
  assert.equal(
    threadStart.params.name,
    'ISSUE-71: make Codex app-server handshake protocol-compatible',
  );
  assert.equal(threadStart.params.cwd, '/tmp/workspace');
  assert.equal(threadStart.params.experimentalRawEvents, false);
  assert.equal(threadStart.params.persistExtendedHistory, false);
  assert.equal(threadStart.params.approvalPolicy, 'never');
  assert.equal(threadStart.params.sandbox, 'workspace-write');
  assert.deepEqual(threadStart.params.config, {
    sandbox_workspace_write: {
      writable_roots: ['/tmp/workspace'],
      network_access: true,
      exclude_tmpdir_env_var: false,
      exclude_slash_tmp: false,
    },
  });
});

test('uses danger-full-access sandbox when requested via command', async () => {
  const fake = new FakeChildProcess();

  const client = new CodexAppServerClient({
    cwd: '/tmp/workspace',
    command: 'codex -s danger-full-access -a never app-server',
    readTimeoutMs: 10,
    stallTimeoutMs: 500,
    spawn: () => {
      const timer = setInterval(() => {
        const writes = fake.writes.map((w) => JSON.parse(w.trim()));
        if (!writes.some((w) => w.method === 'initialize')) return;
        if (!writes.some((w) => w.method === 'initialized')) {
          fake.emitStdoutJson({ id: 1, result: { userAgent: 'diag/0.110.0' } });
          return;
        }
        if (!writes.some((w) => w.method === 'thread/start')) return;
        if (!writes.some((w) => w.method === 'turn/start')) {
          fake.emitStdoutJson({ id: 2, result: { thread: { id: 't1' } } });
          return;
        }
        fake.emitStdoutJson({ id: 3, result: { turn: { id: 'turn-1' } } });
        fake.emitStdoutJson({ method: 'turn/completed', params: { threadId: 't1', turn: { id: 'turn-1' } } });
        clearInterval(timer);
      }, 1);
      return fake;
    },
  });

  await client.run({ renderedPrompt: 'danger test' });

  const writes = fake.writes.map((w) => JSON.parse(w.trim()));
  const threadStart = writes.find((w) => w.method === 'thread/start');
  assert.ok(threadStart, 'thread/start must be sent');
  assert.equal(threadStart.params.sandbox, 'danger-full-access');
  assert.equal(threadStart.params.config, undefined);
});

test('detects cancelled turn and returns cancelled status', async () => {
  const fake = new FakeChildProcess();

  const client = new CodexAppServerClient({
    cwd: '/tmp/workspace',
    readTimeoutMs: 10,
    stallTimeoutMs: 500,
    spawn: () => {
      queueMicrotask(() => {
        fake.emitStdoutJson({ id: 1, result: { userAgent: 'diag/0.110.0' } });
        fake.emitStdoutJson({ id: 2, result: { thread: { id: 't1' } } });
        fake.emitStdoutJson({
          method: 'turn/cancelled',
          params: { threadId: 't1', turnId: 'turn-1' },
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
  let phase = 0;

  const client = new CodexAppServerClient({
    cwd: '/tmp/workspace',
    maxTurns: 3,
    readTimeoutMs: 10,
    stallTimeoutMs: 500,
    spawn: () => {
      const timer = setInterval(() => {
        const writes = fake.writes.map((w) => JSON.parse(w.trim()));

        if (phase === 0 && writes.some((w) => w.method === 'initialize')) {
          phase = 1;
          fake.emitStdoutJson({ id: 1, result: { userAgent: 'diag/0.110.0' } });
          return;
        }

        if (phase === 1 && writes.some((w) => w.method === 'thread/start')) {
          phase = 2;
          fake.emitStdoutJson({ id: 2, result: { thread: { id: 'shared-thread' } } });
          return;
        }

        const turnWrites = writes.filter((w) => w.method === 'turn/start');
        if (phase === 2 && turnWrites.length >= 1) {
          phase = 3;
          fake.emitStdoutJson({ id: 3, result: { turn: { id: 'turn-1' } } });
          fake.emitStdoutJson({
            method: 'turn/completed',
            params: { threadId: 'shared-thread', turn: { id: 'turn-1' } },
          });
          fake.emitStdoutJson({ params: { turn: { active_issue: true } } });
          return;
        }

        if (phase === 3 && turnWrites.length >= 2) {
          phase = 4;
          fake.emitStdoutJson({ id: 4, result: { turn: { id: 'turn-2' } } });
          fake.emitStdoutJson({
            method: 'turn/completed',
            params: { threadId: 'shared-thread', turn: { id: 'turn-2' } },
          });
          fake.emitStdoutJson({ params: { turn: { active_issue: false } } });
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
  const turnMessages = writes
    .filter((w) => w.method === 'turn/start')
    .map((w) => w.params.input?.[0]?.text);
  assert.deepEqual(turnMessages.slice(0, 2), ['first prompt', 'continue please']);
  assert.ok(writes.some((w) => w.method === 'thread/start'));
  assert.ok(
    writes
      .filter((w) => w.method === 'turn/start')
      .every((w) => w.params.threadId === 'shared-thread'),
  );
});

test('derives session id from thread and turn ids when explicit session id is absent', async () => {
  const fake = new FakeChildProcess();
  const client = new CodexAppServerClient({
    cwd: '/tmp/workspace',
    readTimeoutMs: 10,
    stallTimeoutMs: 500,
    spawn: () => {
      queueMicrotask(() => {
        fake.emitStdoutJson({ id: 1, result: { userAgent: 'diag/0.110.0' } });
        fake.emitStdoutJson({ id: 2, result: { thread: { id: 't-derived' } } });
        fake.emitStdoutJson({ id: 3, result: { turn: { id: 'turn-1' } } });
        fake.emitStdoutJson({
          method: 'turn/completed',
          params: { threadId: 't-derived', turn: { id: 'turn-1' } },
        });
      });
      return fake;
    },
  });

  const result = await client.run({ renderedPrompt: 'hello' });
  assert.equal(result.status, 'completed');
  assert.equal(result.state.sessionId, 'thread:t-derived:turn-1');
  assert.equal(result.state.threadId, 't-derived');
  assert.equal(result.state.turnId, 'turn-1');
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

test('snapshot includes runtimeSeconds greater than or equal to zero after run completes', async () => {
  const fake = new FakeChildProcess();
  const client = new CodexAppServerClient({
    cwd: '/tmp/workspace',
    readTimeoutMs: 10,
    stallTimeoutMs: 500,
    spawn: () => {
      queueMicrotask(() => {
        fake.emitStdoutJson({ id: 1, result: { userAgent: 'diag/0.110.0' } });
        fake.emitStdoutJson({ id: 2, result: { thread: { id: 't1' } } });
        fake.emitStdoutJson({ id: 3, result: { turn: { id: 'turn-1' } } });
        fake.emitStdoutJson({
          method: 'turn/completed',
          params: { threadId: 't1', turn: { id: 'turn-1' } },
        });
      });
      return fake;
    },
  });

  const result = await client.run({ renderedPrompt: 'runtime test' });

  assert.equal(result.status, 'completed');
  assert.ok(typeof result.state.runtimeSeconds === 'number' && result.state.runtimeSeconds >= 0);
});

test('captures token usage from token_count events', async () => {
  const fake = new FakeChildProcess();
  const client = new CodexAppServerClient({
    cwd: '/tmp/workspace',
    readTimeoutMs: 10,
    stallTimeoutMs: 500,
    spawn: () => {
      queueMicrotask(() => {
        fake.emitStdoutJson({ id: 1, result: { userAgent: 'diag/0.110.0' } });
        fake.emitStdoutJson({ id: 2, result: { thread: { id: 't1' } } });
        fake.emitStdoutJson({
          method: 'event_msg',
          params: {
            type: 'token_count',
            info: {
              total_token_usage: {
                input_tokens: 1234,
                output_tokens: 56,
                total_tokens: 1290,
              },
            },
          },
        });
        fake.emitStdoutJson({ id: 3, result: { turn: { id: 'turn-1' } } });
        fake.emitStdoutJson({
          method: 'turn/completed',
          params: { threadId: 't1', turn: { id: 'turn-1' } },
        });
      });
      return fake;
    },
  });

  const result = await client.run({ renderedPrompt: 'count tokens' });

  assert.equal(result.status, 'completed');
  assert.deepEqual(result.state.usage, {
    inputTokens: 1234,
    outputTokens: 56,
    totalTokens: 1290,
  });
});

test('snapshot records latestRateLimitAt when a quota error event is observed', async () => {
  const fake = new FakeChildProcess();
  const beforeRun = Date.now();

  const client = new CodexAppServerClient({
    cwd: '/tmp/workspace',
    readTimeoutMs: 10,
    stallTimeoutMs: 1000,
    turnTimeoutMs: 1000,
    spawn: () => {
      queueMicrotask(() => {
        fake.emitStdoutJson({ id: 1, result: { userAgent: 'diag/0.110.0' } });
        fake.emitStdoutJson({ id: 2, result: { thread: { id: 't1' } } });
        fake.emitStdoutJson({
          method: 'error',
          params: {
            error: {
              message: 'Quota exceeded. Check your plan and billing details.',
              codexErrorInfo: 'usageLimitExceeded',
            },
            threadId: 't1',
            turnId: 'turn-1',
          },
        });
      });
      return fake;
    },
  });

  const result = await client.run({ renderedPrompt: 'rate limit tracking' });

  assert.equal(result.status, 'rate_limited');
  assert.ok(typeof result.state.latestRateLimitAt === 'number');
  assert.ok((result.state.latestRateLimitAt ?? 0) >= beforeRun);
});
