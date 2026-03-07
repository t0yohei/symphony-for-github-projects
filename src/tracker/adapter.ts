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
  ownerType?: 'org' | 'user';
  client: GitHubProjectsClient;
  writer?: TrackerWriter;
  pageSize?: number;
  activeStates?: WorkItemState[];
  blockerFieldNames?: string[];
}

const DEFAULT_BLOCKER_FIELD_NAMES = [
  'blocked_by',
  'blocked by',
  'depends_on',
  'depends on',
  'dependencies',
  'blocked',
  'depends',
];

export class GitHubProjectsAdapter implements TrackerAdapter {
  private readonly owner: string;
  private readonly projectNumber: number;
  private readonly ownerType?: 'org' | 'user';
  private readonly client: GitHubProjectsClient;
  private readonly writer?: TrackerWriter;
  private readonly defaultPageSize: number;
  private readonly defaultActiveStates: WorkItemState[];
  private readonly blockerFieldNames: string[];

  constructor(options: GitHubProjectsAdapterOptions) {
    this.owner = options.owner;
    this.projectNumber = options.projectNumber;
    this.ownerType = options.ownerType;
    this.client = options.client;
    this.writer = options.writer;
    this.defaultPageSize = options.pageSize ?? 50;
    this.defaultActiveStates =
      options.activeStates && options.activeStates.length > 0
        ? [...options.activeStates]
        : ['todo', 'in_progress', 'blocked'];
    this.blockerFieldNames =
      options.blockerFieldNames && options.blockerFieldNames.length > 0
        ? options.blockerFieldNames.map((value) => value.toLowerCase())
        : DEFAULT_BLOCKER_FIELD_NAMES;
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
        ownerType: this.ownerType,
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
    const blockerNumbers = this.extractBlockerIssueNumbers(node, body);
    const blockedBy = this.extractBlockedBy(blockerNumbers, numberToId);

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
      updatedAt,
      url: node.content.url,
    };
  }

  private extractBlockerIssueNumbers(node: ProjectItemNode, body: string): number[] {
    const projectFieldNumbers = this.extractIssueNumbersFromProjectFields(node);
    if (projectFieldNumbers.length > 0) {
      return projectFieldNumbers;
    }

    return parseIssueNumbersFromText(body);
  }

  private extractIssueNumbersFromProjectFields(node: ProjectItemNode): number[] {
    const values = node.fieldValues?.nodes ?? [];
    const blockerNumbers = new Set<number>();

    for (const value of values) {
      if (!value || value.__typename !== 'ProjectV2ItemFieldTextValue') {
        continue;
      }

      const fieldName = value.field?.name?.toLowerCase() ?? '';
      if (!this.blockerFieldNames.includes(fieldName)) {
        continue;
      }

      const fieldText = (value as { text?: string | null }).text ?? '';
      for (const num of parseIssueNumbersFromText(fieldText)) {
        blockerNumbers.add(num);
      }
    }

    return [...blockerNumbers];
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

function parseIssueNumbersFromText(text: string): number[] {
  const seen = new Set<number>();
  const matches = text.match(/#(\d+)/g) ?? [];
  for (const match of matches) {
    const value = Number.parseInt(match.slice(1), 10);
    if (Number.isInteger(value) && value > 0) {
      seen.add(value);
    }
  }

  return [...seen];
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
