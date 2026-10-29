import { CAPABILITIES, allowedTools, requiredToolGroups } from './capabilities.js';

// Phases are audit/permission boundaries, not separate LLM agents.
export const WORKFLOW_DEPENDENCIES = Object.freeze({ document: ['research', 'automotive'] });

export class ToolWorkflow {
  constructor(intent, maxSteps) {
    this.intent = intent; this.allowed = allowedTools(intent);
    const roles = [...new Set(intent.operations.map(op => CAPABILITIES[op].agent))];
    if (roles.length > maxSteps) throw new Error('Workflow step budget exceeded');
    this.steps = roles.map(agent => ({ id: `phase-${agent}`, agent, kind: 'workflow', task: intent.goal,
      dependsOn: [...(WORKFLOW_DEPENDENCIES[agent] || []), ...(agent === 'document' && intent.operations.some(op => ['numbers.verify','memory.read','time.read'].includes(op)) ? ['conversation'] : [])].filter(r => roles.includes(r)).map(r => `phase-${r}`),
      status: 'pending', tools: [], unfulfilled: [], result: '' }));
    this.refresh();
  }
  phase(name) { return this.steps.find(s => this.intent.operations.some(op => CAPABILITIES[op].agent === s.agent && [...CAPABILITIES[op].tools,...(CAPABILITIES[op].optionalTools || [])].includes(name))); }
  ready(step) { return step && !['failed', 'blocked'].includes(step.status) && step.dependsOn.every(id => this.steps.find(s => s.id === id)?.status === 'completed'); }
  specs(specs) { return specs.filter(s => this.allowed.has(s.function.name) && this.ready(this.phase(s.function.name))); }
  refresh(finished = false) {
    for (let i = 0; i <= this.steps.length; i++) for (const s of this.steps) {
      const success = new Set(s.tools.filter(t => !t.failed).map(t => t.name));
      s.unfulfilled = requiredToolGroups(this.intent, s.agent).filter(g => !g.tools.some(t => success.has(t))).map(g => g.operation);
      if (s.dependsOn.some(id => ['failed','blocked'].includes(this.steps.find(p => p.id === id)?.status))) s.status = 'blocked';
      else if (s.tools.some(t => t.failed) || (finished && s.unfulfilled.length)) s.status = 'failed';
      else if (!s.unfulfilled.length && (s.tools.length || finished)) s.status = 'completed';
      else s.status = 'pending';
    }
  }
  record(name, result) {
    const phase = this.phase(name);
    phase.tools.push({ name, result: result.slice(0, 6000), failed: /工具执行失败|未知工具|功能.*关|没开|没画成|画不了|主题为空/.test(result) });
    phase.result = phase.tools.map(t => t.result).join('\n').slice(0, 12000);
    this.refresh(); return phase;
  }
  dependencies(phase) { return this.steps.filter(s => phase.dependsOn.includes(s.id)).map(s => ({ id: s.id, result: s.result, tools: s.tools })); }
  get unfulfilled() { return this.steps.flatMap(s => s.unfulfilled); }
}
