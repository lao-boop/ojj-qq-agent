import { CAPABILITIES, validateCapabilities } from './capabilities.js';
import { randomUUID } from 'node:crypto';
import { intentFailure } from './intent-errors.js';
import { IntentRecognizer } from './intent.js';

/** Task state is scoped by conversation, bounded, and deliberately not execution history. */
export class TaskState {
  constructor() { this.chats = new Map(); }
  list(key) {
    const now = Date.now();
    const tasks = (this.chats.get(key) || []).filter(t => now - t.updatedAt < 86400000 || ['running','queued'].includes(t.status));
    this.chats.delete(key); this.chats.set(key, tasks);
    if (this.chats.size > 1000) this.chats.delete(this.chats.keys().next().value);
    return tasks;
  }
  add(key, value) {
    const tasks = this.list(key);
    const task = { ...value, id: randomUUID(), status: 'draft', updatedAt: Date.now() };
    tasks.push(task);
    if (tasks.length > 20) tasks.splice(0, tasks.length - 20);
    return task;
  }
  finish(task, status) { if (task) Object.assign(task, { status, updatedAt: Date.now() }); }
}

export class UnderstandingPipeline {
  constructor({ llm, state = new TaskState(), validators = {}, logger }) { Object.assign(this, { llm, state, validators, logger }); }
  async prepare(chatKey, input) {
    const snapshot = this.state.list(chatKey).map(t => ({ id:t.id, goal:t.goal, kind:t.kind, slots:t.slots, operations:t.operations, forbiddenOperations:t.forbiddenOperations, exclude:t.exclude, status:t.status }));
    let intent;
    try { intent = await new IntentRecognizer(this.llm, this.logger).recognize({ ...input, tasks: snapshot }); }
    catch (error) { return intentFailure(error, this.logger); }
    const contradiction = needsNegationReview(intent, input.instruction);
    if (contradiction) {
      try { intent = await new IntentRecognizer(this.llm, this.logger).recognize({ ...input, tasks: snapshot, review: '上次判为新建，但用户有否定。重新检查否定范围与纠正对象；不明确则 clarification，禁止照旧执行。' }); }
      catch (error) { return intentFailure(error, this.logger); }
      if (needsNegationReview(intent, input.instruction) && !intent.clarification) return { reply: '为避免做反，请明确这次要执行的内容和不要执行的内容。' };
    }
    // Fresh state after model latency: never replace an operation that has started in the meantime.
    const tasks = this.state.list(chatKey);
    let target = intent.targetId ? tasks.find(t => t.id === intent.targetId) : undefined;
    const editing = ['update','reject','cancel','status'].includes(intent.act);
    if (intent.targetId && !target) return { reply: '没有找到你指的任务，请说明是哪一项。' };
    if (editing && !target) {
      const candidates = tasks.filter(t => t.status !== 'cancelled');
      if (candidates.length === 1) target = candidates[0];
      else return { reply: candidates.length ? '你指的是哪项任务？请说一下任务内容。' : '目前没有可对应的任务，请说明完整需求。' };
    }
    if (target?.slots?.source === 'next_audio' && target.requester && target.requester !== input.actorId) return { reply: '这项待翻唱任务属于另一位用户，请单独提出自己的翻唱请求。' };
    if (target?.slots?.source === 'next_audio' && Date.now() - target.updatedAt > 10 * 60 * 1000 && intent.act !== 'cancel') { this.state.finish(target, 'cancelled'); return { reply: '等待下一条音频的任务已过期，请重新确认要翻唱的音频。' }; }
    if (intent.act === 'status') return { reply: `这项任务的状态是：${({draft:'等待补充或确认',running:'正在执行',queued:'已排队，尚未确认交付',completed:'处理结束',failed:'执行失败',cancelled:'已取消'})[target.status]}。` };
    if (editing && ['running','queued'].includes(target.status)) return { reply: '这项任务已经开始执行或排队，目前无法可靠中止或替换；这次没有修改原任务，也不会另外启动一份。' };
    if (intent.act === 'cancel' && ['completed','failed'].includes(target.status)) return { reply: '这项任务已经结束，没有等待取消的执行；已交付内容无法撤回。' };
    if (intent.act === 'cancel') { this.state.finish(target, 'cancelled'); return { reply: '已取消这项待处理任务；已经交付的结果无法撤回。' }; }
    if (intent.act === 'chat') {
      const readonly = { ...intent, operations: intent.operations.filter(op => ['chat.reply','memory.read','research.search','image.inspect','automotive.identify'].includes(op)), readOnly: true };
      if (!readonly.operations.length) readonly.operations = ['chat.reply'];
      readonly.agents = [...new Set(readonly.operations.map(op => CAPABILITIES[op].agent))];
      const issue = intent.clarification || validateCapabilities(readonly, input);
      return issue ? { reply: issue } : { intent: readonly };
    }
    if (intent.act === 'create' && intent.targetId) return { reply: '新建还是修改原任务？请明确一下。' };
    if (target && target.status === 'cancelled') return { reply: '这项任务已取消；要重新开始，请重新提出完整需求。' };
    const merged = target ? { ...intent, kind: target.kind, operations: intent.operations.length ? intent.operations : target.operations, forbiddenOperations: [...new Set([...target.forbiddenOperations, ...intent.forbiddenOperations])], agents: intent.agents.length ? intent.agents : target.agents, slots: { ...target.slots, ...intent.slots }, exclude: [...new Set([...target.exclude, ...intent.exclude])] } : intent;
    if (intent.act === 'reject') {
      Object.assign(target, { exclude: merged.exclude, forbiddenOperations: merged.forbiddenOperations });
      this.state.finish(target, 'draft');
      return { reply: '已记下你排除的内容。请说明正确对象或要修改的地方，我不会自动换一个执行。' };
    }
    if (merged.kind === 'cover' && merged.agents.some(a => a !== 'audio')) return { reply: '这次同时包含翻唱和其他任务，请分开提出；当前不会只执行其中一部分。' };
    if (merged.kind === 'cover' && merged.exclude.includes(merged.slots.title)) return { reply: '你指定的歌名同时被排除了，请确认要唱哪一首。' };
    if (merged.kind === 'cover' && merged.slots.source === 'next_audio') {
      delete merged.slots.title; delete merged.slots.artist;
    }
    if (merged.operations.length) merged.agents = [...new Set(merged.operations.map(op => CAPABILITIES[op].agent))];
    // Reserve updates synchronously before awaiting read-only validators.
    const task = target || this.state.add(chatKey, { ...merged, requester: input.actorId || "" });
    Object.assign(task, merged);
    if (merged.slots.delivery !== 'other_chat') delete task.deliveryAuthorization;
    this.state.finish(task, 'running');
    const clarify = intent.clarification || (intent.missing.length ? `还需要补充：${intent.missing.join('、')}。` : '');
    if (clarify) { this.state.finish(task, 'draft'); return { reply: clarify, task }; }
    const capabilityIssue = validateCapabilities(merged, input);
    if (capabilityIssue) { this.state.finish(task, 'draft'); return { reply: capabilityIssue, task }; }
    if (!merged.operations.length || !merged.agents.length) { this.state.finish(task, 'draft'); return { reply: '请说明需要完成的具体任务。', task }; }
    if (merged.kind === 'cover' && !['attachment','recent_audio','next_audio'].includes(merged.slots.source) && !merged.slots.title) { this.state.finish(task, 'draft'); return { reply: '要翻唱哪首歌？请告诉我歌名，最好也带上歌手。', task }; }
    if (merged.slots.format && !['ppt','docx','excel'].includes(merged.slots.format)) { this.state.finish(task, 'draft'); return { reply: '文档格式请选择 PPT、Word 或 Excel。', task }; }
    try {
      const validator = this.validators[merged.kind];
      if (merged.kind === 'cover' && !validator) { this.state.finish(task, 'draft'); return { reply: '当前入口没有接入曲库核验，不能直接开始翻唱。', task }; }
      const checked = validator ? await validator(merged, input, { task }) : {};
      if (Object.hasOwn(checked, 'authorization')) task.deliveryAuthorization = checked.authorization;
      if (checked.reply) { this.state.finish(task, 'draft'); return { reply: checked.reply, task }; }
      if (merged.kind === 'cover' && merged.slots.source === 'next_audio') { this.state.finish(task, 'draft'); return { reply: '已记下，等待下一条要翻唱的音频；这条准备指令不会执行。', task }; }
      return { intent: { ...merged, goal: JSON.stringify({ goal: merged.goal, slots: merged.slots, exclude: merged.exclude }), validated: checked.value }, task };
    } catch {
      this.state.finish(task, 'draft'); return { reply: '执行前核验没有完成，暂时不会执行，请稍后再试。', task };
    }
  }
}

// If a prohibition has already been captured and enforced, do not ask again just
// because the sentence contains “不要”. Unknown negative scope still gets reviewed.
function needsNegationReview(intent, instruction) {
  if (intent.act !== 'create' || !/(没让你|不要(?:做|画|唱|生成|发)|别(?:做|画|唱|发)|不是要)/.test(instruction)) return false;
  const targets = [];
  if (/(不要|别|没让你)(再)?(画图|生成图片|做图)/.test(instruction)) targets.push('image.generate');
  if (/(不要|别|没让你)(再)?(发语音|读出来|朗读)/.test(instruction)) targets.push('speech.synthesize');
  if (/(不要|别|没让你)(再)?(写歌|创作歌曲)/.test(instruction)) targets.push('music.compose');
  return !targets.length || targets.some(op => !intent.forbiddenOperations.includes(op) || intent.operations.includes(op));
}
