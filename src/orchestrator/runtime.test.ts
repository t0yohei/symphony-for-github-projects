import test from "node:test";
import assert from "node:assert/strict";

import { PollingRuntime } from "./runtime.js";
import type { Logger } from "../logging/logger.js";
import type { NormalizedWorkItem } from "../model/work-item.js";
import type { TrackerAdapter } from "../tracker/adapter.js";

class MemoryLogger implements Logger {
  readonly entries: Array<{ level: "info" | "warn" | "error"; message: string; context?: Record<string, unknown> }> = [];

  info(message: string, context?: Record<string, unknown>): void {
    this.entries.push({ level: "info", message, context });
  }

  warn(message: string, context?: Record<string, unknown>): void {
    this.entries.push({ level: "warn", message, context });
  }

  error(message: string, context?: Record<string, unknown>): void {
    this.entries.push({ level: "error", message, context });
  }
}

function item(id: string): NormalizedWorkItem {
  return {
    id,
    title: `item-${id}`,
    state: "todo",
    labels: [],
    assignees: [],
    updatedAt: new Date().toISOString(),
  };
}

test("schedules exponential backoff retries for transient claim failures", async () => {
  let nowMs = 0;
  const logger = new MemoryLogger();

  const tracker: TrackerAdapter = {
    async listEligibleItems() {
      return [item("A")];
    },
    async markInProgress() {
      throw new Error("temporary outage");
    },
    async markDone() {
      // noop
    },
  };

  const runtime = new PollingRuntime(
    tracker,
    { name: "wf", version: "1", tracker: "github-projects", pollIntervalMs: 1000, maxConcurrency: 1 },
    logger,
    { maxRetryAttempts: 4, baseRetryDelayMs: 1000, now: () => nowMs },
  );

  await runtime.tick();
  const first = runtime.getItemState("A");
  assert.ok(first);
  assert.equal(first.status, "waiting_retry");
  assert.equal(first.attempts, 1);
  assert.equal(first.nextAttemptAt, 1000);

  await runtime.tick();
  const second = runtime.getItemState("A");
  assert.ok(second);
  assert.equal(second.attempts, 1, "should not retry before delay");

  nowMs = 1000;
  await runtime.tick();
  const third = runtime.getItemState("A");
  assert.ok(third);
  assert.equal(third.attempts, 2);
  assert.equal(third.nextAttemptAt, 3000, "second delay should double to 2000ms");
});

test("stops active item when it becomes ineligible and releases state", async () => {
  let eligible = [item("A")];
  const logger = new MemoryLogger();

  const tracker: TrackerAdapter = {
    async listEligibleItems() {
      return eligible;
    },
    async markInProgress() {
      // success
    },
    async markDone() {
      // noop
    },
  };

  const runtime = new PollingRuntime(
    tracker,
    { name: "wf", version: "1", tracker: "github-projects", pollIntervalMs: 1000, maxConcurrency: 1 },
    logger,
  );

  await runtime.tick();
  runtime.markRunning("A");
  assert.equal(runtime.getItemState("A")?.status, "running");

  eligible = [];
  await runtime.tick();
  assert.equal(runtime.getItemState("A"), undefined);

  const stopLog = logger.entries.find((entry) => entry.message === "runtime.item.stopped_ineligible");
  assert.ok(stopLog, "must log stop reason for ineligible transition");
});

test("releases state after retry exhaustion", async () => {
  const logger = new MemoryLogger();
  let nowMs = 10;

  const tracker: TrackerAdapter = {
    async listEligibleItems() {
      return [item("A")];
    },
    async markInProgress() {
      throw new Error("always failing");
    },
    async markDone() {
      // noop
    },
  };

  const runtime = new PollingRuntime(
    tracker,
    { name: "wf", version: "1", tracker: "github-projects", pollIntervalMs: 1000, maxConcurrency: 1 },
    logger,
    { maxRetryAttempts: 2, baseRetryDelayMs: 1, now: () => nowMs },
  );

  await runtime.tick();
  assert.ok(runtime.getItemState("A"), "first failure schedules retry");

  nowMs = 11;
  await runtime.tick();
  assert.equal(runtime.getItemState("A"), undefined, "second failure should exhaust and release");

  const exhaustedLog = logger.entries.find((entry) => entry.message === "runtime.item.retry_exhausted");
  assert.ok(exhaustedLog, "must log exhaustion reason");
});
