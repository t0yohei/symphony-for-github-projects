import assert from 'node:assert/strict';
import test from 'node:test';

import {
  GitHubProjectsWriter,
  StatusFieldNotFoundError,
  StatusOptionNotFoundError,
} from './github-projects-writer.js';
interface FakeGraphQLClient {
  calls: Array<{ query: string; variables?: Record<string, unknown> }>;
  query<T>(queryString: string, variables?: Record<string, unknown>): Promise<T>;
}

function makeFakeClient(responses: Array<{ data?: unknown; error?: string }>): FakeGraphQLClient {
  const calls: Array<{ query: string; variables?: Record<string, unknown> }> = [];
  let callIndex = 0;

  return {
    calls,
    async query<T>(queryString: string, variables?: Record<string, unknown>): Promise<T> {
      calls.push({ query: queryString, variables });
      const resp = responses[callIndex] ?? responses[responses.length - 1];
      callIndex += 1;
      if (resp?.error) {
        throw new Error(resp.error);
      }
      return resp?.data as T;
    },
  };
}

const FIELDS_RESPONSE = {
  node: {
    fields: {
      nodes: [
        {
          id: 'field-1',
          name: 'Status',
          options: [
            { id: 'opt-todo', name: 'Todo' },
            { id: 'opt-ip', name: 'In Progress' },
            { id: 'opt-done', name: 'Done' },
          ],
        },
        {
          id: 'field-2',
          name: 'Priority',
        },
      ],
    },
  },
};

const MUTATION_RESPONSE = {
  updateProjectV2ItemFieldValue: { clientMutationId: null },
};

test('markInProgress sends correct GraphQL mutation', async () => {
  const client = makeFakeClient([{ data: FIELDS_RESPONSE }, { data: MUTATION_RESPONSE }]);

  const writer = new GitHubProjectsWriter({
    projectId: 'proj-1',
    graphqlClient: client,
  });

  await writer.markInProgress('item-42');

  assert.equal(client.calls.length, 2);
  assert.ok(client.calls[0]!.query.includes('fields'));
  assert.ok(client.calls[1]!.query.includes('updateProjectV2ItemFieldValue'));
  assert.equal(client.calls[1]!.variables?.itemId, 'item-42');
  assert.equal(client.calls[1]!.variables?.fieldId, 'field-1');
  assert.equal(client.calls[1]!.variables?.optionId, 'opt-ip');
});

test('markDone sends correct mutation with Done option', async () => {
  const client = makeFakeClient([{ data: FIELDS_RESPONSE }, { data: MUTATION_RESPONSE }]);

  const writer = new GitHubProjectsWriter({
    projectId: 'proj-1',
    graphqlClient: client,
  });

  await writer.markDone('item-99');

  assert.equal(client.calls[1]!.variables?.optionId, 'opt-done');
});

test('caches status field after first fetch', async () => {
  const client = makeFakeClient([
    { data: FIELDS_RESPONSE },
    { data: MUTATION_RESPONSE },
    { data: MUTATION_RESPONSE },
  ]);

  const writer = new GitHubProjectsWriter({
    projectId: 'proj-1',
    graphqlClient: client,
  });

  await writer.markInProgress('item-1');
  await writer.markDone('item-2');

  // Only 1 fields query + 2 mutations = 3 total
  assert.equal(client.calls.length, 3);
});

test('throws StatusFieldNotFoundError when Status field missing', async () => {
  const client = makeFakeClient([
    {
      data: {
        node: { fields: { nodes: [{ id: 'f1', name: 'Priority' }] } },
      },
    },
  ]);

  const writer = new GitHubProjectsWriter({
    projectId: 'proj-1',
    graphqlClient: client,
  });

  await assert.rejects(() => writer.markInProgress('item-1'), StatusFieldNotFoundError);
});

test('throws StatusOptionNotFoundError for unknown status option', async () => {
  const client = makeFakeClient([{ data: FIELDS_RESPONSE }]);

  const writer = new GitHubProjectsWriter({
    projectId: 'proj-1',
    graphqlClient: client,
    statusOptions: { inProgress: 'Working On It', done: 'Done' },
  });

  await assert.rejects(
    () => writer.markInProgress('item-1'),
    (err: StatusOptionNotFoundError) => {
      assert.equal(err.name, 'StatusOptionNotFoundError');
      assert.ok(err.availableOptions.includes('In Progress'));
      return true;
    },
  );
});

test('supports custom status option names', async () => {
  const customFieldsResponse = {
    node: {
      fields: {
        nodes: [
          {
            id: 'field-1',
            name: 'Status',
            options: [
              { id: 'opt-wip', name: 'WIP' },
              { id: 'opt-shipped', name: 'Shipped' },
            ],
          },
        ],
      },
    },
  };

  const client = makeFakeClient([{ data: customFieldsResponse }, { data: MUTATION_RESPONSE }]);

  const writer = new GitHubProjectsWriter({
    projectId: 'proj-1',
    graphqlClient: client,
    statusOptions: { inProgress: 'WIP', done: 'Shipped' },
  });

  await writer.markInProgress('item-1');
  assert.equal(client.calls[1]!.variables?.optionId, 'opt-wip');
});
