import type { NormalizedWorkItem, WorkItemState } from '../model/work-item.js';
import { normalizeState } from '../model/work-item.js';
import {
  type GitHubProjectsClient,
  type ProjectItemNode,
  TrackerMalformedPayloadError,
} from './github-projects-client.js';

export interface TrackerAdapter {
  listEligibleItems(): Promise<NormalizedWorkItem[]>;
  listCandidateItems(options?: { pageSize?: number; activeStates?: WorkItemState[] }): Promise<NormalizedWorkItem[]>;
  listItemsByStates(states: WorkItemState[], options?: { pageSize?: number }): Promise<NormalizedWorkItem[]>;
  getStatesByIds(itemIds: string[]): Promise<Record<string, WorkItemState>>;
  markInProgress(itemId: string): Promise<void>;
  markDone(itemId: string): Promise<void>;
}

export interface TrackerWriter {
  markInProgress(itemId: string): Promise<void>;
  markDone(itemId: string): Promise<void>;
}

export interface GitHubProjectsAdapterOptions {
  owner: string;
  projectNumber: number;
  client: GitHubProjectsClient;
  writer?: TrackerWriter;
  pageSize?: number;
  activeStates?: WorkItemState[];
}

export class GitHubProjectsAdapter implements TrackerAdapter {
  private readonly owner: string;
  private readonly projectNumber: number;
  private readonly client: GitHubProjectsClient;
  private readonly writer?: TrackerWriter;
  private readonly defaultPageSize: number;
  private readonly defaultActiveStates: WorkItemState[];

  constructor(options: GitHubProjectsAdapterOptions) {
    this.owner = options.owner;
    this.projectNumber = options.projectNumber;
    this.client = options.client;
    this.writer = options.writer;
    this.defaultPageSize = options.pageSize ?? 50;
    this.defaultActiveStates =
      options.activeStates && options.activeStates.length > 0
        ? [...options.activeStates]
        : ['todo', 'in_progress', 'blocked'];
  }

  async listEligibleItems(): Promise<NormalizedWorkItem[]> {
    return this.listCandidateItems();
  }

  async listCandidateItems(options?: {
    pageSize?: number;
    activeStates?: WorkItemState[];
  }): Promise<NormalizedWorkItem[]> {
    const activeStates = options?.activeStates ?? this.defaultActiveStates;
    return this.listItemsByStates(activeStates, { pageSize: options?.pageSize });
  }

  async listItemsByStates(
    states: WorkItemState[],
    options?: { pageSize?: number },
  ): Promise<NormalizedWorkItem[]> {
    const pageSize = options?.pageSize ?? this.defaultPageSize;
    const target = new Set(states.map((state) => normalizeState(String(state))));

    const allNodes: ProjectItemNode[] = [];
    let after: string | undefined;
    while (true) {
      const page = await this.client.fetchProjectItemsPage({
        owner: this.owner,
        projectNumber: this.projectNumber,
        first: pageSize,
        after,
      });

      allNodes.push(...page.items);

      if (!page.hasNextPage || !page.endCursor) {
        break;
      }
      after = page.endCursor;
    }

    const numberToId = new Map<number, string>();
    for (const node of allNodes) {
      if (!node.content || node.content.__typename !== 'Issue') {
        continue;
      }
      numberToId.set(node.content.number, node.id);
    }

    const normalized = allNodes
      .map((node) => this.normalizeNode(node, numberToId))
      .filter((node) => target.has(node.state));

    return normalized;
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

  async markInProgress(itemId: string): Promise<void> {
    if (!this.writer) {
      throw new Error('Tracker writer is not configured');
    }
    await this.writer.markInProgress(itemId);
  }

  async markDone(itemId: string): Promise<void> {
    if (!this.writer) {
      throw new Error('Tracker writer is not configured');
    }
    await this.writer.markDone(itemId);
  }

  private normalizeNode(
    node: ProjectItemNode,
    numberToId: Map<number, string>,
  ): NormalizedWorkItem {
    if (!node.content || node.content.__typename !== 'Issue') {
      throw new TrackerMalformedPayloadError('Project item does not contain Issue content');
    }

    const createdAt = node.content.createdAt;
    const updatedAt = node.content.updatedAt;
    if (!createdAt || !updatedAt) {
      throw new TrackerMalformedPayloadError('Project item payload missing timestamps');
    }

    const labels = (node.content.labels?.nodes ?? [])
      .map((label) => label?.name?.trim().toLowerCase())
      .filter((label): label is string => Boolean(label));

    const body = node.content.body ?? '';
    const blockedBy = this.extractBlockedBy(itemNumberFromBody(body), numberToId);

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
      blocked_by: blockedBy,
      assignees: [],
      created_at: createdAt,
      updated_at: updatedAt,
      updatedAt: updatedAt,
      url: node.content.url,
    };
  }

  private extractBlockedBy(
    references: number[],
    numberToId: Map<number, string>,
  ): string[] {
    const blockedBy = new Set<string>();
    for (const number of references) {
      const id = numberToId.get(number);
      if (id) {
        blockedBy.add(id);
      }
    }

    return [...blockedBy];
  }

  private extractState(node: ProjectItemNode): WorkItemState {
    const singleSelect =
      node.fieldValues?.nodes?.find((n) => n?.__typename === 'ProjectV2ItemFieldSingleSelectValue') ?? null;

    if (singleSelect && 'name' in singleSelect && typeof singleSelect.name === 'string') {
      return normalizeState(singleSelect.name);
    }
    return 'todo';
  }
}

function itemNumberFromBody(body: string): number[] {
  const refs: number[] = [];
  const matches = body.match(/#(\d+)/g) ?? [];
  for (const match of matches) {
    const value = Number.parseInt(match.slice(1), 10);
    if (Number.isInteger(value) && value > 0) {
      refs.push(value);
    }
  }

  return [...new Set(refs)];
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
    throw new Error('GitHub Projects write path not implemented yet');
  }

  async markDone(_itemId: string): Promise<void> {
    throw new Error('GitHub Projects write path not implemented yet');
  }
}
