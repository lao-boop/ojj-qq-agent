import { AgentManager as MultiAgentManager } from './multi-agent.js';
import { SingleAgent } from './single-agent.js';

// Preserve the public entry point and an explicit rollback mode.
export class AgentManager {
  constructor(options) {
    return options.config?.architecture === 'multi' ? new MultiAgentManager(options) : new SingleAgent(options);
  }
}
export { validatePlan, normalizeInput } from './multi-agent.js';
