import test from 'node:test';
import assert from 'node:assert/strict';

import type { NormalizedWorkItem } from '../model/work-item.js';
import { renderPromptTemplate } from './template.js';

const issue: NormalizedWorkItem = {
  id: 'ISSUE-123',
  number: 123,
  title: 'Fix template rendering',
  body: 'Use strict mode',
  state: 'todo',
  labels: ['enhancement'],
  assignees: ['kouka'],
  url: 'https://example.com/issues/123',
  updatedAt: '2026-03-06T00:00:00Z',
};

test('renderPromptTemplate renders issue and attempt variables', async () => {
  const rendered = await renderPromptTemplate('Issue {{ issue.id }} / Attempt {{ attempt }}', {
    issue,
    attempt: 2,
  });

  assert.equal(rendered, 'Issue ISSUE-123 / Attempt 2');
});

test('renderPromptTemplate throws when unknown variable is referenced', async () => {
  await assert.rejects(
    () =>
      renderPromptTemplate('Issue {{ issue.identifier }}', {
        issue,
        attempt: null,
      }),
    /undefined variable: issue\.identifier/,
  );
});

test('renderPromptTemplate throws when unknown filter is referenced', async () => {
  await assert.rejects(
    () =>
      renderPromptTemplate('{{ issue.id | non_existing_filter }}', {
        issue,
        attempt: null,
      }),
    /undefined filter: non_existing_filter/,
  );
});

test('renderPromptTemplate uses default template when prompt body is empty', async () => {
  const rendered = await renderPromptTemplate('   ', {
    issue,
    attempt: null,
  });

  assert.match(rendered, /You are executing automation for ISSUE-123\./);
  assert.match(rendered, /Title: Fix template rendering/);
  assert.match(rendered, /Attempt:\s*$/m);
});
