import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { GitHubProjectsAdapter } from "./adapter.js";
import type { GitHubProjectsClient, ProjectItemNode } from "./github-projects-client.js";
import { TrackerMalformedPayloadError } from "./github-projects-client.js";

class FakeClient implements GitHubProjectsClient {
  constructor(
    private readonly pages: Array<{ items: ProjectItemNode[]; hasNextPage: boolean; endCursor: string | null }>,
    private readonly idMap: Record<string, ProjectItemNode> = {},
  ) {}

  async fetchProjectItemsPage(params: {
    owner: string;
    projectNumber: number;
    first: number;
    after?: string;
  }): Promise<{ items: ProjectItemNode[]; hasNextPage: boolean; endCursor: string | null }> {
    const index = params.after ? Number(params.after) : 0;
    return this.pages[index] ?? { items: [], hasNextPage: false, endCursor: null };
  }

  async fetchProjectItemsByIds(ids: string[]): Promise<ProjectItemNode[]> {
    return ids.map((id) => this.idMap[id]).filter((v): v is ProjectItemNode => Boolean(v));
  }
}

function item(id: string, number: number, state: string, labels: string[]): ProjectItemNode {
  return {
    id,
    content: {
      __typename: "Issue",
      number,
      title: `Issue ${number}`,
      body: `Body ${number}`,
      url: `https://example.com/${number}`,
      createdAt: "2026-01-01T00:00:00Z",
      updatedAt: "2026-01-02T00:00:00Z",
      labels: { nodes: labels.map((name) => ({ name })) },
    },
    fieldValues: {
      nodes: [{ __typename: "ProjectV2ItemFieldSingleSelectValue", name: state }],
    },
  };
}

describe("GitHubProjectsAdapter", () => {
  it('delegates markInProgress/markDone to writer when configured', async () => {
    const calls: string[] = [];
    const adapter = new GitHubProjectsAdapter({
      owner: 'o',
      projectNumber: 1,
      client: new FakeClient([]),
      writer: {
        async markInProgress(itemId: string): Promise<void> {
          calls.push(`in:${itemId}`);
        },
        async markDone(itemId: string): Promise<void> {
          calls.push(`done:${itemId}`);
        },
      },
    });

    await adapter.markInProgress('A');
    await adapter.markDone('A');
    assert.deepEqual(calls, ['in:A', 'done:A']);
  });

  it('throws clear error when writer is missing for write operations', async () => {
    const adapter = new GitHubProjectsAdapter({ owner: 'o', projectNumber: 1, client: new FakeClient([]) });

    await assert.rejects(() => adapter.markInProgress('A'), /writer is not configured/i);
    await assert.rejects(() => adapter.markDone('A'), /writer is not configured/i);
  });
  it("paginates candidate fetch and keeps deterministic normalization", async () => {
    const client = new FakeClient([
      { items: [item("A", 101, "Todo", ["Bug", "P1"])], hasNextPage: true, endCursor: "1" },
      { items: [item("B", 102, "Done", ["Feature"])], hasNextPage: false, endCursor: null },
    ]);

    const adapter = new GitHubProjectsAdapter({
      owner: "t0yohei",
      projectNumber: 1,
      client,
      pageSize: 1,
    });

    const candidates = await adapter.listCandidateItems();
    assert.equal(candidates.length, 1);
    assert.deepEqual(candidates[0], {
      id: "A",
      identifier: "#101",
      number: 101,
      title: "Issue 101",
      body: "Body 101",
      description: "Body 101",
      state: "todo",
      priority: null,
      labels: ["bug", "p1"],
      blocked_by: [],
      assignees: [],
      created_at: "2026-01-01T00:00:00Z",
      updated_at: "2026-01-02T00:00:00Z",
      updatedAt: "2026-01-02T00:00:00Z",
      url: "https://example.com/101",
    });
  });

  it("fetches items by explicit states", async () => {
    const client = new FakeClient([
      {
        items: [item("A", 101, "Todo", []), item("B", 102, "Done", [])],
        hasNextPage: false,
        endCursor: null,
      },
    ]);
    const adapter = new GitHubProjectsAdapter({ owner: "o", projectNumber: 1, client });

    const done = await adapter.listItemsByStates(["done"]);
    assert.equal(done.length, 1);
    assert.equal(done[0].id, "B");
  });

  it("fetches state map by ids", async () => {
    const mapped = {
      A: item("A", 1, "In Progress", []),
      B: item("B", 2, "Blocked", []),
      C: item("C", 3, "Cancelled", []),
    };
    const adapter = new GitHubProjectsAdapter({
      owner: "o",
      projectNumber: 1,
      client: new FakeClient([], mapped),
    });

    const states = await adapter.getStatesByIds(["A", "B", "C"]);
    assert.deepEqual(states, { A: "in_progress", B: "blocked", C: "done" });
  });

  it('uses configured active states when listing candidates', async () => {
    const client = new FakeClient([
      {
        items: [item('A', 101, 'Todo', []), item('B', 102, 'Review', [])],
        hasNextPage: false,
        endCursor: null,
      },
    ]);

    const adapter = new GitHubProjectsAdapter({
      owner: 'o',
      projectNumber: 1,
      client,
      activeStates: ['review'],
    });

    const candidates = await adapter.listCandidateItems();
    assert.equal(candidates.length, 1);
    assert.equal(candidates[0].id, 'B');
    assert.equal(candidates[0].state, 'review');
  });

  it("throws malformed payload error when issue content is missing", async () => {
    const bad: ProjectItemNode = {
      id: "X",
      content: null,
      fieldValues: { nodes: [] },
    };
    const adapter = new GitHubProjectsAdapter({
      owner: "o",
      projectNumber: 1,
      client: new FakeClient([{ items: [bad], hasNextPage: false, endCursor: null }]),
    });

    await assert.rejects(() => adapter.listCandidateItems(), TrackerMalformedPayloadError);
  });
});
