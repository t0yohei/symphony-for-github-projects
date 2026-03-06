import test from "node:test";
import assert from "node:assert/strict";

import type { Logger } from "../logging/logger.js";
import type { NormalizedWorkItem } from "../model/work-item.js";
import { PollingRuntime } from "./runtime.js";

class TrackerStub {
  public eligible: NormalizedWorkItem[] = [];
  public markedInProgress: string[] = [];
  public failIds = new Set<string>();

  async listEligibleItems(): Promise<NormalizedWorkItem[]> {
    return this.eligible;
  }

  async markInProgress(itemId: string): Promise<void> {
    if (this.failIds.has(itemId)) {
      throw new Error(`failed:${itemId}`);
    }
    this.markedInProgress.push(itemId);
  }

  async markDone(): Promise<void> {
    return;
  }
}

const silentLogger: Logger = {
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
};

const baseItem = (id: string): NormalizedWorkItem => ({
  id,
  title: id,
  state: "todo",
  labels: [],
  assignees: [],
  updatedAt: "2026-01-01T00:00:00.000Z",
});

test("dispatch respects max concurrency", async () => {
  const tracker = new TrackerStub();
  tracker.eligible = [baseItem("1"), baseItem("2"), baseItem("3")];

  const runtime = new PollingRuntime(
    tracker,
    {
      name: "wf",
      version: "1",
      tracker: "github-projects",
      pollIntervalMs: 5000,
      maxConcurrency: 2,
    },
    silentLogger,
  );

  await runtime.tick();

  assert.deepEqual(tracker.markedInProgress, ["1", "2"]);
  const state = runtime.getStateSnapshot();
  assert.deepEqual(state.running.sort(), ["1", "2"]);
  assert.equal(state.metrics.dispatched, 2);
});

test("duplicate dispatch is prevented for already running item", async () => {
  const tracker = new TrackerStub();
  tracker.eligible = [baseItem("1")];

  const runtime = new PollingRuntime(
    tracker,
    {
      name: "wf",
      version: "1",
      tracker: "github-projects",
      pollIntervalMs: 5000,
      maxConcurrency: 1,
    },
    silentLogger,
  );

  await runtime.tick();
  await runtime.tick();

  assert.deepEqual(tracker.markedInProgress, ["1"]);
  assert.equal(runtime.getStateSnapshot().running.length, 1);
});

test("reconciliation frees capacity when running item is no longer eligible", async () => {
  const tracker = new TrackerStub();
  tracker.eligible = [baseItem("1")];

  const runtime = new PollingRuntime(
    tracker,
    {
      name: "wf",
      version: "1",
      tracker: "github-projects",
      pollIntervalMs: 5000,
      maxConcurrency: 1,
    },
    silentLogger,
  );

  await runtime.tick();
  tracker.eligible = [baseItem("2")];
  await runtime.tick();

  assert.deepEqual(tracker.markedInProgress, ["1", "2"]);
  const state = runtime.getStateSnapshot();
  assert.deepEqual(state.running, ["2"]);
  assert.equal(state.metrics.reconciledDroppedRunning, 1);
});

test("dispatch failures increment retry attempts and release claim", async () => {
  const tracker = new TrackerStub();
  tracker.eligible = [baseItem("fail")];
  tracker.failIds.add("fail");

  const runtime = new PollingRuntime(
    tracker,
    {
      name: "wf",
      version: "1",
      tracker: "github-projects",
      pollIntervalMs: 5000,
      maxConcurrency: 1,
    },
    silentLogger,
  );

  await runtime.tick();

  const state = runtime.getStateSnapshot();
  assert.equal(state.retryAttempts.fail, 1);
  assert.deepEqual(state.claimed, []);
  assert.deepEqual(state.running, []);
  assert.equal(state.metrics.dispatchFailures, 1);
});
