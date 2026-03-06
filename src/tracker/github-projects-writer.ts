export interface GraphQLQueryable {
  query<T>(queryString: string, variables?: Record<string, unknown>): Promise<T>;
}

export interface StatusOptionMapping {
  inProgress: string;
  done: string;
}

const DEFAULT_STATUS_OPTIONS: StatusOptionMapping = {
  inProgress: 'In Progress',
  done: 'Done',
};

export interface GitHubProjectsWriterOptions {
  projectId: string;
  graphqlClient: GraphQLQueryable;
  statusOptions?: Partial<StatusOptionMapping>;
}

interface StatusFieldInfo {
  fieldId: string;
  optionIds: Record<string, string>;
}

interface ProjectFieldNode {
  id: string;
  name: string;
  options?: Array<{ id: string; name: string }>;
}

interface ProjectFieldsResponse {
  node: {
    fields: {
      nodes: ProjectFieldNode[];
    };
  };
}

interface UpdateFieldResponse {
  updateProjectV2ItemFieldValue: {
    clientMutationId: string | null;
  };
}

const FIELDS_QUERY = `
  query($projectId: ID!) {
    node(id: $projectId) {
      ... on ProjectV2 {
        fields(first: 50) {
          nodes {
            ... on ProjectV2SingleSelectField {
              id
              name
              options { id name }
            }
          }
        }
      }
    }
  }
`;

const UPDATE_MUTATION = `
  mutation($projectId: ID!, $itemId: ID!, $fieldId: ID!, $optionId: String!) {
    updateProjectV2ItemFieldValue(input: {
      projectId: $projectId
      itemId: $itemId
      fieldId: $fieldId
      value: { singleSelectOptionId: $optionId }
    }) {
      clientMutationId
    }
  }
`;

export class StatusFieldNotFoundError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'StatusFieldNotFoundError';
  }
}

export class StatusOptionNotFoundError extends Error {
  constructor(
    message: string,
    public readonly availableOptions: string[],
  ) {
    super(message);
    this.name = 'StatusOptionNotFoundError';
  }
}

export class GitHubProjectsWriter {
  private readonly projectId: string;
  private readonly client: GraphQLQueryable;
  private readonly statusOptionNames: StatusOptionMapping;
  private statusFieldCache: StatusFieldInfo | undefined;

  constructor(options: GitHubProjectsWriterOptions) {
    this.projectId = options.projectId;
    this.client = options.graphqlClient;
    this.statusOptionNames = {
      ...DEFAULT_STATUS_OPTIONS,
      ...(options.statusOptions ?? {}),
    };
  }

  async markInProgress(itemId: string): Promise<void> {
    const field = await this.getStatusField();
    const optionId = this.resolveOptionId(field, this.statusOptionNames.inProgress);
    await this.updateField(itemId, field.fieldId, optionId);
  }

  async markDone(itemId: string): Promise<void> {
    const field = await this.getStatusField();
    const optionId = this.resolveOptionId(field, this.statusOptionNames.done);
    await this.updateField(itemId, field.fieldId, optionId);
  }

  private resolveOptionId(field: StatusFieldInfo, optionName: string): string {
    const optionId = field.optionIds[optionName];
    if (!optionId) {
      throw new StatusOptionNotFoundError(
        `Status option "${optionName}" not found in project`,
        Object.keys(field.optionIds),
      );
    }
    return optionId;
  }

  private async updateField(itemId: string, fieldId: string, optionId: string): Promise<void> {
    await this.client.query<UpdateFieldResponse>(UPDATE_MUTATION, {
      projectId: this.projectId,
      itemId,
      fieldId,
      optionId,
    });
  }

  async getStatusField(): Promise<StatusFieldInfo> {
    if (this.statusFieldCache) {
      return this.statusFieldCache;
    }

    const data = await this.client.query<ProjectFieldsResponse>(FIELDS_QUERY, {
      projectId: this.projectId,
    });

    const statusField = data.node.fields.nodes.find(
      (f) => f.name === 'Status' && f.options !== undefined,
    );

    if (!statusField || !statusField.options) {
      throw new StatusFieldNotFoundError('Status single-select field not found in project');
    }

    const optionIds: Record<string, string> = {};
    for (const opt of statusField.options) {
      optionIds[opt.name] = opt.id;
    }

    this.statusFieldCache = {
      fieldId: statusField.id,
      optionIds,
    };

    return this.statusFieldCache;
  }
}
