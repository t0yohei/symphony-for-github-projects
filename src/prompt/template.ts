import { Liquid } from 'liquidjs';

import type { NormalizedWorkItem } from '../model/work-item.js';

const DEFAULT_PROMPT_TEMPLATE = [
  'You are executing automation for {{ issue.id }}.',
  'Title: {{ issue.title }}',
  '{% if issue.body %}Body:\n{{ issue.body }}{% endif %}',
  'Attempt: {{ attempt }}',
].join('\n');

const engine = new Liquid({
  strictVariables: true,
  strictFilters: true,
});

export interface PromptRenderContext {
  issue: NormalizedWorkItem;
  attempt: number | null;
}

export function getDefaultPromptTemplate(): string {
  return DEFAULT_PROMPT_TEMPLATE;
}

export async function renderPromptTemplate(
  templateBody: string,
  context: PromptRenderContext,
): Promise<string> {
  const template = templateBody.trim() === '' ? DEFAULT_PROMPT_TEMPLATE : templateBody;
  return engine.parseAndRender(template, context);
}
