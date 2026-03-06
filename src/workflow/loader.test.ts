import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  WorkflowParseError,
  WorkflowValidationError,
  loadWorkflowFile,
  parseWorkflowMarkdown,
} from './loader.js';

test('parses front matter and trims prompt body', () => {
  const doc = parseWorkflowMarkdown(`---\nname: demo\ncount: 3\n---\n\n  hello prompt\n\n`);

  assert.deepEqual(doc.config, { name: 'demo', count: 3 });
  assert.equal(doc.prompt_template, 'hello prompt');
});

test('parses nested front matter objects', () => {
  const doc = parseWorkflowMarkdown(
    `---\ntracker:\n  kind: github_projects\n  github:\n    owner: kouka-t0yohei\n    projectNumber: 1\n---\nrun\n`,
  );

  assert.deepEqual(doc.config, {
    tracker: {
      kind: 'github_projects',
      github: {
        owner: 'kouka-t0yohei',
        projectNumber: 1,
      },
    },
  });
});

test('preserves multi-line string values', () => {
  const doc = parseWorkflowMarkdown(
    `---\nhooks:\n  after_create: |\n    echo first\n    echo second\n---\nrun\n`,
  );

  assert.deepEqual(doc.config, {
    hooks: {
      after_create: 'echo first\necho second\n',
    },
  });
});

test('returns empty config when front matter is absent', () => {
  const doc = parseWorkflowMarkdown('\n\njust prompt\n\n');

  assert.deepEqual(doc.config, {});
  assert.equal(doc.prompt_template, 'just prompt');
});

test('throws WorkflowParseError when front matter is malformed', () => {
  assert.throws(
    () => parseWorkflowMarkdown('---\nname: demo\nbody without closer'),
    WorkflowParseError,
  );
});

test('throws WorkflowValidationError when front matter is not an object', () => {
  assert.throws(() => parseWorkflowMarkdown('---\n- item\n---\ntext'), WorkflowValidationError);

  assert.throws(() => parseWorkflowMarkdown('---\ntrue\n---\ntext'), WorkflowValidationError);
});

test('loadWorkflowFile reads explicit path', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'workflow-loader-'));
  const filePath = join(dir, 'WORKFLOW.md');
  await writeFile(filePath, '---\nname: from-file\n---\n\nbody\n', 'utf8');

  const doc = await loadWorkflowFile(filePath);
  assert.deepEqual(doc.config, { name: 'from-file' });
  assert.equal(doc.prompt_template, 'body');
});
