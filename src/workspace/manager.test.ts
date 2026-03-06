import test from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";

import {
  WorkspaceManager,
  createTempWorkspaceRoot,
  readTextFile,
} from "./manager.js";
import type { NormalizedWorkItem } from "../model/work-item.js";

function createItem(id: string, state: NormalizedWorkItem["state"] = "todo"): NormalizedWorkItem {
  return {
    id,
    title: "Item",
    state,
    labels: [],
    assignees: [],
    updatedAt: new Date().toISOString(),
  };
}

test("sanitizeWorkspaceKey creates deterministic safe key", () => {
  const first = WorkspaceManager.sanitizeWorkspaceKey(" Issue #9: Workspace Manager ");
  const second = WorkspaceManager.sanitizeWorkspaceKey("issue #9 workspace manager");
  assert.equal(first, "issue-9-workspace-manager");
  assert.equal(second, "issue-9-workspace-manager");
});

test("sanitizeWorkspaceKey truncates long keys with stable suffix", () => {
  const key = WorkspaceManager.sanitizeWorkspaceKey("x".repeat(200), 24);
  assert.equal(key.length, 24);
  assert.match(key, /^x{15}-[0-9a-f]{8}$/);
});

test("runHook is optional and executes configured command safely", async () => {
  const root = await createTempWorkspaceRoot();
  const output = join(root, "item-9", "hook-output.txt");
  const manager = new WorkspaceManager({
    rootDir: root,
    hooks: {
      before_run: {
        command: "node",
        args: [
          "-e",
          "require('node:fs').writeFileSync(process.env.WORKSPACE_PATH + '/hook-output.txt', process.env.WORKSPACE_ITEM_ID)",
        ],
      },
    },
  });

  const noHook = await manager.runHook("after_success", createItem("item-no-hook"));
  assert.equal(noHook.executed, false);

  const result = await manager.runHook("before_run", createItem("item-9"));
  assert.equal(result.executed, true);
  assert.equal(result.exitCode, 0);

  const content = await readTextFile(output);
  assert.equal(content, "item-9");
});

test("cleanupTerminalItemWorkspace is guarded by config and state", async () => {
  const root = await createTempWorkspaceRoot();
  const manager = new WorkspaceManager({
    rootDir: root,
    cleanup: {
      enabled: true,
      terminalStates: ["done"],
    },
  });

  const item = createItem("item-cleanup", "todo");
  const workspacePath = await manager.ensureWorkspace(item.id);

  const skipped = await manager.cleanupTerminalItemWorkspace(item);
  assert.equal(skipped, false);

  const doneItem = { ...item, state: "done" as const };
  const cleaned = await manager.cleanupTerminalItemWorkspace(doneItem);
  assert.equal(cleaned, true);

  await assert.rejects(readTextFile(join(workspacePath, "missing.txt")));
});
