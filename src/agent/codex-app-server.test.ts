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

test('spawns codex app-server with workspace cwd and sends thread/turn start', async () => {
  const fake = new FakeChildProcess();
  const spawnCalls: Array<{ command: string; args: string[]; cwd: string }> = [];

  const client = new CodexAppServerClient({
    cwd: '/tmp/workspace',
    readTimeoutMs: 10,
    stallTimeoutMs: 500,
    spawn: (command, args, options) => {
      spawnCalls.push({ command, args, cwd: options.cwd });
      queueMicrotask(() => {
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

  const payload = fake.writes.join('');
  assert.match(payload, /"method":"thread.start"/);
  assert.match(payload, /"method":"turn.start"/);
  assert.match(payload, /"message":"hello codex"/);
});

test('continues multi-turn when active issue is returned', async () => {
  const fake = new FakeChildProcess();
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
        if (!firstTurnEventSent && payload.includes('"turn":1')) {
          firstTurnEventSent = true;
          fake.emitStdoutJson({ params: { turn: { completed: true, active_issue: true } } });
        }
        if (!secondTurnEventSent && payload.includes('"turn":2')) {
          secondTurnEventSent = true;
          fake.emitStdoutJson({ params: { turn: { completed: true, active_issue: false } } });
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

  const payload = fake.writes.join('');
  assert.match(payload, /"message":"first prompt"/);
  assert.match(payload, /"message":"continue please"/);
  assert.equal(firstTurnEventSent, true);
  assert.equal(secondTurnEventSent, true);
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
