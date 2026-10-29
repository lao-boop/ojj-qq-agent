import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

const TERMINAL = new Set(['completed','failed','cancelled']);
export const TASK_STATUS = { draft:'等待补充或确认', running:'正在执行', queued:'已排队', interrupted:'进程中断，等待核对或继续', completed:'处理结束', failed:'执行失败', cancelled:'已取消' };

/** One process owns the journal. File effects are reconciled from their delivery journal. */
export class TaskState {
  constructor({ file = null, now = () => Date.now() } = {}) {
    Object.assign(this,{file,now}); this.chats = new Map();
    if (!file) return;
    try {
      const data=JSON.parse(fs.readFileSync(file,'utf8'));
      if (data.version!==1 || !Array.isArray(data.chats)) throw new Error('Invalid task journal');
      this.chats=new Map(data.chats);
      for (const [key,tasks] of this.chats) {
        if (!Array.isArray(tasks) || tasks.some(t=>!t.id || !Array.isArray(t.operations))) throw new Error('Invalid task records');
        for (const t of tasks) { t.chatKey=key; if(['running','queued'].includes(t.backgroundState))t.backgroundState='interrupted'; if(['running','queued'].includes(t.status)) { t.status='interrupted'; t.updatedAt=this.now(); } }
      }
      this.save();
    } catch(error) { if(error.code!=='ENOENT')throw error; }
  }
  save() {
    if(!this.file)return;
    fs.mkdirSync(path.dirname(this.file),{recursive:true});
    const tmp=`${this.file}.${randomUUID()}.tmp`;
    fs.writeFileSync(tmp,JSON.stringify({version:1,chats:[...this.chats]},null,2),{mode:0o600}); fs.renameSync(tmp,this.file);
  }
  list(key) { if(!this.chats.has(key))this.chats.set(key,[]); return this.chats.get(key); }
  visible(key,actorId) { return this.list(key).filter(t=>!String(key).startsWith('group:') || t.requester===String(actorId)); }
  add(key,value) {
    const tasks=this.list(key), task={...value,id:randomUUID(),chatKey:key,status:'draft',updatedAt:this.now()}; tasks.push(task);
    const old=tasks.filter(t=>TERMINAL.has(t.status)).slice(0,-200);
    if(old.length)this.chats.set(key,tasks.filter(t=>!old.includes(t)));
    this.save(); return task;
  }
  finish(task,status) { if(task) { Object.assign(task,{status,updatedAt:this.now()}); this.save(); } }
  background(task,status) { if(task){task.backgroundState=status;this.reconcile(task);} }
  reconcile(task) {
    const states=Object.values(task.deliveries || {}).map(r=>r.status);
    const status=['running','queued'].includes(task.backgroundState)?'running'
      :task.backgroundState==='interrupted'?'interrupted'
      :task.backgroundState==='failed'?'failed'
      :states.some(s=>['generating','sending'].includes(s))?'running'
      :states.includes('queued')?'queued'
      :states.length && states.every(s=>s==='cancelled')?'cancelled'
      :states.every(s=>s==='sent')?'completed'
      :states.some(s=>['generation_failed','send_failed'].includes(s))?'failed':'interrupted';
    this.finish(task,status);
  }
  syncDelivery(record) {
    let task=this.list(record.chatKey).find(t=>t.id===record.taskId);
    // Legacy direct document commands also become visible/manageable without guessing an owner.
    if(!task && record.taskId) {
      task={id:record.taskId,chatKey:record.chatKey,requester:record.requester||'',goal:record.topic||record.name||'文档',kind:'general',operations:['document.create'],slots:{},forbiddenOperations:[],exclude:[],status:'interrupted'};
      this.list(record.chatKey).push(task);
    }
    if(!task)return;
    task.deliveries ||= {};
    task.deliveries[record.id]={id:record.id,name:record.name||record.topic||'文档',status:record.status};
    task.deliveryState=record.status;
    this.reconcile(task);
  }
}
