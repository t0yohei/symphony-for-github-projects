import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import YAML from 'yaml';

export type WorkflowConfig = Record<string, unknown>;

export interface WorkflowDocument {
  config: WorkflowConfig;
  prompt_template: string;
}

export class WorkflowLoadError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'WorkflowLoadError';
  }
}

export class WorkflowParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'WorkflowParseError';
  }
}

export class WorkflowValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'WorkflowValidationError';
  }
}

export async function loadWorkflowFile(path?: string): Promise<WorkflowDocument> {
  const workflowPath = path ? resolve(path) : resolve(process.cwd(), 'WORKFLOW.md');

  let raw: string;
  try {
    raw = await readFile(workflowPath, 'utf8');
  } catch (error) {
    throw new WorkflowLoadError(`Failed to read WORKFLOW.md: ${workflowPath}`, { cause: error });
  }

  return parseWorkflowMarkdown(raw);
}

export function parseWorkflowMarkdown(input: string): WorkflowDocument {
  const normalized = input.replace(/\r\n/g, '\n');

  if (!normalized.startsWith('---\n')) {
    return {
      config: {},
      prompt_template: normalized.trim(),
    };
  }

  const closingIndex = normalized.indexOf('\n---\n', 4);
  if (closingIndex < 0) {
    throw new WorkflowParseError('Malformed front matter: missing closing delimiter');
  }

  const frontMatterText = normalized.slice(4, closingIndex).trim();
  const markdownBody = normalized.slice(closingIndex + 5);
  const config = parseYamlObject(frontMatterText);

  return {
    config,
    prompt_template: markdownBody.trim(),
  };
}

function parseYamlObject(text: string): WorkflowConfig {
  if (text.length === 0) {
    return {};
  }

  let parsed: unknown;
  try {
    parsed = YAML.parse(text);
  } catch (error) {
    throw new WorkflowParseError(
      `Malformed front matter: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  if (!isPlainObject(parsed)) {
    throw new WorkflowValidationError('Front matter must be a YAML object');
  }

  return parsed;
}

function isPlainObject(value: unknown): value is WorkflowConfig {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
