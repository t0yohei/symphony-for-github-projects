export * from './bootstrap.js';
export * from './config/runtime-config.js';
export * from './config/resolver.js';
export * from './logging/logger.js';
export * from './model/work-item.js';
export * from './orchestrator/runtime.js';
export * from './tracker/adapter.js';
export * from './tracker/graphql-client.js';
export * from './tracker/github-projects-client.js';
export * from './tracker/github-projects-writer.js';
export * from './agent/codex-app-server.js';
export * from './workspace/hooks.js';
export * from './workspace/manager.js';
export * from './orchestrator/reconciler.js';
export * from './workflow/hot-reload.js';
export * from './prompt/template.js';

export {
  NotImplementedWorkflowLoader,
  validateWorkflowContract,
  type WorkflowContract,
  type WorkflowLoader,
  type WorkflowValidationError as WorkflowContractValidationError,
  type WorkflowValidationErrorCode,
} from './workflow/contract.js';

export {
  loadWorkflowFile,
  parseWorkflowMarkdown,
  WorkflowLoadError,
  WorkflowParseError,
  WorkflowValidationError,
  type WorkflowConfig,
  type WorkflowDocument,
} from './workflow/loader.js';

import { startService, parseArgs } from './cli.js';

if (typeof process !== 'undefined' && process.argv[1]?.endsWith('dist/index.js')) {
  void startService(parseArgs(process.argv.slice(2))).catch((error) => {
    // eslint-disable-next-line no-console
    console.error(error);
    process.exit(1);
  });
}
