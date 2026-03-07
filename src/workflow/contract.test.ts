import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { buildContract, FileWorkflowLoader, WorkflowContractBuildError } from './contract.js';
import type { WorkflowDocument } from './loader.js';

test('buildContract maps WorkflowDocument to LoadedWorkflowContract', () => {
  const doc: WorkflowDocument = {
    config: {
      tracker: {
        kind: 'github_projects',
        github: {
          owner: 'kouka-t0yohei',
          projectNumber: 123,
        },
        auth: {
          tokenEnv: 'GITHUB_TOKEN',
        },
      },
      runtime: {
        pollIntervalMs: 5000,
        maxConcurrency: 3,
        retry: {
          continuationDelayMs: 2000,
        },
      },
      workspace: {
        root: './tmp/workspaces',
      },
      agent: {
        command: 'codex',
        args: ['run'],
        maxTurns: 20,
        timeouts: {
          turnTimeoutMs: 300000,
          readTimeoutMs: 15000,
          stallTimeoutMs: 60000,
          hooksTimeoutMs: 45000,
        },
      },
      hooks: {
        after_create: 'echo start',
      },
    },
    prompt_template: 'Do the thing',
  };

  const contract = buildContract(doc);

  assert.equal(contract.tracker.github.owner, 'kouka-t0yohei');
  assert.equal(contract.tracker.github.projectNumber, 123);
  assert.equal(contract.tracker.github.tokenEnv, 'GITHUB_TOKEN');
  assert.equal(contract.runtime.pollIntervalMs, 5000);
  assert.equal(contract.runtime.maxConcurrency, 3);
  assert.equal(contract.runtime.retry?.continuationDelayMs, 2000);
  assert.equal(contract.workspace.root, './tmp/workspaces');
  assert.deepEqual(contract.agent.args, ['run']);
  assert.equal(contract.agent.maxTurns, 20);
  assert.equal(contract.agent.timeouts?.turnTimeoutMs, 300000);
  assert.equal(contract.hooks?.after_create, 'echo start');
  assert.equal(contract.polling.intervalMs, 5000);
  assert.equal(contract.prompt_template, 'Do the thing');
});

test('buildContract supports legacy keys and github extension namespace', () => {
  const doc: WorkflowDocument = {
    config: {
      tracker: {
        kind: 'github_projects',
        github: {
          owner: 'legacy-owner',
          projectNumber: 321,
          tokenEnv: 'LEGACY_TOKEN',
        },
      },
      polling: {
        intervalMs: 8000,
        maxConcurrency: 2,
      },
      workspace: {
        baseDir: './legacy/workspaces',
      },
      agent: {
        command: 'codex',
      },
      extensions: {
        github_projects: {
          custom_field_map: {
            estimate: 'Story Points',
          },
        },
      },
    },
    prompt_template: 'Prompt',
  };

  const contract = buildContract(doc);
  assert.equal(contract.runtime.pollIntervalMs, 8000);
  assert.equal(contract.workspace.root, './legacy/workspaces');
  assert.equal(contract.tracker.github.tokenEnv, 'LEGACY_TOKEN');
  assert.deepEqual(contract.extensions?.github_projects, {
    custom_field_map: { estimate: 'Story Points' },
  });
});

test('buildContract surfaces validation errors clearly', () => {
  const doc: WorkflowDocument = {
    config: {
      tracker: {
        kind: 'github_projects',
        github: {
          projectNumber: 1,
        },
      },
    },
    prompt_template: 'Prompt',
  };

  assert.throws(
    () => buildContract(doc),
    (error: unknown) => {
      assert.ok(error instanceof WorkflowContractBuildError);
      assert.match(error.message, /Invalid WORKFLOW\.md front matter/);
      assert.ok(error.validationErrors.length > 0);
      assert.ok(error.validationErrors.some((entry) => entry.path === 'tracker.github.owner'));
      return true;
    },
  );
});




test('validateWorkflowContract rejects unknown top-level keys', () => {
  const doc: WorkflowDocument = {
    config: {
      tracker: {
        kind: 'github_projects',
        github: {
          owner: 'kouka-t0yohei',
          projectNumber: 123,
          tokenEnv: 'GITHUB_TOKEN',
        },
      },
      runtime: {
        pollIntervalMs: 30000,
      },
      workspace: {
        root: './tmp',
      },
      agent: {
        command: 'codex',
      },
      mystery: 'nope',
    },
    prompt_template: 'Prompt',
  };

  assert.throws(
    () => buildContract(doc),
    (error: unknown) => {
      assert.ok(error instanceof WorkflowContractBuildError);
      assert.match((error as WorkflowContractBuildError).message, /mystery/);
      const wrapped = error as WorkflowContractBuildError;
      assert.ok(wrapped.validationErrors.some((entry) => entry.code === 'workflow.unknown_key'));
      return true;
    },
  );
});


test('validateWorkflowContract rejects unknown nested keys', () => {
  const doc: WorkflowDocument = {
    config: {
      tracker: {
        kind: 'github_projects',
        github: {
          owner: 'kouka-t0yohei',
          projectNumber: 123,
          tokenEnv: 'GITHUB_TOKEN',
          typoKey: 'bad',
        },
      },
      runtime: {
        pollIntervalMs: 30000,
        unknownRetry: 5,
      },
      workspace: {
        root: './tmp',
      },
      agent: {
        command: 'codex',
      },
    },
    prompt_template: 'Prompt',
  };

  assert.throws(
    () => buildContract(doc),
    (error: unknown) => {
      assert.ok(error instanceof WorkflowContractBuildError);
      const wrapped = error as WorkflowContractBuildError;
      assert.match((error as WorkflowContractBuildError).message, /tracker.github.typoKey|runtime.unknownRetry/);
      assert.ok(wrapped.validationErrors.some((entry) => entry.code === 'workflow.unknown_key'));
      return true;
    },
  );
});

test('buildContract expands workspace path with HOME and env vars', () => {
  process.env.WORKFLOW_TEST_ROOT = '/var/tmp/symphony-custom';
  const doc: WorkflowDocument = {
    config: {
      tracker: {
        kind: 'github_projects',
        github: {
          owner: 'kouka-t0yohei',
          projectNumber: 123,
          tokenEnv: 'GITHUB_TOKEN',
        },
      },
      polling: {
        intervalMs: 5000,
        maxConcurrency: 1,
      },
      workspace: {
        root: '$WORKFLOW_TEST_ROOT/workspaces',
      },
      agent: {
        command: 'codex',
      },
    },
    prompt_template: 'Run',
  };

  const contract = buildContract(doc);
  assert.equal(contract.workspace.root, '/var/tmp/symphony-custom/workspaces');

  delete process.env.WORKFLOW_TEST_ROOT;
});


test('FileWorkflowLoader reads file and returns contract with prompt template', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'workflow-contract-loader-'));
  const filePath = join(dir, 'WORKFLOW.md');
  await writeFile(
    filePath,
    `---
tracker:
  kind: github_projects
extensions:
  github_projects:
    owner: kouka-t0yohei
    project_number: 99
    token_env: GITHUB_TOKEN
runtime:
  poll_interval_ms: 5000
workspace:
  root: ./tmp/workspaces
agent:
  command: codex
---
\nPrompt from file\n`,
    'utf8',
  );

  const loader = new FileWorkflowLoader();
  const workflow = await loader.load(filePath);

  assert.equal(workflow.tracker.github.owner, 'kouka-t0yohei');
  assert.equal(workflow.tracker.github.projectNumber, 99);
  assert.equal(workflow.prompt_template, 'Prompt from file');
});
