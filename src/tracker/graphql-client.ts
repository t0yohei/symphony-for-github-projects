export interface GraphQLClientOptions {
  token: string;
  baseUrl?: string;
}

export interface GraphQLResponse<T = unknown> {
  data?: T;
  errors?: Array<{ message: string; type?: string; path?: string[] }>;
}

export class GraphQLError extends Error {
  constructor(
    message: string,
    public readonly errors: Array<{ message: string; type?: string; path?: string[] }>,
  ) {
    super(message);
    this.name = 'GraphQLError';
  }
}

export class GraphQLClient {
  private readonly token: string;
  private readonly baseUrl: string;

  constructor(options: GraphQLClientOptions) {
    this.token = options.token;
    this.baseUrl = options.baseUrl ?? 'https://api.github.com/graphql';
  }

  async query<T = unknown>(queryString: string, variables?: Record<string, unknown>): Promise<T> {
    const response = await fetch(this.baseUrl, {
      method: 'POST',
      headers: {
        Authorization: `bearer ${this.token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ query: queryString, variables }),
    });

    if (!response.ok) {
      throw new GraphQLError(`GitHub GraphQL request failed: ${response.status}`, []);
    }

    const json = (await response.json()) as GraphQLResponse<T>;

    if (json.errors && json.errors.length > 0) {
      const messages = json.errors.map((e) => e.message).join('; ');
      throw new GraphQLError(`GraphQL errors: ${messages}`, json.errors);
    }

    if (!json.data) {
      throw new GraphQLError('GraphQL response missing data', []);
    }

    return json.data;
  }
}
