import type { NormalizedWorkItem, WorkItemState } from "../model/work-item.js";
import { normalizeState } from "../model/work-item.js";
import {
  type GitHubProjectsClient,
  type ProjectItemNode,
  TrackerMalformedPayloadError,
} from "./github-projects-client.js";

export interface TrackerAdapter {
  listEligibleItems(): Promise<NormalizedWorkItem[]>;
  listCandidateItems(options?: { pageSize?: number; activeStates?: WorkItemState[] }): Promise<NormalizedWorkItem[]>;
  listItemsByStates(states: WorkItemState[], options?: { pageSize?: number }): Promise<NormalizedWorkItem[]>;
  getStatesByIds(itemIds: string[]): Promise<Record<string, WorkItemState>>;
  markInProgress(itemId: string): Promise<void>;
  markDone(itemId: string): Promise<void>;
}

export interface GitHubProjectsAdapterOptions {
  owner: string;
  projectNumber: number;
  client: GitHubProjectsClient;
  pageSize?: number;
}

export class GitHubProjectsAdapter implements TrackerAdapter {
  private readonly owner: string;
  private readonly projectNumber: number;
  private readonly client: GitHubProjectsClient;
  private readonly defaultPageSize: number;

  constructor(options: GitHubProjectsAdapterOptions) {
    this.owner = options.owner;
    this.projectNumber = options.projectNumber;
    this.client = options.client;
    this.defaultPageSize = options.pageSize ?? 50;
  }

  async listEligibleItems(): Promise<NormalizedWorkItem[]> {
    return this.listCandidateItems();
  }

  async listCandidateItems(options?: {
    pageSize?: number;
    activeStates?: WorkItemState[];
  }): Promise<NormalizedWorkItem[]> {
    const activeStates = options?.activeStates ?? ["todo", "in_progress", "blocked"];
    return this.listItemsByStates(activeStates, { pageSize: options?.pageSize });
  }

  async listItemsByStates(
    states: WorkItemState[],
    options?: { pageSize?: number },
  ): Promise<NormalizedWorkItem[]> {
    const pageSize = options?.pageSize ?? this.defaultPageSize;
    const target = new Set(states);
    const acc: NormalizedWorkItem[] = [];

    let after: string | undefined;
    while (true) {
      const page = await this.client.fetchProjectItemsPage({
        owner: this.owner,
        projectNumber: this.projectNumber,
        first: pageSize,
        after,
      });

      for (const node of page.items) {
        const normalized = this.normalizeNode(node);
        if (target.has(normalized.state)) {
          acc.push(normalized);
        }
      }

      if (!page.hasNextPage || !page.endCursor) break;
      after = page.endCursor;
    }

    return acc;
  }

  async getStatesByIds(itemIds: string[]): Promise<Record<string, WorkItemState>> {
    const nodes = await this.client.fetchProjectItemsByIds(itemIds);
    const result: Record<string, WorkItemState> = {};
    for (const node of nodes) {
      const state = this.extractState(node);
      result[node.id] = state;
    }
    return result;
  }

  async markInProgress(_itemId: string): Promise<void> {
    throw new Error("Use GitHubProjectsWriter for tracker write operations");
  }

  async markDone(_itemId: string): Promise<void> {
    throw new Error("Use GitHubProjectsWriter for tracker write operations");
  }

  private normalizeNode(node: ProjectItemNode): NormalizedWorkItem {
    if (!node.content || node.content.__typename !== "Issue") {
      throw new TrackerMalformedPayloadError("Project item does not contain Issue content");
    }

    const createdAt = node.content.createdAt;
    const updatedAt = node.content.updatedAt;
    if (!createdAt || !updatedAt) {
      throw new TrackerMalformedPayloadError("Project item payload missing timestamps");
    }

    const labels = (node.content.labels?.nodes ?? [])
      .map((label) => label?.name?.trim().toLowerCase())
      .filter((label): label is string => Boolean(label));

    const body = node.content.body ?? "";

    return {
      id: node.id,
      identifier: `#${node.content.number}`,
      number: node.content.number,
      title: node.content.title,
      body,
      description: body,
      state: this.extractState(node),
      priority: null,
      labels,
      blocked_by: [],
      assignees: [],
      created_at: createdAt,
      updated_at: updatedAt,
      updatedAt: updatedAt,
      url: node.content.url,
    };
  }

  private extractState(node: ProjectItemNode): WorkItemState {
    const singleSelect =
      node.fieldValues?.nodes?.find((n) => n?.__typename === "ProjectV2ItemFieldSingleSelectValue") ?? null;

    if (singleSelect && "name" in singleSelect && typeof singleSelect.name === "string") {
      return normalizeState(singleSelect.name);
    }
    return "todo";
  }
}

export class GitHubProjectsAdapterPlaceholder implements TrackerAdapter {
  async listEligibleItems(): Promise<NormalizedWorkItem[]> {
    return [];
  }

  async listCandidateItems(): Promise<NormalizedWorkItem[]> {
    return [];
  }

  async listItemsByStates(): Promise<NormalizedWorkItem[]> {
    return [];
  }

  async getStatesByIds(): Promise<Record<string, WorkItemState>> {
    return {};
  }

  async markInProgress(_itemId: string): Promise<void> {
    throw new Error("GitHub Projects write path not implemented yet");
  }

  async markDone(_itemId: string): Promise<void> {
    throw new Error("GitHub Projects write path not implemented yet");
  }
}
